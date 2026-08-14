import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { GpaStage, PendingResumeThread, QueuedMessageRecord, ThreadRecord } from "@shared-types";
import { IconBolt, IconChevronRight, IconClose, IconCompose, IconGuide, IconTerminal } from "../icons";
import { getToolProcessingLabel, type SkillNameMap } from "../lib/conversation-utils";
import { ToolActivityIcon } from "../timeline/transcript";
import type { ComposerSubmission, RuntimeActivity, RuntimeActivityEntry, RuntimeProgress } from "../core/app-types";

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

function getRuntimeEntryCreatedAt(entry: RuntimeActivityEntry): string {
  return entry.kind === "tool"
    ? entry.toolCall.completedAt ?? entry.toolCall.startedAt
    : entry.createdAt;
}

const transientDraftStatusLabels = new Set([
  "正在起草回复",
  "正在检查回复",
  "正在确认回复完整性",
  "正在补充回复"
]);

function isTransientDraftStatus(entry: RuntimeActivityEntry): boolean {
  return entry.kind === "status" && transientDraftStatusLabels.has(entry.label);
}

function getRuntimeHistoryLabel(entry: RuntimeActivityEntry, skillNames?: SkillNameMap): string {
  if (entry.kind !== "tool") return entry.label;
  const action = getToolProcessingLabel(
    entry.toolCall.toolName,
    entry.toolCall.argumentsJson,
    skillNames
  ).replace(/^正在/, "");
  if (entry.toolCall.status === "failed" || entry.toolCall.status === "denied") return `失败 · ${action}`;
  if (entry.toolCall.status === "blocked") return `已拦截 · ${action}`;
  if (entry.toolCall.status === "running" || entry.toolCall.status === "pending") return `正在${action}`;
  return `已完成 · ${action}`;
}

function formatRuntimeEventOffset(createdAt: string, startedAt?: string | null): string {
  if (!startedAt) return "";
  const offset = Date.parse(createdAt) - Date.parse(startedAt);
  return Number.isFinite(offset) ? `+${formatElapsedClock(Math.max(0, offset))}` : "";
}

function isShellOrTestTool(toolName: string, argumentsJson: string): boolean {
  if (toolName === "project.verify") return true;
  if (toolName === "shell.exec") return true;
  return /\b(?:test|vitest|jest|mocha|ava|pytest|go\s+test|cargo\s+test|dotnet\s+test)\b/i.test(argumentsJson);
}

function getSubagentActivityLabel(
  agent: ThreadRecord,
  queued: boolean,
  activity: RuntimeActivity | undefined,
  skillNames?: SkillNameMap
): string {
  if (queued) return "排队中";
  if (agent.status === "completed") return "已完成";
  if (agent.status === "failed") return "失败";
  const activeTool = [...(activity?.entries ?? [])].reverse().find(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> => entry.kind === "tool" && entry.toolCall.status === "running"
  );
  if (activeTool) {
    return isShellOrTestTool(activeTool.toolCall.toolName, activeTool.toolCall.argumentsJson)
      ? "执行 shell/test"
      : getToolProcessingLabel(activeTool.toolCall.toolName, activeTool.toolCall.argumentsJson, skillNames);
  }
  const latest = activity?.entries.at(-1);
  if (latest?.kind === "status") {
    if (/自动中断/.test(latest.label)) return "已自动中断";
    if (/重试|retry/i.test(latest.label)) return "重试中";
  }
  if (agent.status === "waiting") return "等待模型响应";
  return activity ? "等待模型响应" : "启动中";
}

function SubagentWatchdogMeta({
  agent,
  activity,
  queued,
  terminal
}: {
  agent: ThreadRecord;
  activity: RuntimeActivity | undefined;
  queued: boolean;
  terminal: boolean;
}) {
  const latestEntry = activity?.entries.at(-1);
  const progressAt = latestEntry ? getRuntimeEntryCreatedAt(latestEntry) : agent.createdAt;
  const sinceProgressMs = useElapsedClock(progressAt, !terminal);
  const runtimeMs = useElapsedClock(activity?.startedAt ?? agent.createdAt, !terminal);
  const automaticInterruptInMs = Math.max(0, Math.min(120_000 - sinceProgressMs, 1_800_000 - runtimeMs));
  const stalled = !queued && !terminal && sinceProgressMs >= 120_000;
  return <>
    <span>{stalled ? "已停滞" : `最近进度 ${formatElapsedClock(sinceProgressMs)} 前`}</span>
    {!terminal ? <span>{`自动中断倒计时 ${formatElapsedClock(automaticInterruptInMs)}`}</span> : null}
  </>;
}

function ActiveSubagentLines({
  agents,
  queuedAgentIds,
  runtimeActivities,
  onInterrupt,
  skillNames
}: {
  agents: ThreadRecord[];
  queuedAgentIds: Set<string>;
  runtimeActivities: Record<string, RuntimeActivity>;
  onInterrupt: (agent: ThreadRecord) => void;
  skillNames?: SkillNameMap;
}) {
  return (
    <div className="active-subagent-lines" aria-label="本次任务的子智能体" aria-live="polite">
      {agents.map((agent) => {
        const queued = queuedAgentIds.has(agent.id);
        const state = queued
          ? "queued"
          : agent.status === "waiting"
            ? "waiting"
            : agent.status === "running"
              ? "running"
              : agent.status;
        const terminal = !queued && agent.status !== "running" && agent.status !== "waiting";
        const runtimeActivity = runtimeActivities[agent.id];
        const runtimeHistory = getSubagentRuntimeHistory(runtimeActivity, skillNames);
        const title = getSubagentTitle(agent);
        const statusLabel = queued
          ? "排队中"
          : agent.status === "waiting"
            ? "等待中"
            : agent.status === "running"
              ? "运行中"
              : agent.status === "completed"
                ? "已完成"
                : agent.status === "failed"
                  ? "失败"
                : "已创建";
        const activityLabel = getSubagentActivityLabel(agent, queued, runtimeActivity, skillNames);
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
                  active={!terminal}
                  completedAt={terminal ? agent.updatedAt : null}
                />
                <SubagentWatchdogMeta
                  agent={agent}
                  activity={runtimeActivity}
                  queued={queued}
                  terminal={terminal}
                />
                {!terminal ? (
                  <button type="button" className="active-subagent-stop" onClick={() => onInterrupt(agent)}>
                    停止
                  </button>
                ) : null}
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

function getSubagentRuntimeLabel(activity: RuntimeActivity | undefined, skillNames?: SkillNameMap): string | null {
  if (!activity) return null;
  const activeTool = [...activity.entries].reverse().find(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> => entry.kind === "tool" && entry.toolCall.status === "running"
  );
  if (activeTool) return getToolProcessingLabel(activeTool.toolCall.toolName, activeTool.toolCall.argumentsJson, skillNames);
  const latestStatus = [...activity.entries].reverse().find(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "status" }> => entry.kind === "status"
  );
  return latestStatus?.label ?? null;
}

function getSubagentRuntimeHistory(activity: RuntimeActivity | undefined, skillNames?: SkillNameMap): Array<{ id: string; label: string }> {
  if (!activity) return [];
  return activity.entries.slice(-5).reverse().map((entry) => ({
    id: entry.id,
    label: entry.kind === "tool"
      ? entry.toolCall.status === "running"
        ? getToolProcessingLabel(entry.toolCall.toolName, entry.toolCall.argumentsJson, skillNames)
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
    ? "仍在准备任务"
    : isSlow
      ? "正在启动任务"
      : "正在准备任务";

  return (
    <section className={`composer-submission-status ${isSlow ? "slow" : ""}`} aria-live="polite">
      <span className="composer-submission-status-icon" aria-hidden><IconCompose /></span>
      <div className="composer-submission-status-copy">
        <div className="composer-submission-status-head">
          <strong>{label}</strong>
          <time>{formatElapsedClock(elapsedMs)}</time>
        </div>
        <span className="composer-submission-preview">
          {isDelayed ? "准备时间较长，仍在创建任务并整理上下文" : content || "正在创建任务并整理上下文"}
        </span>
      </div>
    </section>
  );
}

export function RuntimeActivityPanel({
  label,
  entries,
  startedAt,
  phase,
  skillNames,
  preferLabel = false,
  hideCurrentStatus = false,
  activeSubagents,
  queuedSubagentIds,
  runtimeActivities,
  onInterruptSubagent
}: {
  label: string;
  entries: RuntimeActivityEntry[];
  startedAt?: string | null;
  phase?: RuntimeProgress["phase"] | null;
  skillNames?: SkillNameMap;
  preferLabel?: boolean;
  hideCurrentStatus?: boolean;
  activeSubagents: ThreadRecord[];
  queuedSubagentIds: Set<string>;
  runtimeActivities: Record<string, RuntimeActivity>;
  onInterruptSubagent: (agent: ThreadRecord) => void;
}) {
  // Older active tasks may already contain draft-phase events. They carry no
  // execution detail, so keep them out of the timeline while preserving tools,
  // retry reasons, and actual task-state transitions.
  const visibleEntries = entries.filter((entry) => !isTransientDraftStatus(entry));
  const latestStatus = [...visibleEntries].reverse().find((entry) => entry.kind === "status");
  const isGenericModelDecisionStatus = latestStatus?.label === "正在请求模型决策" ||
    latestStatus?.label === "正在重新请求模型决策";
  const runningToolCalls = visibleEntries.filter(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> =>
      entry.kind === "tool" && (entry.toolCall.status === "pending" || entry.toolCall.status === "running")
  ).map((entry) => entry.toolCall);
  const runningToolCall = runningToolCalls.at(-1) ?? null;
  const displayLabel = preferLabel || isGenericModelDecisionStatus
    ? label
    : latestStatus?.label ?? label;
  const runningToolLabel = runningToolCall
    ? getToolProcessingLabel(runningToolCall.toolName, runningToolCall.argumentsJson, skillNames)
    : null;
  const runningToolDetail = runningToolLabel && !preferLabel && latestStatus?.label && latestStatus.label !== runningToolLabel
    ? latestStatus.label
    : null;
  const runningCommand = displayLabel.startsWith("正在运行 ")
    ? displayLabel.slice("正在运行 ".length)
    : null;
  const activityStartedAt = startedAt ?? (visibleEntries[0] ? getRuntimeEntryCreatedAt(visibleEntries[0]) : null);
  const elapsedMs = useElapsedClock(activityStartedAt, true);
  const latestEntry = visibleEntries.at(-1);
  const latestActivityAt = latestEntry ? getRuntimeEntryCreatedAt(latestEntry) : activityStartedAt;
  const unchangedMs = useElapsedClock(latestActivityAt, true);
  const primaryLabel = runningToolLabel ?? displayLabel;
  const waitingForExternalInput = /等待|审批|选择/.test(primaryLabel);
  const freshnessLabel = unchangedMs >= 10_000 && !waitingForExternalInput
    ? formatElapsedClock(unchangedMs)
    : null;
  const parallelToolLabel = runningToolCalls.length > 1 ? `另有 ${runningToolCalls.length - 1} 项操作正在执行` : null;
  const currentDetail = parallelToolLabel ?? runningToolDetail ?? freshnessLabel;
  const currentEntryIds = new Set([
    runningToolCall?.id,
    latestStatus?.id
  ].filter((id): id is string => Boolean(id)));
  const historyItems = visibleEntries
    .filter((entry) => !currentEntryIds.has(entry.kind === "tool" ? entry.toolCall.id : entry.id))
    .slice(-5)
    .reverse();

  const currentStatusContent = <>
    <span className="runtime-activity-current-icon" aria-hidden>
      {runningToolCall
        ? <ToolActivityIcon toolName={runningToolCall.toolName} />
        : phase === "preparing" || phase === "generating"
          ? <IconCompose />
          : <IconBolt />}
    </span>
    <span className="runtime-activity-current-copy">
      {runningCommand && !runningToolLabel ? (
        <span className="runtime-activity-command">
          <span>正在运行</span>
          <code title={runningCommand}>{runningCommand}</code>
        </span>
      ) : <strong>{primaryLabel}</strong>}
      {currentDetail ? <span className="runtime-activity-current-detail">{currentDetail}</span> : null}
    </span>
    <time>{formatElapsedClock(elapsedMs)}</time>
  </>;
  const currentStatus = historyItems.length > 0 ? (
    <details className="runtime-activity-status">
      <summary className="runtime-activity-current">
        {currentStatusContent}
        <span className="runtime-activity-history-chevron" aria-hidden><IconChevronRight /></span>
      </summary>
      <div className="runtime-activity-history" aria-label="最近执行记录">
        {historyItems.map((entry) => {
          const toolName = entry.kind === "tool" ? entry.toolCall.toolName : null;
          const eventAt = getRuntimeEntryCreatedAt(entry);
          return (
            <div key={entry.kind === "tool" ? entry.toolCall.id : entry.id} className="runtime-activity-history-item">
              <span className="runtime-activity-history-icon" aria-hidden>
                {toolName ? <ToolActivityIcon toolName={toolName} /> : entry.kind === "output" ? <IconTerminal /> : <IconBolt />}
              </span>
              <span>{getRuntimeHistoryLabel(entry, skillNames)}</span>
              <time>{formatRuntimeEventOffset(eventAt, activityStartedAt)}</time>
            </div>
          );
        })}
      </div>
    </details>
  ) : <div className="runtime-activity-current">{currentStatusContent}</div>;
  return (
    <section className="runtime-activity-panel" aria-live="polite">
      {hideCurrentStatus ? null : currentStatus}
      {activeSubagents.length > 0 ? (
        <ActiveSubagentLines
          agents={activeSubagents}
          queuedAgentIds={queuedSubagentIds}
          runtimeActivities={runtimeActivities}
          skillNames={skillNames}
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
