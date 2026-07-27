import { describe, expect, it } from "vitest";
import {
  extractDelegatedFileScopes,
  isExplicitMcpProhibition,
  isOverlappingSubagentAssignment,
  normalizeSubagentMcpPolicy
} from "../apps/desktop/src/main/subagent-assignment";

describe("subagent assignment overlap detection", () => {
  it("does not treat shared tool names as delegated file scopes", () => {
    const desktopPrompt = "Use fs.read_file, code.outline, and code.search to inspect apps/desktop.";
    const runtimePrompt = "Use fs.read_file, code.outline, and code.search to inspect packages/agent-runtime.";
    expect(extractDelegatedFileScopes(desktopPrompt)).toEqual(new Set());
    expect(isOverlappingSubagentAssignment({ role: "researcher", prompt: runtimePrompt }, { agentRole: "researcher", lastTaskMessage: desktopPrompt })).toBe(false);
  });

  it("detects overlapping assignments with two shared real files", () => {
    const existingPrompt = "Inspect apps/desktop/src/main/app.ts and packages/agent-runtime/src/index.ts.";
    const requestedPrompt = "Review packages/agent-runtime/src/index.ts together with apps/desktop/src/main/app.ts.";
    expect(isOverlappingSubagentAssignment({ role: "reviewer", prompt: requestedPrompt }, { agentRole: "researcher", lastTaskMessage: existingPrompt })).toBe(true);
  });
});

describe("subagent MCP policy", () => {
  it("replaces an agent-generated blanket prohibition with local-first fallback guidance", () => {
    expect(normalizeSubagentMcpPolicy(
      "仅在本地工作区分析。不要使用 MCP。输出文件路径。",
      { projectMode: true, userExplicitlyForbidsMcp: false }
    )).toBe("仅在本地工作区分析。优先检查当前本地工作区；本地证据不足时可以使用 MCP，但不能用 MCP 替代当前项目代码。输出文件路径。");

    expect(normalizeSubagentMcpPolicy(
      "Inspect the repository. Never use MCP tools.",
      { projectMode: true, userExplicitlyForbidsMcp: false }
    )).toBe("Inspect the repository. Inspect the current local workspace first; use MCP when local evidence is insufficient, but not as a substitute for the current project.");
  });

  it("preserves a prohibition explicitly requested by the user", () => {
    expect(isExplicitMcpProhibition("请不要使用 MCP，只看本地代码")).toBe(true);
    expect(normalizeSubagentMcpPolicy(
      "不要使用 MCP。",
      { projectMode: true, userExplicitlyForbidsMcp: true }
    )).toBe("不要使用 MCP。");
  });

  it("does not mistake complaints or substitute warnings for an explicit prohibition", () => {
    expect(isExplicitMcpProhibition("为什么你强制不要使用 MCP？")).toBe(false);
    expect(isExplicitMcpProhibition("我没有说不要使用 MCP")).toBe(false);
    expect(normalizeSubagentMcpPolicy(
      "Do not use MCP as a substitute for the current project.",
      { projectMode: true, userExplicitlyForbidsMcp: false }
    )).toBe("Do not use MCP as a substitute for the current project.");
  });
});
