import { memo, useEffect, useRef, useState } from "react";
import type { Dispatch, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from "react";
import type { ThreadRecord } from "@shared-types";
import { canDeleteThread, getHistoryItemAffordance } from "../core/thread-ui-state";
import { useMotionPresence } from "../core/motion-presence";
import { getFileLeafName } from "../markdown";
import {
  IconChatBubbles,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCompose,
  IconFolder,
  IconFolders,
  IconGear,
  IconHelpCircle,
  IconNotebook,
  IconPin,
  IconPlus,
  IconRename,
  IconSearch,
  IconSkills
} from "../icons";
import {
  HISTORY_DELETE_DRAG_THRESHOLD_PX,
  HISTORY_DELETE_DROP_PADDING_PX,
  HISTORY_DELETE_PRESS_MS,
  HISTORY_DELETE_SWALLOW_MS,
  HISTORY_STANDALONE_GROUP_KEY,
  HISTORY_THREADS_PREVIEW_COUNT,
  expandRect,
  historyDeleteGhostCopy,
  isHistoryProjectGroupCollapsed,
  isPointInRect,
  normalizeHistoryGroupKey,
  pickVisibleHistoryThreads,
  resolveHistoryDeleteDragTarget,
  shouldIgnoreHistoryDeleteDragFrom,
  shouldStartHistoryDeleteDrag,
  type HistoryDeleteDragTarget
} from "./history-utils";
import { HistoryTrashOverlay } from "./history-trash-overlay";
import { WorkspaceContextMenu } from "../workspace/panels";

type ProjectGroup = { cwd: string; threads: ThreadRecord[] };
type RenameState = { id: string; title: string } | null;
type HistoryView = "projects" | "tasks";
type HistoryDragState = {
  pointerId: number;
  target: HistoryDeleteDragTarget;
  label: string;
  detail: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  hot: boolean;
  swallowing: boolean;
};

function isCollaborationThread(thread: ThreadRecord) {
  return (thread.workspaceRoots?.length ?? 0) > 1 || thread.title.startsWith("协作：");
}

type Props = {
  projectGroups: ProjectGroup[];
  standaloneThreads: ThreadRecord[];
  selectedThreadId: string | null;
  deletingThreadId: string | null;
  expandedProjectGroups: Set<string>;
  setExpandedProjectGroups: Dispatch<SetStateAction<Set<string>>>;
  expandedGroups: Set<string>;
  setExpandedGroups: Dispatch<SetStateAction<Set<string>>>;
  renamingThread: RenameState;
  setRenamingThread: Dispatch<SetStateAction<RenameState>>;
  onCommitRename: (title?: string) => Promise<void>;
  onCancelRename: () => void;
  onCreateThread: (mode: "chat" | "project") => Promise<void>;
  onOpenThread: (threadId: string, options?: { scrollToLatest?: boolean }) => Promise<void>;
  onOpenQuickNotes: () => Promise<void>;
  onOpenSearch: () => void;
  onOpenSettings: (tab: "provider" | "update") => void;
  updatePhase?: string;
  updateReminder: string | null;
  onOpenHelp: () => void;
  isGeneratingUserSkill: boolean;
  onGenerateUserSkill: (thread: ThreadRecord) => void;
  onTogglePinned: (thread: ThreadRecord) => Promise<void>;
  onRequestDelete: (thread: ThreadRecord) => void;
  onRequestBatchDelete: (threadIds: string[]) => void;
  batchDeleting?: boolean;
  onBeginRename: (thread: ThreadRecord) => void;
  onEditProject: (cwd: string) => void;
  onCreateProjectChat: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
};

export const HistorySidebar = memo(function HistorySidebar({ projectGroups, standaloneThreads, selectedThreadId, deletingThreadId, expandedProjectGroups, setExpandedProjectGroups, expandedGroups, setExpandedGroups, renamingThread, setRenamingThread, onCommitRename, onCancelRename, onCreateThread, onOpenThread, onOpenQuickNotes, onOpenSearch, onOpenSettings, updatePhase, updateReminder, onOpenHelp, isGeneratingUserSkill, onGenerateUserSkill, onTogglePinned, onRequestDelete, onRequestBatchDelete, batchDeleting = false, onBeginRename, onEditProject, onCreateProjectChat, onRemoveProject }: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; thread: ThreadRecord } | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; cwd: string } | null>(null);
  const [historyView, setHistoryView] = useState<HistoryView>(() => (
    selectedThreadId && standaloneThreads.some((thread) => thread.id === selectedThreadId) ? "tasks" : "projects"
  ));
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<HistoryDragState | null>(null);
  const contextPresence = useMotionPresence(contextMenu, 140);
  const visibleContextMenu = contextMenu ?? contextPresence.value;
  const currentViewThreads = historyView === "projects" ? projectGroups.flatMap((group) => group.threads) : standaloneThreads;
  const allHistoryThreads = [...projectGroups.flatMap((group) => group.threads), ...standaloneThreads];
  const selectableThreads = currentViewThreads.filter((thread) => canDeleteThread(thread.status, deletingThreadId) && !batchDeleting);
  const deletableThreadIds = allHistoryThreads
    .filter((thread) => canDeleteThread(thread.status, deletingThreadId) && !batchDeleting)
    .map((thread) => thread.id);
  const selectedCount = allHistoryThreads.filter((thread) => selectedThreadIds.has(thread.id) && canDeleteThread(thread.status, deletingThreadId)).length;
  const trashRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<HistoryDragState | null>(null);
  const suppressClickRef = useRef(false);
  const pointerActivatedAtRef = useRef(0);
  const swallowTimerRef = useRef<number | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const pendingDragRef = useRef<{
    pointerId: number;
    captureEl: HTMLElement;
    target: HistoryDeleteDragTarget;
    label: string;
    detail: string;
    startX: number;
    startY: number;
  } | null>(null);
  const commitDragDeleteRef = useRef<(target: HistoryDeleteDragTarget) => void>(() => undefined);
  dragRef.current = drag;

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedThreadIds(new Set());
  }

  function enterSelectionMode(threadIds: string[]) {
    setContextMenu(null);
    setProjectContextMenu(null);
    setSelectionMode(true);
    setSelectedThreadIds(new Set(threadIds.filter((threadId) => deletableThreadIds.includes(threadId))));
  }

  function toggleThreadSelection(thread: ThreadRecord) {
    if (!selectionMode || !canDeleteThread(thread.status, deletingThreadId) || batchDeleting) return;
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(thread.id)) next.delete(thread.id);
      else next.add(thread.id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      const allSelected = selectableThreads.length > 0 && selectableThreads.every((thread) => next.has(thread.id));
      for (const thread of selectableThreads) {
        if (allSelected) next.delete(thread.id);
        else next.add(thread.id);
      }
      return next;
    });
  }

  function commitDragDelete(target: HistoryDeleteDragTarget) {
    if (target.kind === "folder") {
      onRemoveProject(target.cwd);
      return;
    }
    if (target.kind === "threads") {
      onRequestBatchDelete(target.threadIds);
      exitSelectionMode();
      return;
    }
    const thread = allHistoryThreads.find((item) => item.id === target.threadId);
    if (thread) onRequestDelete(thread);
  }
  commitDragDeleteRef.current = commitDragDelete;

  function detachHistoryGesture() {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    gestureCleanupRef.current?.();
    gestureCleanupRef.current = null;
    pendingDragRef.current = null;
    document.body.classList.remove("is-history-pressing");
  }

  function assignDrag(next: HistoryDragState | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function clearDrag() {
    if (swallowTimerRef.current !== null) {
      window.clearTimeout(swallowTimerRef.current);
      swallowTimerRef.current = null;
    }
    detachHistoryGesture();
    assignDrag(null);
    document.body.classList.remove("is-history-trashing");
  }

  function activateHistoryThread(thread: ThreadRecord) {
    if (selectionMode) {
      toggleThreadSelection(thread);
      return;
    }
    setHistoryView(thread.mode === "project" && thread.cwd ? "projects" : "tasks");
    void onOpenThread(thread.id, { scrollToLatest: true });
  }

  function beginHistoryDrag(
    event: ReactPointerEvent<HTMLElement>,
    target: HistoryDeleteDragTarget | null,
    names: { threadTitle?: string; folderName?: string },
    onActivate?: () => void
  ) {
    if (event.button !== 0 || !target || batchDeleting) return;
    if (dragRef.current?.active || dragRef.current?.swallowing) return;
    if (shouldIgnoreHistoryDeleteDragFrom(event.target)) return;
    detachHistoryGesture();
    if (dragRef.current) assignDrag(null);

    const copy = historyDeleteGhostCopy(target, names);
    const pointerId = event.pointerId;
    const captureEl = event.currentTarget;
    pendingDragRef.current = {
      pointerId,
      captureEl,
      target,
      label: copy.label,
      detail: copy.detail,
      startX: event.clientX,
      startY: event.clientY
    };
    setContextMenu(null);
    setProjectContextMenu(null);
    pressTimerRef.current = window.setTimeout(() => {
      if (!pendingDragRef.current || pendingDragRef.current.pointerId !== pointerId) return;
      document.body.classList.add("is-history-pressing");
    }, HISTORY_DELETE_PRESS_MS);

    function dropRect() {
      return expandRect(trashRef.current?.getBoundingClientRect(), HISTORY_DELETE_DROP_PADDING_PX);
    }

    function onPointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      const current = dragRef.current;
      if (current?.swallowing) return;
      const pending = pendingDragRef.current;
      if (!current?.active) {
        if (!pending) return;
        const distance = Math.hypot(moveEvent.clientX - pending.startX, moveEvent.clientY - pending.startY);
        if (!shouldStartHistoryDeleteDrag(distance, HISTORY_DELETE_DRAG_THRESHOLD_PX)) return;
        suppressClickRef.current = true;
        captureEl.setPointerCapture?.(pointerId);
        document.body.classList.add("is-history-trashing");
        assignDrag({
          pointerId,
          target: pending.target,
          label: pending.label,
          detail: pending.detail,
          startX: pending.startX,
          startY: pending.startY,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          active: true,
          hot: isPointInRect(moveEvent.clientX, moveEvent.clientY, dropRect()),
          swallowing: false
        });
        return;
      }
      assignDrag({
        ...current,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        hot: isPointInRect(moveEvent.clientX, moveEvent.clientY, dropRect())
      });
    }

    function onPointerUp(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      const current = dragRef.current;
      if (!current?.active) {
        detachHistoryGesture();
        if (current) assignDrag(null);
        pointerActivatedAtRef.current = Date.now();
        onActivate?.();
        return;
      }
      if (!isPointInRect(upEvent.clientX, upEvent.clientY, dropRect())) {
        clearDrag();
        return;
      }
      suppressClickRef.current = true;
      assignDrag({ ...current, x: upEvent.clientX, y: upEvent.clientY, active: true, hot: true, swallowing: true });
      detachHistoryGesture();
      swallowTimerRef.current = window.setTimeout(() => {
        const dropped = current.target;
        clearDrag();
        commitDragDeleteRef.current(dropped);
      }, HISTORY_DELETE_SWALLOW_MS);
    }

    function onPointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== pointerId) return;
      if (dragRef.current?.swallowing) return;
      clearDrag();
    }

    function onKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key === "Escape") clearDrag();
    }

    gestureCleanupRef.current = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      if (captureEl.hasPointerCapture?.(pointerId)) captureEl.releasePointerCapture(pointerId);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown);
  }

  useEffect(() => () => {
    document.body.classList.remove("is-history-trashing", "is-history-pressing");
    gestureCleanupRef.current?.();
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    if (swallowTimerRef.current !== null) window.clearTimeout(swallowTimerRef.current);
  }, []);

  useEffect(() => {
    if (!selectionMode) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !dragRef.current) exitSelectionMode();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectionMode]);

  function consumeSuppressedClick(event: { preventDefault: () => void; stopPropagation: () => void }) {
    const pointerActivated = Date.now() - pointerActivatedAtRef.current < 400;
    if (!suppressClickRef.current && !pointerActivated) return false;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
    pointerActivatedAtRef.current = 0;
    return true;
  }

  function toggleGroup(setter: Dispatch<SetStateAction<Set<string>>>, groupKey: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  function renderThread(thread: ThreadRecord) {
    const affordance = getHistoryItemAffordance(thread.status);
    const running = affordance.kind === "running-indicator";
    const renaming = renamingThread?.id === thread.id;
    const draggable = !running && !renaming && canDeleteThread(thread.status, deletingThreadId) && !batchDeleting;
    const draggingIds = drag?.active || drag?.swallowing
      ? drag.target.kind === "thread" ? [drag.target.threadId] : drag.target.threadIds
      : [];
    return (
      <div
        key={thread.id}
        className={`history-item history-item-${thread.mode} ${selectedThreadId === thread.id ? "selected" : ""} ${running ? "running" : ""} ${deletingThreadId === thread.id ? "is-removing" : ""} ${selectionMode && selectedThreadIds.has(thread.id) ? "is-checked" : ""} ${draggingIds.includes(thread.id) ? "is-dragging-trash" : ""} ${draggable ? "is-draggable" : ""}`}
        title={running ? affordance.title : draggable ? "拖到垃圾桶删除" : undefined}
        aria-busy={running}
        onPointerDown={draggable ? (event) => beginHistoryDrag(event, resolveHistoryDeleteDragTarget({
          source: "thread",
          threadId: thread.id,
          selectedThreadIds: [...selectedThreadIds],
          deletableThreadIds
        }), { threadTitle: thread.title }, () => activateHistoryThread(thread)) : undefined}
        onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, thread }); }}
      >
        {selectionMode && !renaming ? <button type="button" className={`history-item-select ${selectedThreadIds.has(thread.id) ? "is-selected" : ""}`} aria-label={`${selectedThreadIds.has(thread.id) ? "取消选择" : "选择"} ${thread.title}`} aria-pressed={selectedThreadIds.has(thread.id)} disabled={!canDeleteThread(thread.status, deletingThreadId) || batchDeleting} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); if (consumeSuppressedClick(event)) return; toggleThreadSelection(thread); }}><span aria-hidden="true">{selectedThreadIds.has(thread.id) ? <IconCheck /> : null}</span></button> : null}
        {renaming ? <input className="history-item-rename-input" autoFocus value={renamingThread.title} aria-label="重命名任务" onFocus={(event) => event.currentTarget.select()} onChange={(event) => setRenamingThread({ id: thread.id, title: event.target.value })} onBlur={(event) => void onCommitRename(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") { event.preventDefault(); onCancelRename(); } }} onClick={(event) => event.stopPropagation()} /> : <button type="button" className="history-item-main" onClick={(event) => { if (consumeSuppressedClick(event)) return; activateHistoryThread(thread); }}><span className="history-item-label">{thread.title}</span>{thread.isPinned ? <span className="history-item-pin" title="已置顶" aria-label="已置顶"><IconPin /></span> : null}</button>}
      </div>
    );
  }

  function renderGroup(groupKey: string, groupThreads: ThreadRecord[], options?: { heading?: ReactNode; title?: string; ariaLabel: string; className?: string; collapsible?: boolean; folderCwd?: string }) {
    const collapsible = options?.collapsible !== false;
    const collapsed = isHistoryProjectGroupCollapsed(expandedProjectGroups, groupKey, collapsible);
    const expanded = expandedGroups.has(groupKey);
    const { visibleThreads, hiddenCount, canExpand } = pickVisibleHistoryThreads(groupThreads, { expanded, previewCount: HISTORY_THREADS_PREVIEW_COUNT, selectedThreadId });
    const folderTarget = options?.folderCwd
      ? resolveHistoryDeleteDragTarget({
          source: "folder",
          folderCwd: options.folderCwd,
          selectedThreadIds: [...selectedThreadIds],
          folderThreadIds: groupThreads.map((thread) => thread.id),
          deletableThreadIds
        })
      : null;
    const draggingFolder = Boolean(drag && (drag.active || drag.swallowing) && drag.target.kind === "folder" && options?.folderCwd && drag.target.cwd === options.folderCwd);
    return <section key={groupKey} className={`history-project-group ${options?.className ?? ""} ${collapsed ? "is-collapsed" : ""} ${draggingFolder ? "is-dragging-trash" : ""}`} aria-label={options?.ariaLabel}>
      {options?.heading ? (collapsible ? <button type="button" className={`history-project-heading ${folderTarget ? "is-draggable" : ""}`} title={folderTarget ? `${options.title} · 拖到垃圾桶删除` : options.title} aria-expanded={!collapsed} onPointerDown={folderTarget ? (event) => beginHistoryDrag(event, folderTarget, { folderName: getFileLeafName(options.folderCwd ?? "") }, () => toggleGroup(setExpandedProjectGroups, groupKey)) : undefined} onClick={(event) => { if (consumeSuppressedClick(event)) return; toggleGroup(setExpandedProjectGroups, groupKey); }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setProjectContextMenu({ x: event.clientX, y: event.clientY, cwd: options.folderCwd ?? options.title ?? "" }); }}><span className={`history-project-disclosure ${collapsed ? "" : "is-expanded"}`} aria-hidden><IconChevronRight /></span>{options.heading}</button> : <div className="history-standalone-heading" title={options.title}>{options.heading}</div>) : null}
      {!collapsed ? <div className="history-project-threads">{visibleThreads.map(renderThread)}{canExpand ? <button type="button" className={`history-project-more ${expanded ? "is-expanded" : ""}`} aria-expanded={expanded} onClick={() => toggleGroup(setExpandedGroups, groupKey)}><span>{expanded ? "收起" : `展开更多 (${hiddenCount})`}</span><IconChevronDown /></button> : null}</div> : null}
    </section>;
  }

  return <aside className="sidebar">
    <div className="sidebar-scroll">
      <div className="sidebar-brand-row"><div className="sidebar-brand"><strong>Code<span className="sidebar-brand-accent">XH</span></strong><span>AI Workspace</span></div><div className="sidebar-brand-tools"><button className="sidebar-search sidebar-quick-notes" type="button" title="随手记" aria-label="随手记" onClick={() => void onOpenQuickNotes()}><IconNotebook /></button><button className="sidebar-search" type="button" title="搜索历史对话" onClick={onOpenSearch}><IconSearch /></button></div></div>
      <div className="sidebar-nav"><button className="sidebar-nav-button" onClick={() => { setHistoryView("tasks"); void onCreateThread("chat"); }}><span className="sidebar-nav-icon"><IconChatBubbles /></span><span>新建任务</span></button><button className="sidebar-nav-button" onClick={() => { setHistoryView("projects"); void onCreateThread("project"); }}><span className="sidebar-nav-icon"><IconFolder /></span><span>新建项目</span><span className="sidebar-nav-plus"><IconPlus /></span></button></div>
      <div className="sidebar-history-tabs" role="tablist" aria-label="历史列表">
        <button type="button" className={`sidebar-history-tab ${historyView === "projects" ? "active" : ""}`} role="tab" aria-selected={historyView === "projects"} title="项目" aria-label="显示项目" onClick={() => setHistoryView("projects")}><IconFolder /></button>
        <button type="button" className={`sidebar-history-tab ${historyView === "tasks" ? "active" : ""}`} role="tab" aria-selected={historyView === "tasks"} title="普通聊天" aria-label="显示普通聊天" onClick={() => setHistoryView("tasks")}><IconChatBubbles /></button>
      </div>
      <div className={`history-list history-list-${historyView}`} aria-label={historyView === "projects" ? "项目" : "其他任务"}>
        {selectionMode ? (
          <div className="history-selection-toolbar" aria-label="批量选择历史对话">
            <span className="history-selection-count">已选择 {selectedCount}</span>
            <button type="button" className="history-selection-action" onClick={toggleSelectAll} disabled={selectableThreads.length === 0 || batchDeleting}>{selectableThreads.length > 0 && selectableThreads.every((thread) => selectedThreadIds.has(thread.id)) ? "取消全选" : "全选"}</button>
            <button type="button" className="history-selection-close" onClick={exitSelectionMode} disabled={batchDeleting} title="退出批量选择"><IconClose /></button>
          </div>
        ) : null}
        {historyView === "projects" ? (
          projectGroups.length > 0 ? projectGroups.map((group) => {
            const collaborationProject = group.threads.some(isCollaborationThread);
            return renderGroup(normalizeHistoryGroupKey(group.cwd), group.threads, { ariaLabel: collaborationProject ? `协作项目 ${getFileLeafName(group.cwd)}` : `项目 ${getFileLeafName(group.cwd)}`, title: group.cwd, folderCwd: group.cwd, heading: <>{collaborationProject ? <IconFolders /> : <IconFolder />}<span>{getFileLeafName(group.cwd)}</span></> });
          }) : <div className="history-empty">还没有项目</div>
        ) : standaloneThreads.length > 0 ? renderGroup(HISTORY_STANDALONE_GROUP_KEY, standaloneThreads, { ariaLabel: "其他任务", className: "history-standalone-group", collapsible: false }) : <div className="history-empty">还没有其他任务</div>}
      </div>
      {visibleContextMenu ? <WorkspaceContextMenu x={visibleContextMenu.x} y={visibleContextMenu.y} motionPhase={contextPresence.phase} onClose={() => setContextMenu(null)} actions={[
        ...(!visibleContextMenu.thread.parentThreadId && visibleContextMenu.thread.status !== "running" ? [{ id: "extract-history-thread-skill", label: isGeneratingUserSkill ? "正在提炼技能..." : "提炼技能", icon: <IconSkills />, onSelect: () => onGenerateUserSkill(visibleContextMenu.thread) }] : []),
        { id: "rename-history-thread", label: "重命名", icon: <IconRename />, onSelect: () => onBeginRename(visibleContextMenu.thread) },
        { id: "toggle-history-pin", label: visibleContextMenu.thread.isPinned ? "取消置顶" : "置顶任务", icon: <IconPin />, onSelect: () => void onTogglePinned(visibleContextMenu.thread) },
        { id: "batch-select-history-thread", label: "批量选择", icon: <IconCheck />, onSelect: () => enterSelectionMode(
          selectionMode ? [...selectedThreadIds, visibleContextMenu.thread.id] : [visibleContextMenu.thread.id]
        ) }
      ]} /> : null}
      {projectContextMenu ? <WorkspaceContextMenu x={projectContextMenu.x} y={projectContextMenu.y} onClose={() => setProjectContextMenu(null)} actions={[
        { id: "edit-project", label: "编辑项目", icon: <IconFolders />, onSelect: () => onEditProject(projectContextMenu.cwd) },
        { id: "create-project-chat", label: "新建聊天", icon: <IconCompose />, onSelect: () => onCreateProjectChat(projectContextMenu.cwd) },
        { id: "batch-select-project", label: "批量选择", icon: <IconCheck />, onSelect: () => {
          const group = projectGroups.find((item) => item.cwd === projectContextMenu.cwd);
          enterSelectionMode((group?.threads ?? []).map((thread) => thread.id));
        } }
      ]} /> : null}
    </div>
    <div className="sidebar-settings"><button type="button" className="sidebar-settings-button" onClick={() => onOpenSettings("provider")}><span className="sidebar-settings-main"><IconGear /><span>设置</span></span></button>{updateReminder ? <button type="button" className={`sidebar-update-reminder ${updatePhase ?? ""}`} title="打开更新设置" onClick={() => onOpenSettings("update")}><span className="sidebar-update-reminder-dot" aria-hidden /><span>{updateReminder}</span></button> : null}<button type="button" className="sidebar-settings-help" title="产品说明与使用指南" aria-label="产品说明与使用指南" onClick={onOpenHelp}><IconHelpCircle /></button></div>
    <HistoryTrashOverlay
      active={Boolean(drag?.active || drag?.swallowing)}
      hot={Boolean(drag?.hot)}
      swallowing={Boolean(drag?.swallowing)}
      label={drag?.label ?? ""}
      detail={drag?.detail ?? ""}
      ghostX={drag?.x ?? 0}
      ghostY={drag?.y ?? 0}
      trashRef={trashRef}
    />
  </aside>;
});
