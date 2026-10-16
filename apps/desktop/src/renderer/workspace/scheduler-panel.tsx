import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GptReasoningEffort,
  SchedulerRunRecord,
  SchedulerScheduleType,
  SchedulerStatePayload,
  SchedulerTask
} from "@shared-types";
import { ComposerModelPicker, ReasoningEffortPicker, type ComposerModelGroup } from "../composer/model-controls";
import type { ComposerSelectOption } from "../workspace/composer-select";
import { formatRelativeTime } from "../core/app-formatters";
import { DateInput, Field, SelectInput, TextInput, TimeInput } from "../form-controls";
import { IconChatBubbles, IconCheck, IconChevronDown, IconClock, IconClose, IconFolder, IconPlus, IconSearch, IconTrash } from "../icons";
import "./scheduler-panel.css";

type Props = {
  motionPhase: string;
  onClose: () => void;
  /** 运行记录跳回对应会话。 */
  onOpenThread: (threadId: string) => void;
  /** 可选工作空间（复用新任务页的聚合结果）：选了就是项目级任务。 */
  workspaceOptions?: Array<{ cwd: string; name: string; threadCount: number }>;
  /** 可选执行模型（与新任务页 composer 同一份数据）；不选 = 跟随默认。 */
  modelProviders?: ComposerSelectOption[];
  modelGroups?: ComposerModelGroup[];
  defaultProviderId?: string;
  defaultModelId?: string;
  /** 解析（供应商,模型）的推理强度元数据；null/不可配置 = 不显示强度选择。 */
  reasoningEffortResolver?: (providerId: string, modelId: string) => {
    configurable: boolean;
    efforts: readonly GptReasoningEffort[];
    defaultEffort: GptReasoningEffort;
  } | null;
};

type PanelTab = "tasks" | "runs";
type TaskFilter = "all" | "enabled" | "paused";

type DialogState = {
  id: string | null;
  name: string;
  prompt: string;
  scheduleType: SchedulerScheduleType;
  time: string;
  weekday: number;
  monthDay: number;
  runAtDate: string;
  /** "" = 不使用工作空间（普通任务）。 */
  cwd: string;
  /** "" = 跟随应用默认模型。 */
  providerId: string;
  modelId: string;
  /** "" = 跟随应用全局推理强度。 */
  reasoningEffort: GptReasoningEffort | "";
  validity: "forever" | "until";
  validUntil: string;
  error: string;
  busy: boolean;
};

const WEEKDAY_OPTIONS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const SCHEDULE_TYPE_LABELS: Record<SchedulerScheduleType, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  once: "仅一次"
};

function getFolderLeafName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** 模型选择胶囊文案：未选/失效都显示「默认模型」。 */
function resolveModelTriggerLabel(groups: ComposerModelGroup[], providerId: string, modelId: string): string {
  if (!providerId || !modelId) return "默认模型";
  const group = groups.find((item) => item.providerId === providerId);
  const model = group?.models.find((item) => item.id === modelId);
  return group && model ? `${group.providerLabel} · ${model.label}` : "默认模型";
}

function describeSchedule(task: SchedulerTask): string {
  switch (task.scheduleType) {
    case "weekly":
      return `每周${WEEKDAY_OPTIONS[task.weekday ?? 1] ?? "周一"} ${task.time}`;
    case "monthly":
      return `每月 ${task.monthDay ?? 1} 号 ${task.time}`;
    case "once": {
      const parsed = task.runAt ? new Date(task.runAt) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) return "单次运行";
      return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${task.time}`;
    }
    default:
      return `每天 ${task.time}`;
  }
}

function formatCountdown(targetIso: string | null, nowMs: number): string {
  if (!targetIso) return "未排程";
  const diff = new Date(targetIso).getTime() - nowMs;
  if (!Number.isFinite(diff)) return "未排程";
  if (diff <= 0) return "即将执行";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "即将执行";
  if (minutes < 60) return `${minutes}分钟后执行`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时后执行`;
  return `${Math.floor(hours / 24)}天后执行`;
}

function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms) || (ms ?? 0) <= 0) return "—";
  const totalSeconds = Math.floor((ms ?? 0) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

const RUN_STATUS_META: Record<SchedulerRunRecord["status"], { label: string; tone: "ok" | "bad" | "busy" }> = {
  running: { label: "运行中", tone: "busy" },
  success: { label: "成功", tone: "ok" },
  failed: { label: "失败", tone: "bad" },
  catchup_success: { label: "补跑成功", tone: "ok" },
  catchup_failed: { label: "补跑失败", tone: "bad" },
  test_success: { label: "测试运行成功", tone: "ok" },
  test_failed: { label: "测试运行失败", tone: "bad" }
};

function emptyDialog(): DialogState {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  return {
    id: null,
    name: "",
    prompt: "",
    scheduleType: "daily",
    time: `${hh}:00`,
    weekday: 1,
    monthDay: 1,
    runAtDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    cwd: "",
    providerId: "",
    modelId: "",
    reasoningEffort: "",
    validity: "forever",
    validUntil: "",
    error: "",
    busy: false
  };
}

function dialogFromTask(task: SchedulerTask): DialogState {
  const base = emptyDialog();
  const runAt = task.runAt ? new Date(task.runAt) : null;
  return {
    ...base,
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    scheduleType: task.scheduleType,
    time: task.time,
    weekday: task.weekday ?? 1,
    monthDay: task.monthDay ?? 1,
    runAtDate: runAt && !Number.isNaN(runAt.getTime())
      ? `${runAt.getFullYear()}-${String(runAt.getMonth() + 1).padStart(2, "0")}-${String(runAt.getDate()).padStart(2, "0")}`
      : base.runAtDate,
    cwd: task.cwd ?? "",
    providerId: task.providerId ?? "",
    modelId: task.modelId ?? "",
    reasoningEffort: task.reasoningEffort ?? "",
    validity: task.validUntil ? "until" : "forever",
    validUntil: task.validUntil ?? ""
  };
}

export function SchedulerPanel({
  motionPhase,
  onClose,
  onOpenThread,
  workspaceOptions = [],
  modelProviders = [],
  modelGroups = [],
  defaultProviderId = "",
  defaultModelId = "",
  reasoningEffortResolver
}: Props) {
  const [state, setState] = useState<SchedulerStatePayload | null>(null);
  const [tab, setTab] = useState<PanelTab>("tasks");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [topError, setTopError] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [runQuery, setRunQuery] = useState("");
  const [runStatusFilter, setRunStatusFilter] = useState<"all" | "success" | "failed" | "running">("all");
  // 工作空间弹层：与新任务页的选择器同款（搜索 + 项目列表 + 本地文件夹）。
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const workspaceFieldRef = useRef<HTMLDivElement | null>(null);
  // 卡片上的「N小时后执行」需要一个前进的时钟；30s 粒度足够。
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    void window.codexh.getSchedulerState().then(setState).catch(() => undefined);
    return window.codexh.onSchedulerState((next) => setState(next));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 弹层打开时点外面即收起。
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!workspaceFieldRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [workspaceMenuOpen]);

  const visibleWorkspaceOptions = useMemo(() => {
    const query = workspaceQuery.trim().toLowerCase();
    if (!query) return workspaceOptions;
    return workspaceOptions.filter((option) =>
      option.name.toLowerCase().includes(query) || option.cwd.toLowerCase().includes(query)
    );
  }, [workspaceOptions, workspaceQuery]);

  // 当前生效选择（任务显式选的，缺省落到应用默认模型）的推理强度元数据。
  const reasoningMeta = useMemo(() => {
    const providerId = dialog?.providerId || defaultProviderId;
    const modelId = dialog?.modelId || defaultModelId;
    if (!providerId || !modelId || !reasoningEffortResolver) return null;
    return reasoningEffortResolver(providerId, modelId);
  }, [dialog?.providerId, dialog?.modelId, defaultProviderId, defaultModelId, reasoningEffortResolver]);

  const tasks = state?.tasks ?? [];
  const runs = state?.runs ?? [];

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (filter === "enabled") return task.enabled;
      if (filter === "paused") return !task.enabled;
      return true;
    });
  }, [tasks, filter]);

  const filteredRuns = useMemo(() => {
    const query = runQuery.trim().toLowerCase();
    return runs.filter((run) => {
      if (runStatusFilter === "success" && !(run.status.endsWith("_success") || run.status === "success")) return false;
      if (runStatusFilter === "failed" && !(run.status.endsWith("_failed") || run.status === "failed")) return false;
      if (runStatusFilter === "running" && run.status !== "running") return false;
      if (query && !run.taskName.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [runs, runStatusFilter, runQuery]);

  const enabledCount = tasks.filter((task) => task.enabled).length;
  const pausedCount = tasks.length - enabledCount;

  async function guard(action: () => Promise<unknown>) {
    setTopError("");
    try {
      await action();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const marker = raw.lastIndexOf("Error: ");
      setTopError((marker >= 0 ? raw.slice(marker + 7) : raw).trim());
    }
  }

  function toggleTask(task: SchedulerTask) {
    void guard(() => window.codexh.setSchedulerTaskEnabled(task.id, !task.enabled));
  }

  function runTaskNow(task: SchedulerTask) {
    void guard(() => window.codexh.runSchedulerTaskNow(task.id));
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitBatchMode() {
    setBatchMode(false);
    setSelectedIds(new Set());
  }

  function deleteSelected() {
    for (const id of selectedIds) {
      void window.codexh.deleteSchedulerTask(id).catch(() => undefined);
    }
    exitBatchMode();
  }

  function setEnabledSelected(enabled: boolean) {
    for (const id of selectedIds) {
      void window.codexh.setSchedulerTaskEnabled(id, enabled).catch(() => undefined);
    }
    exitBatchMode();
  }

  async function submitDialog() {
    if (!dialog || dialog.busy) return;
    if (!dialog.name.trim()) {
      setDialog({ ...dialog, error: "请填写任务名称。" });
      return;
    }
    if (!dialog.prompt.trim()) {
      setDialog({ ...dialog, error: "请填写任务提示词。" });
      return;
    }
    if (dialog.scheduleType === "once" && (!dialog.runAtDate || Number.isNaN(Date.parse(`${dialog.runAtDate}T${dialog.time}`)))) {
      setDialog({ ...dialog, error: "请选择有效的执行日期。" });
      return;
    }
    setDialog({ ...dialog, error: "", busy: true });
    try {
      await window.codexh.upsertSchedulerTask({
        id: dialog.id ?? undefined,
        name: dialog.name,
        prompt: dialog.prompt,
        scheduleType: dialog.scheduleType,
        time: dialog.time,
        weekday: dialog.weekday,
        monthDay: dialog.monthDay,
        runAt: dialog.scheduleType === "once" ? `${dialog.runAtDate}T${dialog.time}` : undefined,
        cwd: dialog.cwd || null,
        providerId: dialog.providerId || null,
        modelId: dialog.modelId || null,
        reasoningEffort: dialog.reasoningEffort || null,
        validUntil: dialog.validity === "until" && dialog.validUntil ? dialog.validUntil : null,
        enabled: dialog.id ? undefined : true
      });
      setDialog(null);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const marker = raw.lastIndexOf("Error: ");
      setDialog({ ...dialog, error: (marker >= 0 ? raw.slice(marker + 7) : raw).trim(), busy: false });
    }
  }

  return (
    <section className="quick-notes-sheet quick-notes-inline scheduler-inline" aria-label="定时任务" data-motion={motionPhase}>
      <header className="project-sheet-header">
        <div className="quick-notes-header-title scheduler-title">
          <button type="button" className={tab === "tasks" ? "is-active" : ""} onClick={() => setTab("tasks")}>定时任务</button>
          <button type="button" className={tab === "runs" ? "is-active" : ""} onClick={() => setTab("runs")}>运行记录</button>
        </div>
        <div className="scheduler-header-actions">
          {tab === "tasks" ? (
            <>
              <button type="button" className={`scheduler-ghost-button ${batchMode ? "is-active" : ""}`} onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}>
                {batchMode ? "退出批量" : "批量管理"}
              </button>
              <button type="button" className="scheduler-primary-button" onClick={() => setDialog(emptyDialog())}>
                <IconPlus />
                <span>新建</span>
              </button>
            </>
          ) : null}
          <button type="button" className="project-sheet-close" title="关闭" onClick={onClose}><IconClose /></button>
        </div>
      </header>

      {topError ? <div className="scheduler-top-error" role="alert">{topError}</div> : null}

      {tab === "tasks" ? (
        <div className="scheduler-body">
          <div className="scheduler-filter-row">
            {([
              ["all", `全部 (${tasks.length})`],
              ["enabled", `已启用 (${enabledCount})`],
              ["paused", `已暂停 (${pausedCount})`]
            ] as Array<[TaskFilter, string]>).map(([value, label]) => (
              <button key={value} type="button" className={`scheduler-chip ${filter === value ? "is-active" : ""}`} onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>

          {batchMode && selectedIds.size > 0 ? (
            <div className="scheduler-batch-bar">
              <span>已选择 {selectedIds.size} 项</span>
              <button type="button" onClick={() => setEnabledSelected(true)}>启用</button>
              <button type="button" onClick={() => setEnabledSelected(false)}>暂停</button>
              <button type="button" className="is-danger" onClick={deleteSelected}>删除</button>
            </div>
          ) : null}

          <div className="scheduler-task-list">
            {filteredTasks.length === 0 ? (
              <div className="scheduler-empty">还没有定时任务，点右上角「新建」创建一个。</div>
            ) : filteredTasks.map((task) => (
              <article
                key={task.id}
                className={`scheduler-card ${batchMode && selectedIds.has(task.id) ? "is-selected" : ""}`}
                onClick={() => (batchMode ? toggleSelected(task.id) : setDialog(dialogFromTask(task)))}
              >
                <div className="scheduler-card-head">
                  {batchMode ? (
                    <span className={`scheduler-check ${selectedIds.has(task.id) ? "is-on" : ""}`}>{selectedIds.has(task.id) ? <IconCheck /> : null}</span>
                  ) : null}
                  <h3 title={task.name}>{task.name}</h3>
                  <button
                    type="button"
                    className={`fc-switch ${task.enabled ? "is-on" : ""}`}
                    role="switch"
                    aria-checked={task.enabled}
                    aria-label={`${task.enabled ? "暂停" : "启用"} ${task.name}`}
                    onClick={(event) => { event.stopPropagation(); toggleTask(task); }}
                  >
                    <span className="fc-switch-knob" aria-hidden="true" />
                  </button>
                </div>
                <p className="scheduler-card-prompt">{task.prompt}</p>
                <div className="scheduler-card-foot">
                  <span className="scheduler-card-schedule"><IconClock />{describeSchedule(task)}{task.validUntil ? ` · 有效期至 ${task.validUntil}` : " · 长期有效"}</span>
                  {task.cwd ? <span className="scheduler-card-cwd" title={`项目级任务 · ${task.cwd}`}>{getFolderLeafName(task.cwd)}</span> : null}
                  <button
                    type="button"
                    className="scheduler-card-test"
                    title="立即测试运行一次"
                    onClick={(event) => { event.stopPropagation(); runTaskNow(task); }}
                  >测试运行</button>
                  <span className="scheduler-card-next">
                    {task.enabled
                      ? task.nextRunAt
                        ? formatCountdown(task.nextRunAt, nowMs)
                        : "已过期"
                      : "已暂停"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <div className="scheduler-body">
          <div className="scheduler-runs-toolbar">
            <div className="scheduler-search">
              <IconSearch />
              <input value={runQuery} placeholder="搜索任务名称" onChange={(event) => setRunQuery(event.target.value)} />
            </div>
            <select className="scheduler-select" value={runStatusFilter} onChange={(event) => setRunStatusFilter(event.target.value as typeof runStatusFilter)} aria-label="按状态筛选">
              <option value="all">全部状态</option>
              <option value="success">成功</option>
              <option value="failed">失败</option>
              <option value="running">运行中</option>
            </select>
          </div>

          <div className="scheduler-runs-table" role="table" aria-label="运行记录">
            <div className="scheduler-runs-head" role="row">
              <span role="columnheader">任务名称</span>
              <span role="columnheader">状态</span>
              <span role="columnheader">运行时间</span>
              <span role="columnheader">耗时</span>
              <span role="columnheader">任务类型</span>
              <span role="columnheader">操作</span>
            </div>
            {filteredRuns.length === 0 ? (
              <div className="scheduler-empty">暂无运行记录。</div>
            ) : filteredRuns.map((run) => {
              const meta = RUN_STATUS_META[run.status];
              return (
                <div className="scheduler-runs-row" role="row" key={run.id}>
                  <span role="cell" className="scheduler-run-name" title={run.error || run.taskName}>{run.taskName}</span>
                  <span role="cell">
                    <span className={`scheduler-run-status is-${meta.tone}`}>{meta.label}</span>
                  </span>
                  <span role="cell" className="scheduler-run-time" title={run.startedAt}>{formatRelativeTime(run.startedAt)}</span>
                  <span role="cell">{run.status === "running"
                    ? formatDuration(Math.max(0, nowMs - Date.parse(run.startedAt)))
                    : formatDuration(run.durationMs)}</span>
                  <span role="cell">本地</span>
                  <span role="cell" className="scheduler-run-actions">
                    {run.threadId ? (
                      <button type="button" title="打开会话" onClick={() => onOpenThread(run.threadId!)}><IconChatBubbles /></button>
                    ) : null}
                    <button type="button" title="删除记录" onClick={() => void guard(() => window.codexh.deleteSchedulerRun(run.id))}><IconTrash /></button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {dialog ? (
        <div className="scheduler-dialog-backdrop" data-motion={motionPhase} onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}>
          <div className="scheduler-dialog" role="dialog" aria-modal="true" aria-label={dialog.id ? "编辑定时任务" : "新建定时任务"}>
            <header className="scheduler-dialog-head">
              <h2>{dialog.id ? "编辑定时任务" : "新建定时任务"}</h2>
              <button type="button" className="project-sheet-close" title="关闭" onClick={() => setDialog(null)}><IconClose /></button>
            </header>
            <div className="scheduler-dialog-body">
              <TextInput
                label="任务名称"
                value={dialog.name}
                placeholder="输入任务名称"
                onChange={(value) => setDialog({ ...dialog, name: value })}
              />
              <Field label="提示词">
                <div ref={workspaceFieldRef} className="scheduler-prompt-shell">
                  <textarea
                    className="fc-control scheduler-prompt-input"
                    value={dialog.prompt}
                    placeholder="添加提示词"
                    rows={6}
                    onChange={(event) => setDialog({ ...dialog, prompt: event.currentTarget.value })}
                  />
                  <div className="scheduler-prompt-toolbar">
                    <button
                      type="button"
                      className={`composer-status-trigger ${workspaceMenuOpen ? "is-open" : ""}`}
                      aria-haspopup="menu"
                      aria-expanded={workspaceMenuOpen}
                      title={dialog.cwd || "选择工作空间"}
                      onClick={() => setWorkspaceMenuOpen((open) => !open)}
                    >
                      <IconFolder />
                      <span className="composer-status-label">{dialog.cwd ? getFolderLeafName(dialog.cwd) : "选择工作空间"}</span>
                      <IconChevronDown />
                    </button>
                    {dialog.cwd ? (
                      <span className="scheduler-prompt-cwd" title={dialog.cwd}>{dialog.cwd}</span>
                    ) : null}
                    <ComposerModelPicker
                      triggerLabel={resolveModelTriggerLabel(
                        modelGroups,
                        dialog.providerId || defaultProviderId,
                        dialog.modelId || defaultModelId
                      )}
                      providers={modelProviders}
                      modelGroups={modelGroups}
                      selectedProviderId={dialog.providerId || defaultProviderId}
                      selectedModelId={dialog.modelId || defaultModelId}
                      onSelectModel={(providerId, modelId) => setDialog({ ...dialog, providerId, modelId })}
                      disabled={modelProviders.length === 0}
                    />
                    {reasoningMeta?.configurable ? (
                      <ReasoningEffortPicker
                        value={dialog.reasoningEffort || reasoningMeta.defaultEffort}
                        efforts={reasoningMeta.efforts}
                        onChange={(value) => setDialog({ ...dialog, reasoningEffort: value })}
                        disabled={false}
                      />
                    ) : null}
                  </div>
                  {workspaceMenuOpen ? (
                    <div className="composer-status-menu scheduler-workspace-menu" role="menu">
                      <label className="composer-status-search">
                        <IconSearch />
                        <input
                          autoFocus
                          value={workspaceQuery}
                          onChange={(event) => setWorkspaceQuery(event.target.value)}
                          placeholder="搜索工作空间"
                        />
                      </label>
                      <div className="composer-status-list">
                        {visibleWorkspaceOptions.length ? (
                          visibleWorkspaceOptions.map((option) => (
                            <button
                              key={option.cwd}
                              type="button"
                              role="menuitem"
                              className={`composer-status-option ${dialog.cwd === option.cwd ? "is-selected" : ""}`}
                              onClick={() => {
                                setDialog({ ...dialog, cwd: option.cwd });
                                setWorkspaceMenuOpen(false);
                              }}
                            >
                              <span className="composer-status-option-main">
                                <span className="composer-status-option-name">{option.name}</span>
                                {option.threadCount > 1 ? <span className="composer-status-option-note">{option.threadCount} 个任务</span> : null}
                                <span className="composer-status-option-path">{option.cwd}</span>
                              </span>
                              {dialog.cwd === option.cwd ? (
                                <span className="composer-status-option-check"><IconCheck /></span>
                              ) : null}
                            </button>
                          ))
                        ) : (
                          <p className="composer-status-empty">没有匹配的工作空间</p>
                        )}
                      </div>
                      <div className="composer-status-divider" />
                      <button
                        type="button"
                        role="menuitem"
                        className="composer-status-action"
                        onClick={async () => {
                          const picked = await window.codexh.chooseProjectDirectory(dialog.cwd || undefined);
                          if (picked) setDialog({ ...dialog, cwd: picked });
                          setWorkspaceMenuOpen(false);
                        }}
                      >
                        <IconFolder />
                        <span>打开本地文件夹</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="composer-status-action"
                        onClick={() => {
                          setDialog({ ...dialog, cwd: "" });
                          setWorkspaceMenuOpen(false);
                        }}
                      >
                        <IconClose />
                        <span>不使用工作空间</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              </Field>
              <div className="scheduler-dialog-grid">
                <SelectInput
                  label="重复"
                  value={dialog.scheduleType}
                  options={(Object.keys(SCHEDULE_TYPE_LABELS) as SchedulerScheduleType[]).map((value) => ({
                    value,
                    label: SCHEDULE_TYPE_LABELS[value]
                  }))}
                  onChange={(value) => setDialog({ ...dialog, scheduleType: value as SchedulerScheduleType })}
                />
                {dialog.scheduleType === "weekly" ? (
                  <SelectInput
                    label="星期"
                    value={String(dialog.weekday)}
                    options={WEEKDAY_OPTIONS.map((label, index) => ({ value: String(index), label }))}
                    onChange={(value) => setDialog({ ...dialog, weekday: Number(value) })}
                  />
                ) : null}
                {dialog.scheduleType === "monthly" ? (
                  <SelectInput
                    label="日期"
                    value={String(dialog.monthDay)}
                    options={Array.from({ length: 28 }, (_, index) => index + 1).map((day) => ({
                      value: String(day),
                      label: `${day} 号`
                    }))}
                    onChange={(value) => setDialog({ ...dialog, monthDay: Number(value) })}
                  />
                ) : null}
                <TimeInput
                  label="时间"
                  value={dialog.time}
                  onChange={(value) => setDialog({ ...dialog, time: value })}
                />
                {dialog.scheduleType === "once" ? (
                  <DateInput
                    label="执行日期"
                    value={dialog.runAtDate}
                    onChange={(value) => setDialog({ ...dialog, runAtDate: value })}
                  />
                ) : null}
              </div>
              <div className="scheduler-dialog-grid">
                <SelectInput
                  label="有效期"
                  value={dialog.validity}
                  options={[
                    { value: "forever", label: "长期有效" },
                    { value: "until", label: "指定日期" }
                  ]}
                  onChange={(value) => setDialog({ ...dialog, validity: value as DialogState["validity"] })}
                />
                {dialog.validity === "until" ? (
                  <DateInput
                    label="失效日期"
                    value={dialog.validUntil}
                    onChange={(value) => setDialog({ ...dialog, validUntil: value })}
                  />
                ) : null}
              </div>
              {dialog.error ? <div className="scheduler-dialog-error" role="alert">{dialog.error}</div> : null}
            </div>
            <footer className="scheduler-dialog-foot">
              {dialog.id ? (
                <button
                  type="button"
                  className="scheduler-dialog-remove"
                  onClick={() => {
                    const id = dialog.id;
                    setDialog(null);
                    if (id) void guard(() => window.codexh.deleteSchedulerTask(id));
                  }}
                >删除任务</button>
              ) : null}
              <span className="scheduler-dialog-foot-spacer" />
              <button type="button" className="scheduler-ghost-button" onClick={() => setDialog(null)}>取消</button>
              <button type="button" className="scheduler-primary-button" disabled={dialog.busy} onClick={() => void submitDialog()}>{dialog.busy ? "保存中…" : "确定"}</button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
