import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readText = (url: URL): string => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

const app = readText(new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url));
const sidebar = readText(
  new URL("../apps/desktop/src/renderer/history/history-sidebar.tsx", import.meta.url)
);
const panel = readText(
  new URL("../apps/desktop/src/renderer/workspace/api-favorites-inline-panel.tsx", import.meta.url)
);
const favoritesPanel = readText(
  new URL("../apps/desktop/src/renderer/workspace/api-card-favorites.tsx", import.meta.url)
);
const navigation = readText(
  new URL("../apps/desktop/src/renderer/settings/settings-navigation.ts", import.meta.url)
);
const styles = readText(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url));
const icons = readText(new URL("../apps/desktop/src/renderer/icons.tsx", import.meta.url));
const rail = readText(
  new URL("../apps/desktop/src/renderer/history/sidebar-nav-items.ts", import.meta.url)
);
const railMore = readText(
  new URL("../apps/desktop/src/renderer/history/sidebar-nav-more.tsx", import.meta.url)
);

/** 取出一段实现代码，避免断言命中同名的其它位置。 */
function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `未找到实现起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `未找到实现终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("接口卡片：侧栏入口 + 聊天区内联面板", () => {
  it("侧栏入口排在「随手记」下面，并带选中态", () => {
    const nav = section(sidebar, '<div className="sidebar-nav">', '<div className="history-list"');
    // 入口顺序由目录定义：随手记在前，接口卡片紧随其后。
    const quickNotesLabel = rail.indexOf('quickNotes: "随手记"');
    const apiFavoritesLabel = rail.indexOf('apiFavorites: "接口卡片"');
    expect(quickNotesLabel).toBeGreaterThanOrEqual(0);
    expect(apiFavoritesLabel).toBeGreaterThan(quickNotesLabel);

    expect(nav).toContain("{railItems.visible.map(renderRailItem)}");
    expect(nav).toContain("<SidebarNavMore items={railItems.hidden}");
    expect(sidebar).toContain("apiFavorites: onOpenApiFavorites,");
    expect(sidebar).toContain('railItemActiveStates[id] ? "is-active" : ""');
  });

  it("侧栏入口用卡片图标，不再借用地球图标", () => {
    const nav = section(sidebar, '<div className="sidebar-nav">', '<div className="history-list"');
    expect(railMore).toContain("apiFavorites: <IconApiCard />");
    expect(nav).not.toContain("<IconGlobe />");
    expect(railMore).not.toContain("<IconGlobe />");
    expect(railMore).toContain("IconApiCard,");

    const iconStart = icons.indexOf("export function IconApiCard() {");
    expect(iconStart).toBeGreaterThanOrEqual(0);
    const iconBody = icons.slice(iconStart, iconStart + 240);
    expect(iconBody).toContain("<SvgIcon>");
    expect(iconBody).toContain("<rect");
    expect(iconBody).toContain('rx="3"');
  });

  it("面板渲染在聊天画布内，排在聊天记录与输入区之前", () => {
    const canvasStart = app.indexOf("<section className={`chat-canvas");
    expect(canvasStart).toBeGreaterThanOrEqual(0);
    expect(app.slice(canvasStart, canvasStart + 320)).toContain(
      '${isApiFavoritesOpen ? "is-api-favorites" : ""}'
    );

    const panelIndex = app.indexOf("<ApiFavoritesInlinePanel", canvasStart);
    const scrollIndex = app.indexOf("chatScrollRef", canvasStart);
    expect(panelIndex).toBeGreaterThan(canvasStart);
    expect(scrollIndex).toBeGreaterThan(panelIndex);
    const panelEnd = app.indexOf("/>", panelIndex);
    expect(app.slice(panelIndex, panelEnd)).toContain(
      "onClose={() => setIsApiFavoritesOpen(false)}"
    );
  });

  it("不再挂在设置页，也不保留设置页专用组件", () => {
    expect(navigation).not.toContain("apiFavorites");
    expect(app).not.toContain("ApiFavoritesPage");
    expect(app).not.toContain("settings/pages/knowledge/api-favorites-page");
    expect(app).toContain(
      'import { ApiFavoritesInlinePanel } from "./workspace/api-favorites-inline-panel";'
    );
  });

  it("打开接口卡片先收起随手记、退出分享并收起终端抽屉，再次点击可收起", () => {
    const openEvent = section(
      app,
      "const openApiFavoritesEvent = useStableEvent(",
      "const openHistorySearchEvent"
    );
    expect(openEvent).toContain("if (isApiFavoritesOpen) {");
    expect(openEvent).toContain("setIsQuickNotesOpen(false);");
    expect(openEvent).toContain("if (isSharing) exitShareMode();");
    expect(openEvent).toContain("if (isTerminalOpen) setIsTerminalOpen(false);");
    expect(openEvent).toContain("setIsApiFavoritesOpen(true);");
  });

  it("打开随手记会收起接口卡片", () => {
    const quickNotesEvent = section(
      app,
      "const openQuickNotesEvent = useStableEvent(",
      "const openApiFavoritesEvent"
    );
    expect(quickNotesEvent).toContain("setIsApiFavoritesOpen(false);");
  });

  it("点左侧会话或新建任务都能切回聊天", () => {
    const openThreadFn = section(
      app,
      "async function openThread(threadId: string",
      "const isSwitchingThread"
    );
    expect(openThreadFn).toContain("setIsApiFavoritesOpen(false);");

    const activateFn = section(
      app,
      "function activateNewThread(thread: ThreadRecord) {",
      "selectThreadId(thread.id)"
    );
    expect(activateFn).toContain("setIsApiFavoritesOpen(false);");

    const newTaskFn = section(
      app,
      "function openNewTaskComposer(preset?: { workspaceCwd?: string | null }) {",
      "if (selectedThreadId) selectThreadId(null);"
    );
    expect(newTaskFn).toContain("setIsApiFavoritesOpen(false);");
  });

  it("面板是聊天区内的区块，不是覆盖界面的弹窗", () => {
    expect(panel).toContain('className="quick-notes-sheet quick-notes-inline api-favorites-inline"');
    expect(panel).not.toContain("motion-overlay");
    expect(panel).not.toContain("api-favorites-inline-body");
    expect(panel).toContain("<ApiCardFavoritesPanel");
  });

  it("样式把面板铺满聊天区，并让聊天记录与输入区让位", () => {
    expect(styles).toContain(".chat-canvas.is-api-favorites > .chat-scroll");
    expect(styles).toContain(".chat-canvas.is-api-favorites > footer");
    const inlineRule = section(styles, ".api-favorites-sheet.api-favorites-inline {", "\n}");
    expect(inlineRule).toContain("display: flex");
    expect(inlineRule).toContain("height: 100%");
    expect(inlineRule).toContain("padding: 0");
  });

  it("新任务页的页脚被排在后面的规则隐藏，面板才能真正铺满", () => {
    // .chat-canvas.is-new-task footer 把 footer 设成 flex，且与隐藏规则特异性相同；
    // 隐藏规则必须排在它之后，否则面板下方会漏出欢迎页与输入框。
    const newTaskFooterRule = styles.indexOf(".chat-canvas.is-new-task footer {");
    expect(newTaskFooterRule).toBeGreaterThanOrEqual(0);
    const guard = styles.slice(newTaskFooterRule);
    expect(guard).toContain(".chat-canvas.is-api-favorites > footer");
    expect(guard).toContain(".chat-canvas.is-quick-notes > footer");
    expect(guard).toContain(".chat-canvas.is-document-viewer > footer");
    expect(guard).toContain("display: none !important;");
  });

  it("面板改成左侧列表 + 右侧详情两栏，并整体复用随手记的骨架", () => {
    // 容器与标题栏直接用随手记的类名，接口卡片只保留自己的作用域类。
    expect(panel).toContain('className="quick-notes-sheet quick-notes-inline api-favorites-inline"');
    expect(panel).toContain('className="project-sheet-header"');
    expect(panel).toContain('className="quick-notes-header-title"');
    expect(panel).toContain("<IconApiCard />");

    // 左右两栏、条目、信息栏与底部操作区同样沿用随手记的类名，不再自建骨架。
    for (const className of [
      'className="quick-notes-layout"',
      'className="quick-notes-list"',
      'className="quick-notes-list-header"',
      'className="quick-notes-items"',
      'className={`quick-notes-item ',
      'className="quick-notes-item-meta"',
      'className="quick-notes-editor"',
      'className="quick-notes-markdown-bar"',
      'className="quick-notes-footer"',
      'className="quick-notes-footer-actions"',
      'className="quick-notes-empty"'
    ]) {
      expect(favoritesPanel).toContain(className);
    }
    expect(favoritesPanel).not.toContain('className="api-favorites-layout"');
    expect(favoritesPanel).not.toContain('className="api-favorites-sidebar"');
    expect(favoritesPanel).not.toContain('className="api-favorites-detail"');
    expect(favoritesPanel).not.toContain("api-favorites-inline-body");

    const sidebarSection = section(favoritesPanel, '<aside className="quick-notes-list">', "</aside>");
    expect(sidebarSection).toContain('className="api-favorites-search-wrap"');
    expect(sidebarSection).toContain("<IconSearch />");
    expect(sidebarSection).toContain("data-method={favorite.config.method.toLowerCase()}");
    expect(sidebarSection).toContain('selectedId === favorite.id ? "selected" : ""');
    expect(sidebarSection).toContain('className="api-favorites-method"');
    expect(sidebarSection).toContain('className="api-favorites-hint"');

    // 右栏：方法/URL 信息栏 + 名称与徽标 + 完整卡片 + 底部按钮区。
    expect(favoritesPanel).toContain('className="api-favorites-detail-title"');
    expect(favoritesPanel).toContain('className="api-favorites-detail-name"');
    expect(favoritesPanel).toContain('className="api-favorites-chip');
    expect(favoritesPanel).toContain('className="button primary"');
    expect(favoritesPanel).toContain('className="button secondary"');
    expect(favoritesPanel).toContain("<ApiCardMessage");
    expect(favoritesPanel).toContain('import { IconSearch } from "../icons";');

    // 接口卡片专属样式限定在 .api-favorites-inline 作用域内，不会波及随手记。
    for (const selector of [
      ":root .api-favorites-inline .api-favorites-method {",
      ':root .api-favorites-inline .quick-notes-item[data-method="get"] {',
      ':root .api-favorites-inline .quick-notes-item[data-method="delete"] {',
      ":root .api-favorites-inline .api-favorites-detail-name {",
      ":root .api-favorites-inline .api-favorites-detail-title {",
      ":root .api-favorites-inline .api-favorites-search-wrap {",
      ":root .api-favorites-inline .api-favorites-hint {",
      ":root .api-favorites-inline .quick-notes-footer-actions {"
    ]) {
      expect(styles).toContain(selector);
    }
  });
});
