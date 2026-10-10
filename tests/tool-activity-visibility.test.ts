import { describe, expect, it } from "vitest";
import {
  buildConversationTurnSections,
  buildTimelineEntries,
  shouldKeepTimelineEntryWhenTurnCollapsed
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import { mergeToolCallResults } from "../apps/desktop/src/renderer/timeline/tool-activity-state";
import type { MessageRecord, ToolCallRecord } from "../packages/shared-types/src";

const userMessage: MessageRecord = {
  id: "user-1",
  threadId: "thread-1",
  turnRunId: "turn-1",
  role: "user",
  content: "检查并修复",
  metadataJson: null,
  createdAt: "2026-10-10T00:00:00.000Z"
};

const toolCall: ToolCallRecord = {
  id: "tool-1",
  threadId: "thread-1",
  turnRunId: "turn-1",
  toolName: "shell.exec",
  argumentsJson: JSON.stringify({ command: "pnpm test" }),
  resultJson: null,
  status: "running",
  riskLevel: "low",
  approvalMode: "auto",
  startedAt: "2026-10-10T00:00:01.000Z",
  completedAt: null
};

describe("tool activity visibility", () => {
  it("keeps live tool groups in their chronological timeline position", () => {
    const entries = buildTimelineEntries([userMessage], [toolCall], [], undefined, "running");
    const toolGroup = entries.find((entry) => entry.kind === "tool-group");
    const turn = buildConversationTurnSections(entries)[0];

    expect(toolGroup?.kind).toBe("tool-group");
    expect(turn).toBeDefined();
    expect(shouldKeepTimelineEntryWhenTurnCollapsed(toolGroup!, turn, new Set())).toBe(true);
  });

  it("does not cache a running tool's empty result so completion can load it again", () => {
    const loadedResults = new Map<string, string | null>();
    const nextResults = mergeToolCallResults(loadedResults, [
      { toolCallId: "tool-1", available: true, resultJson: null }
    ], new Set(["tool-1"]));

    expect(nextResults).toBe(loadedResults);
    expect(nextResults.has("tool-1")).toBe(false);
  });

  it("caches a tool result once the detail becomes available", () => {
    const loadedResults = mergeToolCallResults(new Map(), [
      { toolCallId: "tool-1", available: true, resultJson: "{\"ok\":true}" }
    ], new Set(["tool-1"]));

    expect(loadedResults.get("tool-1")).toBe("{\"ok\":true}");
  });

  it("caches a terminal tool's empty result to avoid repeated detail loads", () => {
    const loadedResults = mergeToolCallResults(new Map(), [
      { toolCallId: "tool-1", available: true, resultJson: null }
    ], new Set());

    expect(loadedResults.has("tool-1")).toBe(true);
    expect(loadedResults.get("tool-1")).toBeNull();
  });
});
