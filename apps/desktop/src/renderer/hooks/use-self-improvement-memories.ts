import { useEffect, useMemo, useRef, useState } from "react";
import type { SelfImprovementMemoryRecord, SelfImprovementMemoryScope, SelfImprovementMemoryStats } from "@shared-types";
import { getMemoryLastPageIndex, sortMemoryRecordsNewestFirst } from "../workspace/memory-pagination";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

/** `all` shows both scopes side by side; the other two isolate one scope. */
export type MemoryScopeFilter = "all" | SelfImprovementMemoryScope;

const EMPTY_STATS: SelfImprovementMemoryStats = { total: 0, global: 0, project: 0 };

export function useSelfImprovementMemories(showNotice: Notice) {
  const [memories, setMemories] = useState<SelfImprovementMemoryRecord[]>([]);
  const [stats, setStats] = useState<SelfImprovementMemoryStats>(EMPTY_STATS);
  const [scopeFilter, setScopeFilter] = useState<MemoryScopeFilter>("all");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const showNoticeRef = useRef(showNotice);
  showNoticeRef.current = showNotice;

  /** Memories narrowed to the active scope tab; pagination follows this list. */
  const visibleMemories = useMemo(
    () => (scopeFilter === "all" ? memories : memories.filter((memory) => memory.scope === scopeFilter)),
    [memories, scopeFilter]
  );

  async function refresh() {
    try {
      const [nextMemories, nextStats] = await Promise.all([
        window.codexh.listSelfImprovementMemories({ all: true, limit: 1_000 }) as Promise<SelfImprovementMemoryRecord[]>,
        window.codexh.countSelfImprovementMemories() as Promise<SelfImprovementMemoryStats>
      ]);
      const sorted = sortMemoryRecordsNewestFirst(nextMemories);
      setMemories(sorted);
      setStats(nextStats ?? EMPTY_STATS);
      setPage((current) => Math.min(current, getMemoryLastPageIndex(sorted.length)));
    } catch (error) {
      showNoticeRef.current("加载记忆失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Background distillation reports through a runtime event, so the list stays
  // current without the user re-opening the settings page.
  useEffect(() => {
    const dispose = window.codexh.onRuntimeEvent((event) => {
      if ((event as { type?: string } | null)?.type === "memory.updated") void refresh();
    });
    return dispose;
  }, []);

  async function refreshNow() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const result = await window.codexh.refreshSelfImprovementMemories();
      await refresh();
      showNotice(result.processed > 0 || result.pruned > 0
        ? `记忆已更新：提炼 ${result.processed} 条，清理 ${result.pruned} 条`
        : "没有可提炼的任务（已处理的任务不会重复提炼）", { tone: "success" });
    } catch (error) {
      showNotice("提炼记忆失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRefreshing(false);
    }
  }

  async function remove(id: string) {
    const removed = memories.find((memory) => memory.id === id);
    if (!removed) return;
    const nextStats = {
      total: Math.max(0, stats.total - 1),
      global: Math.max(0, stats.global - (removed.scope === "global" ? 1 : 0)),
      project: Math.max(0, stats.project - (removed.scope === "project" ? 1 : 0))
    };
    setMemories((current) => current.filter((memory) => memory.id !== id));
    setStats(nextStats);
    setPage((current) => Math.min(current, getMemoryLastPageIndex(memories.length - 1)));
    try {
      await window.codexh.deleteSelfImprovementMemory(id);
      showNotice("记忆已删除", { tone: "success" });
    } catch (error) {
      setMemories((current) => current.some((memory) => memory.id === id) ? current : sortMemoryRecordsNewestFirst([...current, removed]));
      setStats(stats);
      showNotice("删除记忆失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function confirmClear() {
    if (isClearing) return;
    setIsClearing(true);
    try {
      const cleared = await window.codexh.clearSelfImprovementMemories();
      setMemories([]);
      setStats(EMPTY_STATS);
      setPage(0);
      setIsClearConfirmOpen(false);
      showNotice(cleared > 0 ? `已清空 ${cleared} 条记忆` : "记忆已清空", { tone: "success" });
    } catch (error) {
      showNotice("清空记忆失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsClearing(false);
    }
  }

  return {
    memories,
    visibleMemories,
    stats,
    scopeFilter,
    setScopeFilter,
    isRefreshing,
    page,
    setPage,
    isClearConfirmOpen,
    setIsClearConfirmOpen,
    isClearing,
    refresh,
    refreshNow,
    remove,
    confirmClear
  };
}
