import { useState } from "react";
import type { ArtifactRecord, GpaState } from "@shared-types";
import { buildPlanTimelineItems, getActivePlanTimelineItem, parseTimelineJson } from "../lib/conversation-utils";
import type { RuntimeActivityEntry } from "../core/app-types";
import { PlanItem, StatusIcon } from "../cards/runtime-cards";

export function PlanTimeline({ state, isRunning }: { state: GpaState; isRunning: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const items = buildPlanTimelineItems(state);
  const completedCount = items.filter((item) => item.status === "completed").length;
  const isFinalizing = items.length > 0 && completedCount === items.length && state.stage === "act";
  const currentItem = getActivePlanTimelineItem(items) ?? (isFinalizing ? {
    id: "finalizing",
    label: isRunning
      ? `计划 ${completedCount}/${items.length} 已完成，正在最终验证`
      : `计划 ${completedCount}/${items.length} 已完成`,
    status: isRunning ? "in_progress" as const : "completed" as const
  } : null);

  if (!currentItem) return null;

  return (
    <section className={`composer-plan ${expanded ? "is-expanded" : ""}`} aria-label="Updated Plan">
      <button
        type="button"
        className="composer-plan-summary"
        aria-expanded={expanded}
        title={expanded ? "收起计划" : "向上展开查看全部计划"}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="composer-plan-title"><span>●</span><strong>Updated Plan</strong></span>
        {currentItem ? (
          <span className={`composer-plan-current ${currentItem.status}`}>
            <StatusIcon status={currentItem.status} />
            <span>{currentItem.label}</span>
          </span>
        ) : null}
        <span className="composer-plan-chevron" aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="composer-plan-panel" role="region" aria-label="全部计划">
          <div className="composer-plan-list">
            {items.map((item) => <PlanItem key={item.id} label={item.label} status={item.status} />)}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function getRuntimeActivityStartedAt(entries: RuntimeActivityEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.kind === "tool") {
      if (entry.toolCall.startedAt) return entry.toolCall.startedAt;
      continue;
    }
    if (entry.createdAt) return entry.createdAt;
  }
  return undefined;
}

function getRuntimeBrowserScreenshotPaths(entries: RuntimeActivityEntry[], artifacts: ArtifactRecord[]): string[] {
  const turnRunIds = new Set(
    entries.filter((entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> => entry.kind === "tool")
      .map((entry) => entry.toolCall.turnRunId)
  );
  const paths = artifacts
    .filter((artifact) => artifact.artifactKind === "browser-screenshot" && !!artifact.turnRunId && turnRunIds.has(artifact.turnRunId))
    .map((artifact) => artifact.absolutePath);
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.toolCall.toolName !== "browser.capture_screenshot") continue;
    const result = parseTimelineJson(entry.toolCall.resultJson);
    const json = result.json && typeof result.json === "object" ? result.json as Record<string, unknown> : {};
    if (typeof json.filePath === "string") paths.push(json.filePath);
  }
  return [...new Set(paths)];
}
