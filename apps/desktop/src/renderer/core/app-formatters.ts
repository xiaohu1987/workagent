import type { ErrorSolutionRecord, GpaStage, KnowledgeBaseSummary, KnowledgeScope, ThreadRecord } from "@shared-types";

type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";
type NotificationStatus = "attention" | "running" | "completed" | "failed" | "cancelled";

export function formatUpdatePhase(phase: UpdatePhase): string {
  switch (phase) {
    case "checking": return "正在检查";
    case "up-to-date": return "已是最新";
    case "available": return "发现新版本";
    case "downloading": return "正在下载";
    case "downloaded": return "已验证，可安装";
    case "installing": return "正在安装";
    case "error": return "更新失败";
    default: return "等待检查";
  }
}

export function formatUpdateDownloadSize(receivedBytes?: number, totalBytes?: number): string {
  const received = formatByteSize(receivedBytes ?? 0);
  return totalBytes && totalBytes > 0 ? `${received} / ${formatByteSize(totalBytes)}` : `${received} 已下载`;
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return formatByteSize(bytes);
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getSidebarUpdateReminder(phase?: UpdatePhase): string | null {
  if (phase === "available") return "有更新";
  if (phase === "downloading") return "下载中";
  if (phase === "downloaded") return "可安装";
  return null;
}

export function getWorkspaceLabel(thread: ThreadRecord | null): string {
  const target = thread?.cwd?.trim();
  if (!target) return "workagent";
  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "workagent";
}

export function formatRelativeTime(isoTime: string): string {
  const diffMinutes = Math.max(0, Math.floor((Date.now() - new Date(isoTime).getTime()) / 60_000));
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  return `${Math.floor(diffHours / 24)} 天前`;
}

export function formatNotificationElapsed(startedAt: string, endTime: number): string {
  const started = Date.parse(startedAt);
  const seconds = Number.isFinite(started) && Number.isFinite(endTime) ? Math.max(0, Math.floor((endTime - started) / 1_000)) : 0;
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function getNotificationStatusLabel(status: NotificationStatus): string {
  if (status === "attention") return "待处理";
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "已停止";
}

export function formatKnowledgeScope(scope: KnowledgeScope): string {
  return scope === "global" ? "全局" : scope === "project" ? "项目" : "会话";
}

export function formatKnowledgeStatus(status: KnowledgeBaseSummary["status"]): string {
  return status === "ready" ? "可用" : status === "importing" ? "索引中" : "失败";
}

export function formatKnowledgeBytes(bytes: number): string {
  return formatByteSize(bytes);
}

export function getErrorSolutionRecallStatus(outcome: ErrorSolutionRecord["lastRecallOutcome"]): string | null {
  switch (outcome) {
    case "matched": return "已提供建议";
    case "blocked": return "最近已拦截";
    case "prerequisite": return "已要求重新读取";
    case "recovered": return "已成功恢复";
    default: return null;
  }
}

export function formatLatency(latencyMs: number): string {
  return latencyMs >= 1_000 ? `${(latencyMs / 1_000).toFixed(2)} s` : `${latencyMs} ms`;
}

export function formatTokensPerSecond(tokensPerSecond: number): string {
  return `${tokensPerSecond.toFixed(tokensPerSecond >= 10 ? 1 : 2)} Tokens/s`;
}

export function gpaModeLabel(mode: GpaStage): string {
  if (mode === "goal") return "目标 GOAL";
  if (mode === "plan") return "计划 PLAN";
  if (mode === "act") return "执行 ACT";
  return "GPA";
}
