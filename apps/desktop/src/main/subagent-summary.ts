import type { SubagentResultEnvelope, ThreadRecord } from "@shared-types";

const MAX_SUBAGENT_SUMMARY_LENGTH = 480;

export function buildSubagentCompletionSummary(
  thread: Pick<ThreadRecord, "agentPath" | "agentRole">,
  result: Pick<SubagentResultEnvelope, "summary">
): string {
  const label = (thread.agentRole || thread.agentPath.split("/").filter(Boolean).at(-1) || "子任务")
    .replace(/[-_]/g, " ");
  const summary = result.summary.replace(/\s+/g, " ").trim();
  const compactSummary = summary.length > MAX_SUBAGENT_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUBAGENT_SUMMARY_LENGTH).trimEnd()}...`
    : summary || "已完成，未返回额外说明。";

  return `子智能体 ${label} 已完成\n\n${compactSummary}`;
}
