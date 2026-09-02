import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { GpaStage, MultiAgentMode, PendingResumeThread, QueuedMessageRecord, SubagentResultEnvelope, ThreadRecord } from "@shared-types";
import { IconBolt, IconCheck, IconChevronRight, IconClose, IconCompose, IconGuide, IconHelpCircle, IconSpinner, IconStop, IconTerminal } from "../icons";
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

export type SubagentDisplayState = "queued" | "running" | "waiting_input" | "completed" | "failed" | "cancelled";

const subagentTaskWordLabels: Record<string, string> = {
  api: "API",
  analysis: "分析",
  analyze: "分析",
  auth: "认证",
  backend: "后端",
  check: "检查",
  code: "代码",
  coverage: "覆盖",
  docs: "文档",
  documentation: "文档",
  frontend: "前端",
  implement: "实现",
  implementation: "实现",
  research: "调研",
  review: "审查",
  security: "安全",
  test: "测试",
  testing: "测试",
  tests: "测试",
  ui: "UI",
  ux: "UX"
};

export function getSubagentTaskName(agent: Pick<ThreadRecord, "agentRole" | "lastTaskMessage">): string {
  const rawRole = agent.agentRole?.trim() ?? "";
  const shouldUsePrompt = !rawRole || /^(?:spawn[_ -]?agent|subagent|agent|worker)$/i.test(rawRole);
  const promptGoal = agent.lastTaskMessage
    ?.replace(/^\[[^\]]+\]\s*/, "")
    .split(/[\r\n。！？.!?]/, 1)[0]
    .trim();
  const raw = shouldUsePrompt && promptGoal ? promptGoal.slice(0, 32) : rawRole || "任务分析";
  if (/[^\x00-\x7f]/.test(raw)) return raw;

  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => subagentTaskWordLabels[word.toLowerCase()] ?? word);
  return words.join("").replace(/([A-Z0-9]+)(?=[\u4e00-\u9fff])/g, "$1 ") || "任务分析";
}

export function resolveSubagentDisplayState(
  agent: Pick<ThreadRecord, "status">,
  queued: boolean,
  result: SubagentResultEnvelope | undefined,
  waitingForInput: boolean
): SubagentDisplayState {
  if (result?.status === "interrupted") return "cancelled";
  if (queued || result?.status === "queued") return "queued";
  if (waitingForInput) return "waiting_input";
  if (result?.status === "failed" || agent.status === "failed") return "failed";
  if (result?.status === "completed" || agent.status === "completed") return "completed";
  return "running";
}

const subagentStatusLabels: Record<SubagentDisplayState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待输入",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

function SubagentStatusIcon({ state }: { state: SubagentDisplayState }) {
  if (state === "completed") return <IconCheck />;
  if (state === "failed") return <IconClose />;
  if (state === "cancelled") return <IconStop />;
  if (state === "waiting_input") return <IconHelpCircle />;
  return state === "queued" ? <IconBolt /> : <IconSpinner />;
}

function getSubagentActivityLabel(
  agent: ThreadRecord,
  state: SubagentDisplayState,
  activity: RuntimeActivity | undefined,
  skillNames?: SkillNameMap
): string {
  if (state === "queued") return "等待可用执行槽位";
  if (state === "waiting_input") return "需要你的输入后继续";
  if (state === "completed") return "结果已就绪";
  if (state === "failed") return "执行未完成";
  if (state === "cancelled") return "任务已停止";
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
    if (/重试|retry/i.test(latest.label)) return "重试中";
    return latest.label;
  }
  if (agent.status === "waiting") return "等待模型响应";
  return activity ? "正在分析任务" : "正在启动";
}

function formatActivityAge(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时`;
}

function SubagentFreshness({
  agent,
  activity,
  state
}: {
  agent: ThreadRecord;
  activity: RuntimeActivity | undefined;
  state: SubagentDisplayState;
}) {
  const latestEntry = activity?.entries.at(-1);
  const terminal = state === "completed" || state === "failed" || state === "cancelled";
  const progressAt = latestEntry ? getRuntimeEntryCreatedAt(latestEntry) : terminal ? agent.updatedAt : agent.createdAt;
  const sinceProgressMs = useElapsedClock(progressAt, !terminal);
  if (terminal) return <span>{`最后更新 ${formatActivityAge(sinceProgressMs)}前`}</span>;
  if (state === "running" && sinceProgressMs >= 30_000) {
    return <span className="is-idle">{`仍在运行，${formatActivityAge(sinceProgressMs)}无新活动`}</span>;
  }
  return <span>{`最近更新 ${formatActivityAge(sinceProgressMs)}前`}</span>;
}

type SubagentPhase = { id: string; label: string; state: "completed" | "current" | "failed" | "cancelled" };

function getSubagentEntryPhase(entry: RuntimeActivityEntry): string | null {
  if (entry.kind === "output") return "检查输出";
  if (entry.kind === "status") {
    if (/重试|retry/i.test(entry.label)) return "重试";
    if (/审批|确认|输入|选择/.test(entry.label)) return "等待输入";
    if (/等待模型|模型响应|模型生成/.test(entry.label)) return "等待模型响应";
    if (/等待子智能体|等待子任务|等待协作/.test(entry.label)) return "等待子任务";
    if (/等待/.test(entry.label)) return "等待继续";
    if (/分析|思考|模型|决策|理解/.test(entry.label)) return "分析任务";
    return null;
  }
  const identity = `${entry.toolCall.toolName} ${entry.toolCall.argumentsJson}`.toLowerCase();
  if (/test|vitest|jest|pytest|mocha|cargo test|go test|dotnet test/.test(identity)) return "执行测试";
  if (/read|search|list|glob|find|inspect/.test(identity)) return "读取代码";
  if (/patch|write|edit|replace|delete|move|rename/.test(identity)) return "修改代码";
  if (/browser|playwright|screenshot/.test(identity)) return "检查界面";
  return "执行操作";
}

export function getSubagentPhases(
  state: SubagentDisplayState,
  activity: RuntimeActivity | undefined
): SubagentPhase[] {
  if (state === "queued") return [{ id: "queued", label: "排队准备", state: "current" }];
  const labels: string[] = [];
  for (const entry of activity?.entries ?? []) {
    const label = getSubagentEntryPhase(entry);
    if (label && labels.at(-1) !== label) labels.push(label);
  }
  if (labels.length === 0) labels.push("分析任务");
  if (state === "waiting_input" && labels.at(-1) !== "等待输入") labels.push("等待输入");
  if (state === "completed") labels.push("整理结果");
  if (state === "failed") labels.push("任务失败");
  if (state === "cancelled") labels.push("任务取消");
  return labels.slice(-5).map((label, index, visibleLabels) => ({
    id: `${index}-${label}`,
    label,
    state: index < visibleLabels.length - 1 || state === "completed"
      ? "completed"
      : state === "failed"
        ? "failed"
        : state === "cancelled"
          ? "cancelled"
          : "current"
  }));
}

function getSubagentOperationMetric(activity: RuntimeActivity | undefined): string | null {
  const tools = (activity?.entries ?? []).filter(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> => entry.kind === "tool"
  );
  if (tools.length === 0) return null;
  const completed = tools.filter((entry) =>
    entry.toolCall.status === "completed" || entry.toolCall.status === "failed" || entry.toolCall.status === "blocked" || entry.toolCall.status === "denied"
  ).length;
  return `操作 ${completed}/${tools.length}`;
}

export function compactSubagentResultSummary(value: string | null | undefined, fallback: string): string {
  const firstLine = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, "").trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function getSubagentCurrentOutput(
  state: SubagentDisplayState,
  result: SubagentResultEnvelope | undefined,
  activity: RuntimeActivity | undefined
): string {
  if (state === "failed") return compactSubagentResultSummary(result?.errors[0] ?? result?.summary, "任务失败，但没有返回错误原因。");
  if (state === "cancelled") return compactSubagentResultSummary(result?.errors[0], "任务已由用户或运行保护机制停止。");
  if (state === "completed") return compactSubagentResultSummary(result?.summary, "任务已完成，但没有返回结果摘要。");
  const latestOutput = [...(activity?.entries ?? [])].reverse().find(
    (entry): entry is Extract<RuntimeActivityEntry, { kind: "output" }> => entry.kind === "output"
  );
  return compactSubagentResultSummary(latestOutput?.content, "暂未形成可展示的中间产出。");
}

export function getSubagentGroupSummary(
  agents: ThreadRecord[],
  queuedAgentIds: Set<string>,
  resultsById: Map<string, SubagentResultEnvelope>,
  waitingInputAgentIds: Set<string>
): string {
  const counts = new Map<SubagentDisplayState, number>();
  for (const agent of agents) {
    const state = resolveSubagentDisplayState(agent, queuedAgentIds.has(agent.id), resultsById.get(agent.id), waitingInputAgentIds.has(agent.id));
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const parts = (["completed", "running", "waiting_input", "queued", "failed", "cancelled"] as const)
    .flatMap((state) => counts.get(state) ? [`${counts.get(state)} ${subagentStatusLabels[state]}`] : []);
  return parts.length > 0 ? `子任务 ${parts.join(" · ")}` : "子任务 尚未启动";
}

export function shouldShowSubagentStatusDock(taskProcessing: boolean, mode: MultiAgentMode, activeSubagentCount = 0): boolean {
  return taskProcessing && mode === "proactive" && activeSubagentCount > 0;
}

export function SubagentStatusDock({
  summary,
  count,
  expanded,
  onToggle,
  children
}: {
  summary: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  if (count === 0) return null;

  return (
    <div className={`subagent-status-dock ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="workspace-control-button subagent-status-dock-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls="subagent-status-panel"
        aria-label={`${expanded ? "收起" : "展开"}子智能体详情，${summary}`}
        title={expanded ? "收起子智能体详情" : "展开子智能体详情"}
      >
        <span className="subagent-status-dock-icon" aria-hidden><IconGuide /></span>
        {count > 0 ? <span className="subagent-status-dock-count" aria-hidden>{count}</span> : null}
      </button>
      {expanded ? (
        <div id="subagent-status-panel" className="subagent-status-panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function SubagentTaskGroup({
  agents,
  queuedAgentIds,
  resultsById,
  waitingInputAgentIds,
  runtimeActivities,
  onInterrupt,
  onSendInstruction,
  onRetry,
  onTakeOver,
  skillNames
}: {
  agents: ThreadRecord[];
  queuedAgentIds: Set<string>;
  resultsById: Map<string, SubagentResultEnvelope>;
  waitingInputAgentIds: Set<string>;
  runtimeActivities: Record<string, RuntimeActivity>;
  onInterrupt: (agent: ThreadRecord) => void;
  onSendInstruction: (agent: ThreadRecord, instruction: string) => Promise<void>;
  onRetry: (agent: ThreadRecord) => Promise<void>;
  onTakeOver: (agent: ThreadRecord) => void;
  skillNames?: SkillNameMap;
}) {
  const [instructionAgentId, setInstructionAgentId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ agentId: string; message: string } | null>(null);

  const runAction = async (agent: ThreadRecord, action: () => Promise<void>): Promise<boolean> => {
    setBusyAgentId(agent.id);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError({ agentId: agent.id, message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <section id="subagent-task-group" className="subagent-task-group" aria-label="本次任务的子任务" aria-live="polite">
      <header className="subagent-task-group-header">
        <div>
          <span className="subagent-task-group-kicker">并行任务</span>
          <strong>{getSubagentGroupSummary(agents, queuedAgentIds, resultsById, waitingInputAgentIds)}</strong>
        </div>
      </header>
      <div className="subagent-task-list">
      {agents.map((agent) => {
        const queued = queuedAgentIds.has(agent.id);
        const result = resultsById.get(agent.id);
        const state = resolveSubagentDisplayState(agent, queued, result, waitingInputAgentIds.has(agent.id));
        const terminal = state === "completed" || state === "failed" || state === "cancelled";
        const runtimeActivity = runtimeActivities[agent.id];
        const runtimeHistory = getSubagentRuntimeHistory(runtimeActivity, skillNames);
        const title = getSubagentTaskName(agent);
        const activityLabel = getSubagentActivityLabel(agent, state, runtimeActivity, skillNames);
        const phases = getSubagentPhases(state, runtimeActivity);
        const operationMetric = getSubagentOperationMetric(runtimeActivity);
        const currentOutput = getSubagentCurrentOutput(state, result, runtimeActivity);
        const isEditingInstruction = instructionAgentId === agent.id;
        const isBusy = busyAgentId === agent.id;
        return (
          <details key={agent.id} className={`subagent-task ${state}`}>
            <summary title="展开任务详情">
              <span className={`subagent-task-status ${state}`}>
                <span aria-hidden><SubagentStatusIcon state={state} /></span>
                {subagentStatusLabels[state]}
              </span>
              <span className="subagent-task-summary-copy">
                <strong>{title}</strong>
                <span>{terminal ? currentOutput : activityLabel}</span>
              </span>
              <span className="subagent-task-freshness"><SubagentFreshness agent={agent} activity={runtimeActivity} state={state} /></span>
              {state === "failed" || state === "cancelled" ? (
                <button
                  type="button"
                  className="subagent-task-quick-retry"
                  disabled={isBusy}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void runAction(agent, () => onRetry(agent));
                  }}
                >
                  <IconSpinner />
                  {isBusy ? "重试中..." : "重试"}
                </button>
              ) : <span className="subagent-task-view-label">{terminal ? "查看结果" : "查看详情"}</span>}
              <span className="subagent-task-chevron" aria-hidden><IconChevronRight /></span>
            </summary>
            <div className="subagent-task-detail">
              <div className="subagent-task-section">
                <span className="subagent-task-section-label">任务目标</span>
                <p>{agent.lastTaskMessage || agent.agentRole || "暂无任务说明。"}</p>
              </div>
              <div className="subagent-task-section">
                <div className="subagent-task-section-head">
                  <span className="subagent-task-section-label">阶段进度</span>
                  {operationMetric ? <span className="subagent-task-metric">{operationMetric}</span> : null}
                </div>
                <div className="subagent-phase-track">
                  {phases.map((phase, index) => (
                    <span key={phase.id} className={`subagent-phase ${phase.state}`}>
                      <i aria-hidden>{phase.state === "completed" ? "✓" : phase.state === "current" ? "●" : "×"}</i>
                      {phase.label}
                      {index < phases.length - 1 ? <b aria-hidden>→</b> : null}
                    </span>
                  ))}
                </div>
              </div>
              <div className="subagent-task-section">
                <span className="subagent-task-section-label">当前产出</span>
                <p className={`subagent-task-output ${state}`}>{currentOutput}</p>
              </div>
              {runtimeHistory.length > 0 ? (
                <div className="subagent-task-section">
                  <span className="subagent-task-section-label">关键操作时间线</span>
                  <div className="subagent-task-history">
                    {runtimeHistory.map((entry) => <span key={entry.id}>{entry.label}</span>)}
                  </div>
                </div>
              ) : null}
              <div className="subagent-task-meta">
                <SubagentElapsedTime
                  startedAt={runtimeActivity?.startedAt ?? agent.createdAt}
                  active={!terminal}
                  completedAt={terminal ? agent.updatedAt : null}
                />
                <span aria-hidden>·</span>
                <SubagentFreshness agent={agent} activity={runtimeActivity} state={state} />
                <details className="subagent-task-identity">
                  <summary>代理详情</summary>
                  <code>{agent.agentPath}</code>
                  <code>{agent.id}</code>
                </details>
              </div>
              {isEditingInstruction ? (
                <form
                  className="subagent-instruction-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const nextInstruction = instruction.trim();
                    if (!nextInstruction || isBusy) return;
                    void runAction(agent, () => onSendInstruction(agent, nextInstruction)).then((sent) => {
                      if (!sent) return;
                      setInstruction("");
                      setInstructionAgentId(null);
                    });
                  }}
                >
                  <textarea
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="补充范围、约束或新的检查方向"
                    autoFocus
                  />
                  <div>
                    <button type="button" onClick={() => { setInstructionAgentId(null); setInstruction(""); }}>取消</button>
                    <button type="submit" disabled={!instruction.trim() || isBusy}>{isBusy ? "发送中..." : "发送指令"}</button>
                  </div>
                </form>
              ) : null}
              {actionError?.agentId === agent.id ? <div className="subagent-action-error" role="alert">{actionError.message}</div> : null}
              <div className="subagent-task-actions">
                {!terminal ? (
                  <button type="button" className="danger" onClick={() => onInterrupt(agent)} disabled={isBusy}>
                    <IconStop />
                    停止
                  </button>
                ) : null}
                {!terminal ? (
                  <button type="button" onClick={() => { setInstructionAgentId(agent.id); setInstruction(""); }} disabled={isBusy}>
                    <IconCompose />
                    追加指令
                  </button>
                ) : null}
                <button type="button" onClick={() => onTakeOver(agent)} disabled={isBusy}>
                  <IconGuide />
                  接管
                </button>
              </div>
            </div>
          </details>
        );
      })}
      </div>
    </section>
  );
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
  hideCurrentStatus = false
}: {
  label: string;
  entries: RuntimeActivityEntry[];
  startedAt?: string | null;
  phase?: RuntimeProgress["phase"] | null;
  skillNames?: SkillNameMap;
  preferLabel?: boolean;
  hideCurrentStatus?: boolean;
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
          if (entry.kind === "output") {
            return (
              <details key={entry.id} className="runtime-activity-history-output">
                <summary className="runtime-activity-history-item" title="点击查看终端输出">
                  <span className="runtime-activity-history-icon" aria-hidden><IconTerminal /></span>
                  <span>{getRuntimeHistoryLabel(entry, skillNames)}</span>
                  <time>{formatRuntimeEventOffset(eventAt, activityStartedAt)}</time>
                </summary>
                <pre>{entry.content}</pre>
              </details>
            );
          }
          return (
            <div key={entry.kind === "tool" ? entry.toolCall.id : entry.id} className="runtime-activity-history-item">
              <span className="runtime-activity-history-icon" aria-hidden>
                {toolName ? <ToolActivityIcon toolName={toolName} /> : <IconBolt />}
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
