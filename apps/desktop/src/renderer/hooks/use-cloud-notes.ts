import { useRef, useState } from "react";

export type CloudNote = {
  id: string;
  title: string;
  content: string;
  version: number;
  seq: number;
  deleted: boolean;
  dirty: boolean;
  serverUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudNoteLink = {
  cloudNoteId: string;
  quickNoteId: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudNotesStatus = {
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

export type CloudNotesSyncSummary = {
  pushed: number;
  pulled: number;
  conflicts: number;
  cursor: number;
  syncedAt: string;
};

export type CloudNoteEditor = {
  mode: "create" | "edit";
  id: string | null;
  title: string;
  content: string;
  saving: boolean;
};

export type CloudNoteDeleteTarget = { id: string; title: string } | null;

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

/**
 * 云笔记固定连自己的服务器：登录页只让用户填邮箱与密码，
 * 地址不作为可编辑项暴露，避免填错地址导致连不上。
 */
export const DEFAULT_CLOUD_NOTES_SERVER_URL = "http://8.162.8.43:3003";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "请稍后重试。";
}

/** 列表统一按修改时间倒序（同一时间再比创建时间），一次取全量、不分页。 */
export function sortCloudNotes(notes: CloudNote[]): CloudNote[] {
  return [...notes].sort((left, right) => {
    const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
    return byUpdated !== 0 ? byUpdated : right.createdAt.localeCompare(left.createdAt);
  });
}

/**
 * 云笔记页面的数据入口。页面未登录时只渲染注册/登录表单，登录后只渲染笔记列表，
 * 所以这里把账号、列表、关联、编辑弹窗与删除确认几组状态收在一起，
 * 页面组件只负责渲染与调用动作。
 */
export function useCloudNotes(showNotice: Notice) {
  const [status, setStatus] = useState<CloudNotesStatus | null>(null);
  const [notes, setNotes] = useState<CloudNote[]>([]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [serverUrl, setServerUrl] = useState(DEFAULT_CLOUD_NOTES_SERVER_URL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<CloudNoteEditor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CloudNoteDeleteTarget>(null);
  const [lastSync, setLastSync] = useState<CloudNotesSyncSummary | null>(null);
  const autoSyncedRef = useRef(false);

  function applyStatus(next: CloudNotesStatus) {
    setStatus(next);
    // 这个构建只连自有服务器：地址常量固定，登录时写回账号，界面只做只读展示。
    setServerUrl(DEFAULT_CLOUD_NOTES_SERVER_URL);
    setEmail(next.email);
    setDisplayName(next.displayName);
  }

  async function loadNotes() {
    const list = await window.codexh.listCloudNotes();
    // 软删除的记录保留在本地做墓碑，不在列表里展示。
    setNotes(sortCloudNotes(list.filter((note) => !note.deleted)));
  }

  async function loadLinks() {
    const list = await window.codexh.listCloudNoteLinks();
    setLinks(Object.fromEntries(list.map((link) => [link.cloudNoteId, link.quickNoteId])));
  }

  async function refresh(options: { silent?: boolean } = {}): Promise<CloudNotesStatus | null> {
    try {
      const next = await window.codexh.getCloudNotesStatus();
      applyStatus(next);
      await Promise.all([loadNotes(), loadLinks()]);
      if (!options.silent) {
        setMessage("");
      }
      return next;
    } catch (error) {
      setMessage(describeError(error));
      return null;
    }
  }

  /** 首次进入：先读状态；已登录就静默同步一次，让列表拿到服务端最新版本。 */
  async function initialize() {
    const next = await refresh();
    if (!next?.loggedIn || autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    await sync({ silent: true });
  }

  async function submitCredentials(register: boolean) {
    if (!serverUrl.trim()) {
      setMessage("云笔记服务器地址不可用，请重启应用后重试。");
      return;
    }
    if (!email.trim()) {
      setMessage("请填写登录邮箱。");
      return;
    }
    if (!password.trim()) {
      setMessage("请输入登录密码。");
      return;
    }
    setBusy(true);
    setMessage(register ? "正在注册并登录…" : "正在登录…");
    try {
      await window.codexh.configureCloudNotes({ serverUrl, email, displayName });
      const next = await window.codexh.loginCloudNotes({ password, register });
      applyStatus(next);
      setPassword("");
      autoSyncedRef.current = false;
      await Promise.all([loadNotes(), loadLinks()]);
      setMessage(register ? "注册并登录成功，可以开始写云笔记了。" : "登录成功，可以开始写云笔记了。");
      showNotice(register ? "云笔记账号已创建" : "已登录云笔记", { tone: "success", message: next.email });
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setMessage("");
    try {
      await window.codexh.logoutCloudNotes();
      autoSyncedRef.current = false;
      setEditor(null);
      setDeleteTarget(null);
      setNotes([]);
      setLinks({});
      await refresh({ silent: true });
      setMessage("已退出云笔记账号，本地笔记仍然保留。");
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function sync(options: { silent?: boolean } = {}): Promise<CloudNotesSyncSummary | null> {
    const silent = options.silent === true;
    if (!silent) {
      setBusy(true);
      setMessage("正在同步…");
    }
    try {
      const outcome = await window.codexh.syncCloudNotes();
      const summary = {
        pushed: outcome.pushed,
        pulled: outcome.pulled,
        conflicts: outcome.conflicts,
        cursor: outcome.cursor,
        syncedAt: outcome.syncedAt
      };
      setLastSync(summary);
      await Promise.all([loadNotes(), loadLinks()]);
      setMessage(`同步完成：上传 ${outcome.pushed} 条，拉取 ${outcome.pulled} 条，冲突 ${outcome.conflicts} 条。`);
      if (!silent) {
        showNotice("云笔记已同步", {
          tone: "success",
          message: `上传 ${outcome.pushed} 条，拉取 ${outcome.pulled} 条。`
        });
      }
      return summary;
    } catch (error) {
      setMessage(`同步失败：${describeError(error)}`);
      return null;
    } finally {
      if (!silent) setBusy(false);
    }
  }

  function openCreateEditor() {
    setMessage("");
    setEditor({ mode: "create", id: null, title: "", content: "", saving: false });
  }

  function openEditEditor(note: CloudNote) {
    setMessage("");
    setEditor({ mode: "edit", id: note.id, title: note.title, content: note.content, saving: false });
  }

  function closeEditor() {
    setEditor(null);
  }

  function setEditorTitle(value: string) {
    setEditor((current) => (current ? { ...current, title: value } : current));
  }

  function setEditorContent(value: string) {
    setEditor((current) => (current ? { ...current, content: value } : current));
  }

  /** 保存并同步：弹窗里写完立刻推送，关联的随手记由主进程侧同步回写。 */
  async function saveEditor() {
    const draft = editor;
    if (!draft) return;
    if (!draft.content.trim()) {
      setMessage("笔记正文不能为空。");
      return;
    }
    setEditor({ ...draft, saving: true });
    setBusy(true);
    setMessage("");
    try {
      await window.codexh.saveCloudNote({
        id: draft.id ?? undefined,
        title: draft.title,
        content: draft.content
      });
      setEditor(null);
      await loadNotes();
      try {
        const outcome = await window.codexh.syncCloudNotes();
        setLastSync({
          pushed: outcome.pushed,
          pulled: outcome.pulled,
          conflicts: outcome.conflicts,
          cursor: outcome.cursor,
          syncedAt: outcome.syncedAt
        });
        await Promise.all([loadNotes(), loadLinks()]);
        setMessage(
          draft.mode === "create"
            ? `已新增并同步：上传 ${outcome.pushed} 条，拉取 ${outcome.pulled} 条。`
            : `已保存并同步：上传 ${outcome.pushed} 条，拉取 ${outcome.pulled} 条。`
        );
        showNotice(draft.mode === "create" ? "云笔记已新增并同步" : "云笔记已保存并同步", {
          tone: "success",
          message: "服务端已更新，关联的随手记也已跟随。"
        });
      } catch (error) {
        // 本地内容已经落库，网络恢复后再推一次即可。
        setMessage(`笔记已保存到本地，但同步失败：${describeError(error)}`);
        showNotice("笔记已保存，同步待重试", { tone: "warning", message: describeError(error) });
      }
    } catch (error) {
      setEditor((current) => (current ? { ...current, saving: false } : current));
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  function requestDelete(note: Pick<CloudNote, "id" | "title">) {
    setDeleteTarget({ id: note.id, title: note.title });
  }

  function cancelDelete() {
    setDeleteTarget(null);
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setBusy(true);
    setMessage("");
    try {
      await window.codexh.deleteCloudNote(target.id);
      setDeleteTarget(null);
      setEditor((current) => (current?.id === target.id ? null : current));
      await loadNotes();
      // 删除写的是墓碑，马上同步一次让服务端也删掉。
      await sync({ silent: true });
      setMessage("笔记已删除并同步；本地随手记不受影响。");
      showNotice("云笔记已删除", { tone: "success", message: "服务端已同步删除。" });
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  /** 把云笔记拉成（或刷新成）一条本地随手记，并建立双向关联。 */
  async function pullToQuickNote(cloudNoteId: string): Promise<string | null> {
    setBusy(true);
    setMessage("");
    try {
      const result = await window.codexh.pullCloudNoteToQuickNote(cloudNoteId);
      await loadLinks();
      setMessage("已拉取到本地随手记，之后两边编辑会即时相互同步。");
      showNotice("已拉取到随手记", { tone: "success", message: "打开随手记即可继续编辑。" });
      return result.quickNoteId;
    } catch (error) {
      setMessage(describeError(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function linkedQuickNoteId(cloudNoteId: string): string | null {
    return links[cloudNoteId] ?? null;
  }

  return {
    status,
    notes,
    links,
    serverUrl,
    email,
    setEmail,
    password,
    setPassword,
    displayName,
    setDisplayName,
    busy,
    message,
    editor,
    deleteTarget,
    lastSync,
    refresh,
    initialize,
    submitCredentials,
    logout,
    sync,
    openCreateEditor,
    openEditEditor,
    closeEditor,
    setEditorTitle,
    setEditorContent,
    saveEditor,
    requestDelete,
    cancelDelete,
    confirmDelete,
    pullToQuickNote,
    linkedQuickNoteId
  };
}
