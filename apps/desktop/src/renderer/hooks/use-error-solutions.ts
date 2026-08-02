import { useState } from "react";
import type { AppConfig, ErrorSolutionRecord } from "@shared-types";
import { getMemoryLastPageIndex, sortMemoryRecordsNewestFirst } from "../workspace/memory-pagination";
import { useExpandedIds } from "./use-expanded-ids";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useErrorSolutions(config: AppConfig | null, showNotice: Notice) {
  const [solutions, setSolutions] = useState<ErrorSolutionRecord[]>([]);
  const [page, setPage] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("all");
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const { expandedIds, setExpandedIds, toggle } = useExpandedIds();

  async function refresh(filter = modelFilter) {
    try {
      const modelId = filter === "all" ? null : filter;
      const nextSolutions = sortMemoryRecordsNewestFirst(
        (await window.codexh.listErrorSolutions({ limit: 1_000, modelId })) as ErrorSolutionRecord[]
      );
      setSolutions(nextSolutions);
      setPage((current) => Math.min(current, getMemoryLastPageIndex(nextSolutions.length)));
    } catch (error) {
      showNotice("加载错误恢复经验失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function remove(id: string) {
    const removed = solutions.find((entry) => entry.id === id);
    if (!removed) return;
    const wasExpanded = expandedIds.has(id);
    setBusyId(id);
    setSolutions((current) => current.filter((entry) => entry.id !== id));
    setPage((current) => Math.min(current, getMemoryLastPageIndex(solutions.length - 1)));
    setExpandedIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    try {
      await window.codexh.deleteErrorSolution(id);
      showNotice("记忆已删除", { tone: "success" });
    } catch (error) {
      setSolutions((current) => current.some((entry) => entry.id === id) ? current : sortMemoryRecordsNewestFirst([...current, removed]));
      if (wasExpanded) setExpandedIds((current) => new Set(current).add(id));
      showNotice("删除错误恢复经验失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmClear() {
    if (isClearing) return;
    setIsClearing(true);
    try {
      const modelId = modelFilter === "all" ? null : modelFilter;
      const cleared = await window.codexh.clearErrorSolutions(modelId);
      setSolutions((current) => modelId ? current.filter((entry) => entry.modelId !== modelId) : []);
      setPage(0);
      setExpandedIds(new Set());
      setIsClearConfirmOpen(false);
      const modelLabel = modelId ? (config?.models.find((entry) => entry.id === modelId)?.displayName ?? modelId) : null;
      showNotice(cleared > 0
        ? modelLabel ? `已清空 ${modelLabel} 的 ${cleared} 条记忆` : `已清空 ${cleared} 条记忆`
        : "记忆已清空", { tone: "success" });
    } catch (error) {
      showNotice("清空错误恢复经验失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsClearing(false);
    }
  }

  return {
    solutions,
    page,
    setPage,
    busyId,
    modelFilter,
    setModelFilter,
    isClearConfirmOpen,
    setIsClearConfirmOpen,
    isClearing,
    expandedIds,
    refresh,
    remove,
    confirmClear,
    toggle
  };
}
