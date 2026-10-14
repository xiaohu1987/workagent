import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDEBAR_NAV_ITEM_IDS, normalizeHiddenSidebarItems } from "@shared-types";
import { splitSidebarNavItems } from "../apps/desktop/src/renderer/history/sidebar-nav-items";

const readText = (url: URL): string => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

const railMore = readText(
  new URL("../apps/desktop/src/renderer/history/sidebar-nav-more.tsx", import.meta.url)
);
const railMoreStyles = readText(
  new URL("../apps/desktop/src/renderer/history/sidebar-nav-more.css", import.meta.url)
);

/** 取出一条样式规则，避免断言命中同名选择器的其它位置。 */
function rule(source: string, selector: string): string {
  const from = source.indexOf(`${selector} {`);
  expect(from, `未找到样式规则：${selector}`).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf("}", from));
}

describe("sidebar nav item split", () => {
  it("keeps every entry inline when nothing is hidden", () => {
    expect(splitSidebarNavItems()).toEqual({ visible: [...SIDEBAR_NAV_ITEM_IDS], hidden: [] });
    expect(splitSidebarNavItems(null)).toEqual({ visible: [...SIDEBAR_NAV_ITEM_IDS], hidden: [] });
    expect(splitSidebarNavItems([])).toEqual({ visible: [...SIDEBAR_NAV_ITEM_IDS], hidden: [] });
  });

  it("moves hidden entries into the flyout in rail order", () => {
    const split = splitSidebarNavItems(["documentViewer", "quickNotes"]);
    expect(split.visible).toEqual(["apiFavorites", "downloads"]);
    expect(split.hidden).toEqual(["quickNotes", "documentViewer"]);
  });

  it("hides everything when the whole catalog is tucked away", () => {
    const split = splitSidebarNavItems([...SIDEBAR_NAV_ITEM_IDS]);
    expect(split.visible).toEqual([]);
    expect(split.hidden).toEqual([...SIDEBAR_NAV_ITEM_IDS]);
  });

  it("ignores ids the catalog does not know", () => {
    expect(splitSidebarNavItems(["bogus", "apiFavoritesCard"]).visible).toEqual([...SIDEBAR_NAV_ITEM_IDS]);
  });
});

describe("hidden sidebar items normalization", () => {
  it("treats missing or invalid values as show everything", () => {
    expect(normalizeHiddenSidebarItems(undefined)).toEqual([]);
    expect(normalizeHiddenSidebarItems("quickNotes")).toEqual([]);
    expect(normalizeHiddenSidebarItems({ quickNotes: true })).toEqual([]);
  });

  it("drops unknown and non-string entries and de-duplicates", () => {
    expect(normalizeHiddenSidebarItems(["unknown", 3, null, "apiFavorites"])).toEqual(["apiFavorites"]);
    expect(normalizeHiddenSidebarItems(["quickNotes", "quickNotes"])).toEqual(["quickNotes"]);
  });

  it("returns the catalog order regardless of the stored order", () => {
    expect(normalizeHiddenSidebarItems(["documentViewer", "quickNotes"])).toEqual(["quickNotes", "documentViewer"]);
  });
});

describe("「更多」入口的低调形态", () => {
  it("用一根手柄代替整行入口，只在悬停或展开时提亮", () => {
    expect(railMore).toContain('className="sidebar-nav-more-handle"');
    expect(railMore).not.toContain(">更多<");
    // 视觉上收起，但无障碍名称仍然保留。
    expect(railMore).toContain('aria-label="更多"');
    expect(railMore).toContain('title="更多"');

    expect(rule(railMoreStyles, ".sidebar-nav-more-handle")).toMatch(/opacity:\s*0?\.\d/);
    expect(railMoreStyles).toContain(".sidebar-nav-more-trigger:hover .sidebar-nav-more-handle");
    expect(rule(railMoreStyles, ".sidebar-nav-more-trigger")).not.toContain("44px");
  });

  it("隐藏入口正在使用时才补一个小圆点", () => {
    expect(railMore).toContain('sidebar-nav-more-trigger ${activeItemId ? "is-active" : ""}');
    expect(railMoreStyles).toContain(".sidebar-nav-more-trigger.is-active::after");
  });
});
