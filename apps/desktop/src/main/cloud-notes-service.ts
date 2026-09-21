import { randomUUID } from "node:crypto";
import { buildThreadTitleFromFirstMessage } from "./thread-title";
import {
  CloudNotesClient,
  createDeviceId,
  normalizeServerUrl,
  type CloudNoteChange,
  type CloudNoteRecord,
  type CloudNotesAccount
} from "./cloud-notes";
import type { DatabaseService } from "./storage";

export type CloudNotesStatusView = {
  configured: boolean;
  serverUrl: string;
  email: string;
  displayName: string;
  userId: string;
  loggedIn: boolean;
  cursor: number;
  lastSyncedAt: string | null;
  localCount: number;
  pendingCount: number;
  deviceId: string;
};

export type CloudNotesSyncView = {
  pushed: number;
  pulled: number;
  conflicts: number;
  conflictDrafts: Array<{ id: string; title: string; draftId: string }>;
  cursor: number;
  syncedAt: string;
  localCount: number;
  pendingCount: number;
  /** 本地副本被服务端覆盖（含删除）的云笔记 id，供上层把关联的随手记一并更新。 */
  changedIds: string[];
};

/**
 * 云笔记的本地状态机：本地 SQLite 始终是写入入口，服务端只通过 sync 收口。
 * 把它独立于 DesktopBackend，便于单测直接驱动冲突与增量拉取分支。
 */
export class CloudNotesService {
  readonly #db: DatabaseService;

  public constructor(db: DatabaseService) {
    this.#db = db;
  }

  #client(account: CloudNotesAccount): CloudNotesClient {
    return new CloudNotesClient({
      baseUrl: account.serverUrl,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      onSession: (session) => {
        // 令牌轮换后立刻落库，避免下次启动拿旧令牌触发 401。
        this.#db.updateCloudNotesAccountState({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          tokenExpiresAt: session.tokenExpiresAt
        });
      }
    });
  }

  public getStatus(): CloudNotesStatusView {
    const account = this.#db.getCloudNotesAccount();
    return {
      configured: !!account,
      serverUrl: account?.serverUrl ?? "",
      email: account?.email ?? "",
      displayName: account?.displayName ?? "",
      userId: account?.userId ?? "",
      loggedIn: !!account?.accessToken,
      cursor: account?.cursor ?? 0,
      lastSyncedAt: account?.lastSyncedAt ?? null,
      localCount: this.#db.countCloudNotes(),
      pendingCount: this.#db.countDirtyCloudNotes(),
      deviceId: account?.deviceId ?? ""
    };
  }

  public configure(input: {
    serverUrl?: string;
    email?: string;
    displayName?: string;
    deviceId?: string;
  }): CloudNotesStatusView {
    const current = this.#db.getCloudNotesAccount();
    const serverUrl = input.serverUrl?.trim() ? normalizeServerUrl(input.serverUrl) : current?.serverUrl ?? "";
    if (!serverUrl) throw new Error("请填写云笔记服务器地址，例如 http://127.0.0.1:3003。");
    const switchedServer = !!current && current.serverUrl !== serverUrl;
    if (switchedServer) {
      // 换服务器后旧版本号不再有意义：本地笔记全部标记为待推送，由新服务端重新分配版本。
      for (const note of this.#db.listCloudNotes()) {
        this.#db.upsertCloudNote({
          id: note.id,
          title: note.title,
          content: note.content,
          version: 0,
          seq: 0,
          deleted: note.deleted,
          dirty: true,
          serverUpdatedAt: null
        });
      }
    }
    this.#db.saveCloudNotesAccount({
      serverUrl,
      email: input.email?.trim() ?? current?.email ?? "",
      displayName: input.displayName?.trim() ?? current?.displayName ?? "",
      userId: switchedServer ? "" : current?.userId ?? "",
      accessToken: switchedServer ? "" : current?.accessToken ?? "",
      refreshToken: switchedServer ? "" : current?.refreshToken ?? "",
      tokenExpiresAt: switchedServer ? "" : current?.tokenExpiresAt ?? "",
      cursor: switchedServer ? 0 : current?.cursor ?? 0,
      lastSyncedAt: switchedServer ? null : current?.lastSyncedAt ?? null,
      deviceId: input.deviceId?.trim() || current?.deviceId || createDeviceId()
    });
    return this.getStatus();
  }

  public async login(password: string, register = false): Promise<CloudNotesStatusView> {
    const account = this.#db.getCloudNotesAccount();
    if (!account) throw new Error("请先填写云笔记服务器地址与登录邮箱。");
    if (!account.email.trim()) throw new Error("请先填写登录邮箱。");
    const session = await CloudNotesClient.connect({
      serverUrl: account.serverUrl,
      email: account.email,
      password,
      displayName: account.displayName || undefined,
      mode: register ? "register" : "login"
    });
    this.#db.saveCloudNotesAccount({
      serverUrl: session.serverUrl,
      userId: session.userId,
      email: session.email || account.email,
      displayName: session.displayName || account.displayName,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenExpiresAt: session.tokenExpiresAt,
      cursor: account.cursor,
      lastSyncedAt: account.lastSyncedAt,
      deviceId: account.deviceId
    });
    return this.getStatus();
  }

  public async logout(): Promise<void> {
    const account = this.#db.getCloudNotesAccount();
    if (!account) return;
    if (account.refreshToken) {
      await this.#client(account).revoke(account.refreshToken);
    }
    this.#db.clearCloudNotesAccount();
  }

  public list(): CloudNoteRecord[] {
    return this.#db.listCloudNotes();
  }

  public save(input: { id?: string; title?: string; content: string; dirty?: boolean }): CloudNoteRecord {
    const content = input.content.trim();
    if (!content) throw new Error("笔记内容不能为空。");
    const existing = input.id ? this.#db.getCloudNote(input.id) : null;
    const id = existing?.id ?? input.id ?? randomUUID();
    const title = input.title?.trim() || existing?.title || buildThreadTitleFromFirstMessage(content);
    return this.#db.upsertCloudNote({
      id,
      title,
      content,
      version: existing?.version ?? 0,
      seq: existing?.seq ?? 0,
      deleted: false,
      dirty: input.dirty ?? true,
      serverUpdatedAt: existing?.serverUpdatedAt ?? null
    });
  }

  public remove(id: string): void {
    const note = this.#db.getCloudNote(id);
    if (!note) return;
    // 从未同步过的本地笔记直接删除，不在服务端留下空墓碑。
    if (!note.serverUpdatedAt && note.version === 0) {
      this.#db.deleteCloudNote(id);
      return;
    }
    this.#db.upsertCloudNote({
      id: note.id,
      title: note.title,
      content: note.content,
      version: note.version,
      seq: note.seq,
      deleted: true,
      dirty: true,
      serverUpdatedAt: note.serverUpdatedAt
    });
  }

  public async sync(): Promise<CloudNotesSyncView> {
    const account = this.#db.getCloudNotesAccount();
    if (!account) throw new Error("请先连接云笔记服务器。");
    if (!account.accessToken) throw new Error("登录状态已失效，请重新登录云笔记。");
    const client = this.#client(account);
    const changes: CloudNoteChange[] = this.#db.listDirtyCloudNotes().map((note) => ({
      id: note.id,
      title: note.title,
      content: note.content,
      version: note.version,
      deleted: note.deleted,
      clientUpdatedAt: note.updatedAt,
      deviceId: account.deviceId
    }));
    // 一次往返同时推送本地改动并拉取服务端变更，避免两端版本反复来回。
    const outcome = await client.sync({ since: account.cursor, changes, deviceId: account.deviceId });
    const conflictIds = new Set(outcome.conflicts.map((note) => note.id));
    let pushed = 0;
    const changedIds: string[] = [];
    for (const entry of outcome.applied) {
      if (entry.status === "conflict") continue;
      const local = this.#db.getCloudNote(entry.id);
      if (!local) continue;
      if (local.deleted) {
        this.#db.deleteCloudNote(entry.id);
      } else {
        this.#db.upsertCloudNote({
          id: local.id,
          title: local.title,
          content: local.content,
          version: entry.version,
          seq: outcome.cursor,
          deleted: false,
          dirty: false,
          serverUpdatedAt: local.serverUpdatedAt ?? outcome.serverTime
        });
      }
      pushed += 1;
      changedIds.push(entry.id);
    }

    const conflictDrafts: Array<{ id: string; title: string; draftId: string }> = [];
    for (const serverNote of outcome.conflicts) {
      const local = this.#db.getCloudNote(serverNote.id);
      // 冲突时保留本地草稿（改标题后重新推送），同时接受服务端权威副本。
      const draftId = randomUUID();
      this.#db.upsertCloudNote({
        id: draftId,
        title: `${local?.title || serverNote.title || "未命名"}（冲突副本）`,
        content: local?.content ?? "",
        version: 0,
        seq: 0,
        deleted: false,
        dirty: true,
        serverUpdatedAt: null
      });
      this.#db.upsertCloudNote({
        id: serverNote.id,
        title: serverNote.title,
        content: serverNote.content,
        version: serverNote.version,
        seq: serverNote.seq,
        deleted: serverNote.deleted,
        dirty: false,
        serverUpdatedAt: serverNote.serverUpdatedAt ?? outcome.serverTime
      });
      conflictDrafts.push({ id: serverNote.id, title: serverNote.title, draftId });
      changedIds.push(serverNote.id);
    }

    let pulled = 0;
    for (const serverNote of outcome.notes) {
      if (conflictIds.has(serverNote.id)) continue;
      const local = this.#db.getCloudNote(serverNote.id);
      if (serverNote.deleted) {
        if (local) {
          this.#db.deleteCloudNote(serverNote.id);
          pulled += 1;
          changedIds.push(serverNote.id);
        }
        continue;
      }
      // 本地未改动且版本不落后，说明只是回声，不需要覆盖。
      if (local && !local.dirty && local.version >= serverNote.version) continue;
      this.#db.upsertCloudNote({
        id: serverNote.id,
        title: serverNote.title,
        content: serverNote.content,
        version: serverNote.version,
        seq: serverNote.seq,
        deleted: false,
        dirty: false,
        serverUpdatedAt: serverNote.serverUpdatedAt ?? outcome.serverTime
      });
      pulled += 1;
      changedIds.push(serverNote.id);
    }

    this.#db.updateCloudNotesAccountState({
      cursor: outcome.cursor,
      lastSyncedAt: outcome.serverTime
    });
    return {
      pushed,
      pulled,
      conflicts: conflictDrafts.length,
      conflictDrafts,
      cursor: outcome.cursor,
      syncedAt: outcome.serverTime,
      localCount: this.#db.countCloudNotes(),
      pendingCount: this.#db.countDirtyCloudNotes(),
      changedIds
    };
  }
}
