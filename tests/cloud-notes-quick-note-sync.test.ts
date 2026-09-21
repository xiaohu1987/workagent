import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 读取源码，用于守住云笔记 ↔ 随手记双向同步的接线不被改坏。 */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const backendSource = readSource("../apps/desktop/src/main/app.ts");
const ipcSource = readSource("../apps/desktop/src/main/index.ts");
const preloadSource = readSource("../apps/desktop/src/preload/index.ts");
const quickNotesHook = readSource("../apps/desktop/src/renderer/hooks/use-quick-notes.ts");
const quickNotesSheet = readSource("../apps/desktop/src/renderer/workspace/quick-notes-sheet.tsx");
const cloudNotesPage = readSource(
  "../apps/desktop/src/renderer/settings/pages/connections/cloud-notes-page.tsx"
);
const cloudNotesHook = readSource("../apps/desktop/src/renderer/hooks/use-cloud-notes.ts");
const stylesSource = readSource("../apps/desktop/src/renderer/styles.css");

/** 取出一段实现代码，避免断言命中同名的其它位置。 */
function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `未找到实现起点：${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `未找到实现终点：${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("云笔记与随手记的双向同步", () => {
  it("随手记保存后立即推送已关联的云笔记", () => {
    const saveQuickNote = section(backendSource, "public saveQuickNote(", "private persistQuickNote(");
    expect(saveQuickNote).toContain("this.pushQuickNoteToCloud(note.id)");
  });

  it("只有建立了关联才推送，内容一致时跳过", () => {
    const push = section(backendSource, "private pushQuickNoteToCloud(", "private applyCloudNoteToLinkedQuickNote(");
    expect(push).toContain("this.#db.getCloudNoteLinkByQuickNote(quickNoteId)");
    expect(push).toContain("if (!link) return;");
    expect(push).toContain("cloudNote.title === quickNote.title && cloudNote.content === quickNote.content");
  });

  it("云笔记保存与同步完成后回写关联的随手记", () => {
    const saveCloudNote = section(backendSource, "public saveCloudNote(", "public deleteCloudNote(");
    expect(saveCloudNote).toContain("this.applyCloudNoteToLinkedQuickNote(note.id)");
    const syncCloudNotes = section(backendSource, "public syncCloudNotes()", "public listCloudNoteLinks(");
    expect(syncCloudNotes).toContain("this.applyCloudNotesToLinkedQuickNotes(view.changedIds)");
  });

  it("拉取云笔记时新建或刷新随手记并建立关联", () => {
    const pull = section(backendSource, "public pullCloudNoteToQuickNote(", "public async syncQuickNoteToCloud(");
    expect(pull).toContain("this.#db.getCloudNoteLinkByCloudNote(cloudNoteId)");
    expect(pull).toContain("this.#db.upsertCloudNoteLink(cloudNoteId, quickNote.id)");
  });

  it("随手记同步到云笔记：未关联则新建，并用同一张关联表绑定", () => {
    const sync = section(backendSource, "public async syncQuickNoteToCloud(", "public syncCloudNotesQuietly(");
    expect(sync).toContain("this.#db.getCloudNoteLinkByQuickNote(quickNoteId)");
    expect(sync).toContain("id: link?.cloudNoteId");
    expect(sync).toContain("this.#db.upsertCloudNoteLink(cloudNote.id, quickNoteId)");
    // 网络不可用时内容留在待推送队列，只回报原因，不丢数据。
    expect(sync).toContain("synced: false");
  });

  it("列表接口带出云笔记关联标记，删除随手记只解开关联", () => {
    const list = section(backendSource, "public listQuickNotes()", "public saveQuickNote(");
    expect(list).toContain("cloudNoteId: links.get(note.id) ?? null");
    const remove = section(backendSource, "public deleteQuickNote(", "private cloudNotesService(");
    expect(remove).toContain("this.#db.deleteCloudNoteLinkByQuickNote(id)");
  });

  it("IPC 与 preload 暴露两个同步通道", () => {
    expect(ipcSource).toContain('ipcMain.handle("cloud-notes:sync-quick-note"');
    expect(ipcSource).toContain('ipcMain.handle("cloud-notes:pull-to-quick-note"');
    expect(preloadSource).toContain('ipcRenderer.invoke("cloud-notes:sync-quick-note"');
    expect(preloadSource).toContain('ipcRenderer.invoke("cloud-notes:pull-to-quick-note"');
  });

  it("随手记界面提供「同步到云笔记」与关联状态", () => {
    expect(quickNotesHook).toContain("async function syncToCloud()");
    expect(quickNotesHook).toContain("window.codexh.syncQuickNoteToCloud(selectedId)");
    expect(quickNotesSheet).toContain("同步到云笔记");
    expect(quickNotesSheet).toContain("已关联云笔记");
    expect(quickNotesSheet).toContain("cloudNoteId, syncingCloud, onSyncToCloud");
  });

  it("云笔记页面：未登录只看注册登录，登录后是列表加账号", () => {
    expect(cloudNotesPage).toContain("if (!status.loggedIn)");
    expect(cloudNotesPage).toContain("cloud-notes-account");
    expect(cloudNotesPage).toContain("accountName");
    expect(cloudNotesPage).toContain("新增云笔记");
    expect(cloudNotesPage).toContain("退出登录");
    expect(cloudNotesPage).not.toContain("保存地址");
  });

  it("云笔记服务器地址固定为自有服务器，登录页只填邮箱与密码", () => {
    expect(cloudNotesHook).toContain('export const DEFAULT_CLOUD_NOTES_SERVER_URL = "http://8.162.8.43:3003"');
    expect(cloudNotesHook).toContain("useState(DEFAULT_CLOUD_NOTES_SERVER_URL)");
    expect(cloudNotesHook).toContain("setServerUrl(DEFAULT_CLOUD_NOTES_SERVER_URL)");
    // 地址只读：hook 不再对外暴露写地址的入口。
    expect(cloudNotesHook).not.toContain("setServerUrl,");
    // 页面不再暴露可编辑的地址输入框，只在页脚只读展示固定地址。
    expect(cloudNotesPage).not.toContain("setServerUrl");
    expect(cloudNotesPage).not.toContain("127.0.0.1:3003");
    expect(cloudNotesPage).toContain("state.serverUrl");
    expect(cloudNotesPage).toContain("cloud-notes-auth-card");
    expect(cloudNotesPage).toContain("cloud-notes-auth-tabs");
    expect(cloudNotesPage).toContain("cloud-notes-auth-submit");
    expect(cloudNotesPage).toContain('name="password"');
    expect(stylesSource).toContain(".cloud-notes-auth-card");
    expect(stylesSource).toContain(".cloud-notes-auth-tabs");
    expect(stylesSource).toContain(".cloud-notes-auth-field input:focus-visible");
  });
});
