import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_CONFIG_SECRET_PATH_ERROR,
  classifyShellRisk,
  isSecretFilesystemPath,
  READ_ONLY_SANDBOX_WRITE_ERROR,
  resolveEffectiveSandbox,
  resolveSandboxDecision,
  SANDBOX_NETWORK_DENIED_ERROR
} from "@agent-runtime";

const appHome = path.join(os.homedir(), ".codexh");

describe("sandbox policy", () => {
  it("promotes opened projects and chat deliverables to workspace-write", () => {
    expect(resolveEffectiveSandbox({
      threadMode: "chat",
      sandboxMode: "read-only",
      gpaFullAccess: false,
      chatTurnWantsDeliverable: false
    })).toEqual({ mode: "read-only", skipInWorkspaceApprovals: false });

    expect(resolveEffectiveSandbox({
      threadMode: "project",
      sandboxMode: "read-only",
      gpaFullAccess: false,
      chatTurnWantsDeliverable: false
    })).toEqual({ mode: "workspace-write", skipInWorkspaceApprovals: false });

    expect(resolveEffectiveSandbox({
      threadMode: "chat",
      sandboxMode: "read-only",
      gpaFullAccess: true,
      chatTurnWantsDeliverable: true
    })).toEqual({ mode: "workspace-write", skipInWorkspaceApprovals: true });

    expect(resolveEffectiveSandbox({
      threadMode: "project",
      sandboxMode: "full-access",
      gpaFullAccess: true,
      chatTurnWantsDeliverable: false
    })).toEqual({ mode: "full-access", skipInWorkspaceApprovals: true });

    expect(resolveEffectiveSandbox({
      threadMode: "chat",
      sandboxMode: "read-only",
      gpaFullAccess: true,
      chatTurnWantsDeliverable: false
    })).toEqual({ mode: "read-only", skipInWorkspaceApprovals: false });
  });

  it("treats application config, env files, ssh keys, and git hooks as secrets", () => {
    expect(isSecretFilesystemPath(path.join(appHome, "config.toml"), appHome)).toBe(true);
    expect(isSecretFilesystemPath(path.join("C:", "repo", ".env"), appHome)).toBe(true);
    expect(isSecretFilesystemPath(path.join("C:", "Users", "demo", ".ssh", "id_rsa"), appHome)).toBe(true);
    expect(isSecretFilesystemPath(path.join("C:", "repo", ".git", "hooks", "pre-commit"), appHome)).toBe(true);
    expect(isSecretFilesystemPath(path.join("C:", "repo", "src", "app.ts"), appHome)).toBe(false);
  });

  it("classifies outbound, git mutation, and destructive shell commands", () => {
    expect(classifyShellRisk("curl https://example.com")).toBe("outbound");
    expect(classifyShellRisk("npm install lodash")).toBe("outbound");
    expect(classifyShellRisk("git commit -m ready")).toBe("git_mutation");
    expect(classifyShellRisk("rm -rf dist")).toBe("destructive");
    expect(classifyShellRisk("npm test")).toBe("routine");
  });

  it("denies secret reads, read-only writes, and outbound shell without network access", () => {
    const cwd = path.join("C:", "task-output");
    expect(resolveSandboxDecision({
      toolName: "fs.read_file",
      args: { path: path.join(appHome, "config.toml") },
      cwd,
      mode: "workspace-write",
      networkAccess: false,
      workspaceRoots: [cwd],
      allowedReadPaths: [],
      appHome
    })).toMatchObject({
      action: "deny",
      kind: "secret",
      reason: APP_CONFIG_SECRET_PATH_ERROR
    });

    expect(resolveSandboxDecision({
      toolName: "fs.write_file",
      args: { path: "out.md", content: "hi" },
      cwd,
      mode: "read-only",
      networkAccess: false,
      workspaceRoots: [cwd],
      allowedReadPaths: [],
      appHome
    })).toMatchObject({
      action: "deny",
      kind: "read_only_write",
      reason: READ_ONLY_SANDBOX_WRITE_ERROR
    });

    expect(resolveSandboxDecision({
      toolName: "shell.exec",
      args: { command: "curl https://example.com" },
      cwd,
      mode: "workspace-write",
      networkAccess: false,
      workspaceRoots: [cwd],
      allowedReadPaths: [],
      appHome
    })).toMatchObject({
      action: "deny",
      kind: "network",
      reason: SANDBOX_NETWORK_DENIED_ERROR
    });
  });

  it("asks before reading a non-secret path outside the workspace", () => {
    const cwd = path.join("C:", "task-output");
    const outside = path.join("D:", "notes", "readme.md");
    const decision = resolveSandboxDecision({
      toolName: "fs.read_file",
      args: { path: outside },
      cwd,
      mode: "read-only",
      networkAccess: false,
      workspaceRoots: [cwd],
      allowedReadPaths: [],
      appHome
    });
    expect(decision.action).toBe("ask");
    expect(decision.kind).toBe("outside_read");
    expect(decision.addReadablePath).toBe(path.resolve(outside));
  });

  it("allows workspace reads without asking", () => {
    const cwd = path.join("C:", "task-output");
    expect(resolveSandboxDecision({
      toolName: "fs.read_file",
      args: { path: "notes.md" },
      cwd,
      mode: "read-only",
      networkAccess: false,
      workspaceRoots: [cwd],
      allowedReadPaths: [],
      appHome
    })).toMatchObject({ action: "allow", kind: "ok" });
  });
});
