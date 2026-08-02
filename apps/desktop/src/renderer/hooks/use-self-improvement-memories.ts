import { useState } from "react";
import type { SelfImprovementMemoryRecord } from "@shared-types";
import { getMemoryLastPageIndex, sortMemoryRecordsNewestFirst } from "../workspace/memory-pagination";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useSelfImprovementMemories(showNotice: Notice) {
  const [memories, setMemories] = useState<SelfImprovementMemoryRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  async function refresh() {
    try {
      const nextMemories = sortMemoryRecordsNewestFirst(
        await window.codexh.listSelfImprovementMemories({ all: true, limit: 1_000 }) as SelfImprovementMemoryRecord[]
      );
      setMemories(nextMemories);
      setPage((current) => Math.min(current, getMemoryLastPageIndex(nextMemories.length)));
    } catch (error) {
      showNotice("加载记忆失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function refreshNow() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const result = await window.codexh.refreshSelfImprovementMemories();
      await refresh();
      showNotice(result.processed > 0 || result.pruned > 0
        ? `记忆已更新：提炼 ${result.processed} 条，清理 ${result.pruned} 条`
        : "没有可处理的记忆任务", { tone: "success" });
    } catch (error) {
      showNotice("提炼记忆失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsRefreshing(false);
    }
  }

  async function remove(id: string) {
    const removed = memories.find((memory) => memory.id === id);
    if (!removed) return;
    setMemories((current) => current.filter((memory) => memory.id !== id));
    setPage((current) => Math.min(current, getMemoryLastPageIndex(memories.length - 1)));
    try {
      await window.codexh.deleteSelfImprovementMemory(id);
      showNotice("记忆已删除", { tone: "success" });
    } catch (error) {
      setMemories((current) => current.some((memory) => memory.id === id) ? current : sortMemoryRecordsNewestFirst([...current, removed]));
      showNotice("删除记忆失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function confirmClear() {
    if (isClearing) return;
    setIsClearing(true);
    try {
      const cleared = await window.codexh.clearSelfImprovementMemories();
      setMemories([]);
      setPage(0);
      setIsClearConfirmOpen(false);
      showNotice(cleared > 0 ? `已清空 ${cleared} 条记忆` : "记忆已清空", { tone: "success" });
    } catch (error) {
      showNotice("清空记忆失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsClearing(false);
    }
  }

  return { memories, isRefreshing, page, setPage, isClearConfirmOpen, setIsClearConfirmOpen, isClearing, refresh, refreshNow, remove, confirmClear };
}
