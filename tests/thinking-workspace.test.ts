import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { rememberThinkingText, selectThinkingText } from "../apps/desktop/src/renderer/workspace/thinking-state";
import { ThinkingWorkspace } from "../apps/desktop/src/renderer/workspace/thinking-workspace";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const rightWorkspaceSource = readSource("../apps/desktop/src/renderer/workspace/right-workspace.tsx");
const appSource = readSource("../apps/desktop/src/renderer/App.tsx");
const iconsSource = readSource("../apps/desktop/src/renderer/icons.tsx");
const styles = readSource("../apps/desktop/src/renderer/styles.css");

describe("deep thinking workspace tab", () => {
  it("remembers the latest reasoning per thread and ignores empty frames", () => {
    const first = rememberThinkingText(null, "thread-1", "先看目录结构");
    expect(selectThinkingText(first, "thread-1")).toBe("先看目录结构");
    expect(selectThinkingText(first, "thread-2")).toBe("");

    const held = rememberThinkingText(first, "thread-1", "");
    expect(held).toBe(first);
    expect(selectThinkingText(held, "thread-1")).toBe("先看目录结构");

    const grown = rememberThinkingText(held, "thread-1", "先看目录结构，再确认测试入口");
    expect(selectThinkingText(grown, "thread-1")).toBe("先看目录结构，再确认测试入口");

    const other = rememberThinkingText(grown, "thread-2", "整理发布清单");
    expect(selectThinkingText(other, "thread-1")).toBe("");
    expect(selectThinkingText(other, "thread-2")).toBe("整理发布清单");
  });

  it("renders an empty state until the model produces reasoning", () => {
    const idle = renderToStaticMarkup(createElement(ThinkingWorkspace, {
      text: "",
      taskRunning: false,
      streaming: false
    }));
    expect(idle).toContain("right-workspace-empty-state");
    expect(idle).toContain("深度思考");

    const starting = renderToStaticMarkup(createElement(ThinkingWorkspace, {
      text: "   ",
      taskRunning: true,
      streaming: false
    }));
    expect(starting).toContain("right-workspace-empty-state");
    expect(starting).toContain("正在思考");
  });

  it("renders the streamed reasoning inside the panel", () => {
    const live = renderToStaticMarkup(createElement(ThinkingWorkspace, {
      text: "先定位滚动淡出的实现",
      taskRunning: true,
      streaming: true
    }));
    expect(live).toContain("thinking-workspace-body");
    expect(live).toContain("先定位滚动淡出的实现");
    expect(live).toContain("思考中");

    const settled = renderToStaticMarkup(createElement(ThinkingWorkspace, {
      text: "先定位滚动淡出的实现",
      taskRunning: false,
      streaming: false
    }));
    expect(settled).toContain("已完成");
    expect(settled).not.toContain("思考中");
  });

  it("puts the thinking tab ahead of the browser tab", () => {
    expect(iconsSource).toContain("export function IconBrain()");
    expect(rightWorkspaceSource).toContain('"thinking" | "terminal" | "browser"');
    expect(rightWorkspaceSource).toContain("IconBrain");
    expect(rightWorkspaceSource).toContain('id="right-workspace-content-thinking"');
    expect(rightWorkspaceSource).toContain("live={thinkingStreaming}");
    expect(rightWorkspaceSource.indexOf('id="thinking"')).toBeGreaterThan(-1);
    expect(rightWorkspaceSource.indexOf('id="thinking"')).toBeLessThan(rightWorkspaceSource.indexOf('id="browser"'));
  });

  it("stops streaming reasoning inside the chat transcript", () => {
    // The transcript mounts no reasoning block at all any more.
    expect(appSource).not.toContain("<AssistantDraftReasoning");
    expect(appSource).toContain("rememberThinkingText");
    expect(appSource).toContain("thinkingStreaming={thinkingStreaming}");
  });

  it("styles the thinking panel and its live tab dot", () => {
    expect(styles).toContain(".thinking-workspace-body {");
    expect(styles).toContain(".thinking-workspace-status.is-active");
    expect(styles).toContain(".right-workspace-tab-live-dot {");
    expect(styles).toContain("@keyframes thinking-tab-pulse {");
  });
});
