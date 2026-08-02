import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useState } from "react";
import type { ThreadRecord } from "@shared-types";
import { canDeleteThread, getHistoryItemAffordance } from "../core/thread-ui-state";
import { useMotionPresence } from "../core/motion-presence";
import { getFileLeafName } from "../markdown";
import {
  IconChevronDown,
  IconChevronRight,
  IconCompose,
  IconFolder,
  IconGear,
  IconHelpCircle,
  IconNotebook,
  IconPin,
  IconPlus,
  IconRename,
  IconSearch,
  IconSkills,
  IconTrash
} from "../icons";
import { HISTORY_STANDALONE_GROUP_KEY, HISTORY_THREADS_PREVIEW_COUNT, normalizeHistoryGroupKey, pickVisibleHistoryThreads } from "./history-utils";
import { WorkspaceContextMenu } from "../workspace/panels";

type ProjectGroup = { cwd: string; threads: ThreadRecord[] };
type RenameState = { id: string; title: string } | null;

type Props = {
  threads: ThreadRecord[];
  projectGroups: ProjectGroup[];
  standaloneThreads: ThreadRecord[];
  selectedThreadId: string | null;
  deletingThreadId: string | null;
  collapsedGroups: Set<string>;
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>;
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
  onBeginRename: (thread: ThreadRecord) => void;
};

export function HistorySidebar({ threads, projectGroups, standaloneThreads, selectedThreadId, deletingThreadId, collapsedGroups, setCollapsedGroups, expandedGroups, setExpandedGroups, renamingThread, setRenamingThread, onCommitRename, onCancelRename, onCreateThread, onOpenThread, onOpenQuickNotes, onOpenSearch, onOpenSettings, updatePhase, updateReminder, onOpenHelp, isGeneratingUserSkill, onGenerateUserSkill, onTogglePinned, onRequestDelete, onBeginRename }: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; thread: ThreadRecord } | null>(null);
  const contextPresence = useMotionPresence(contextMenu, 140);
  const visibleContextMenu = contextMenu ?? contextPresence.value;

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
    return (
      <div key={thread.id} className={`history-item history-item-${thread.mode} ${selectedThreadId === thread.id ? "selected" : ""} ${running ? "running" : ""} ${deletingThreadId === thread.id ? "is-removing" : ""}`} title={running ? affordance.title : undefined} aria-busy={running} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, thread }); }}>
        {renaming ? <input className="history-item-rename-input" autoFocus value={renamingThread.title} aria-label="重命名任务" onFocus={(event) => event.currentTarget.select()} onChange={(event) => setRenamingThread({ id: thread.id, title: event.target.value })} onBlur={(event) => void onCommitRename(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === "Escape") { event.preventDefault(); onCancelRename(); } }} onClick={(event) => event.stopPropagation()} /> : <button type="button" className="history-item-main" onClick={() => void onOpenThread(thread.id, { scrollToLatest: true })}><span className="history-item-label">{thread.title}</span>{thread.isPinned ? <span className="history-item-pin" title="已置顶" aria-label="已置顶"><IconPin /></span> : null}</button>}
      </div>
    );
  }

  function renderGroup(groupKey: string, groupThreads: ThreadRecord[], options?: { heading?: ReactNode; title?: string; ariaLabel: string; className?: string; collapsible?: boolean }) {
    const collapsible = options?.collapsible !== false;
    const collapsed = collapsible && collapsedGroups.has(groupKey);
    const expanded = expandedGroups.has(groupKey);
    const { visibleThreads, hiddenCount, canExpand } = pickVisibleHistoryThreads(groupThreads, { expanded, previewCount: HISTORY_THREADS_PREVIEW_COUNT, selectedThreadId });
    return <section key={groupKey} className={`history-project-group ${options?.className ?? ""} ${collapsed ? "is-collapsed" : ""}`} aria-label={options?.ariaLabel}>
      {options?.heading ? (collapsible ? <button type="button" className="history-project-heading" title={options.title} aria-expanded={!collapsed} onClick={() => toggleGroup(setCollapsedGroups, groupKey)}><span className={`history-project-disclosure ${collapsed ? "" : "is-expanded"}`} aria-hidden><IconChevronRight /></span>{options.heading}</button> : <div className="history-standalone-heading" title={options.title}>{options.heading}</div>) : null}
      {!collapsed ? <div className="history-project-threads">{visibleThreads.map(renderThread)}{canExpand ? <button type="button" className={`history-project-more ${expanded ? "is-expanded" : ""}`} aria-expanded={expanded} onClick={() => toggleGroup(setExpandedGroups, groupKey)}><span>{expanded ? "收起" : `展开更多 (${hiddenCount})`}</span><IconChevronDown /></button> : null}</div> : null}
    </section>;
  }

  return <aside className="sidebar">
    <div className="sidebar-scroll">
      <div className="sidebar-brand-row"><div className="sidebar-brand"><strong>Code<span className="sidebar-brand-accent">XH</span></strong><span>AI Workspace</span></div><div className="sidebar-brand-tools"><button className="sidebar-search sidebar-quick-notes" type="button" title="随手记" aria-label="随手记" onClick={() => void onOpenQuickNotes()}><IconNotebook /></button><button className="sidebar-search" type="button" title="搜索历史对话" onClick={onOpenSearch}><IconSearch /></button></div></div>
      <div className="sidebar-nav"><button className="sidebar-nav-button" onClick={() => void onCreateThread("chat")}><span className="sidebar-nav-icon"><IconCompose /></span><span>新建任务</span></button><button className="sidebar-nav-button" onClick={() => void onCreateThread("project")}><span className="sidebar-nav-icon"><IconFolder /></span><span>新建项目</span><span className="sidebar-nav-plus"><IconPlus /></span></button></div>
      <div className="sidebar-section-title">项目</div>
      <div className="history-list">{threads.length === 0 ? <div className="history-empty">还没有任务</div> : <>{projectGroups.map((group) => renderGroup(normalizeHistoryGroupKey(group.cwd), group.threads, { ariaLabel: `项目 ${getFileLeafName(group.cwd)}`, title: group.cwd, heading: <><IconFolder /><span>{getFileLeafName(group.cwd)}</span></> }))}{standaloneThreads.length > 0 ? renderGroup(HISTORY_STANDALONE_GROUP_KEY, standaloneThreads, { ariaLabel: "其他任务", className: "history-standalone-group", collapsible: false, heading: projectGroups.length > 0 ? "其他任务" : undefined }) : null}</>}</div>
      {visibleContextMenu ? <WorkspaceContextMenu x={visibleContextMenu.x} y={visibleContextMenu.y} motionPhase={contextPresence.phase} onClose={() => setContextMenu(null)} actions={[
        ...(!visibleContextMenu.thread.parentThreadId && visibleContextMenu.thread.status !== "running" ? [{ id: "extract-history-thread-skill", label: isGeneratingUserSkill ? "正在提炼技能..." : "提炼技能", icon: <IconSkills />, onSelect: () => onGenerateUserSkill(visibleContextMenu.thread) }] : []),
        { id: "rename-history-thread", label: "重命名", icon: <IconRename />, onSelect: () => onBeginRename(visibleContextMenu.thread) },
        { id: "toggle-history-pin", label: visibleContextMenu.thread.isPinned ? "取消置顶" : "置顶任务", icon: <IconPin />, onSelect: () => void onTogglePinned(visibleContextMenu.thread) },
        ...(canDeleteThread(visibleContextMenu.thread.status, deletingThreadId) ? [{ id: "delete-history-thread", label: "删除任务", icon: <IconTrash />, destructive: true, onSelect: () => onRequestDelete(visibleContextMenu.thread) }] : [])
      ]} /> : null}
    </div>
    <div className="sidebar-settings"><button type="button" className="sidebar-settings-button" onClick={() => onOpenSettings("provider")}><span className="sidebar-settings-main"><IconGear /><span>设置</span></span></button>{updateReminder ? <button type="button" className={`sidebar-update-reminder ${updatePhase ?? ""}`} title="打开更新设置" onClick={() => onOpenSettings("update")}><span className="sidebar-update-reminder-dot" aria-hidden /><span>{updateReminder}</span></button> : null}<button type="button" className="sidebar-settings-help" title="产品说明与使用指南" aria-label="产品说明与使用指南" onClick={onOpenHelp}><IconHelpCircle /></button></div>
  </aside>;
}
