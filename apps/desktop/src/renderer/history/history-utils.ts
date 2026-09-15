import type { ThreadRecord } from "@shared-types";

export const HISTORY_THREADS_PREVIEW_COUNT = 10;
export const HISTORY_STANDALONE_GROUP_KEY = "__standalone__";
export const HISTORY_EXPANDED_GROUPS_STORAGE_KEY = "codexh.history-expanded-groups";

export function isHistoryProjectGroupCollapsed(
  expandedGroupKeys: ReadonlySet<string>,
  groupKey: string,
  collapsible = true
): boolean {
  return collapsible && !expandedGroupKeys.has(groupKey);
}

export function normalizeHistoryGroupKey(cwd: string): string {
  return cwd.replace(/\\/g, "/").toLocaleLowerCase();
}

export function readStoredStringSet(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

export function writeStoredStringSet(key: string, values: Set<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // Ignore quota and private-mode write failures.
  }
}

export const HISTORY_DELETE_DRAG_THRESHOLD_PX = 16;
export const HISTORY_DELETE_PRESS_MS = 220;
export const HISTORY_DELETE_DROP_PADDING_PX = 28;
export const HISTORY_DELETE_SWALLOW_MS = 280;
export const HISTORY_DELETE_DRAG_IGNORE_SELECTOR = "input, .history-project-more, .history-item-rename-input, .history-item-select";

export type HistoryDeleteDragTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "threads"; threadIds: string[] }
  | { kind: "folder"; cwd: string; threadIds: string[] };

export function resolveHistoryDeleteDragTarget(input: {
  source: "thread" | "folder";
  threadId?: string;
  folderCwd?: string;
  selectedThreadIds: readonly string[];
  folderThreadIds?: readonly string[];
  deletableThreadIds: readonly string[];
}): HistoryDeleteDragTarget | null {
  const deletable = new Set(input.deletableThreadIds);
  if (input.source === "folder") {
    const folderThreadIds = input.folderThreadIds ?? [];
    if (!input.folderCwd || folderThreadIds.length === 0) return null;
    if (folderThreadIds.some((threadId) => !deletable.has(threadId))) return null;
    return { kind: "folder", cwd: input.folderCwd, threadIds: [...folderThreadIds] };
  }
  if (!input.threadId || !deletable.has(input.threadId)) return null;
  const selected = input.selectedThreadIds.filter((threadId) => deletable.has(threadId));
  if (selected.includes(input.threadId) && selected.length > 1) {
    return { kind: "threads", threadIds: selected };
  }
  return { kind: "thread", threadId: input.threadId };
}

export function historyDeleteDragCount(target: HistoryDeleteDragTarget): number {
  return target.kind === "thread" ? 1 : target.threadIds.length;
}

export function historyDeleteGhostCopy(
  target: HistoryDeleteDragTarget,
  names: { threadTitle?: string; folderName?: string }
): { label: string; detail: string } {
  if (target.kind === "thread") {
    return { label: names.threadTitle?.trim() || "聊天记录", detail: "拖到垃圾桶删除" };
  }
  if (target.kind === "folder") {
    return {
      label: names.folderName?.trim() || "项目文件夹",
      detail: `共 ${target.threadIds.length} 个聊天`
    };
  }
  return { label: `${target.threadIds.length} 个聊天记录`, detail: "拖到垃圾桶删除" };
}

export function shouldIgnoreHistoryDeleteDragFrom(
  target: { closest?: (selector: string) => unknown; parentElement?: { closest?: (selector: string) => unknown } } | null | undefined
): boolean {
  const element = typeof target?.closest === "function" ? target : target?.parentElement;
  return typeof element?.closest === "function" && Boolean(element.closest(HISTORY_DELETE_DRAG_IGNORE_SELECTOR));
}

export function expandRect(
  rect: { left: number; top: number; right: number; bottom: number } | null | undefined,
  padding: number
): { left: number; top: number; right: number; bottom: number } | null {
  if (!rect) return null;
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding
  };
}

export function isPointInRect(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number } | null | undefined
): boolean {
  if (!rect) return false;
  return x >= rect.left && y >= rect.top && x <= rect.right && y <= rect.bottom;
}

export function shouldStartHistoryDeleteDrag(distance: number, threshold = HISTORY_DELETE_DRAG_THRESHOLD_PX): boolean {
  return distance >= threshold;
}

export function shouldShowHistoryPressCursor(heldMs: number, delay = HISTORY_DELETE_PRESS_MS): boolean {
  return heldMs >= delay;
}

export function pickVisibleHistoryThreads(
  threads: ThreadRecord[],
  options: { expanded: boolean; previewCount: number; selectedThreadId: string | null }
): { visibleThreads: ThreadRecord[]; hiddenCount: number; canExpand: boolean } {
  const canExpand = threads.length > options.previewCount;
  if (options.expanded || !canExpand) {
    return { visibleThreads: threads, hiddenCount: 0, canExpand };
  }

  const preview = threads.slice(0, options.previewCount);
  const hiddenCount = threads.length - preview.length;
  if (!options.selectedThreadId || preview.some((thread) => thread.id === options.selectedThreadId)) {
    return { visibleThreads: preview, hiddenCount, canExpand };
  }

  const selected = threads.find((thread) => thread.id === options.selectedThreadId);
  if (!selected) {
    return { visibleThreads: preview, hiddenCount, canExpand };
  }

  return {
    visibleThreads: [...preview.slice(0, Math.max(0, options.previewCount - 1)), selected],
    hiddenCount,
    canExpand
  };
}
