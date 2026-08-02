import { useState } from "react";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useRuntimeLogMaintenance(formatStorageBytes: (bytes: number) => string, showNotice: Notice) {
  const [stats, setStats] = useState<{ bytes: number; fileCount: number } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  async function refresh() {
    setIsLoading(true);
    try {
      setStats(await window.codexh.getRuntimeLogStats());
    } catch (error) {
      showNotice("加载日志统计失败。", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmClear() {
    if (isClearing) return;
    setIsClearing(true);
    try {
      const cleared = await window.codexh.clearRuntimeLogs();
      setStats({ bytes: 0, fileCount: 0 });
      setIsClearConfirmOpen(false);
      showNotice(cleared.bytes > 0 ? "日志已清理。" : "当前没有可清理的日志。", {
        message: cleared.bytes > 0 ? `已释放 ${formatStorageBytes(cleared.bytes)} 磁盘空间。` : undefined,
        tone: "success"
      });
      await refresh();
    } catch (error) {
      showNotice("清理日志失败。", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsClearing(false);
    }
  }

  return { stats, isLoading, isClearConfirmOpen, setIsClearConfirmOpen, isClearing, refresh, confirmClear };
}
