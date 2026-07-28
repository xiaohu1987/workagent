import { describe, expect, it } from "vitest";
import {
  canDeleteThread,
  getComposerPrimaryActionState,
  getDeleteThreadBlockedMessage,
  getHistoryItemAffordance,
  isThreadExecutionInProgress,
  shouldPreservePreparingRuntime,
  shouldShowTaskProcessing
} from "../apps/desktop/src/renderer/thread-ui-state";
import {
  buildTimelineEntries,
  buildConversationTurnSections,
  getDefaultCollapsedConversationTurnIds,
  createOptimisticThreadSnapshot,
  getThreadDeleteFailureMessage,
  getToolProcessingLabel,
  getActiveSubagents,
  getSubagentWaitLabel,
  isSubagentWaitTool,
  getToolActivityPresentation,
  getToolActivitySummary,
  getToolActivityTarget,
  getSidebarUpdateReminder,
  shouldShowRuntimeActivityPanel,
  filterTranscriptMessages,
  isFileWriteTool,
  isInternalAgentProtocolMessage,
  isPatchAssistantMessage,
  getAssistantDraftDisplayContent,
  mergeSnapshotRecords,
  reconcilePendingUserMessages,
  reconcileAssistantDraftCompletion,
  reconcileAssistantDraftUpdate,
  replaceConversationMessagesFromEdit,
  selectActiveAssistantDraft,
  shouldKeepAssistantDraft
} from "../apps/desktop/src/renderer/App";
import type { MessageRecord, ThreadRecord, ToolCallRecord } from "../packages/shared-types/src";

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "tool-1",
    threadId: "thread-1",
    turnRunId: "turn-1",
    toolName: "fs.read_file",
    argumentsJson: JSON.stringify({ path: "src/App.tsx" }),
    resultJson: "{}",
    status: "completed",
    riskLevel: "low",
    approvalMode: "auto",
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:01.000Z",
    ...overrides
  };
}

describe("thread UI state helpers", () => {
  it("replaces the edited message and removes its stale conversation tail locally", () => {
    const messages: MessageRecord[] = [
      { id: "user-1", threadId: "thread-1", turnRunId: "turn-1", role: "user", content: "old", metadataJson: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "assistant-1", threadId: "thread-1", turnRunId: "turn-1", role: "assistant", content: "old answer", metadataJson: null, createdAt: "2026-07-28T00:00:01.000Z" }
    ];
    const replacement: MessageRecord = {
      id: "optimistic-replacement",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: "edited",
      metadataJson: null,
      createdAt: "2026-07-28T00:00:02.000Z"
    };

    expect(replaceConversationMessagesFromEdit(messages, "user-1", replacement)).toEqual([replacement]);
  });

  it("hides incomplete agent decision JSON from the chat transcript", () => {
    expect(isInternalAgentProtocolMessage('{"assistant_message": "正在检查服务')).toBe(true);
    expect(isInternalAgentProtocolMessage("普通的助手回复")).toBe(false);
  });

  it("treats running and waiting threads as executing", () => {
    expect(isThreadExecutionInProgress("running")).toBe(true);
    expect(isThreadExecutionInProgress("waiting")).toBe(true);
    expect(isThreadExecutionInProgress("completed")).toBe(false);
    expect(isThreadExecutionInProgress(null)).toBe(false);
  });

  it("does not keep processing UI from stale progress after stop", () => {
    expect(shouldShowTaskProcessing("running", false)).toBe(true);
    expect(shouldShowTaskProcessing("waiting", false)).toBe(true);
    expect(shouldShowTaskProcessing("idle", true)).toBe(true);
    expect(shouldShowTaskProcessing("idle", false)).toBe(false);
    expect(shouldShowTaskProcessing("completed", false)).toBe(false);
    expect(shouldShowTaskProcessing("failed", false)).toBe(false);
  });

  it("keeps a just-submitted message out of the queue during the runtime handoff", () => {
    expect(shouldPreservePreparingRuntime("idle", 1, false)).toBe(true);
    expect(shouldPreservePreparingRuntime("running", 1, false)).toBe(false);
    expect(shouldPreservePreparingRuntime("idle", 0, false)).toBe(false);
    expect(shouldPreservePreparingRuntime("completed", 0, false)).toBe(false);
    expect(shouldPreservePreparingRuntime("idle", 1, true)).toBe(false);
  });

  it("shows a spinner affordance for executing history items", () => {
    expect(getHistoryItemAffordance("running")).toEqual({
      kind: "running-indicator",
      title: "任务执行中"
    });
    expect(getHistoryItemAffordance("waiting")).toEqual({
      kind: "running-indicator",
      title: "任务等待中"
    });
    expect(getHistoryItemAffordance("completed")).toEqual({
      kind: "delete",
      title: "删除任务"
    });
  });

  it("only shows interrupt for an empty composer while a thread is executing", () => {
    expect(getComposerPrimaryActionState("running", "")).toEqual({
      kind: "interrupt",
      title: "停止执行",
      ariaLabel: "停止执行",
      disabled: false
    });

    expect(getComposerPrimaryActionState("waiting", "继续")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: false
    });
  });

  it("keeps the send action disabled until trimmed input is present", () => {
    expect(getComposerPrimaryActionState("completed", "")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: true
    });

    expect(getComposerPrimaryActionState("completed", "   ")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: true
    });

    expect(getComposerPrimaryActionState("completed", "你好")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: false
    });
  });

  it("blocks delete while the thread is executing or another delete is already pending", () => {
    expect(canDeleteThread("running", null)).toBe(false);
    expect(getDeleteThreadBlockedMessage("running", null)).toBe("任务正在执行，暂时不能删除。");

    expect(canDeleteThread("completed", "thread-1")).toBe(false);
    expect(getDeleteThreadBlockedMessage("completed", "thread-1")).toBeNull();

    expect(canDeleteThread("completed", null)).toBe(true);
    expect(getDeleteThreadBlockedMessage("completed", null)).toBeNull();
  });
});

describe("tool processing labels", () => {
  it("uses specific status text for common tool operations", () => {
    expect(getToolProcessingLabel("fs.read_file")).toBe("正在读取文件");
    expect(getToolProcessingLabel("fs.read_directory")).toBe("正在读取目录");
    expect(getToolProcessingLabel("apply_patch")).toBe("正在写入文件");
    expect(getToolProcessingLabel("shell.exec")).toBe("正在执行命令");
    expect(getToolProcessingLabel("browser.open_tab")).toBe("正在操作浏览器");
    expect(getToolProcessingLabel("web_search.search_query")).toBe("正在搜索网络");
    expect(getToolProcessingLabel("wait_agent")).toBe("正在等待子智能体");
  });

  it("includes the current command or target in the running status", () => {
    expect(getToolProcessingLabel("shell.exec", JSON.stringify({ command: "pnpm build" }))).toBe("正在运行 pnpm build");
    expect(getToolProcessingLabel("fs.read_file", JSON.stringify({ path: "src/App.tsx" }))).toBe("正在读取 src/App.tsx");
    expect(
      getToolProcessingLabel("apply_patch", JSON.stringify({
        patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch"
      }))
    ).toBe("正在修改 src/App.tsx");
  });
});

describe("tool activity targets", () => {
  it("hides a fallback tool name that would duplicate the activity label", () => {
    expect(getToolActivityTarget("skills.load", {}, "skills.load")).toBe("");
    expect(getToolActivityTarget("shell.exec", { command: "pnpm test" }, "pnpm test")).toBe("pnpm test");
    expect(getToolActivityTarget("fs.write_file", { path: "src/App.tsx" }, "src/App.tsx")).toBe("src/App.tsx");
  });
});

describe("file write transcript filtering", () => {
  it("hides raw Codex patches and their write-tool cards from the chat timeline", () => {
    expect(isPatchAssistantMessage("*** Begin Patch\n*** Add File: src/app.ts\n+export {}\n*** End Patch")).toBe(true);
    expect(isPatchAssistantMessage("Implemented the requested feature.")).toBe(false);
    expect(isFileWriteTool("apply_patch")).toBe(true);
    expect(isFileWriteTool("fs.write_file")).toBe(true);
    expect(isFileWriteTool("fs.read_file")).toBe(false);
  });

  it("hides internal agent protocol echoes from the transcript", () => {
    expect(isInternalAgentProtocolMessage("先只提交 T1，证据严格使用 tool_call_id。")).toBe(true);
    expect(isInternalAgentProtocolMessage("已完成文件读取并继续实现。")).toBe(false);
  });
});

describe("runtime activity visibility", () => {
  it("only keeps the execution heartbeat visible while the task is still active", () => {
    expect(shouldShowRuntimeActivityPanel(true)).toBe(true);
    expect(shouldShowRuntimeActivityPanel(false)).toBe(false);
  });
});

describe("sidebar update reminder", () => {
  it("only shows a reminder when an update needs user attention", () => {
    expect(getSidebarUpdateReminder("available")).toBe("有更新");
    expect(getSidebarUpdateReminder("downloading")).toBe("下载中");
    expect(getSidebarUpdateReminder("downloaded")).toBe("可安装");
    expect(getSidebarUpdateReminder("up-to-date")).toBeNull();
    expect(getSidebarUpdateReminder("checking")).toBeNull();
  });
});

describe("tool activity summaries", () => {
  it("keeps a concise live action available for the inline running indicator", () => {
    const presentation = getToolActivityPresentation([
      makeToolCall({
        toolName: "shell.exec",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ command: "pnpm build" })
      })
    ]);

    expect(presentation.status).toBe("in_progress");
    expect(presentation.runningCall?.toolName).toBe("shell.exec");
    expect(presentation.summary).toEqual({
      title: "\u6b63\u5728\u8fd0\u884c pnpm build",
      detail: ""
    });
  });

  it("removes the live state after every tool has completed", () => {
    const presentation = getToolActivityPresentation([
      makeToolCall({ toolName: "shell.exec", argumentsJson: JSON.stringify({ command: "pnpm build" }) })
    ]);

    expect(presentation.status).toBe("completed");
    expect(presentation.runningCall).toBeUndefined();
  });

  it("keeps preflight blocks distinct from executed failures", () => {
    const presentation = getToolActivityPresentation([
      makeToolCall({
        status: "blocked",
        resultJson: JSON.stringify({ blocked: true, content: "Known ineffective strategy" })
      })
    ]);

    expect(presentation.status).toBe("blocked");
    expect(presentation.runningCall).toBeUndefined();
  });

  it("summarizes completed operations in user-facing categories", () => {
    const summary = getToolActivitySummary([
      makeToolCall({ id: "search", toolName: "code.search", argumentsJson: JSON.stringify({ query: "timeline" }) }),
      makeToolCall({ id: "read", toolName: "fs.read_file" }),
      makeToolCall({ id: "write", toolName: "apply_patch", argumentsJson: JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/App.tsx\n*** End Patch" }) }),
      makeToolCall({ id: "test", toolName: "shell.exec", argumentsJson: JSON.stringify({ command: "pnpm test" }) })
    ]);

    expect(summary).toEqual({
      title: "\u5df2\u5b8c\u6210\u67e5\u8be2\u4e0e\u8bfb\u53d6",
      detail: "\u67e5\u8be2 1 \u6b21 \u00b7 \u8bfb\u53d6 1 \u9879 \u00b7 \u5199\u5165 1 \u6b21\uff08\u6d89\u53ca 1 \u4e2a\u6587\u4ef6\uff09 \u00b7 \u9a8c\u8bc1 1 \u6b21"
    });
  });

  it("surfaces failed operations in the collapsed summary", () => {
    const summary = getToolActivitySummary([
      makeToolCall({ id: "failed", toolName: "shell.exec", status: "failed", argumentsJson: JSON.stringify({ command: "pnpm test" }) }),
      makeToolCall({ id: "read", toolName: "fs.read_file" })
    ]);

    expect(summary.title).toBe("\u90e8\u5206\u8bfb\u53d6\u4e0e\u9a8c\u8bc1\u672a\u5b8c\u6210");
    expect(summary.detail).toBe("\u5df2\u5c1d\u8bd5 2 \u6b21\u8bfb\u53d6\u4e0e\u9a8c\u8bc1 \u00b7 1 \u6b21\u5931\u8d25");
  });

  it("describes MCP calls as queries instead of exposing the tool name", () => {
    const summary = getToolActivitySummary([
      makeToolCall({ id: "mcp-1", toolName: "mcp.call" }),
      makeToolCall({ id: "mcp-2", toolName: "mcp.call", status: "failed" })
    ]);

    expect(summary).toEqual({
      title: "\u90e8\u5206\u67e5\u8be2\u672a\u5b8c\u6210",
      detail: "\u5df2\u5c1d\u8bd5 2 \u6b21\u67e5\u8be2 \u00b7 1 \u6b21\u5931\u8d25"
    });
  });
});

describe("tool timeline grouping", () => {
  it("collapses every completed history turn while leaving only the live turn open", () => {
    const sections = [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }];

    expect(getDefaultCollapsedConversationTurnIds(sections, "turn-3", true)).toEqual(["turn-1", "turn-2"]);
    expect(getDefaultCollapsedConversationTurnIds(sections, "turn-3", false)).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("builds message, elapsed-control, and response sections for every user turn", () => {
    const makeMessage = (id: string, role: MessageRecord["role"], createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: `turn-${id}`,
      role,
      content: id,
      metadataJson: null,
      createdAt
    });
    const entries = buildTimelineEntries([
      makeMessage("user-1", "user", "2026-07-15T00:00:00.000Z"),
      {
        ...makeMessage("progress-1", "assistant", "2026-07-15T00:00:00.500Z"),
        metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: [] })
      },
      makeMessage("assistant-1", "assistant", "2026-07-15T00:00:01.000Z"),
      {
        ...makeMessage("guidance-1", "user", "2026-07-15T00:00:01.500Z"),
        turnRunId: "turn-user-1",
        metadataJson: JSON.stringify({ displayKind: "guidance" })
      },
      makeMessage("user-2", "user", "2026-07-15T00:00:02.000Z"),
      makeMessage("assistant-2", "assistant", "2026-07-15T00:00:03.000Z"),
      makeMessage("user-3", "user", "2026-07-15T00:00:04.000Z")
    ], [], []);

    expect(buildConversationTurnSections(entries)).toEqual([
      expect.objectContaining({
        id: "message-user-1",
        userEntryId: "message-user-1",
        summaryEntryId: "message-assistant-1",
        entryIds: ["message-user-1", "message-progress-1", "message-assistant-1", "message-guidance-1"],
        startedAt: "2026-07-15T00:00:00.000Z",
        completedAt: "2026-07-15T00:00:01.500Z"
      }),
      expect.objectContaining({
        id: "message-user-2",
        userEntryId: "message-user-2",
        summaryEntryId: "message-assistant-2",
        entryIds: ["message-user-2", "message-assistant-2"]
      }),
      expect.objectContaining({
        id: "message-user-3",
        userEntryId: "message-user-3",
        summaryEntryId: null,
        entryIds: ["message-user-3"]
      })
    ]);
  });

  it("interleaves each progress message before its tool group and keeps the final answer last", () => {
    const commentary: MessageRecord = {
      id: "commentary-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "I will inspect the renderer first.",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-1"] }),
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const final: MessageRecord = {
      ...commentary,
      id: "commentary-2",
      content: "The project uses an older solution format, so I will inspect its target framework.",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-2"] }),
      createdAt: "2026-07-15T00:00:02.000Z"
    };
    const answer: MessageRecord = {
      ...commentary,
      id: "final-1",
      content: "The renderer has been inspected.",
      metadataJson: null,
      createdAt: "2026-07-15T00:00:04.000Z"
    };

    const entries = buildTimelineEntries(
      [commentary, final, answer],
      [
        makeToolCall({ id: "tool-1", toolName: "shell.exec", startedAt: "2026-07-15T00:00:01.000Z" }),
        makeToolCall({ id: "tool-2", toolName: "fs.read_file", startedAt: "2026-07-15T00:00:03.000Z" })
      ],
      []
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "tool-group", "message", "tool-group", "message"]);
    expect(entries[0]).toMatchObject({ kind: "message", message: { id: "commentary-1" } });
    expect(entries[2]).toMatchObject({ kind: "message", message: { id: "commentary-2" } });
    expect(entries[4]).toMatchObject({ kind: "message", message: { id: "final-1" } });
  });

  it("anchors legacy tools after the nearest preceding message", () => {
    const message = (id: string, createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: id,
      metadataJson: null,
      createdAt
    });
    const entries = buildTimelineEntries(
      [
        message("progress-1", "2026-07-15T00:00:01.000Z"),
        message("progress-2", "2026-07-15T00:00:03.000Z"),
        message("progress-3", "2026-07-15T00:00:05.000Z")
      ],
      [
        makeToolCall({ id: "legacy-tool-1", startedAt: "2026-07-15T00:00:01.100Z", completedAt: "2026-07-15T00:00:02.000Z" }),
        makeToolCall({ id: "legacy-tool-2", startedAt: "2026-07-15T00:00:03.100Z", completedAt: "2026-07-15T00:00:04.000Z" }),
        makeToolCall({ id: "legacy-tool-3", startedAt: "2026-07-15T00:00:05.100Z", completedAt: "2026-07-15T00:00:06.000Z" })
      ],
      []
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "message", "tool-group", "message", "tool-group", "message", "tool-group"
    ]);
    expect(entries.filter((entry) => entry.kind === "tool-group").map((entry) => entry.toolCalls[0]?.id))
      .toEqual(["legacy-tool-1", "legacy-tool-2", "legacy-tool-3"]);
  });

  it("merges identical progress text and its later tool batches into one timeline segment", () => {
    const progress = (id: string, toolCallId: string, createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "我继续核对相关资料。",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: [toolCallId] }),
      createdAt
    });

    const visible = filterTranscriptMessages([
      progress("progress-1", "tool-1", "2026-07-15T00:00:01.000Z"),
      progress("progress-2", "tool-2", "2026-07-15T00:00:03.000Z")
    ], "running");

    expect(visible.map((message) => message.id)).toEqual(["progress-1"]);

    const entries = buildTimelineEntries(visible, [
      makeToolCall({ id: "tool-1", toolName: "browser.navigate", startedAt: "2026-07-15T00:00:02.000Z" }),
      makeToolCall({ id: "tool-2", toolName: "browser.navigate", startedAt: "2026-07-15T00:00:04.000Z" })
    ], []);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "tool-group"]);
    expect(entries[1]).toMatchObject({
      kind: "tool-group",
      toolCalls: [{ id: "tool-1" }, { id: "tool-2" }]
    });
  });

  it("keeps a context compaction notice in chronological transcript order", () => {
    const message = (id: string, createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: id,
      metadataJson: null,
      createdAt
    });
    const entries = buildTimelineEntries(
      [
        message("before", "2026-07-15T00:00:00.000Z"),
        message("after", "2026-07-15T00:00:02.000Z")
      ],
      [],
      [],
      undefined,
      undefined,
      [],
      {
        turnRunId: "turn-1",
        contextWindow: 128_000,
        threshold: 100_000,
        target: 80_000,
        beforeTokens: 110_000,
        afterTokens: 40_000,
        messagesBefore: 30,
        messagesAfter: 12,
        createdAt: "2026-07-15T00:00:01.000Z"
      }
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "message",
      "context-compaction",
      "message"
    ]);
  });

  it("groups calls by turn and keeps legacy calls separate", () => {
    const entries = buildTimelineEntries(
      [],
      [
        makeToolCall({ id: "turn-1-read", turnRunId: "turn-1" }),
        makeToolCall({ id: "turn-1-search", turnRunId: "turn-1", toolName: "code.search" }),
        makeToolCall({ id: "turn-2-read", turnRunId: "turn-2", startedAt: "2026-07-15T00:01:00.000Z" }),
        makeToolCall({ id: "legacy", turnRunId: "", startedAt: "2026-07-15T00:02:00.000Z" })
      ],
      []
    );
    const toolGroups = entries.filter((entry) => entry.kind === "tool-group");

    expect(toolGroups).toHaveLength(3);
    expect(toolGroups.find((entry) => entry.id === "tool-group-turn-1")?.toolCalls).toHaveLength(2);
    expect(toolGroups.find((entry) => entry.id === "tool-group-legacy-legacy")?.toolCalls).toHaveLength(1);
  });

  it("merges hidden tool-only decisions within the same visible-message interval", () => {
    const firstAnchor: MessageRecord = {
      id: "batch-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "",
      metadataJson: JSON.stringify({ displayKind: "tool_batch", toolCallIds: ["tool-1", "tool-2"] }),
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const secondAnchor: MessageRecord = {
      ...firstAnchor,
      id: "batch-2",
      metadataJson: JSON.stringify({ displayKind: "tool_batch", toolCallIds: ["tool-3"] }),
      createdAt: "2026-07-15T00:00:03.000Z"
    };

    const entries = buildTimelineEntries(
      [firstAnchor, secondAnchor],
      [
        makeToolCall({ id: "tool-1", startedAt: "2026-07-15T00:00:01.000Z" }),
        makeToolCall({ id: "tool-2", startedAt: "2026-07-15T00:00:02.000Z" }),
        makeToolCall({ id: "tool-3", startedAt: "2026-07-15T00:00:04.000Z" })
      ],
      []
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["tool-group"]);
    expect(entries.map((entry) => entry.kind === "tool-group" ? entry.toolCalls.map((call) => call.id) : [])).toEqual([
      ["tool-1", "tool-2", "tool-3"]
    ]);
  });

  it("shows every completed and running tool call between two visible messages in one group", () => {
    const progress: MessageRecord = {
      id: "progress-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "I am checking the current page.",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-1"] }),
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const hiddenBatch: MessageRecord = {
      ...progress,
      id: "hidden-batch",
      content: "",
      metadataJson: JSON.stringify({ displayKind: "tool_batch", toolCallIds: ["tool-2"] }),
      createdAt: "2026-07-15T00:00:02.000Z"
    };
    const entries = buildTimelineEntries(
      [progress, hiddenBatch],
      [
        makeToolCall({ id: "tool-1", status: "completed", startedAt: "2026-07-15T00:00:01.000Z", completedAt: "2026-07-15T00:00:01.500Z" }),
        makeToolCall({ id: "tool-2", status: "completed", startedAt: "2026-07-15T00:00:03.000Z", completedAt: "2026-07-15T00:00:03.500Z" }),
        makeToolCall({ id: "tool-3", status: "running", startedAt: "2026-07-15T00:00:04.000Z", completedAt: null })
      ],
      [],
      undefined,
      "running"
    );

    const group = entries.find((entry) => entry.kind === "tool-group");
    expect(group?.kind).toBe("tool-group");
    expect(group?.kind === "tool-group" ? group.toolCalls.map((call) => [call.id, call.status]) : []).toEqual([
      ["tool-1", "completed"],
      ["tool-2", "completed"],
      ["tool-3", "running"]
    ]);
  });

  it("keeps file changes as a separate outcome summary", () => {
    const entries = buildTimelineEntries(
      [],
      [makeToolCall({
        toolName: "apply_patch",
        argumentsJson: JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch" })
      })],
      []
    );

    expect(entries.some((entry) => entry.kind === "tool-group")).toBe(true);
    expect(entries.some((entry) => entry.kind === "file-summary")).toBe(true);
  });
});

describe("optimistic user message reconciliation", () => {
  it("creates an immediately renderable empty snapshot for a new thread", () => {
    const thread: ThreadRecord = {
      id: "thread-new",
      title: "New task",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      projectId: null,
      workspaceId: null,
      modelId: "model-1",
      providerId: "provider-1",
      status: "idle",
      selectedSkillIds: [],
      selectedPluginIds: [],
      knowledgeBaseIds: [],
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
      isPinned: false,
      pinnedAt: null,
      gpaStateJson: null,
      parentThreadId: null,
      rootThreadId: "thread-new",
      agentPath: "/root",
      agentRole: null,
      lastTaskMessage: null,
      multiAgentMode: "disabled"
    };

    expect(createOptimisticThreadSnapshot(thread)).toMatchObject({
      snapshotMode: "full",
      thread,
      messages: [],
      messageCount: 0,
      queuedMessages: [],
      toolCalls: [],
      subagents: [],
      queuedSubagentIds: []
    });
  });

  it("replaces an optimistic message with the persisted display message", () => {
    const optimistic: MessageRecord = {
      id: "optimistic-1",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: "Check the WebP submission controls",
      metadataJson: null,
      createdAt: "2026-07-15T01:00:00.000Z"
    };
    const persisted: MessageRecord = {
      ...optimistic,
      id: "persisted-1",
      content: "Check the WebP submission controls\n\n[attached skill context]",
      metadataJson: JSON.stringify({ displayContent: optimistic.content }),
      createdAt: "2026-07-15T01:00:02.000Z"
    };

    expect(reconcilePendingUserMessages([optimistic], [persisted])).toEqual([]);
  });

  it("matches persisted messages one-to-one when identical requests are sent", () => {
    const first: MessageRecord = {
      id: "optimistic-1",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: "Continue",
      metadataJson: null,
      createdAt: "2026-07-15T01:00:00.000Z"
    };
    const second: MessageRecord = { ...first, id: "optimistic-2", createdAt: "2026-07-15T01:00:01.000Z" };
    const persisted: MessageRecord = { ...first, id: "persisted-1", createdAt: "2026-07-15T01:00:02.000Z" };

    expect(reconcilePendingUserMessages([first, second], [persisted])).toEqual([second]);
  });
});

describe("subagent waiting status", () => {
  it("recognizes both canonical and compatibility wait tool names", () => {
    expect(isSubagentWaitTool("wait_agent")).toBe(true);
    expect(isSubagentWaitTool("multi_agents.wait")).toBe(true);
    expect(isSubagentWaitTool("spawn_agent")).toBe(false);
  });

  it("reports only active and queued subagents in the root waiting label", () => {
    const agents = [
      { id: "running", status: "running" as const },
      { id: "queued", status: "idle" as const },
      { id: "done", status: "completed" as const }
    ];

    expect(getSubagentWaitLabel(agents, new Set(["queued"]))).toBe("正在等待 2 个子智能体 · 1 运行 · 1 排队");
    expect(getSubagentWaitLabel([{ id: "input", status: "waiting" }], new Set())).toBe("正在等待 1 个子智能体 · 1 等待处理");
    expect(getSubagentWaitLabel([{ id: "done", status: "completed" }], new Set())).toBeNull();
  });

  it("keeps only live subagents in the execution disclosure", () => {
    const agents = [
      { id: "running", status: "running" as const },
      { id: "waiting", status: "waiting" as const },
      { id: "queued", status: "idle" as const },
      { id: "done", status: "completed" as const },
      { id: "failed", status: "failed" as const }
    ];

    expect(getActiveSubagents(agents, new Set(["queued"])).map((agent) => agent.id)).toEqual([
      "running",
      "waiting",
      "queued"
    ]);
  });
});

describe("assistant draft lifecycle", () => {
  const persistedFailure: MessageRecord = {
    id: "failure-message",
    threadId: "thread-1",
    turnRunId: "failed-turn",
    role: "assistant",
    content: "The task failed.",
    metadataJson: null,
    createdAt: "2026-07-27T07:25:27.191Z"
  };

  it("removes an uncommitted draft when its thread reaches a terminal state", () => {
    expect(shouldKeepAssistantDraft(
      { completed: false },
      [persistedFailure],
      "failed"
    )).toBe(false);
  });

  it("keeps only an unfinished draft while its thread is still executing", () => {
    expect(shouldKeepAssistantDraft(
      { completed: false },
      [],
      "running"
    )).toBe(true);
    expect(shouldKeepAssistantDraft(
      { completed: true, messageId: persistedFailure.id },
      [persistedFailure],
      "running"
    )).toBe(false);
  });

  it("shows an unfinished draft even when the same turn already has progress messages", () => {
    const commentary: MessageRecord = {
      ...persistedFailure,
      id: "progress-message",
      turnRunId: "active-turn",
      content: "我先核对资料。",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-1"] })
    };
    const draft = {
      draftId: "draft-1",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "这是正在逐字生成的结论",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false,
    };

    expect(selectActiveAssistantDraft([draft], "thread-1", "running", [commentary])).toEqual(draft);
  });

  it("shows an empty draft immediately so a buffered provider still has a heartbeat", () => {
    const draft = {
      draftId: "draft-empty",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false
    };

    expect(selectActiveAssistantDraft([draft], "thread-1", "running", [])).toEqual(draft);
  });

  it("ignores late updates from an older model request in the same turn", () => {
    const newer = {
      draftId: "draft-2",
      sequence: 2,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "新的候选",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:29.000Z",
      completed: false
    };
    const older = { ...newer, draftId: "draft-1", sequence: 1, content: "迟到的旧候选" };

    expect(reconcileAssistantDraftUpdate({ [newer.draftId]: newer }, older)).toEqual({ [newer.draftId]: newer });
  });

  it("replaces an older same-thread draft when the next model request starts", () => {
    const older = {
      draftId: "draft-1",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "上一轮无效候选",
      phase: "retrying" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false
    };
    const newer = {
      ...older,
      draftId: "draft-2",
      sequence: 2,
      content: "",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:29.000Z"
    };

    expect(reconcileAssistantDraftUpdate({ [older.draftId]: older }, newer)).toEqual({
      [newer.draftId]: newer
    });
  });

  it("removes a streamed draft as soon as runtime marks it discarded", () => {
    const draft = {
      draftId: "draft-1",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "不会成为最终回复的候选内容",
      phase: "auditing" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false,
    };

    expect(reconcileAssistantDraftCompletion({ "draft-1": draft }, {
      turnRunId: "active-turn",
      draftId: "draft-1",
      discarded: true,
      suppressed: false
    })).toEqual({});
  });

  it("keeps a committed draft until its exact persisted message arrives", () => {
    expect(shouldKeepAssistantDraft(
      { completed: true, messageId: "final-message" },
      [],
      "completed"
    )).toBe(true);
    expect(shouldKeepAssistantDraft(
      { completed: true, messageId: "final-message" },
      [{ ...persistedFailure, id: "final-message" }],
      "completed"
    )).toBe(false);
  });

  it("marks the exact draft committed and retains its content until persistence catches up", () => {
    const draft = {
      draftId: "draft-final",
      sequence: 3,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "完整的最终答复",
      phase: "auditing" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false
    };

    const reconciled = reconcileAssistantDraftCompletion({ [draft.draftId]: draft }, {
      turnRunId: draft.turnRunId,
      draftId: draft.draftId,
      messageId: "message-final",
      discarded: false,
      suppressed: false
    });

    expect(reconciled[draft.draftId]).toMatchObject({
      content: draft.content,
      completed: true,
      messageId: "message-final"
    });
  });

  it("renders only active user-visible streaming text", () => {
    expect(getAssistantDraftDisplayContent({ content: "第一段回复\n\n第二段正在生成" }))
      .toBe("第一段回复\n\n第二段正在生成");
    expect(getAssistantDraftDisplayContent({ content: "audit candidate" })).toBe("audit candidate");
    expect(getAssistantDraftDisplayContent({ content: '{"assistant_message":"内部协议",' })).toBe("");
    expect(getAssistantDraftDisplayContent({
      content: "正文\n<tool_calls>[{\"name\":\"fs.read_file\"}]</tool_calls>"
    })).toBe("正文\n");
  });

});

describe("incremental snapshot merging", () => {
  it("appends new records, applies updates, and keeps chronological order", () => {
    const existing = [
      { id: "tool-1", createdAt: "2026-07-15T01:00:00.000Z", status: "running" },
      { id: "tool-2", createdAt: "2026-07-15T01:02:00.000Z", status: "completed" }
    ];
    const changes = [
      { id: "tool-1", createdAt: "2026-07-15T01:00:00.000Z", status: "completed" },
      { id: "tool-3", createdAt: "2026-07-15T01:01:00.000Z", status: "completed" }
    ];

    expect(mergeSnapshotRecords(existing, changes, (item) => item.createdAt)).toEqual([
      { id: "tool-1", createdAt: "2026-07-15T01:00:00.000Z", status: "completed" },
      { id: "tool-3", createdAt: "2026-07-15T01:01:00.000Z", status: "completed" },
      { id: "tool-2", createdAt: "2026-07-15T01:02:00.000Z", status: "completed" }
    ]);
  });

  it("keeps artifact ordering newest first", () => {
    const existing = [{ id: "artifact-1", createdAt: "2026-07-15T01:00:00.000Z" }];
    const changes = [{ id: "artifact-2", createdAt: "2026-07-15T01:02:00.000Z" }];

    expect(mergeSnapshotRecords(existing, changes, (item) => item.createdAt, "descending"))
      .toEqual([{ id: "artifact-2", createdAt: "2026-07-15T01:02:00.000Z" }, existing[0]]);
  });
});

describe("thread deletion feedback", () => {
  it("explains how to release a Windows-locked task output directory", () => {
    const message = getThreadDeleteFailureMessage(
      new Error("EBUSY: resource busy or locked, rmdir 'C:\\Users\\name\\.codexh\\outputs\\thread-1'")
    );

    expect(message).toContain("终端或预览");
    expect(message).toContain("完全退出并重新打开 CodeXH");
    expect(message).not.toContain("EBUSY");
  });
});
