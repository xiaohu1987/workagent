import os from "node:os";
import path from "node:path";
import type { SandboxMode } from "@shared-types";

export function defaultAppHome(): string {
  return path.join(os.homedir(), ".codexh");
}

export const APP_CONFIG_SECRET_PATH_ERROR =
  "应用配置含密钥，不能按项目文件读取；请看设置页或仓库源码。不要重试该路径。";
export const SECRET_FILESYSTEM_PATH_ERROR =
  "该路径属于密钥或凭据（如应用配置、.env、SSH 密钥或 Git hooks），禁止读取。不要重试该路径。";
export const OUTSIDE_WORKSPACE_PATH_ERROR =
  "该路径不在当前工作区或已授权附件内。工作区外的非密钥文件需要先获得用户批准；密钥路径请不要重试。";
export const READ_ONLY_SANDBOX_WRITE_ERROR =
  "当前沙箱为只读，禁止写入、补丁或删除。不要重试写入类工具。";
export const SANDBOX_NETWORK_DENIED_ERROR =
  "当前沙箱禁止出站网络。请在设置中开启「允许 shell 出站」，或改用不含联网的命令。不要重试同一条命令。";

const SECRET_BASENAMES = new Set([
  ".env",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  "id_ed25519.pub",
  "id_ecdsa",
  "id_ecdsa.pub",
  "id_dsa",
  "id_dsa.pub"
]);

export function normalizeComparablePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function authorizedRootForPath(targetPath: string, roots: string[]): string | null {
  const resolved = path.resolve(targetPath);
  for (const candidate of roots) {
    if (!candidate) continue;
    const root = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return root;
    }
  }
  return null;
}

export function isPathInsideAuthorizedRoots(absPath: string, roots: string[]): boolean {
  return authorizedRootForPath(absPath, roots) !== null;
}

export function isAppConfigSecretPath(absPath: string, appHome = defaultAppHome()): boolean {
  return normalizeComparablePath(absPath) === normalizeComparablePath(path.join(appHome, "config.toml"));
}

export function isSecretFilesystemPath(absPath: string, appHome = defaultAppHome()): boolean {
  const resolved = path.resolve(absPath);
  const normalized = normalizeComparablePath(resolved);
  const home = normalizeComparablePath(appHome);
  if (normalized === `${home}/config.toml`) return true;
  if (normalized === home) return false;
  if (normalized.startsWith(`${home}/`) && path.basename(normalized) === "config.toml") return true;

  const segments = normalized.split("/");
  if (segments.includes(".ssh")) return true;
  const gitHooksIndex = segments.lastIndexOf("hooks");
  if (gitHooksIndex > 0 && segments[gitHooksIndex - 1] === ".git") return true;

  const base = path.basename(resolved).toLowerCase();
  if (SECRET_BASENAMES.has(base) || base.startsWith(".env.")) return true;
  if (base.endsWith(".pem") || base.endsWith(".pfx") || base.endsWith(".p12")) return true;
  return false;
}

export function secretFilesystemPathError(absPath: string, appHome = defaultAppHome()): string {
  return isAppConfigSecretPath(absPath, appHome) ? APP_CONFIG_SECRET_PATH_ERROR : SECRET_FILESYSTEM_PATH_ERROR;
}

export type ShellRiskKind = "outbound" | "git_mutation" | "destructive" | "routine";

const OUTBOUND_SHELL_PATTERN =
  /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\bssh\b|\bscp\b|\bsftp\b|ftp\b|npm\s+(?:i|install|ci|publish|add)\b|pnpm\s+(?:i|install|add|publish)\b|yarn\s+(?:add|publish)\b|pip(?:3)?\s+install\b)\b/i;
const GIT_MUTATION_SHELL_PATTERN =
  /\bgit(?:\s+--?[A-Za-z][\w-]*(?:[=\s]+[^\s;&|]+)?)*\s+(?:add|restore|reset|clean|commit|push|pull|fetch|merge(?!-base\b)|rebase|cherry-pick|worktree)\b/i;
const DESTRUCTIVE_SHELL_PATTERN =
  /\b(?:rm\s+-[a-zA-Z]*r[a-zA-Z]*f\b|rmdir\s+\/s\b|Remove-Item\b[^\n]*-(?:Recurse|Force)\b|del\s+\/s\b|format\s+[A-Za-z]:)/i;

export function classifyShellRisk(command: string): ShellRiskKind {
  const text = command.trim();
  if (!text) return "routine";
  if (OUTBOUND_SHELL_PATTERN.test(text)) return "outbound";
  if (GIT_MUTATION_SHELL_PATTERN.test(text)) return "git_mutation";
  if (DESTRUCTIVE_SHELL_PATTERN.test(text)) return "destructive";
  return "routine";
}

export interface ToolRuntimeSandbox {
  mode: SandboxMode;
  networkAccess: boolean;
  skipInWorkspaceApprovals: boolean;
  appHome: string;
}

export function shouldSkipWorkspaceMutationApproval(
  sandbox: ToolRuntimeSandbox | undefined,
  kind: "write" | "delete" | "shell"
): boolean {
  if (!sandbox || sandbox.mode === "read-only") return false;
  if (kind === "delete") return false;
  if (sandbox.mode === "workspace-write") return true;
  return sandbox.skipInWorkspaceApprovals;
}
