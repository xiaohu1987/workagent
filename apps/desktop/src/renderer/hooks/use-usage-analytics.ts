import { useState } from "react";
import type { UsageAnalyticsGranularity, UsageAnalyticsSummary } from "@shared-types";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useUsageAnalytics(showNotice: Notice) {
  const [rangeDays, setRangeDays] = useState<number | null>(7);
  const [granularity, setGranularity] = useState<UsageAnalyticsGranularity>("day");
  const [summary, setSummary] = useState<UsageAnalyticsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function refresh() {
    setIsLoading(true);
    try {
      setSummary(await window.codexh.getUsageAnalytics({ rangeDays, granularity }));
    } catch (error) {
      showNotice("读取使用统计失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsLoading(false);
    }
  }

  return { rangeDays, setRangeDays, granularity, setGranularity, summary, isLoading, refresh };
}
