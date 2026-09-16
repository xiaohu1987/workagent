import path from "node:path";
import type { SandboxMode } from "@shared-types";
import {
  classifyShellRisk,
  defaultAppHome,
  isPathInsideAuthorizedRoots,
  isSecretFilesystemPath,
  OUTSIDE_WORKSPACE_PATH_ERROR,
  READ_ONLY_SANDBOX_WRITE_ERROR,
  SANDBOX_NETWORK_DENIED_ERROR,
  secretFilesystemPathError
} from "@tool-runtime";

export {
  APP_CONFIG_SECRET_PATH_ERROR,
  classifyShellRisk,
  defaultAppHome,
  isAppConfigSecretPath,
  isPathInsideAuthorizedRoots,
  isSecretFilesystemPath,
  OUTSIDE_WORKSPACE_PATH_ERROR,
  READ_ONLY_SANDBOX_WRITE_ERROR,
  SANDBOX_NETWORK_DENIED_ERROR,
  SECRET_FILESYSTEM_PATH_ERROR,
  secretFilesystemPathError,
  shouldSkipWorkspaceMutationApproval,
  type ShellRiskKind,
  type ToolRuntimeSandbox
} from "@tool-runtime";

const WRITE_TOOL_NAMES = new Set([
  "fs.write_file",
  "fs.mkdir",
  "fs.rename",
  "fs.delete",
  "fs.copy",
  "apply_patch",
  "search_replace"
]);

const READ_PATH_TOOL_NAMES = new Set([
  "fs.read_file",
  "fs.read_directory",
  "code.outline"
]);

export type SandboxDecisionAction = "allow" | "deny" | "ask";

export type SandboxDecisionKind =
  | "secret"
  | "read_only_write"
  | "outside_workspace"
  | "network"
  | "outside_read"
  | "ok";

export interface SandboxDecision {
  action: SandboxDecisionAction;
  reason: string;
  kind: SandboxDecisionKind;
  addReadablePath?: string;
  askTitle?: string;
}

export interface EffectiveSandbox {
  mode: SandboxMode;
  networkAccess: boolean;
  skipInWorkspaceApprovals: boolean;
}

export function resolveEffectiveSandbox(input: {
  threadMode: "project" | "chat";
  sandboxMode: SandboxMode;
  sandboxNetworkAccess: boolean;
  gpaFullAccess: boolean;
  chatTurnWantsDeliverable: boolean;
}): EffectiveSandbox {
  // Match Codex's Full access preset: the user's explicit choice controls the
  // whole turn and must not depend on natural-language deliverable detection.
  if (input.gpaFullAccess) {
    return {
      mode: "full-access",
      networkAccess: true,
      skipInWorkspaceApprovals: true
    };
  }

  let mode: SandboxMode = input.sandboxMode;
  if (input.sandboxMode !== "full-access") {
    if (input.threadMode === "project" || input.chatTurnWantsDeliverable) {
      mode = "workspace-write";
    }
  }
  return {
    mode,
    networkAccess: input.sandboxNetworkAccess,
    skipInWorkspaceApprovals: false
  };
}

export function buildSandboxSystemPrompt(mode: SandboxMode, networkAccess: boolean): string {
  const networkLine = networkAccess
    ? "Outbound shell commands are allowed by the current access policy."
    : "Outbound shell commands (curl, wget, ssh, npm install/publish, and similar) are blocked until Settings enables sandbox network access. Do not retry the same networked command.";
  const modeLine = mode === "read-only"
    ? "Sandbox is read-only: you may read the workspace and attached files. Do not write, patch, or delete files. Shell commands require user approval."
    : mode === "workspace-write"
      ? "Sandbox is workspace-write: you may read and write inside the authorized workspace roots. Paths outside those roots need user approval first. Secrets stay denied."
      : "Sandbox is full-access for non-secret paths. Application config, .env, SSH keys, and Git hooks remain unreadable. Approvals still follow desktop settings.";
  return [
    "## Sandbox",
    modeLine,
    networkLine,
    "Never read application config such as config.toml under the user .codexh directory, .env files, SSH keys, or Git hooks. If a read is denied as a secret path, stop and do not retry that path."
  ].join("\n");
}

function coercePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveToolPath(cwd: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
}

function collectToolTargetPaths(
  toolName: string,
  args: Record<string, unknown>
): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  if (READ_PATH_TOOL_NAMES.has(toolName)) {
    const target = coercePath(args.path);
    if (target) reads.push(target);
  }
  if (toolName === "fs.write_file" || toolName === "fs.mkdir" || toolName === "fs.delete") {
    const target = coercePath(args.path);
    if (target) writes.push(target);
  }
  if (toolName === "search_replace") {
    const target = coercePath(args.file_path) ?? coercePath(args.path);
    if (target) writes.push(target);
  }
  if (toolName === "fs.rename" || toolName === "fs.copy") {
    const from = coercePath(args.from);
    const to = coercePath(args.to);
    if (from) writes.push(from);
    if (to) writes.push(to);
  }
  return { reads, writes };
}

export function resolveSandboxDecision(input: {
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  mode: SandboxMode;
  networkAccess: boolean;
  workspaceRoots: string[];
  allowedReadPaths: string[];
  appHome?: string;
}): SandboxDecision {
  const appHome = input.appHome ?? defaultAppHome();
  const readableRoots = [...input.workspaceRoots, ...input.allowedReadPaths];

  if (WRITE_TOOL_NAMES.has(input.toolName) && input.mode === "read-only") {
    return {
      action: "deny",
      kind: "read_only_write",
      reason: READ_ONLY_SANDBOX_WRITE_ERROR
    };
  }

  if (input.toolName === "shell.exec") {
    const command = typeof input.args.command === "string" ? input.args.command : "";
    const risk = classifyShellRisk(command);
    if (risk === "outbound" && !input.networkAccess) {
      return {
        action: "deny",
        kind: "network",
        reason: SANDBOX_NETWORK_DENIED_ERROR
      };
    }
  }

  const { reads, writes } = collectToolTargetPaths(input.toolName, input.args);
  for (const target of writes) {
    const resolved = resolveToolPath(input.cwd, target);
    if (isSecretFilesystemPath(resolved, appHome)) {
      return {
        action: "deny",
        kind: "secret",
        reason: secretFilesystemPathError(resolved, appHome)
      };
    }
    if (input.mode !== "full-access" && !isPathInsideAuthorizedRoots(resolved, input.workspaceRoots)) {
      return {
        action: "deny",
        kind: "outside_workspace",
        reason: OUTSIDE_WORKSPACE_PATH_ERROR
      };
    }
  }

  for (const target of reads) {
    const resolved = resolveToolPath(input.cwd, target);
    if (isSecretFilesystemPath(resolved, appHome)) {
      return {
        action: "deny",
        kind: "secret",
        reason: secretFilesystemPathError(resolved, appHome)
      };
    }
    if (input.mode === "full-access" || isPathInsideAuthorizedRoots(resolved, readableRoots)) {
      continue;
    }
    return {
      action: "ask",
      kind: "outside_read",
      reason: `准备读取工作区外的文件：\n${resolved}\n\n该路径不是密钥。批准后仅在本回合允许读取该路径，请勿读取应用配置、.env、SSH 密钥或 Git hooks。`,
      askTitle: "读取工作区外文件",
      addReadablePath: resolved
    };
  }

  return {
    action: "allow",
    kind: "ok",
    reason: ""
  };
}
