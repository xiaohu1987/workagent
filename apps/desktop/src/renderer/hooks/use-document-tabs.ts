import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DOCUMENT_CHOOSE_EXTENSIONS,
  getDefaultDocumentViewMode,
  getDocumentFileName,
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
  openDocuments: () => Promise<void>;
  openDroppedPaths: (paths: string[]) => Promise<void>;
  selectTab: (tabId: string) => void;
  requestCloseTab: (tabId: string) => void;
  requestClosePanel: () => void;
  resolvePendingAction: (decision: "save" | "discard") => Promise<void>;
  cancelPendingAction: () => void;
  updateContent: (tabId: string, content: string) => void;
  setTabMode: (tabId: string, mode: DocumentViewMode) => void;
  saveTab: (tabId: string) => Promise<boolean>;
  saveTabAs: (tabId: string) => Promise<boolean>;
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
      error: null
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
          error: null
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
   * 打开一批已知绝对路径的文档：文件对话框与从系统拖入共用这一份加载逻辑，
   * 同一路径只保留一个页签，已打开的直接激活而不是重复开。
   */
  const openPaths = useCallback(
    async (paths: string[]) => {
      const current = tabsRef.current;
      const opened: DocumentTab[] = [];
      let focusId: string | null = null;
      for (const path of paths) {
        const existing = current.find((tab) => tab.path === path)
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

  /** 从系统拖入的文件：路径已由预加载脚本解析好，直接复用页签打开流程。 */
  const openDroppedPaths = useCallback(
    async (paths: string[]) => {
      await openPaths(paths);
    },
    [openPaths]
  );

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

  const saveTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab || tab.binary || tab.loading) {
        return false;
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
        return true;
      } catch (error) {
        patchTab(tabId, {
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [patchTab]
  );

  const saveTabAs = useCallback(
    async (tabId: string): Promise<boolean> => {
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!tab) {
        return false;
      }
      try {
        const savedPath = await window.codexh.saveDocumentFileAs({
          suggestedPath: tab.path,
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
        return true;
      } catch (error) {
        patchTab(tabId, {
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
    },
    [patchTab]
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

  return {
    tabs,
    activeTabId,
    activeTab,
    pendingAction,
    picking,
    dirtyCount,
    openDocuments,
    openDroppedPaths,
    selectTab,
    requestCloseTab,
    requestClosePanel,
    resolvePendingAction,
    cancelPendingAction,
    updateContent,
    setTabMode,
    saveTab,
    saveTabAs
  };
}
