import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shouldRevealBrowserWorkspace } from "../apps/desktop/src/renderer/workspace/browser-preferences";
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
});
