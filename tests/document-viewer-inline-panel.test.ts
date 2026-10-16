import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readText = (url: URL): string => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

const app = readText(new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url));
const sidebar = readText(
  new URL("../apps/desktop/src/renderer/history/history-sidebar.tsx", import.meta.url)
);
const panel = readText(
  new URL("../apps/desktop/src/renderer/workspace/document-viewer-panel.tsx", import.meta.url)
);
const utils = readText(
  new URL("../apps/desktop/src/renderer/workspace/document-viewer-utils.ts", import.meta.url)
);
const styles = readText(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url));
const tabs = readText(
  new URL("../apps/desktop/src/renderer/hooks/use-document-tabs.ts", import.meta.url)
);
const main = readText(new URL("../apps/desktop/src/main/index.ts", import.meta.url));
const preload = readText(new URL("../apps/desktop/src/preload/index.ts", import.meta.url));
const env = readText(new URL("../apps/desktop/src/renderer/env.d.ts", import.meta.url));
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

describe("查看文档：侧栏入口 + 聊天区内联面板", () => {
  it("侧栏入口排在「接口卡片」下面，并带选中态", () => {
    const nav = section(sidebar, '<div className="sidebar-nav">', '<div className="history-list"');
    expect(nav).toContain("{railItems.visible.map(renderRailItem)}");
    expect(nav).toContain("<SidebarNavMore items={railItems.hidden}");

    // 入口顺序由目录定义：接口卡片在前，查看文档紧随其后。
    const apiFavoritesLabel = rail.indexOf('apiFavorites: "接口卡片"');
    const documentViewerLabel = rail.indexOf('documentViewer: "查看文档"');
    expect(apiFavoritesLabel).toBeGreaterThanOrEqual(0);
    expect(documentViewerLabel).toBeGreaterThan(apiFavoritesLabel);

    expect(sidebar).toContain("documentViewer: onOpenDocumentViewer");
    expect(sidebar).toContain('railItemActiveStates[id] ? "is-active" : ""');
    expect(railMore).toContain("documentViewer: <IconFile />");
  });

  it("侧栏声明了查看文档的 props", () => {
    expect(sidebar).toContain("onOpenDocumentViewer: () => void;");
    expect(sidebar).toContain("documentViewerActive?: boolean;");
  });

  it("入口显示已打开的文档数，数量为 0 时整块不渲染", () => {
    // 数量由 App 的页签控制器透传，侧栏只负责展示，不自己持有状态。
    expect(app).toContain("documentViewerOpenCount={documentTabs.tabs.length}");
    expect(sidebar).toContain("documentViewerOpenCount?: number;");
    expect(sidebar).toContain("documentViewerOpenCount = 0");
    expect(sidebar).toContain("const count = railItemCounts[id] ?? 0;");
    // 0 时不输出任何节点，所以不需要靠 CSS 隐藏。
    expect(sidebar).toContain('{count > 0 ? <span className="sidebar-nav-count"');
    expect(styles).toContain(".sidebar-nav-count {");
  });

  it("面板渲染在聊天画布内，排在聊天记录与输入区之前", () => {
    const canvasStart = app.indexOf("<section className={`chat-canvas");
    expect(canvasStart).toBeGreaterThanOrEqual(0);
    expect(app.slice(canvasStart, canvasStart + 400)).toContain(
      '${isDocumentViewerOpen ? "is-document-viewer" : ""}'
    );

    const panelIndex = app.indexOf("<DocumentViewerPanel", canvasStart);
    const scrollIndex = app.indexOf("chatScrollRef", canvasStart);
    expect(panelIndex).toBeGreaterThan(canvasStart);
    expect(scrollIndex).toBeGreaterThan(panelIndex);
    const panelEnd = app.indexOf("/>", panelIndex);
    expect(app.slice(panelIndex, panelEnd)).toContain("documents={documentTabs}");
    expect(app).toContain(
      'import { DocumentViewerPanel } from "./workspace/document-viewer-panel";'
    );
  });

  it("打开查看文档先收起随手记与接口卡片、退出分享并收起终端抽屉，再次点击可收起", () => {
    const openEvent = section(
      app,
      "const openDocumentViewerEvent = useStableEvent(",
      "const openHistorySearchEvent"
    );
    expect(openEvent).toContain("if (isDocumentViewerOpen) {");
    expect(openEvent).toContain("setIsQuickNotesOpen(false);");
    expect(openEvent).toContain("setIsApiFavoritesOpen(false);");
    expect(openEvent).toContain("if (isSharing) exitShareMode();");
    expect(openEvent).toContain("if (isTerminalOpen) setIsTerminalOpen(false);");
    expect(openEvent).toContain("setIsDocumentViewerOpen(true);");
  });

  it("打开随手记或接口卡片都会收起查看文档", () => {
    const quickNotesEvent = section(
      app,
      "const openQuickNotesEvent = useStableEvent(",
      "const openApiFavoritesEvent"
    );
    expect(quickNotesEvent).toContain("setIsDocumentViewerOpen(false);");

    const apiFavoritesEvent = section(
      app,
      "const openApiFavoritesEvent = useStableEvent(",
      "const openDocumentViewerEvent"
    );
    expect(apiFavoritesEvent).toContain("setIsDocumentViewerOpen(false);");
  });

  it("点左侧会话或新建任务都能切回聊天", () => {
    const openThreadFn = section(
      app,
      "async function openThread(threadId: string",
      "const isSwitchingThread"
    );
    expect(openThreadFn).toContain("setIsDocumentViewerOpen(false);");

    const activateFn = section(
      app,
      "function activateNewThread(thread: ThreadRecord) {",
      "selectThreadId(thread.id)"
    );
    expect(activateFn).toContain("setIsDocumentViewerOpen(false);");

    const newTaskFn = section(
      app,
      "function openNewTaskComposer(preset?: { workspaceCwd?: string | null }) {",
      "if (selectedThreadId) selectThreadId(null);"
    );
    expect(newTaskFn).toContain("setIsDocumentViewerOpen(false);");
  });

  it("切去看任务只让出聊天区，原来打开的文档不随面板卸载丢掉", () => {
    // 页签集合挂在 App 层：面板卸载后已经打开的文档仍在，再点入口就能接着看。
    expect(app).toContain('import { useDocumentTabs } from "./hooks/use-document-tabs";');
    expect(app).toContain(
      "const documentTabs = useDocumentTabs(() => setIsDocumentViewerOpen(false));"
    );
    expect(app).toContain("documents={documentTabs}");
    // 面板不再自己持有页签状态，切任务收起面板时不会带走已打开的文档。
    expect(panel).not.toContain("const documents = useDocumentTabs(");
    expect(panel).toContain("documents: DocumentTabsController;");

    const openThreadFn = section(
      app,
      "async function openThread(threadId: string",
      "const isSwitchingThread"
    );
    expect(openThreadFn).toContain("setIsDocumentViewerOpen(false);");
    expect(openThreadFn).not.toContain("documentTabs");
  });

  it("按 Esc 能收起查看文档，并纳入快捷键依赖", () => {
    expect(app).toContain(
      "if (isDocumentViewerOpen) {\n          requestDocumentViewerClose();\n          return;\n        }"
    );
    expect(app).toContain(
      "isApiFavoritesOpen, isDocumentViewerOpen, isClearErrorSolutionsConfirmOpen"
    );
    // 页签集合在 App 层，Esc 与侧栏再次点击直接调这一层的 requestClosePanel，先过未保存确认。
    expect(app).toContain(
      "const documentTabs = useDocumentTabs(() => setIsDocumentViewerOpen(false));"
    );
    expect(app).toContain("documentTabs.requestClosePanel();");
    expect(panel).not.toContain("onRegisterCloseRequest");
    const openEvent = section(
      app,
      "const openDocumentViewerEvent = useStableEvent(",
      "const openHistorySearchEvent"
    );
    expect(openEvent).toContain("requestDocumentViewerClose();");
  });

  it("面板是聊天区内的区块，不是覆盖界面的弹窗，且支持预览与源码互切", () => {
    expect(panel).toContain("document-viewer-sheet document-viewer-inline");
    expect(panel).not.toContain("motion-overlay");
    expect(panel).toContain('className="document-viewer-inline-body"');
    // 标题栏左侧只保留「+」入口，原来的标题文字与说明文案已去掉。
    expect(panel).toContain('className="document-viewer-open-button"');
    expect(panel).toContain("<IconPlus />");
    expect(panel).not.toContain("document-viewer-header-title");
    expect(panel).not.toContain("document-viewer-header-scope");
    expect(panel).not.toContain("按后缀名自动渲染与高亮");
    // 标题栏标出按后缀名识别出的文档类型。
    expect(panel).toContain("getDocumentViewKindLabel(activeTab.kind)");
    expect(panel).toContain('aria-label="展示方式"');
    expect(panel).toContain("onSelect(item)");
    expect(panel).toContain("renderMarkdownDocument(");
    expect(panel).toContain("<iframe");
    expect(panel).toContain("highlightFilePreview(tab.content, language.id)");
  });

  it("页签栏、源码编辑器与未保存标记都在面板里", () => {
    expect(panel).toContain('role="tablist"');
    expect(panel).toContain('className="document-tab-dirty"');
    expect(panel).toContain("isDocumentDirty(tab.content, tab.savedContent)");
    expect(panel).toContain('className="document-editor-gutter"');
    expect(panel).toContain('className="document-editor-highlight"');
    expect(panel).toContain('className={`document-editor-input ${highlightEnabled ? "" : "document-editor-input-plain"}`}');
    expect(panel).toContain("Ctrl+S");
    expect(panel).toContain("另存为（Ctrl+Shift+S）");
  });

  it("关闭未保存的页签或面板前先弹确认条，三种决策都落在同一处", () => {
    expect(panel).toContain('role="alertdialog"');
    expect(panel).toContain('onDecision("save")');
    expect(panel).toContain('onDecision("discard")');
    expect(panel).toContain("onCancel={documents.cancelPendingAction}");
    expect(panel).toContain("requestCloseTab");
    expect(panel).toContain("requestClosePanel");
  });

  it("页签集合在同一处管理：多选打开、按路径去重、脏标记与保存", () => {
    expect(tabs).toContain("window.codexh.chooseDocumentFiles({");
    expect(tabs).toContain("extensions: DOCUMENT_CHOOSE_EXTENSIONS");
    expect(tabs).toContain("current.find((tab) => tab.path === path)");
    expect(tabs).toContain("window.codexh.writeDocumentFile({");
    expect(tabs).toContain("window.codexh.saveDocumentFileAs({");
    expect(tabs).toContain("applyLineEnding(tab.content, tab.lineEnding)");
    expect(tabs).toContain('setPendingAction({ type: "closePanel" })');
    expect(tabs).toContain("if (tab.truncated) {");
  });

  it("读写文档的通道在主进程、预加载与渲染层三处对齐", () => {
    const channels = [
      "documents:choose-file",
      "documents:choose-files",
      "documents:read-file",
      "documents:write-file",
      "documents:save-as"
    ];
    for (const channel of channels) {
      expect(main).toContain(`ipcMain.handle("${channel}"`);
      expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
    }
    expect(env).toContain(
      "writeDocumentFile: (payload: { path: string; content: string }) => Promise<{ path: string }>;"
    );
    expect(env).toContain(
      "saveDocumentFileAs: (payload: { suggestedPath?: string; content: string }) => Promise<string | null>;"
    );
  });

  it("样式覆盖页签、编辑器与确认条，且三栏共用同一行高", () => {
    expect(styles).toContain(".document-tab-strip {");
    expect(styles).toContain(".document-tab-dirty {");
    expect(styles).toContain(".document-editor-gutter {");
    expect(styles).toContain(".document-editor-input {");
    expect(styles).toContain(".document-viewer-confirm {");
    expect(styles).toContain("--editor-line: 20px;");
    expect(styles).toContain("line-height: var(--editor-line);");
  });

  it("按后缀名区分渲染方式：Markdown/HTML 可预览，代码与文本只有源码", () => {
    expect(utils).toContain('const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdx"];');
    expect(utils).toContain('const HTML_EXTENSIONS = ["html", "htm"];');
    expect(utils).toContain('if (MARKDOWN_EXTENSIONS.includes(extension)) return "markdown";');
    expect(utils).toContain('if (HTML_EXTENSIONS.includes(extension)) return "html";');
    expect(utils).toContain('return kind === "markdown" || kind === "html" ? ["rendered", "source"] : ["source"];');
    expect(utils).toContain("getFilePreviewLanguage(path).id ? \"code\" : \"text\"");
    expect(utils).toContain("listFilePreviewExtensions()");
  });

  it("样式把面板铺满聊天区，并让聊天记录与输入区让位", () => {
    expect(styles).toContain(".chat-canvas.is-document-viewer > .chat-scroll");
    expect(styles).toContain(".chat-canvas.is-document-viewer > footer");
    const inlineRule = section(styles, ".document-viewer-sheet.document-viewer-inline {", "\n}");
    expect(inlineRule).toContain("display: flex");
    expect(inlineRule).toContain("height: 100%");
    expect(inlineRule).toContain("padding: 0");
  });

  it("空态用引导卡片说明支持的格式，并给出文字打开入口", () => {
    expect(panel).toContain('className="document-viewer-empty-card"');
    expect(panel).toContain('className="document-viewer-empty-badges"');
    expect(panel).toContain('className="document-viewer-empty-open"');
    expect(panel).toContain("还没有打开文档");
    expect(panel).toContain("DOCUMENT_EMPTY_BADGES.map(");
    expect(styles).toContain(".document-viewer-empty-card {");
    expect(styles).toContain(".document-viewer-open-button {");
    expect(styles).not.toContain(".document-viewer-choose-button");
  });

  it("支持把文件从系统直接拖进面板：按后缀过滤后复用同一套页签打开逻辑", () => {
    expect(panel).toContain("onDragEnter={handleDragEnter}");
    expect(panel).toContain("onDragOver={handleDragOver}");
    expect(panel).toContain("onDragLeave={handleDragLeave}");
    expect(panel).toContain("onDrop={handleDrop}");
    // 只接管文件拖拽，拖文字或链接时保持原生行为。
    expect(panel).toContain('Array.from(event.dataTransfer.types).includes("Files")');
    // 拖入的 File 在渲染层拿不到本地路径，交给预加载脚本解析后再按后缀过滤。
    expect(panel).toContain("window.codexh.resolveDroppedFilePath(file)");
    expect(panel).toContain("paths.filter(isSupportedDocumentPath)");
    expect(panel).toContain("void documents.openDroppedPaths(supported);");
    expect(panel).toContain('className="document-viewer-drop-hint"');
    expect(panel).toContain('className="document-viewer-drop-notice"');
    expect(panel).toContain('${dropActive ? " is-drop-target" : ""}');
    // 与文件对话框共用同一份加载流程，不另写一份去重与加载。
    expect(tabs).toContain("const openDroppedPaths = useCallback(");
    expect(tabs).toContain("await openPaths(paths, { openDuplicatePaths: true });");
    expect(tabs).toContain("await openPaths(chosen);");
    // 拖入不查面板里已打开的同路径页签：已经有文件打开时再拖入也会新开一个页签。
    expect(tabs).toContain("async (paths: string[], options?: { openDuplicatePaths?: boolean }) => {");
    expect(tabs).toContain("options?.openDuplicatePaths");
    expect(tabs).toContain("current.find((tab) => tab.path === path)");
    expect(utils).toContain("export function isSupportedDocumentPath(path: string): boolean {");
    expect(env).toContain("resolveDroppedFilePath: (file: File) => string;");
    expect(preload).toContain("webUtils.getPathForFile(file)");
    expect(styles).toContain(".document-viewer-drop-hint {");
    expect(styles).toContain(".document-viewer-sheet.is-drop-target");
  });

  it("标题栏的「+」新建空白页，打开文件另有独立入口", () => {
    const header = section(
      panel,
      '<div className="document-viewer-header-leading">',
      '<div className="document-viewer-header-actions">'
    );
    expect(header).toContain('aria-label="新建空白页"');
    expect(header).toContain("onClick={documents.newBlankDocument}");
    expect(header).toContain('aria-label="打开文件"');
    expect(header).toContain("onClick={() => void documents.openDocuments()}");
    expect(header).toContain("<IconPlus />");
    expect(header).toContain("<IconFile />");
    // 两个按钮共用同一套样式，不另起一份。
    expect(header.match(/className="document-viewer-open-button"/g)?.length).toBe(2);
  });

  it("新建空白页是未落盘的可编辑页签，重复新建会复用已有的干净空页", () => {
    const blankFn = section(
      tabs,
      "const newBlankDocument = useCallback(",
      "const selectTab = useCallback("
    );
    expect(blankFn).toContain("getNextUntitledDocumentTitle(current.map((item) => item.title))");
    expect(blankFn).toContain('path: ""');
    expect(blankFn).toContain('kind: "text"');
    expect(blankFn).toContain('mode: "source"');
    expect(blankFn).toContain("loading: false");
    expect(blankFn).toContain("!tab.path && !isDocumentDirty(tab.content, tab.savedContent)");
    expect(tabs).toContain("newBlankDocument,");
    expect(tabs).toContain("newBlankDocument: () => void;");
  });

  it("空白页没有路径时保存即另存为，默认文件名由标题推导", () => {
    const saveFn = section(tabs, "const saveTab = useCallback(", "const requestCloseTab = useCallback(");
    expect(saveFn).toContain("if (!tab.path) {");
    expect(saveFn).toContain("return saveTabAs(tabId);");

    const saveAsFn = section(tabs, "const saveTabAs = useCallback(", "const saveTab = useCallback(");
    expect(saveAsFn).toContain(
      "suggestedPath: tab.path || getUntitledDocumentSuggestedFileName(tab.title)"
    );
  });

  it("未命名标题按序号避重，默认另存为 txt", () => {
    expect(utils).toContain('export const UNTITLED_DOCUMENT_TITLE_PREFIX = "未命名";');
    expect(utils).toContain("export function getUntitledDocumentTitle(sequence: number): string {");
    expect(utils).toContain("export function getNextUntitledDocumentTitle(takenTitles: string[]): string {");
    expect(utils).toContain("while (taken.has(getUntitledDocumentTitle(index))) {");
    expect(utils).toContain("export function getUntitledDocumentSuggestedFileName(title: string): string {");
    expect(utils).toContain("return `${title}.txt`;");
  });

  it("源文件被外部改动时给出提醒，是否重新加载由用户决定", () => {
    // 纯逻辑只保留一份：是否变化、提醒文案都在 utils 里，面板只负责展示。
    // 不做后台轮询，所以没有检查间隔常量：检查只在面板每次打开时触发一次。
    expect(utils).not.toContain("DOCUMENT_SOURCE_CHECK_INTERVAL_MS");
    expect(utils).toContain("export function hasDocumentSourceChanged(");
    expect(utils).toContain("baseMtimeMs: number | null,");
    expect(utils).toContain("export function describeDocumentSourceUpdate(titles: string[]): string {");

    // 主进程只查最后修改时间，不读内容；渲染层拿时间戳与基线比对。
    expect(main).toContain('ipcMain.handle("documents:stat-files"');
    expect(main).toContain("backend.statDocumentFilesByPath(payload.paths)");
    expect(preload).toContain('ipcRenderer.invoke("documents:stat-files", payload)');
    expect(env).toContain("statDocumentFiles: (payload: { paths: string[] }) =>");

    const checkFn = section(
      tabs,
      "const checkSourceUpdates = useCallback(",
      "const reloadSourceUpdates = useCallback("
    );
    expect(checkFn).toContain("filter((tab) => Boolean(tab.path) && !tab.binary)");
    expect(checkFn).toContain(
      "await window.codexh.statDocumentFiles({ paths: targets.map((tab) => tab.path) });"
    );
    expect(checkFn).toContain(
      "hasDocumentSourceChanged(tab.sourceMtimeMs, mtimeByTabId.get(tab.id) ?? null)"
    );
    expect(checkFn).toContain(
      "return changed === tab.sourceChanged ? tab : { ...tab, sourceChanged: changed };"
    );

    // 自己保存完就把基线推到新版本，免得保存本身被当成一次外部更新。
    const baselineFn = section(
      tabs,
      "const refreshSourceBaseline = useCallback(",
      "const checkSourceUpdates = useCallback("
    );
    expect(baselineFn).toContain("sourceMtimeMs: stamp?.mtimeMs ?? null, sourceChanged: false");

    // 两个出口：重新加载按磁盘版本覆盖，保留当前内容只把基线对齐。
    const reloadFn = section(
      tabs,
      "const reloadSourceUpdates = useCallback(",
      "const keepSourceVersions = useCallback("
    );
    expect(reloadFn).toContain("filter((tab) => tab.sourceChanged && tab.path)");
    expect(reloadFn).toContain("await loadTab(tab.id, tab.path);");
    const keepFn = section(tabs, "const keepSourceVersions = useCallback(", "const selectTab = useCallback(");
    expect(keepFn).toContain("await refreshSourceBaseline(tab.id);");
    expect(tabs).toContain("changedSourceTitles: string[];");
    expect(tabs).toContain("const changedSourceTitles = useMemo(");

    // 触发点是「切回来」：面板收起后卸载，重新打开时挂载即检查一次。
    expect(app).toContain("useMotionPresence(isDocumentViewerOpen ? true : null, 220)");
    expect(app).toContain("{documentViewerPresence.value ? (");
    const checkEffect = section(
      panel,
      "每次打开面板（切回来）时检查一次源文件是否被外部改动",
      "\n  return (\n    <section"
    );
    expect(checkEffect).toContain("void checkSourceUpdates();");
    expect(checkEffect).not.toContain("window.setInterval(");
    expect(checkEffect).not.toContain("clearInterval");
    const notice = section(
      panel,
      'className="document-viewer-source-notice"',
      "document-viewer-inline-body"
    );
    expect(notice).toContain("describeDocumentSourceUpdate(changedSourceTitles)");
    expect(notice).toContain("reloadSourceUpdates()");
    expect(notice).toContain("keepSourceVersions()");
    expect(panel).toContain("document-tab-outdated");
    expect(styles).toContain(".document-viewer-source-notice {");
    expect(styles).toContain(".document-tab-outdated {");
  });

  it("读取大文件时给出加载特效：面板有专用加载视图，页签上也有读取指示", () => {
    // 加载中不再复用通用空态，改用面板自己的加载卡片，并点名正在读哪一份。
    expect(panel).toContain("function DocumentViewerLoading({ title }: { title: string }) {");
    expect(panel).toContain('className="document-viewer-loading"');
    expect(panel).toContain('role="status"');
    expect(panel).toContain("正在读取「{title}」");
    expect(panel).toContain("<DocumentViewerLoading title={tab.title} />");
    expect(panel).not.toContain("WorkspaceEmptyState");

    // 页签栏同步给出读取指示，切到别的页签也能看出这份还没读完。
    expect(panel).toContain("{tab.loading ? (");
    expect(panel).toContain('className="document-tab-loading"');

    // 样式：转圈、文件名、一条往返扫描的进度轨；减少动效时关掉位移动画。
    expect(styles).toContain(".document-viewer-loading {");
    expect(styles).toContain(".document-viewer-loading-track {");
    expect(styles).toContain("animation: document-viewer-loading-scan 1.25s ease-in-out infinite;");
    expect(styles).toContain("@keyframes document-viewer-loading-scan {");
    expect(styles).toContain(".document-tab-loading {");
    expect(styles).toContain(
      ".document-viewer-loading-track i,\n  .user-skill-generating-dots i {"
    );
  });
});
