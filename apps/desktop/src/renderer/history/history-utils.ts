import type { ThreadRecord } from "@shared-types";

export const HISTORY_THREADS_PREVIEW_COUNT = 10;
export const HISTORY_STANDALONE_GROUP_KEY = "__standalone__";
export const HISTORY_COLLAPSED_GROUPS_STORAGE_KEY = "codexh.history-collapsed-groups";

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
