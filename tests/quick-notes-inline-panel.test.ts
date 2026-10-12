import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readText = (url: URL): string => readFileSync(url, "utf8").replace(/\r\n/g, "\n");

const app = readText(new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url));
const sidebar = readText(
  new URL("../apps/desktop/src/renderer/history/history-sidebar.tsx", import.meta.url)
);
const panel = readText(
  new URL("../apps/desktop/src/renderer/workspace/quick-notes-panel.tsx", import.meta.url)
);
const styles = readText(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url));

/** 取出一段实现代码，避免断言命中同名的其它位置。 */
function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `未找到实现起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `未找到实现终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("随手记：侧栏入口 + 聊天区内联面板", () => {
  it("侧栏入口排在「新建任务」下面，并带选中态", () => {
    const nav = section(sidebar, '<div className="sidebar-nav">', '<div className="history-list"');
    const createTaskIndex = nav.indexOf("新建任务");
    const quickNotesIndex = nav.indexOf("随手记");
    expect(createTaskIndex).toBeGreaterThanOrEqual(0);
    expect(quickNotesIndex).toBeGreaterThan(createTaskIndex);
    expect(nav).toContain("onClick={() => void onOpenQuickNotes()}");
    expect(nav).toContain('quickNotesActive ? "is-active" : ""');
  });

  it("面板渲染在聊天画布内，代替聊天记录与输入区", () => {
    const canvasStart = app.indexOf("<section className={`chat-canvas");
    expect(canvasStart).toBeGreaterThanOrEqual(0);
    expect(app.slice(canvasStart, canvasStart + 240)).toContain(
      '${isQuickNotesOpen ? "is-quick-notes" : ""}'
    );

    const panelIndex = app.indexOf("<QuickNotesPanel", canvasStart);
    const scrollIndex = app.indexOf("chat-scroll", canvasStart);
    expect(panelIndex).toBeGreaterThan(canvasStart);
    expect(panelIndex).toBeLessThan(scrollIndex);
    const panelEnd = app.indexOf("/>", panelIndex);
    expect(panelEnd).toBeGreaterThan(panelIndex);
    expect(app.slice(panelIndex, panelEnd)).toContain(
      "onClose={() => setIsQuickNotesOpen(false)}"
    );
  });

  it("不再挂载旧的随手记弹窗", () => {
    expect(app).not.toContain("QuickNotesSheet");
    expect(app).not.toContain("./workspace/quick-notes-sheet");
    expect(app).toContain('import { QuickNotesPanel } from "./workspace/quick-notes-panel";');
  });

  it("打开随手记先退出分享模式并收起终端抽屉，避免多种占用聊天区的状态叠加", () => {
    const openEvent = section(
      app,
      "const openQuickNotesEvent = useStableEvent(",
      "const openHistorySearchEvent"
    );
    expect(openEvent).toContain("if (isSharing) exitShareMode();");
    expect(openEvent).toContain("if (isTerminalOpen) setIsTerminalOpen(false);");
    expect(openEvent).toContain("return openQuickNotes();");
  });

  it("面板是聊天区内的区块，不是覆盖界面的弹窗", () => {
    expect(panel).toContain('className="quick-notes-sheet quick-notes-inline"');
    expect(panel).not.toContain('"project-sheet quick-notes-sheet');
    expect(panel).toContain('className="quick-notes-confirm-bar"');
  });

  it("样式把面板铺满聊天区，并让聊天记录与输入区让位", () => {
    expect(styles).toContain(".chat-canvas.is-quick-notes > .chat-scroll");
    expect(styles).toContain(".chat-canvas.is-quick-notes > footer");
    const inlineRule = section(styles, ".quick-notes-sheet.quick-notes-inline {", "\n}");
    expect(inlineRule).toContain("display: flex");
    expect(inlineRule).toContain("height: 100%");
    expect(inlineRule).toContain("padding: 0");
    expect(styles).toContain(".sidebar-nav-button.is-active");
  });

  it("底部状态与操作整体靠右排列", () => {
    const footerRule = section(
      styles,
      ".quick-notes-sheet.quick-notes-inline .quick-notes-footer {",
      "\n}"
    );
    expect(footerRule).toContain("flex-wrap: wrap");
    expect(footerRule).toContain("justify-content: flex-end");

    const statusRule = section(
      styles,
      ".quick-notes-sheet.quick-notes-inline .quick-notes-status {",
      "\n}"
    );
    expect(statusRule).toContain("margin-left: auto");
    expect(statusRule).toContain("text-align: right");
  });

  it("点左侧会话或新建任务都能切回聊天，侧栏入口也可再次点击收起", () => {
    const openEvent = section(
      app,
      "const openQuickNotesEvent = useStableEvent(",
      "const openHistorySearchEvent"
    );
    expect(openEvent).toContain("if (isQuickNotesOpen) return Promise.resolve();");

    const openThreadFn = section(
      app,
      "async function openThread(threadId: string",
      "const isSwitchingThread"
    );
    expect(openThreadFn).toContain("setIsQuickNotesOpen(false);");

    const activateFn = section(
      app,
      "function activateNewThread(thread: ThreadRecord) {",
      "selectThreadId(thread.id)"
    );
    expect(activateFn).toContain("setIsQuickNotesOpen(false);");

    const newTaskFn = section(
      app,
      "function openNewTaskComposer(preset?: { workspaceCwd?: string | null }) {",
      "if (selectedThreadId) selectThreadId(null);"
    );
    expect(newTaskFn).toContain("setIsQuickNotesOpen(false);");
  });
});
