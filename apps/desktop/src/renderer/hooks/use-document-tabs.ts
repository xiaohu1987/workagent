import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DOCUMENT_CHOOSE_EXTENSIONS,
  getDefaultDocumentViewMode,
  getDocumentFileName,
  getNextUntitledDocumentTitle,
  getUntitledDocumentSuggestedFileName,
  hasDocumentSourceChanged,
  resolveDocumentViewKind,
  type DocumentViewKind,
  type DocumentViewMode
} from "../workspace/document-viewer-utils";
import {
  applyLineEnding,
  detectLineEnding,
  isDocumentDirty,
  type DocumentLineEnding
} from "../workspace/document-editing";

/** 单个页签：内容一律按 LF 存放在内存里，保存时再按原换行风格还原。 */
export type DocumentTab = {
  id: string;
  path: string;
  title: string;
  content: string;
  savedContent: string;
  kind: DocumentViewKind;
  mode: DocumentViewMode;
  lineEnding: DocumentLineEnding;
  truncated: boolean;
  binary: boolean;
  loading: boolean;
  error: string | null;
  /** 打开或保存时记下的源文件最后修改时间；为 null 时不做「已更新」提醒。 */
  sourceMtimeMs: number | null;
  /** 磁盘上的源文件已在面板之外被改过，等用户决定重新加载还是保留当前内容。 */
  sourceChanged: boolean;
};

/** 需要用户先决定存不存的待办：关掉某个页签，或整个收起面板。 */
export type DocumentPendingAction =
  | { type: "closeTab"; tabId: string }
  | { type: "closePanel" };

export type DocumentTabsController = {
  tabs: DocumentTab[];
  activeTabId: string | null;
  activeTab: DocumentTab | null;
  pendingAction: DocumentPendingAction | null;
  picking: boolean;
  dirtyCount: number;
  /** 被磁盘改动过的页签标题，面板据此显示提醒与处理入口。 */
  changedSourceTitles: string[];
  openDocuments: () => Promise<void>;
  openDroppedPaths: (paths: string[]) => Promise<void>;
  newBlankDocument: () => void;
  selectTab: (tabId: string) => void;
  requestCloseTab: (tabId: string) => void;
  requestClosePanel: () => void;
  resolvePendingAction: (decision: "save" | "discard") => Promise<void>;
  cancelPendingAction: () => void;
  updateContent: (tabId: string, content: string) => void;
  setTabMode: (tabId: string, mode: DocumentViewMode) => void;
  saveTab: (tabId: string) => Promise<boolean>;
  saveTabAs: (tabId: string) => Promise<boolean>;
  /** 检查磁盘上的源文件是否变了；面板打开期间按间隔调用。 */
  checkSourceUpdates: () => Promise<void>;
  /** 重新加载被标记的页签，未保存的修改会被磁盘版本替换。 */
  reloadSourceUpdates: () => Promise<void>;
  /** 忽略提醒：保留页签内容，只把基线对齐到磁盘版本。 */
  keepSourceVersions: () => Promise<void>;
};

/**
 * 「查看文档」的页签集合：多文件并排打开、源文件编辑、脏标记与关闭确认。
 * 与随手记、接口卡片一致地保持在渲染层，主进程只负责读写与落盘弹窗。
 */
export function useDocumentTabs(onClosePanel: () => void): DocumentTabsController {
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<DocumentPendingAction | null>(null);
  const [picking, setPicking] = useState(false);
  const tabsRef = useRef<DocumentTab[]>([]);
  const pickingRef = useRef(false);
  const nextTabIdRef = useRef(1);
  const closePanelRef = useRef(onClosePanel);

  useEffect(() => {
    closePanelRef.current = onClosePanel;
  }, [onClosePanel]);

  /** 状态与 ref 同步推进，异步保存流程才能读到最新内容。 */
  const applyTabs = useCallback((updater: (current: DocumentTab[]) => DocumentTab[]) => {
    const next = updater(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const patchTab = useCallback(
    (tabId: string, patch: Partial<DocumentTab>) => {
      applyTabs((current) =>
        current.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab))
      );
    },
    [applyTabs]
  );

  const createTab = useCallback((path: string): DocumentTab => {
    const kind = resolveDocumentViewKind(path);
    return {
      id: `document-tab-${nextTabIdRef.current++}`,
      path,
      title: getDocumentFileName(path),
      content: "",
      savedContent: "",
      kind,
      mode: getDefaultDocumentViewMode(kind),
      lineEnding: "lf",
      truncated: false,
      binary: false,
      loading: true,
      error: null,
      sourceMtimeMs: null,
      sourceChanged: false
    };
  }, []);

  const loadTab = useCallback(
    async (tabId: string, path: string) => {
      try {
        const result = await window.codexh.readDocumentFile({ path });
        const normalized = result.content.replace(/\r\n?/g, "\n");
        patchTab(tabId, {
          content: normalized,
          savedContent: normalized,
          truncated: result.truncated,
          binary: result.binary,
          lineEnding: detectLineEnding(result.content),
          loading: false,
          error: null,
          sourceMtimeMs: result.mtimeMs,
          sourceChanged: false
        });
      } catch (error) {
        patchTab(tabId, {
          content: "",
          savedContent: "",
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    [patchTab]
  );

  /**
   * 打开一批已知绝对路径的文档：文件对话框与从系统拖入共用这一份加载逻辑。
   * 文件对话框按路径去重，已打开的直接激活；拖入时每次都新开页签。
   */
  const openPaths = useCallback(
    async (paths: string[], options?: { openDuplicatePaths?: boolean }) => {
      const current = tabsRef.current;
      const opened: DocumentTab[] = [];
      let focusId: string | null = null;
      for (const path of paths) {
        // 拖入时只在一批拖入内部去重，不查面板里已打开的页签：已有文件打开时再拖入也会新开一个页签。
        const existing = options?.openDuplicatePaths
          ? opened.find((tab) => tab.path === path)
          : current.find((tab) => tab.path === path)
            ?? opened.find((tab) => tab.path === path);
        if (existing) {
          focusId = existing.id;
          continue;
        }
        const tab = createTab(path);
        opened.push(tab);
        focusId = tab.id;
      }
      if (opened.length > 0) {
        applyTabs((latest) => [...latest, ...opened]);
      }
      if (focusId) {
        setActiveTabId(focusId);
      }
      for (const tab of opened) {
        void loadTab(tab.id, tab.path);
      }
    },
    [applyTabs, createTab, loadTab]
  );

  const openDocuments = useCallback(async () => {
    if (pickingRef.current) {
      return;
    }
    pickingRef.current = true;
    setPicking(true);
    try {
      const chosen = await window.codexh.chooseDocumentFiles({
        extensions: DOCUMENT_CHOOSE_EXTENSIONS
      });
      if (!chosen || chosen.length === 0) {
        return;
      }
      await openPaths(chosen);
    } catch (error) {
      // 选择失败不改动已有页签，仅记录在终端可见的控制台，避免打断已有编辑。
      console.error("[document-viewer] 打开文档失败", error);
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }, [openPaths]);

  /**
   * 从系统拖入的文件：路径已由预加载脚本解析好，复用页签打开流程。
   * 拖入总是新开页签，面板里已有文件打开时也不会顶掉或复用现有页签。
   */
  const openDroppedPaths = useCallback(
    async (paths: string[]) => {
      await openPaths(paths, { openDuplicatePaths: true });
    },
    [openPaths]
  );

  /**
   * 新建空白页：不读磁盘、不占路径，直接给一个可编辑的空页签。
   * 已经有一个没改过的空白页时复用它，连点「+」不会堆出一排空页签。
   */
  const newBlankDocument = useCallback(() => {
    const current = tabsRef.current;
    const reusable = current.find(
      (tab) => !tab.path && !isDocumentDirty(tab.content, tab.savedContent)
    );
    if (reusable) {
      setActiveTabId(reusable.id);
      setPendingAction(null);
      return;
    }
    const tab: DocumentTab = {
      id: `document-tab-${nextTabIdRef.current++}`,
      path: "",
      title: getNextUntitledDocumentTitle(current.map((item) => item.title)),
      content: "",
      savedContent: "",
      kind: "text",
      mode: "source",
      lineEnding: "lf",
      truncated: false,
      binary: false,
      loading: false,
      error: null,
      sourceMtimeMs: null,
      sourceChanged: false
    };
    applyTabs((latest) => [...latest, tab]);
    setActiveTabId(tab.id);
    setPendingAction(null);
  }, [applyTabs]);

  /**
   * 把自己的一次保存也排除在「外部更新」之外：刚写完盘就把基线对齐到新的时间戳，
   * 否则保存本身会被下一次检查误判成磁盘版本变了。
   */
  const refreshSourceBaseline = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab?.path) {
        return;
      }
      try {
        const [stamp] = await window.codexh.statDocumentFiles({ paths: [tab.path] });
        patchTab(tabId, { sourceMtimeMs: stamp?.mtimeMs ?? null, sourceChanged: false });
      } catch {
        // 查不到就保留原基线，下一次检查会重新判断。
      }
    },
    [patchTab]
  );

  /**
   * 面板打开期间检查源文件更新：只对已经落盘的页签查最后修改时间，
   * 与基线不一致就标记出来，由用户在界面上决定重新加载还是保留当前内容。
   * 结果按请求顺序对应页签，因此不依赖两边路径字符串完全一致。
   */
  const checkSourceUpdates = useCallback(async () => {
    const targets = tabsRef.current.filter((tab) => Boolean(tab.path) && !tab.binary);
    if (targets.length === 0) {
      return;
    }
    try {
      const stamps = await window.codexh.statDocumentFiles({ paths: targets.map((tab) => tab.path) });
      const mtimeByTabId = new Map<string, number | null>();
      targets.forEach((tab, index) => {
        const stamp = stamps[index];
        if (stamp) {
          mtimeByTabId.set(tab.id, stamp.mtimeMs);
        }
      });
      applyTabs((current) =>
        current.map((tab) => {
          if (!mtimeByTabId.has(tab.id)) {
            return tab;
          }
          const changed = hasDocumentSourceChanged(tab.sourceMtimeMs, mtimeByTabId.get(tab.id) ?? null);
          return changed === tab.sourceChanged ? tab : { ...tab, sourceChanged: changed };
        })
      );
    } catch {
      // 检查失败不打扰用户，下一个间隔会重试。
    }
  }, [applyTabs]);

  const reloadSourceUpdates = useCallback(async () => {
    const targets = tabsRef.current.filter((tab) => tab.sourceChanged && tab.path);
    for (const tab of targets) {
      await loadTab(tab.id, tab.path);
    }
  }, [loadTab]);

  const keepSourceVersions = useCallback(async () => {
    const targets = tabsRef.current.filter((tab) => tab.sourceChanged && tab.path);
    for (const tab of targets) {
      await refreshSourceBaseline(tab.id);
    }
  }, [refreshSourceBaseline]);

  const selectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setPendingAction(null);
  }, []);

  const removeTab = useCallback(
    (tabId: string) => {
      const current = tabsRef.current;
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) {
        return;
      }
      const next = current.filter((tab) => tab.id !== tabId);
      applyTabs(() => next);
      setActiveTabId((currentId) => {
        if (currentId !== tabId) {
          return currentId;
        }
        // 关掉当前页签后落到右邻，没有右邻就落到左邻。
        return next[Math.min(index, next.length - 1)]?.id ?? null;
      });
    },
    [applyTabs]
  );

  const saveTabAs = useCallback(
    async (tabId: string): Promise<boolean> => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) {
        return false;
      }
      try {
        const savedPath = await window.codexh.saveDocumentFileAs({
          // 空白页还没有落盘位置，给一个按标题推导的默认文件名。
          suggestedPath: tab.path || getUntitledDocumentSuggestedFileName(tab.title),
          content: applyLineEnding(tab.content, tab.lineEnding)
        });
        if (!savedPath) {
          return false;
        }
        const kind = resolveDocumentViewKind(savedPath);
        patchTab(tabId, {
          path: savedPath,
          title: getDocumentFileName(savedPath),
          kind,
          savedContent: tab.content,
          truncated: false,
          binary: false,
          error: null
        });
        // 换了路径要重新记基线，否则刚另存出来的文件会被当成「磁盘上有更新」。
        await refreshSourceBaseline(tabId);
        return true;
      } catch (error) {
        patchTab(tabId, {
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [patchTab, refreshSourceBaseline]
  );

  const saveTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab || tab.binary || tab.loading) {
        return false;
      }
      if (!tab.path) {
        // 空白页没有落盘位置，保存即另存为，避免往空路径上写文件。
        return saveTabAs(tabId);
      }
      if (tab.truncated) {
        // 只读到前 512 KB 就写回会把文件截断，直接拒绝并说明原因。
        patchTab(tabId, { error: "文件超过预览上限，只读到了前 512 KB，已取消保存以免截断原文件。" });
        return false;
      }
      try {
        await window.codexh.writeDocumentFile({
          path: tab.path,
          content: applyLineEnding(tab.content, tab.lineEnding)
        });
        patchTab(tabId, { savedContent: tab.content, error: null });
        // 保存本身也会改 mtime，先把基线推到这个新版本，免得自己触发一次更新提醒。
        await refreshSourceBaseline(tabId);
        return true;
      } catch (error) {
        patchTab(tabId, {
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [patchTab, refreshSourceBaseline, saveTabAs]
  );

  const requestCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) {
        return;
      }
      if (isDocumentDirty(tab.content, tab.savedContent) && !tab.binary) {
        setPendingAction({ type: "closeTab", tabId });
        return;
      }
      removeTab(tabId);
    },
    [removeTab]
  );

  const requestClosePanel = useCallback(() => {
    const dirty = tabsRef.current.filter(
      (tab) => !tab.binary && isDocumentDirty(tab.content, tab.savedContent)
    );
    if (dirty.length === 0) {
      closePanelRef.current();
      return;
    }
    setPendingAction({ type: "closePanel" });
  }, []);

  const resolvePendingAction = useCallback(
    async (decision: "save" | "discard") => {
      const action = pendingAction;
      if (!action) {
        return;
      }
      if (decision === "save") {
        const dirty = tabsRef.current.filter(
          (tab) => !tab.binary && isDocumentDirty(tab.content, tab.savedContent)
        );
        for (const tab of dirty) {
          const saved = await saveTab(tab.id);
          if (!saved) {
            // 任一页签保存失败就中止，保留现场让用户处理。
            return;
          }
        }
      }
      setPendingAction(null);
      if (action.type === "closeTab") {
        removeTab(action.tabId);
        return;
      }
      closePanelRef.current();
    },
    [pendingAction, removeTab, saveTab]
  );

  const cancelPendingAction = useCallback(() => setPendingAction(null), []);

  const updateContent = useCallback(
    (tabId: string, content: string) => patchTab(tabId, { content }),
    [patchTab]
  );

  const setTabMode = useCallback(
    (tabId: string, mode: DocumentViewMode) => patchTab(tabId, { mode }),
    [patchTab]
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  );

  const dirtyCount = useMemo(
    () => tabs.filter((tab) => !tab.binary && isDocumentDirty(tab.content, tab.savedContent)).length,
    [tabs]
  );

  /** 被磁盘改动过的页签标题，面板据此显示一条提醒与两个处理入口。 */
  const changedSourceTitles = useMemo(
    () => tabs.filter((tab) => tab.sourceChanged).map((tab) => tab.title),
    [tabs]
  );

  return {
    tabs,
    activeTabId,
    activeTab,
    pendingAction,
    picking,
    dirtyCount,
    changedSourceTitles,
    openDocuments,
    openDroppedPaths,
    newBlankDocument,
    selectTab,
    requestCloseTab,
    requestClosePanel,
    resolvePendingAction,
    cancelPendingAction,
    updateContent,
    setTabMode,
    saveTab,
    saveTabAs,
    checkSourceUpdates,
    reloadSourceUpdates,
    keepSourceVersions
  };
}
