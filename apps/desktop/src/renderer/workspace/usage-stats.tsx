import type { ProviderDefinition, UsageAnalyticsGranularity, UsageAnalyticsSummary } from "@shared-types";
import { useState } from "react";
import { IconRefresh } from "../icons";
import { ComposerSelect } from "./composer-select";
import { getProviderDisplayName } from "../lib/config-utils";

export function UsageStatisticsPanel({
  summary,
  providers,
  loading,
  rangeDays,
  granularity,
  onRangeChange,
  onGranularityChange,
  onRefresh
}: {
  summary: UsageAnalyticsSummary | null;
  providers: ProviderDefinition[];
  loading: boolean;
  rangeDays: number | null;
  granularity: UsageAnalyticsGranularity;
  onRangeChange: (value: number | null) => void;
  onGranularityChange: (value: UsageAnalyticsGranularity) => void;
  onRefresh: () => void;
}) {
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<string[]>([]);
  const palette = ["#4d8df7", "#19bd86", "#dca331", "#a875e9", "#1badc7", "#e36b78", "#7b8ba4"];
  const models = (summary?.models ?? []).slice(0, 7);
  const totalModelTokens = models.reduce((total, row) => total + row.usage.totalTokens, 0);
  let cursor = 0;
  const donutGradient = totalModelTokens > 0
    ? `conic-gradient(${models.map((row, index) => {
      const start = cursor;
      cursor += (row.usage.totalTokens / totalModelTokens) * 100;
      return `${palette[index % palette.length]} ${start}% ${cursor}%`;
    }).join(", ")})`
    : "conic-gradient(#293443 0 100%)";
  const trend = summary?.trend ?? [];
  const series = [
    { id: "input", label: "输入", color: "#4d8df7", values: trend.map((point) => point.usage.inputTokens) },
    { id: "output", label: "输出", color: "#19bd86", values: trend.map((point) => point.usage.outputTokens) },
    { id: "cache-write", label: "缓存写入", color: "#dca331", values: trend.map((point) => point.usage.inputCacheWriteTokens) },
    { id: "cache-hit", label: "缓存命中", color: "#1badc7", values: trend.map((point) => point.usage.inputCacheHitTokens) }
  ];
  const tokenMax = Math.max(1, ...series.flatMap((item) => item.values));
  const chart = { left: 46, right: 12, top: 16, bottom: 30, width: 542, height: 130 };
  const labelEvery = Math.max(1, Math.ceil(trend.length / 7));

  return (
    <section className="usage-statistics-content" aria-label="使用统计">
      <div className="usage-statistics-toolbar">
        <label>时间范围<ComposerSelect className="usage-statistics-select" ariaLabel="统计时间范围" placeholder="选择时间范围" value={rangeDays === null ? "all" : String(rangeDays)} onChange={(value) => onRangeChange(value === "all" ? null : Number(value))} options={[{ value: "7", label: "近 7 天" }, { value: "30", label: "近 30 天" }, { value: "90", label: "近 90 天" }, { value: "all", label: "全部记录" }]} /></label>
        <label>粒度<ComposerSelect className="usage-statistics-select" ariaLabel="统计粒度" placeholder="选择统计粒度" value={granularity} onChange={(value) => onGranularityChange(value === "week" || value === "month" ? value : "day")} options={[{ value: "day", label: "按天" }, { value: "week", label: "按周" }, { value: "month", label: "按月" }]} /></label>
        <button className="usage-statistics-refresh" type="button" onClick={onRefresh} disabled={loading} title="刷新统计"><IconRefresh /><span>{loading ? "加载中" : "刷新"}</span></button>
      </div>
      <div className="usage-statistics-summary" aria-label="统计摘要">
        <span><b>{formatTokenCount(summary?.totalUsage.totalTokens ?? 0)}</b> Tokens</span>
        <span><b>{summary?.totalRequests ?? 0}</b> 请求</span>
        <span><b>{formatCacheHitRate(summary?.totalUsage.cacheHitRate ?? 0)}</b> 缓存命中</span>
      </div>
      <div className="usage-statistics-grid">
        <section className="usage-statistics-panel distribution-panel" aria-label="模型分布">
          <header><h3>模型分布</h3><span>{summary?.models.length ?? 0} 个模型</span></header>
          <div className="usage-model-distribution">
            <div className="usage-donut" style={{ background: donutGradient }} />
            <div className="usage-model-table-wrap"><table className="usage-model-table"><thead><tr><th>模型</th><th>请求</th><th>Token</th></tr></thead><tbody>{models.length ? models.map((row, index) => {
              const provider = providers.find((entry) => entry.id === row.providerId);
              const providerLabel = provider ? getProviderDisplayName(provider) : row.providerId;
              const label = `${providerLabel} / ${row.modelId}`;
              return <tr key={`${row.providerId}:${row.modelId}`}><td><i style={{ background: palette[index % palette.length] }} /><span title={label}>{label}</span></td><td>{row.requestCount.toLocaleString()}</td><td>{formatTokenCount(row.usage.totalTokens)}</td></tr>;
            }) : <tr><td colSpan={3} className="usage-empty-cell">该时间范围暂无调用记录</td></tr>}</tbody></table></div>
          </div>
        </section>
        <section className="usage-statistics-panel trend-panel" aria-label="Token 使用趋势">
          <header><h3>Token 使用趋势</h3><span>{trend.length ? `${trend[0].label} 至 ${trend.at(-1)?.label}` : "暂无趋势"}</span></header>
          <div className="usage-chart-legend">{series.map((item) => {
            const isHidden = hiddenSeriesIds.includes(item.id);
            return <button
              key={item.id}
              className={isHidden ? "is-hidden" : undefined}
              type="button"
              aria-pressed={!isHidden}
              title={`${isHidden ? "显示" : "隐藏"}${item.label}折线`}
              onClick={() => setHiddenSeriesIds((current) => current.includes(item.id)
                ? current.filter((id) => id !== item.id)
                : [...current, item.id]
              )}
            ><i style={{ background: item.color }} />{item.label}</button>;
          })}</div>
          <div className="usage-chart-wrap">{trend.length ? <svg className="usage-chart" viewBox="0 0 600 176" role="img" aria-label="Token 使用趋势折线图">
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => { const y = chart.top + chart.height - ratio * chart.height; return <g key={ratio}><line x1={chart.left} y1={y} x2={chart.left + chart.width} y2={y} /><text x={chart.left - 6} y={y + 3} textAnchor="end">{formatTokenCount(Math.round(tokenMax * ratio))}</text></g>; })}
            {series.filter((item) => !hiddenSeriesIds.includes(item.id)).map((item) => {
              const points = item.values.map((value, index) => ({
                x: chart.left + (index * chart.width) / Math.max(1, trend.length - 1),
                y: chart.top + chart.height - (value / tokenMax) * chart.height,
                value,
                label: trend[index]?.label ?? ""
              }));
              return <g key={item.id} className="usage-chart-series" style={{ color: item.color }}>
                <path d={buildSmoothUsageLinePath(points)} />
                {points.map((point) => <circle key={`${item.id}-${point.label}`} cx={point.x} cy={point.y} r="3"><title>{`${point.label} ${item.label}: ${point.value.toLocaleString()} Tokens`}</title></circle>)}
              </g>;
            })}
            {trend.map((point, index) => {
              const x = chart.left + (index * chart.width) / Math.max(1, trend.length - 1);
              return (index % labelEvery === 0 || index === trend.length - 1) ? <text key={point.key} x={x} y="170" textAnchor="middle">{point.label.slice(5)}</text> : null;
            })}
          </svg> : <div className="usage-chart-empty">暂无可绘制的 Token 数据</div>}</div>
        </section>
      </div>
    </section>
  );
}

export function buildSmoothUsageLinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const following = points[index + 2] ?? next;
    const control1X = current.x + (next.x - previous.x) / 6;
    const control1Y = current.y + (next.y - previous.y) / 6;
    const control2X = next.x - (following.x - current.x) / 6;
    const control2Y = next.y - (following.y - current.y) / 6;
    path += ` C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${next.x} ${next.y}`;
  }
  return path;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1_000_000_000).toFixed(tokens >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  }
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K` : String(tokens);
}

export function formatCacheHitRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0%";
  return `${Math.round(rate * 1000) / 10}%`;
}

export function formatTokenCountExact(tokens: number): string {
  if (!Number.isFinite(tokens)) return "0";
  return Math.round(tokens).toLocaleString("en-US");
}
