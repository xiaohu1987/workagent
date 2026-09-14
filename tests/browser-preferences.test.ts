import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shouldRevealBrowserWorkspace, selectMountedBrowserThreadIds } from "../apps/desktop/src/renderer/workspace/browser-preferences";
import { BrowserWorkspace, getBrowserTabLabel } from "../apps/desktop/src/renderer/workspace/browser-workspace";

function createTab(overrides: Partial<{
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}> = {}) {
  return {
    id: "tab-1",
    threadId: "thread-1",
    title: "哔哩哔哩",
    url: "https://www.bilibili.com/",
    isActive: true,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides
  };
}

describe("browser workspace preferences", () => {
  it("reveals the selected thread browser workspace only for non-silent openings", () => {
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-1",
      payload: { action: "open", silentBrowserOpen: false }
    }, "thread-1")).toBe(true);
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-1",
      payload: { action: "open", silentBrowserOpen: true }
    }, "thread-1")).toBe(false);
  });

  it("does not reveal the browser workspace for background threads or non-opening updates", () => {
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-2",
      payload: { action: "open", silentBrowserOpen: false }
    }, "thread-1")).toBe(false);
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-1",
      payload: { action: "navigate", silentBrowserOpen: false }
    }, "thread-1")).toBe(false);
  });

  it("mounts only the visible selected thread and a small number of running browser sessions", () => {
    const tabsByThread = {
      "thread-selected": [{ id: "tab-1" }],
      "thread-running": [{ id: "tab-2" }],
      "thread-idle": [{ id: "tab-3" }],
      "thread-waiting": [{ id: "tab-4" }]
    };

    expect(selectMountedBrowserThreadIds({
      selectedThreadId: "thread-selected",
      browserPanelVisible: true,
      threads: [
        { id: "thread-selected", status: "idle" },
        { id: "thread-running", status: "running" },
        { id: "thread-idle", status: "idle" },
        { id: "thread-waiting", status: "waiting" }
      ],
      tabsByThread
    })).toEqual(["thread-selected", "thread-running"]);

    expect(selectMountedBrowserThreadIds({
      selectedThreadId: "thread-selected",
      browserPanelVisible: false,
      threads: [
        { id: "thread-selected", status: "idle" },
        { id: "thread-running", status: "running" }
      ],
      tabsByThread: {
        "thread-selected": [{ id: "tab-1" }],
        "thread-running": [{ id: "tab-2" }]
      }
    })).toEqual(["thread-running"]);

    expect(selectMountedBrowserThreadIds({
      selectedThreadId: "thread-selected",
      browserPanelVisible: true,
      threads: [
        { id: "thread-selected", status: "idle" },
        { id: "thread-parent", status: "running" }
      ],
      tabsByThread: {
        "thread-idle-old": [{ id: "old" }],
        "thread-selected": [{ id: "tab-1" }],
        "thread-child": [{ id: "tab-child" }]
      }
    })).toEqual(["thread-selected", "thread-child"]);
  });
});

describe("browser tab switcher", () => {
  it("falls back to the page URL when a tab has no title", () => {
    expect(getBrowserTabLabel({ title: "  星将ST10大力神  ", url: "https://example.com" })).toBe("星将ST10大力神");
    expect(getBrowserTabLabel({ title: "   ", url: "https://www.bilibili.com/" })).toBe("https://www.bilibili.com/");
  });

  it("renders a dropdown trigger for the current page instead of a horizontal tab strip", () => {
    const markup = renderToStaticMarkup(createElement(BrowserWorkspace, {
      threadId: "thread-1",
      visible: true,
      onCloseTab: () => undefined,
      tabs: [
        createTab(),
        createTab({
          id: "tab-2",
          title: "88元25cm一体变形大力神",
          url: "https://www.bilibili.com/video/BV1enomd2jfo/",
          isActive: false
        })
      ]
    }));

    expect(markup).toContain("browser-tab-switcher");
    expect(markup).toContain("browser-tab-switcher-field");
    expect(markup).not.toContain("browser-tab-switcher-backdrop");
    expect(markup).toContain("选择网页");
    expect(markup).toContain("2 个网页");
    expect(markup).toContain("哔哩哔哩");
    expect(markup).toContain("关闭 哔哩哔哩");
    expect(markup).not.toContain("is-picking");
    expect(markup).not.toContain("workspace-subtab-strip");
  });

  it("keeps only the active webview mounted when the browser workspace is hidden", () => {
    const markup = renderToStaticMarkup(createElement(BrowserWorkspace, {
      threadId: "thread-1",
      visible: false,
      onCloseTab: () => undefined,
      tabs: [
        createTab(),
        createTab({
          id: "tab-2",
          title: "后台页",
          url: "https://example.com/hidden",
          isActive: false
        })
      ]
    }));

    expect(markup.match(/browser-frame/g)?.length ?? 0).toBe(1);
    expect(markup).toContain("https://www.bilibili.com/");
    expect(markup).not.toContain("https://example.com/hidden");
  });
});
