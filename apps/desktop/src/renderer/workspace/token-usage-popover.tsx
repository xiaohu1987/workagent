import type { RefObject } from "react";
import type { TokenUsage } from "@shared-types";
import { IconBolt } from "../icons";
import { formatCacheHitRate, formatTokenCount, formatTokenCountExact } from "./usage-stats";

type TokenUsagePopoverProps = {
  usage: TokenUsage;
  active: boolean;
  selectedThreadId: string | null;
  motionPhase?: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
};

export function TokenUsagePopover({ usage, active, selectedThreadId, motionPhase, buttonRef, panelRef, onToggle }: TokenUsagePopoverProps) {
  const inputBreakdownTotal = usage.inputCacheHitTokens + usage.inputCacheMissTokens + usage.inputCacheWriteTokens;
  const segmentWidth = (value: number): string => inputBreakdownTotal > 0 ? `${Math.min(100, Math.max(0, (value / inputBreakdownTotal) * 100))}%` : "0%";

  return (
    <div className="token-usage-control">
      <button ref={buttonRef} type="button" className={`token-usage-toggle ${active ? "active" : ""}`} title={`累计消耗 ${formatTokenCount(usage.totalTokens)} Tokens${selectedThreadId ? " · 实时" : ""}`} aria-label={`累计消耗 ${formatTokenCount(usage.totalTokens)} Tokens`} aria-haspopup="dialog" aria-expanded={active} onClick={onToggle}>
        <span className="token-usage-toggle-label" aria-hidden>累计消耗</span>
        <strong className="token-usage-toggle-value">{formatTokenCount(usage.totalTokens)}</strong>
        {selectedThreadId ? <em className="token-usage-toggle-live" aria-hidden>实时</em> : null}
      </button>
      {motionPhase ? (
        <div ref={panelRef} className={`token-usage-panel motion-${motionPhase}`} role="dialog" aria-modal="false" aria-label="本对话 Token 消耗">
          <header className="token-usage-panel-header"><strong>Token 消耗明细</strong><span>总计 <b>{formatTokenCountExact(usage.totalTokens)}</b></span></header>
          <div className="token-usage-panel-body">
            <div className="token-usage-section">
              <TokenRow marker="input" label="输入" value={usage.inputTokens} sectionHead />
              <TokenRow marker="hit" label="缓存命中" value={usage.inputCacheHitTokens} />
              <TokenRow marker="miss" label="缓存未命中" value={usage.inputCacheMissTokens} />
              <TokenRow marker="write" label="缓存写入" value={usage.inputCacheWriteTokens} />
            </div>
            <div className="token-usage-section">
              <TokenRow marker="output" label="输出" value={usage.outputTokens} sectionHead />
              <TokenRow marker="none" label="思考过程" value={usage.outputReasoningTokens} />
              <TokenRow marker="none" label="回复内容" value={usage.outputContentTokens} />
            </div>
            <div className="token-usage-rate"><span className="token-usage-rate-label"><span className="token-usage-rate-icon" aria-hidden><IconBolt /></span>缓存命中率</span><strong>{formatCacheHitRate(usage.cacheHitRate)}</strong></div>
            <div className="token-usage-bar" aria-label={`输入构成：命中 ${segmentWidth(usage.inputCacheHitTokens)}，写入 ${segmentWidth(usage.inputCacheWriteTokens)}，未命中 ${segmentWidth(usage.inputCacheMissTokens)}`}>
              <span className="token-usage-bar-segment hit" style={{ width: segmentWidth(usage.inputCacheHitTokens) }} />
              <span className="token-usage-bar-segment write" style={{ width: segmentWidth(usage.inputCacheWriteTokens) }} />
              <span className="token-usage-bar-segment miss" style={{ width: segmentWidth(usage.inputCacheMissTokens) }} />
            </div>
            <div className="token-usage-legend" aria-hidden><span><i className="token-usage-marker hit" />命中</span><span><i className="token-usage-marker write" />写入</span><span><i className="token-usage-marker miss" />未命中</span></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TokenRow({ marker, label, value, sectionHead = false }: { marker: string; label: string; value: number; sectionHead?: boolean }) {
  return <div className={`token-usage-row ${sectionHead ? "section-head" : ""}`}><span className={`token-usage-marker ${marker}`} aria-hidden /><span className="token-usage-name">{label}</span><b>{formatTokenCountExact(value)}</b></div>;
}
