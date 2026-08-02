import type { AppConfig, UsageAnalyticsGranularity, UsageAnalyticsSummary } from "@shared-types";
import { UsageStatisticsPanel } from "../workspace/usage-stats";

type SettingsUsagePageProps = {
  summary: UsageAnalyticsSummary | null;
  providers: AppConfig["providers"];
  loading: boolean;
  rangeDays: number | null;
  granularity: UsageAnalyticsGranularity;
  onRangeChange: (value: number | null) => void;
  onGranularityChange: (value: UsageAnalyticsGranularity) => void;
  onRefresh: () => void;
};

export function SettingsUsagePage({
  summary,
  providers,
  loading,
  rangeDays,
  granularity,
  onRangeChange,
  onGranularityChange,
  onRefresh
}: SettingsUsagePageProps) {
  return (
    <div className="settings-section usage-statistics-settings">
      <UsageStatisticsPanel
        summary={summary}
        providers={providers}
        loading={loading}
        rangeDays={rangeDays}
        granularity={granularity}
        onRangeChange={onRangeChange}
        onGranularityChange={onGranularityChange}
        onRefresh={onRefresh}
      />
    </div>
  );
}
