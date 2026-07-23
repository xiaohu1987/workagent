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
  getThreadDeleteFailureMessage,
  getToolProcessingLabel,
  getToolActivityPresentation,
  getToolActivitySummary,
  getSidebarUpdateReminder,
  shouldShowRuntimeActivityPanel,
  isFileWriteTool,
  isInternalAgentProtocolMessage,
  isPatchAssistantMessage,
  reconcilePendingUserMessages
} from "../apps/desktop/src/renderer/App";
import type { MessageRecord, ToolCallRecord } from "../packages/shared-types/src";

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

  it("switches the composer primary action to interrupt while a thread is executing", () => {
    expect(getComposerPrimaryActionState("running", "")).toEqual({
      kind: "interrupt",
      title: "停止执行",
      ariaLabel: "停止执行",
      disabled: false
    });

    expect(getComposerPrimaryActionState("waiting", "继续")).toEqual({
      kind: "interrupt",
      title: "停止执行",
      ariaLabel: "停止执行",
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
  it("interleaves persisted commentary before its tool group and final answer", () => {
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
