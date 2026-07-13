import { describe, expect, it } from "vitest";
import {
  canDeleteThread,
  getComposerPrimaryActionState,
  getDeleteThreadBlockedMessage,
  getHistoryItemAffordance,
  isThreadExecutionInProgress,
  shouldShowTaskProcessing
} from "../apps/desktop/src/renderer/thread-ui-state";
import {
  getToolProcessingLabel,
  isFileWriteTool,
  isPatchAssistantMessage
} from "../apps/desktop/src/renderer/App";

describe("thread UI state helpers", () => {
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
});
