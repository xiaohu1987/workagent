import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { GpaStage, PendingResumeThread, QueuedMessageRecord, ThreadRecord, ToolCallRecord } from "@shared-types";
import { IconChevronRight, IconClose, IconGuide, IconTerminal } from "../icons";
import { getToolProcessingLabel } from "../lib/conversation-utils";
import { ToolActivityGroup, ToolActivityIcon, getConciseToolActivityLabel } from "../timeline/transcript";
import type { ComposerSubmission, RuntimeActivity, RuntimeActivityEntry } from "../core/app-types";

function useElapsedClock(startedAt: string | null | undefined, active: boolean, completedAt?: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt || completedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active, startedAt, completedAt]);

  if (!startedAt) return 0;
  const end = completedAt ? Date.parse(completedAt) : now;
  return Math.max(0, end - Date.parse(startedAt));
}

function formatElapsedClock(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function ActiveSubagentLines({
  agents,
  queuedAgentIds,
  runtimeActivities,
  onInterrupt
}: {
  agents: ThreadRecord[];
  queuedAgentIds: Set<string>;
  runtimeActivities: Record<string, RuntimeActivity>;
  onInterrupt: (agent: ThreadRecord) => void;
}) {
  return (
    <div className="active-subagent-lines" aria-label="运行中的子智能体" aria-live="polite">
      {agents.map((agent) => {
        const queued = queuedAgentIds.has(agent.id);
        const state = queued ? "queued" : agent.status === "waiting" ? "waiting" : "running";
        const runtimeActivity = runtimeActivities[agent.id];
        const runtimeLabel = getSubagentRuntimeLabel(runtimeActivity);
        const runtimeHistory = getSubagentRuntimeHistory(runtimeActivity);
        const title = getSubagentTitle(agent);
        const statusLabel = queued ? "排队中" : agent.status === "waiting" ? "等待中" : "运行中";
        const activityLabel = queued
          ? "等待可用名额"
          : runtimeLabel ?? (agent.status === "waiting" ? "等待处理中" : "正在准备任务");
        return (
          <details key={agent.id} className={`active-subagent-line ${state}`}>
            <summary title="展开子智能体详情">
              <span className="active-subagent-name">子智能体 {title}</span>
              <span className="active-subagent-separator">:</span>
              <span className="active-subagent-activity">{activityLabel}</span>
            </summary>
            <div className="active-subagent-detail">
              <div className="active-subagent-meta">
                <code>{agent.agentPath}</code>
                <span>{statusLabel}</span>
                <span aria-hidden>·</span>
                <SubagentElapsedTime
                  startedAt={runtimeActivity?.startedAt ?? agent.createdAt}
                  active
                  completedAt={null}
                />
                <button type="button" className="active-subagent-stop" onClick={() => onInterrupt(agent)}>
                  停止
                </button>
              </div>
              {runtimeHistory.length > 0 ? (
                <div className="active-subagent-history">
                  {runtimeHistory.map((entry) => <span key={entry.id}>{entry.label}</span>)}
                </div>
              ) : <div className="active-subagent-empty">正在等待运行状态。</div>}
              <div className="active-subagent-prompt">{agent.lastTaskMessage || agent.agentRole || "暂无任务说明。"}</div>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function getSubagentTitle(agent: ThreadRecord): string {
  return agent.agentRole?.trim() || "子任务分析";
}

function SubagentElapsedTime({
  startedAt,
  active,
  completedAt
}: {
  startedAt: string;
  active: boolean;
  completedAt: string | null;
}) {
  const elapsedMs = useElapsedClock(startedAt, active, completedAt);
  return <time>{formatElapsedClock(elapsedMs)}</time>;
}

function getSubagentRuntimeLabel(activity: RuntimeActivity | undefined): string | null {
  if (!activity) return null;
  const activeTool = [...activity.entries].reverse().find(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> => entry.kind === "tool" && entry.toolCall.status === "running"
  );
  if (activeTool) return getToolProcessingLabel(activeTool.toolCall.toolName, activeTool.toolCall.argumentsJson);
  const latestStatus = [...activity.entries].reverse().find(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "status" }> => entry.kind === "status"
  );
  return latestStatus?.label ?? null;
}

function getSubagentRuntimeHistory(activity: RuntimeActivity | undefined): Array<{ id: string; label: string }> {
  if (!activity) return [];
  return activity.entries.slice(-5).reverse().map((entry) => ({
    id: entry.id,
    label: entry.kind === "tool"
      ? entry.toolCall.status === "running"
        ? getToolProcessingLabel(entry.toolCall.toolName, entry.toolCall.argumentsJson)
        : `${entry.toolCall.status === "failed" ? "工具失败" : "已完成"} · ${entry.toolCall.toolName}`
      : entry.kind === "status"
        ? entry.label
        : entry.label
  }));
}

export function PendingResumeCard({
  pending,
  onResume,
  onDismiss
}: {
  pending: PendingResumeThread;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const preview = pending.lastUserMessage.trim();
  return (
    <section className="pending-resume-card" aria-label="恢复已停止的任务">
      <div className="pending-resume-card-body">
        <strong className="pending-resume-card-title">之前的任务已停止</strong>
        <span className="pending-resume-card-text">上次退出程序时该任务被中断，是否继续执行？</span>
        {preview ? <p className="pending-resume-card-preview" title={preview}>{preview}</p> : null}
      </div>
      <div className="pending-resume-card-actions">
        <button type="button" className="pending-resume-card-primary" onClick={onResume}>继续任务</button>
        <button type="button" className="pending-resume-card-dismiss" onClick={onDismiss}>忽略</button>
      </div>
    </section>
  );
}

export function TurnElapsedBanner({
  startedAt,
  completedAt,
  active = false,
  collapsed = false,
  onToggle
}: {
  startedAt: string;
  completedAt?: string | null;
  active?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const elapsedMs = useElapsedClock(startedAt, active, completedAt);
  return (
    <div className={`turn-elapsed-banner ${active ? "active" : "completed"}`} aria-live="polite">
      <div className="turn-elapsed-head">
        <span className="turn-elapsed-label">已处理 {formatElapsedClock(elapsedMs)}</span>
        {onToggle ? (
          <button
            type="button"
            className={`turn-elapsed-toggle ${collapsed ? "" : "is-expanded"}`}
            aria-expanded={!collapsed}
            title={collapsed ? "展开处理过程" : "折叠处理过程"}
            onClick={onToggle}
          >
            <IconChevronRight />
          </button>
        ) : null}
      </div>
      <div className="turn-elapsed-track" aria-hidden="true">
        <span className="turn-elapsed-bar" />
      </div>
    </div>
  );
}

export function ComposerSubmissionStatus({ submission }: { submission: ComposerSubmission }) {
  const elapsedMs = useElapsedClock(submission.startedAt, true);
  const isSlow = elapsedMs >= 5_000;
  const isDelayed = elapsedMs >= 15_000;
  const content = submission.content.replace(/\s+/g, " ").trim();
  const label = isDelayed
    ? `\u4ecd\u5728\u51c6\u5907\u4efb\u52a1 \u00b7 \u5df2\u7b49\u5f85 ${formatElapsedClock(elapsedMs)}`
    : isSlow
      ? `\u6b63\u5728\u542f\u52a8\u4efb\u52a1 \u00b7 \u5df2\u7b49\u5f85 ${formatElapsedClock(elapsedMs)}`
      : "\u6d88\u606f\u5df2\u6536\u5230\uff0c\u6b63\u5728\u51c6\u5907\u4efb\u52a1";

  return (
    <section className={`composer-submission-status ${isSlow ? "slow" : ""}`} aria-live="polite">
      <span className="task-processing-dots" aria-hidden="true"><i /><i /><i /></span>
      <div>
        <strong>{label}</strong>
        {content ? <span className="composer-submission-preview">{content}</span> : null}
      </div>
    </section>
  );
}

export function RuntimeActivityPanel({
  label,
  entries,
  deferredToolCalls,
  preferLabel = false,
  hideCurrentStatus = false,
  activeSubagents,
  queuedSubagentIds,
  runtimeActivities,
  onInterruptSubagent
}: {
  label: string;
  entries: RuntimeActivityEntry[];
  deferredToolCalls: ToolCallRecord[];
  preferLabel?: boolean;
  hideCurrentStatus?: boolean;
  activeSubagents: ThreadRecord[];
  queuedSubagentIds: Set<string>;
  runtimeActivities: Record<string, RuntimeActivity>;
  onInterruptSubagent: (agent: ThreadRecord) => void;
}) {
  const latestStatus = [...entries].reverse().find((entry) => entry.kind === "status");
  const runningToolCall = [...entries].reverse().find(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> =>
      entry.kind === "tool" && (entry.toolCall.status === "pending" || entry.toolCall.status === "running")
  )?.toolCall ?? null;
  const displayLabel = preferLabel ? label : latestStatus?.label ?? label;
  const runningToolLabel = runningToolCall
    ? getConciseToolActivityLabel([runningToolCall], runningToolCall)
    : null;
  const runningToolDetail = runningToolLabel && !preferLabel && latestStatus?.label && latestStatus.label !== runningToolLabel
    ? latestStatus.label
    : null;
  const runningCommand = displayLabel.startsWith("正在运行 ")
    ? displayLabel.slice("正在运行 ".length)
    : null;

  const currentStatusContent = <>
      {runningToolCall ? (
        <span className="runtime-activity-current-icon" aria-hidden>
          <ToolActivityIcon toolName={runningToolCall.toolName} />
        </span>
      ) : null}
      {runningToolLabel ? <strong>{runningToolLabel}</strong> : runningCommand ? (
        <span className="runtime-activity-command">
          <span>正在运行</span>
          <code title={runningCommand}>{runningCommand}</code>
        </span>
      ) : <strong>{displayLabel}</strong>}
      {runningToolDetail ? <span className="runtime-activity-current-detail">{runningToolDetail}</span> : null}
    </>;
  const currentStatus = <div className="runtime-activity-current">{currentStatusContent}</div>;
  const liveToolCalls = deferredToolCalls.length > 0
    ? deferredToolCalls
    : runningToolCall
      ? [runningToolCall]
      : [];
  return (
    <section className="runtime-activity-panel" aria-live="polite">
      {liveToolCalls.length > 0
        ? <ToolActivityGroup toolCalls={liveToolCalls} />
        : hideCurrentStatus
          ? null
          : currentStatus}
      {activeSubagents.length > 0 ? (
        <ActiveSubagentLines
          agents={activeSubagents}
          queuedAgentIds={queuedSubagentIds}
          runtimeActivities={runtimeActivities}
          onInterrupt={onInterruptSubagent}
        />
      ) : null}
    </section>
  );
}

export function RuntimeActivityOutputRow({ label, content }: { label: string; content: string }) {
  return (
    <details className="runtime-activity-output">
      <summary>
        <span className="runtime-activity-output-icon" aria-hidden><IconTerminal /></span>
        <strong>{label}</strong>
        <span>查看输出</span>
      </summary>
      <pre>{content}</pre>
    </details>
  );
}

export function QueuedMessageList({
  messages,
  hasProject,
  deletingId,
  onDelete,
  onSteer
}: {
  messages: QueuedMessageRecord[];
  hasProject: boolean;
  deletingId: string | null;
  onDelete: (id: string) => void;
  onSteer: (message: QueuedMessageRecord) => void;
}) {
  const visible = messages.filter(
    (message) =>
      !message.content.trimStart().startsWith("[internal:") &&
      !message.displayContent.trimStart().startsWith("[internal:")
  );
  if (visible.length === 0) {
    return null;
  }
  return (
    <section className={`composer-queue ${hasProject ? "has-project" : ""}`} aria-label="排队消息">
      {visible.map((message, index) => (
        <div key={message.id} className={`composer-queue-item ${deletingId === message.id ? "is-removing" : ""}`}>
          <span className="composer-queue-index" aria-hidden>{index + 1}</span>
          <span className="composer-queue-label">{index === 0 ? "下一项" : "待处理"}</span>
          <span className="composer-queue-preview" title={message.displayContent}>{message.displayContent}</span>
          {message.attachments.length > 0 ? <span className="composer-queue-attachments">{message.attachments.length} 个附件</span> : null}
          <button
            type="button"
            className="composer-queue-steer"
            title="引导当前任务"
            aria-label="引导当前任务"
            disabled={deletingId === message.id}
            onClick={() => onSteer(message)}
          >
            <IconGuide />
          </button>
          <button
            type="button"
            className="composer-queue-delete"
            title="删除排队消息"
            aria-label="删除排队消息"
            disabled={deletingId === message.id}
            onClick={() => onDelete(message.id)}
          >
            <IconClose />
          </button>
        </div>
      ))}
    </section>
  );
}

export function GpaConfirmationCard({
  stage,
  disabled,
  isEditing,
  revisionDraft,
  revisionRef,
  onConfirm,
  onRevise,
  onRevisionChange,
  onRevisionCancel,
  onRevisionSubmit
}: {
  stage: Exclude<GpaStage, "off" | "act">;
  disabled: boolean;
  isEditing: boolean;
  revisionDraft: string;
  revisionRef: RefObject<HTMLTextAreaElement | null>;
  onConfirm: () => void;
  onRevise: () => void;
  onRevisionChange: (value: string) => void;
  onRevisionCancel: () => void;
  onRevisionSubmit: () => void;
}) {
  const isPlan = stage === "plan";
  const title = isPlan ? "确认计划" : "确认目标";
  const description = isPlan
    ? "计划确认后将直接进入执行阶段。"
    : "目标确认后将生成可执行的任务计划。";
  const confirmLabel = isPlan ? "确认并开始执行" : "确认并生成计划";

  if (isEditing) {
    return (
      <section className="gpa-confirmation editing" aria-label="修改计划">
        <div className="gpa-confirmation-copy">
          <strong>修改计划</strong>
          <span>说明需要调整的范围、顺序或验收条件。</span>
        </div>
        <textarea
          ref={revisionRef}
          className="gpa-revision-input"
          value={revisionDraft}
          onChange={(event) => onRevisionChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              onRevisionSubmit();
            }
          }}
          placeholder="例如：先完成基础玩法，再加入难度选择；验收时补充单元测试。"
          disabled={disabled}
        />
        <div className="gpa-revision-footer">
          <span>Ctrl / Cmd + Enter 提交</span>
          <div className="gpa-confirmation-actions">
            <button className="gpa-confirmation-button secondary" type="button" onClick={onRevisionCancel} disabled={disabled}>
              取消
            </button>
            <button className="gpa-confirmation-button primary" type="button" onClick={onRevisionSubmit} disabled={disabled || !revisionDraft.trim()}>
              提交修改
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`gpa-confirmation stage-${stage}`} aria-label={title}>
      <div className="gpa-confirmation-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="gpa-confirmation-actions">
        <button className="gpa-confirmation-button secondary" type="button" onClick={onRevise} disabled={disabled}>
          修改
        </button>
        <button className={`gpa-confirmation-button primary stage-${stage}`} type="button" onClick={onConfirm} disabled={disabled}>
          {confirmLabel}
        </button>
      </div>
    </section>
  );
}

export function GpaPlanResumeRetryConfirmationCard({
  pendingCount,
  disabled,
  onDismiss,
  onConfirm
}: {
  pendingCount: number;
  disabled: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  return (
    <section className="gpa-confirmation gpa-resume-retry" aria-label="确认继续 GPA 计划">
      <div className="gpa-confirmation-copy">
        <strong>GPA 计划已暂停</strong>
        <span>剩余 {pendingCount} 项任务尚未完成。是否从下一项继续执行？</span>
      </div>
      <div className="gpa-confirmation-actions">
        <button className="gpa-confirmation-button secondary" type="button" onClick={onDismiss} disabled={disabled}>
          暂不继续
        </button>
        <button className="gpa-confirmation-button primary" type="button" onClick={onConfirm} disabled={disabled}>
          {disabled ? "正在重试..." : "重试剩余任务"}
        </button>
      </div>
    </section>
  );
}

export function PlanItem({ label, status }: { label: string; status: "pending" | "in_progress" | "completed" }) {
  return (
    <div className={`plan-timeline-item ${status}`}>
      <span className="plan-tree">└─</span>
      <StatusIcon status={status} />
      <span className="plan-timeline-label">{label}</span>
    </div>
  );
}

export function StatusIcon({ status }: { status: "pending" | "in_progress" | "completed" | "failed" | "blocked" }) {
  const glyph = status === "completed" ? "✔" : status === "in_progress" ? "◐" : status === "failed" ? "✕" : "□";
  return <span className={`timeline-status-icon ${status}`}>{glyph}</span>;
}
