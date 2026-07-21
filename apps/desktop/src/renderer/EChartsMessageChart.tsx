import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ECharts, EChartsOption } from "echarts";
import "./echarts-message-chart.css";

export const ECHARTS_CONFIG_MAX_BYTES = 256 * 1024;

const ECHARTS_THEME_NAME = "codexh-chat";
const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);
let echartsModulePromise: Promise<typeof import("echarts")> | null = null;

const ECHARTS_THEME = {
  backgroundColor: "transparent",
  color: ["#b7a2ff", "#67c7b0", "#f0ae76", "#78aef2", "#e483a8", "#a8d36f", "#d39bf0"],
  textStyle: { color: "#dfe4ed" },
  title: { textStyle: { color: "#f4f6fa" }, subtextStyle: { color: "#8d96a5" } },
  legend: { textStyle: { color: "#b9c1cd" } },
  categoryAxis: {
    axisLine: { lineStyle: { color: "#46505f" } },
    axisTick: { lineStyle: { color: "#46505f" } },
    axisLabel: { color: "#9da7b6" },
    splitLine: { lineStyle: { color: ["rgba(255,255,255,0.06)"] } }
  },
  valueAxis: {
    axisLine: { lineStyle: { color: "#46505f" } },
    axisTick: { lineStyle: { color: "#46505f" } },
    axisLabel: { color: "#9da7b6" },
    splitLine: { lineStyle: { color: ["rgba(255,255,255,0.07)"] } }
  },
  tooltip: {
    backgroundColor: "rgba(19, 21, 27, 0.96)",
    borderColor: "rgba(183, 162, 255, 0.34)",
    textStyle: { color: "#edf0f5" }
  }
};

export type ParsedEChartsConfig =
  | { ok: true; option: EChartsOption; title: string }
  | { ok: false; error: string };

export function parseEChartsConfig(content: string): ParsedEChartsConfig {
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > ECHARTS_CONFIG_MAX_BYTES) {
    return { ok: false, error: "图表配置超过 256 KB 限制。" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { ok: false, error: `JSON 格式无效：${error instanceof Error ? error.message : String(error)}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "ECharts 配置必须是 JSON 对象。" };
  }

  const unsafeReason = findUnsafeConfigValue(parsed);
  if (unsafeReason) return { ok: false, error: unsafeReason };

  const option = parsed as EChartsOption;
  return { ok: true, option: withReportLayout(withDefaultAria(option)), title: getChartTitle(option) };
}

function findUnsafeConfigValue(value: unknown, parentKey = ""): string | null {
  if (typeof value === "string") {
    if (/^image:\/\/https?:\/\//i.test(value) || (parentKey === "image" && /^https?:\/\//i.test(value))) {
      return "图表配置不允许加载远程图片。";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = findUnsafeConfigValue(item, parentKey);
      if (reason) return reason;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) return `图表配置包含不允许的键：${key}`;
    const reason = findUnsafeConfigValue(nested, key);
    if (reason) return reason;
  }
  return null;
}

function withDefaultAria(option: EChartsOption): EChartsOption {
  if (option.aria) return option;
  return { ...option, aria: { enabled: true } };
}

function withReportLayout(option: EChartsOption): EChartsOption {
  const { title: _title, ...reportOption } = option;
  const hasLegend = option.legend !== undefined;
  const hasCartesianAxis = option.xAxis !== undefined || option.yAxis !== undefined;
  const next: EChartsOption = { ...reportOption };

  // The message card owns the title. Keeping it out of the canvas prevents it
  // from colliding with an otherwise unpositioned ECharts legend.
  if (hasLegend) {
    next.legend = withDefaultTop(option.legend, 12) as EChartsOption["legend"];
  }
  if (hasCartesianAxis) {
    next.grid = withDefaultGrid(option.grid, hasLegend ? 58 : 28) as EChartsOption["grid"];
  }
  return next;
}

function withDefaultTop(value: unknown, top: number): unknown {
  const apply = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return { ...record, top: record.top ?? top };
  };
  return Array.isArray(value) ? value.map(apply) : apply(value);
}

function withDefaultGrid(value: unknown, top: number): unknown {
  const apply = (item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { top, left: 18, right: 18, bottom: 12, containLabel: true };
    }
    const record = item as Record<string, unknown>;
    return { ...record, top: record.top ?? top, containLabel: record.containLabel ?? true };
  };
  return Array.isArray(value) ? value.map(apply) : apply(value);
}

function getChartTitle(option: EChartsOption): string {
  const title = Array.isArray(option.title) ? option.title[0] : option.title;
  if (title && typeof title === "object" && "text" in title && typeof title.text === "string" && title.text.trim()) {
    return title.text.trim();
  }
  return "数据图表";
}

async function loadECharts() {
  if (!echartsModulePromise) {
    echartsModulePromise = import("echarts").then((module) => {
      module.registerTheme(ECHARTS_THEME_NAME, ECHARTS_THEME);
      return module;
    });
  }
  return echartsModulePromise;
}

function EChartsSurface({
  option,
  title,
  expanded = false,
  onInstance
}: {
  option: EChartsOption;
  title: string;
  expanded?: boolean;
  onInstance: (instance: ECharts | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const optionRef = useRef(option);
  const onInstanceRef = useRef(onInstance);
  const [loadError, setLoadError] = useState<string | null>(null);
  optionRef.current = option;
  onInstanceRef.current = onInstance;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let resizeFrame: number | null = null;

    void loadECharts()
      .then((echarts) => {
        if (cancelled || !hostRef.current) return;
        const chart = echarts.init(hostRef.current, ECHARTS_THEME_NAME, { renderer: "canvas" });
        chartRef.current = chart;
        chart.setOption(optionRef.current, { notMerge: true });
        onInstanceRef.current(chart);
        observer = new ResizeObserver(() => {
          if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
          resizeFrame = window.requestAnimationFrame(() => {
            resizeFrame = null;
            chart.resize();
          });
        });
        observer.observe(hostRef.current);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      onInstanceRef.current(null);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true });
  }, [option]);

  return loadError ? (
    <div className="message-chart-load-error">图表加载失败：{loadError}</div>
  ) : (
    <div
      ref={hostRef}
      className={`message-chart-canvas${expanded ? " is-expanded" : ""}`}
      role="img"
      aria-label={title}
    />
  );
}

export type EChartsReportChartProps = {
  /** A JSON-compatible ECharts option object. */
  option: EChartsOption;
  /** Optional heading shown in the chart toolbar and export filename. */
  title?: string;
  /** Original JSON retained for the copy-configuration action. */
  configText?: string;
};

/** Reusable report surface for any validated ECharts option. */
export function EChartsReportChart({ option, title, configText }: EChartsReportChartProps) {
  const [inlineChart, setInlineChart] = useState<ECharts | null>(null);
  const [expandedChart, setExpandedChart] = useState<ECharts | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const serializedConfig = useMemo(() => configText ?? JSON.stringify(option, null, 2), [configText, option]);
  const chartOption = useMemo(() => withReportLayout(withDefaultAria(option)), [option]);
  const chartTitle = title?.trim() || getChartTitle(option);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [expanded]);

  async function copyConfig() {
    const didCopy = await copyChartText(serializedConfig);
    setCopied(didCopy);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    if (didCopy) copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  function exportPng(instance: ECharts | null) {
    if (!instance) return;
    try {
      const dataUrl = instance.getDataURL({
        type: "png",
        pixelRatio: 2,
        backgroundColor: "#101217"
      });
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${safeFileName(chartTitle)}.png`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      // Invalid or tainted canvas content should not break the surrounding message.
    }
  }

  const actions = (chart: ECharts | null, includeExpand: boolean) => (
    <div className="message-chart-actions">
      <button type="button" title={copied ? "已复制配置" : "复制图表配置"} aria-label={copied ? "已复制配置" : "复制图表配置"} onClick={() => void copyConfig()}>
        <ChartIcon kind="copy" />
      </button>
      <button type="button" title="导出 PNG" aria-label="导出 PNG" disabled={!chart} onClick={() => exportPng(chart)}>
        <ChartIcon kind="download" />
      </button>
      {includeExpand ? (
        <button type="button" title="全屏查看" aria-label="全屏查看" onClick={() => setExpanded(true)}>
          <ChartIcon kind="expand" />
        </button>
      ) : null}
    </div>
  );

  return (
    <>
      <section className="message-chart" aria-label={`ECharts 图表：${chartTitle}`}>
        <header className="message-chart-header">
          <span title={chartTitle}>{chartTitle}</span>
          {actions(inlineChart, true)}
        </header>
        <EChartsSurface option={chartOption} title={chartTitle} onInstance={setInlineChart} />
      </section>
      {expanded ? createPortal(
        <div className="message-chart-lightbox" role="presentation" onClick={() => setExpanded(false)}>
          <section className="message-chart-dialog" role="dialog" aria-modal="true" aria-label={chartTitle} onClick={(event) => event.stopPropagation()}>
            <header className="message-chart-dialog-header">
              <span title={chartTitle}>{chartTitle}</span>
              {actions(expandedChart, false)}
              <button type="button" title="关闭" aria-label="关闭" onClick={() => setExpanded(false)}>
                <ChartIcon kind="close" />
              </button>
            </header>
            <EChartsSurface expanded option={chartOption} title={chartTitle} onInstance={setExpandedChart} />
          </section>
        </div>,
        document.body
      ) : null}
    </>
  );
}

/** Markdown adapter: validates untrusted model output before handing it to the report component. */
export function EChartsMessageChart({ configText }: { configText: string }) {
  const parsed = useMemo(() => parseEChartsConfig(configText), [configText]);
  if (!parsed.ok) return <InvalidEChartsConfig configText={configText} error={parsed.error} />;
  return <EChartsReportChart option={parsed.option} title={parsed.title} configText={configText} />;
}

function InvalidEChartsConfig({ configText, error }: { configText: string; error: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="message-chart-error" role="alert">
      <div className="message-chart-error-header">
        <div><strong>图表配置无效</strong><span>{error}</span></div>
        <button
          type="button"
          title={copied ? "已复制配置" : "复制图表配置"}
          aria-label={copied ? "已复制配置" : "复制图表配置"}
          onClick={() => void copyChartText(configText).then(setCopied)}
        >
          <ChartIcon kind="copy" />
        </button>
      </div>
      <details>
        <summary>查看配置</summary>
        <pre>{configText}</pre>
      </details>
    </section>
  );
}

async function copyChartText(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 80) || "数据图表";
}

function ChartIcon({ kind }: { kind: "copy" | "download" | "expand" | "close" }) {
  if (kind === "copy") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2" /><path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></svg>;
  if (kind === "download") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></svg>;
  if (kind === "expand") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}
