import { describe, expect, it } from "vitest";
import { extractDelegatedFileScopes, isOverlappingSubagentAssignment } from "../apps/desktop/src/main/subagent-assignment";

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
