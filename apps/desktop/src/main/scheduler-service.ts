import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { isGptReasoningEffort } from "@shared-types";
import type {
  GptReasoningEffort,
  SchedulerManageInput,
  SchedulerRunKind,
  SchedulerRunRecord,
  SchedulerStatePayload,
  SchedulerTask,
  SchedulerScheduleType
} from "@shared-types";

const TASKS_FILE = "tasks.json";
const RUNS_FILE = "runs.json";
const STORE_VERSION = 1;
/** 每次轮询的间隔：分钟级调度足够，也让补跑的等待时间可控。 */
const TICK_INTERVAL_MS = 20_000;
/** 运行记录总量上限：滚动丢弃最老的记录，避免 runs.json 无限膨胀。 */
const MAX_RUN_RECORDS = 500;

const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function normalizeTime(value: unknown, fallback = "09:00"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!TIME_PATTERN.test(trimmed)) return fallback;
  const [hour, minute] = trimmed.split(":");
  return `${hour.padStart(2, "0")}:${minute}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function endOfDay(isoDate: string): number {
  const parsed = Date.parse(`${isoDate}T23:59:59.999`);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function atTime(base: Date, time: string): Date {
  const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
  const next = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour || 0, minute || 0, 0, 0);
  return next;
}

/** 人读的计划描述（每天 09:00 / 每周三 20:30 / 每月 1 号 09:00 / 2026-10-20 09:00）。 */
export function describeSchedule(task: Pick<SchedulerTask, "scheduleType" | "time" | "weekday" | "monthDay" | "runAt">): string {
  switch (task.scheduleType) {
    case "once": {
      const parsed = task.runAt ? new Date(task.runAt) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) return "单次运行";
      const date = `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
      return `${date} ${task.time}`;
    }
    case "weekly":
      return `每周${WEEKDAY_LABELS[clampInt(task.weekday, 0, 6, 1)]?.replace("周", "") ?? "一"} ${task.time}`;
    case "monthly":
      return `每月 ${clampInt(task.monthDay, 1, 28, 1)} 号 ${task.time}`;
    default:
      return `每天 ${task.time}`;
  }
}

/**
 * 定时任务调度器：配置与运行记录持久化为 userData/scheduler 下的 JSON，
 * tick 循环只做「到点 → 排队跑」，执行动作通过注入的 exec 回调完成
 * （主进程侧 = 新建普通聊天线程并投递提示词）。
 */
export class SchedulerService {
  readonly #dataDir: string;
  readonly #exec: (task: SchedulerTask, kind: SchedulerRunKind) => Promise<{ threadId: string; ok: boolean; error?: string }>;
  readonly #emit: (state: SchedulerStatePayload) => void;
  readonly #log: (kind: string, payload: Record<string, unknown>) => void;
  /** 启动恢复用：查线程当前状态，把重启遗留的「运行中」记录收尾。 */
  readonly #getThreadStatus?: (threadId: string) => string | null;
  #tasks: SchedulerTask[] = [];
  #runs: SchedulerRunRecord[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  /** 串行化执行：到点任务排队跑，避免整点多任务互相踩踏。 */
  #chain: Promise<void> = Promise.resolve();
  readonly #activeTaskIds = new Set<string>();
  #startedAt = 0;

  public constructor(options: {
    dataDir: string;
    exec: (task: SchedulerTask, kind: SchedulerRunKind) => Promise<{ threadId: string; ok: boolean; error?: string }>;
    emit: (state: SchedulerStatePayload) => void;
    log?: (kind: string, payload: Record<string, unknown>) => void;
    getThreadStatus?: (threadId: string) => string | null;
  }) {
    this.#dataDir = options.dataDir;
    this.#exec = options.exec;
    this.#emit = options.emit;
    this.#log = options.log ?? (() => undefined);
    this.#getThreadStatus = options.getThreadStatus;
  }

  public async start(): Promise<void> {
    this.#startedAt = Date.now();
    await this.#load();
    // 应用重启会把执行中的记录变成孤儿（执行 promise 随进程消失）：
    // 按线程实际状态收尾，查不到线程的一律记为中断。
    if (this.#recoverInterruptedRuns()) {
      await this.#persistRuns();
    }
    // 进程停摆期间错过的任务由第一次 tick 统一补跑（scheduledAt 早于启动时刻）：
    // 不能在这里预先推进 nextRunAt，否则第一次 tick 看到的全是「未来时间」，补跑永远不触发。
    this.#timer = setInterval(() => this.#tick(), TICK_INTERVAL_MS);
    this.#timer.unref?.();
    this.#tick();
    this.#emit(this.getState());
  }

  public stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  public getState(): SchedulerStatePayload {
    return {
      tasks: this.#tasks.map((task) => ({ ...task })),
      runs: this.#runs.slice(0, MAX_RUN_RECORDS).map((run) => ({ ...run })),
      now: new Date().toISOString()
    };
  }

  public listTasks(): SchedulerTask[] {
    return this.#tasks.map((task) => ({ ...task }));
  }

  public upsertTask(input: Partial<SchedulerTask> & { name?: string; prompt?: string }): SchedulerTask {
    const now = new Date().toISOString();
    const existing = input.id ? this.#tasks.find((task) => task.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("定时任务不存在或已被删除。");
    const name = (input.name ?? existing?.name ?? "").trim();
    if (!name) throw new Error("请填写任务名称。");
    const prompt = (input.prompt ?? existing?.prompt ?? "").trim();
    if (!prompt) throw new Error("请填写任务提示词。");
    const scheduleType = normalizeScheduleType(input.scheduleType ?? existing?.scheduleType);
    const time = normalizeTime(input.time ?? existing?.time);
    // 工作空间：空 = projectless 普通任务；非空归一为绝对路径，到点执行时
    // 若目录已不存在由执行体降级为普通任务。
    const cwdInput = typeof input.cwd === "string" && input.cwd.trim()
      ? path.resolve(input.cwd.trim())
      : null;
    // 执行模型：空 = 跟随应用默认；存 id，到点建线程时透传（失效由
    // createThread 的 resolveThreadModelSelection 回落到默认）。
    const providerIdInput = typeof input.providerId === "string" && input.providerId.trim()
      ? input.providerId.trim()
      : input.providerId === undefined ? existing?.providerId ?? null : null;
    const modelIdInput = typeof input.modelId === "string" && input.modelId.trim()
      ? input.modelId.trim()
      : input.modelId === undefined ? existing?.modelId ?? null : null;
    // 推理强度：非法值一律回落为 null（跟随全局）。
    const reasoningEffortInput =
      input.reasoningEffort !== undefined && isGptReasoningEffort(input.reasoningEffort)
        ? input.reasoningEffort
        : input.reasoningEffort === undefined ? existing?.reasoningEffort ?? null : null;
    // 固定会话线程：仅由执行体回写（attachThread），LLM/表单传值也兼容。
    const threadIdInput = typeof input.threadId === "string" && input.threadId.trim()
      ? input.threadId.trim()
      : input.threadId === undefined ? existing?.threadId ?? null : null;
    const task: SchedulerTask = {
      id: existing?.id ?? randomUUID(),
      name: name.slice(0, 80),
      prompt: prompt.slice(0, 20_000),
      enabled: input.enabled ?? existing?.enabled ?? true,
      scheduleType,
      time,
      weekday: scheduleType === "weekly" ? clampInt(input.weekday ?? existing?.weekday, 0, 6, 1) : undefined,
      monthDay: scheduleType === "monthly" ? clampInt(input.monthDay ?? existing?.monthDay, 1, 28, 1) : undefined,
      runAt: scheduleType === "once" ? normalizeRunAt(input.runAt ?? existing?.runAt, time) : undefined,
      cwd: cwdInput,
      providerId: providerIdInput,
      modelId: modelIdInput,
      reasoningEffort: reasoningEffortInput,
      threadId: threadIdInput,
      validUntil: normalizeValidUntil(input.validUntil ?? existing?.validUntil),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextRunAt: existing?.nextRunAt ?? null,
      lastRunAt: existing?.lastRunAt ?? null
    };
    // once 任务被编辑成未来时间后重新武装；其余类型从现在起算下一轮。
    task.nextRunAt = task.enabled ? this.#computeNextRunAt(task, new Date())?.toISOString() ?? null : null;
    const index = this.#tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) this.#tasks[index] = task;
    else this.#tasks.push(task);
    void this.#persistTasks();
    this.#emit(this.getState());
    return { ...task };
  }

  public deleteTask(id: string): void {
    const before = this.#tasks.length;
    this.#tasks = this.#tasks.filter((task) => task.id !== id);
    if (this.#tasks.length === before) throw new Error("定时任务不存在或已被删除。");
    void this.#persistTasks();
    this.#emit(this.getState());
  }

  public setEnabled(id: string, enabled: boolean): SchedulerTask {
    const task = this.#tasks.find((item) => item.id === id);
    if (!task) throw new Error("定时任务不存在或已被删除。");
    task.enabled = Boolean(enabled);
    task.updatedAt = new Date().toISOString();
    task.nextRunAt = task.enabled ? this.#computeNextRunAt(task, new Date())?.toISOString() ?? null : null;
    void this.#persistTasks();
    this.#emit(this.getState());
    return { ...task };
  }

  /** 手动跑一次（测试运行）：入队后立即返回，结果走运行记录推送。 */
  public runNow(id: string): void {
    const task = this.#tasks.find((item) => item.id === id);
    if (!task) throw new Error("定时任务不存在或已被删除。");
    if (this.#activeTaskIds.has(id)) throw new Error("该任务正在运行中，请等待完成后再试。");
    this.#enqueue(task.id, "test", new Date().toISOString());
  }

  public deleteRun(id: string): void {
    this.#runs = this.#runs.filter((run) => run.id !== id);
    void this.#persistRuns();
    this.#emit(this.getState());
  }

  /** 执行体回写：把任务固定到某个会话线程（每次执行续聊同一个）。 */
  public setTaskThread(taskId: string, threadId: string | null): SchedulerTask {
    const task = this.#tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("定时任务不存在或已被删除。");
    task.threadId = threadId;
    void this.#persistTasks();
    this.#emit(this.getState());
    return { ...task };
  }

  /** LLM 小工具入口：把 scheduler_manage 的入参路由到对应操作。 */
  public async handleManage(input: SchedulerManageInput): Promise<{ ok: boolean; content: string }> {
    switch (input.action) {
      case "list": {
        const state = this.getState();
        const lines = state.tasks.map((task) =>
          `- [${task.enabled ? "已启用" : "已暂停"}] ${task.id} 「${task.name}」 ${describeSchedule(task)}` +
          `${task.nextRunAt ? `，下次 ${task.nextRunAt}` : ""}，有效期${task.validUntil ? `至 ${task.validUntil}` : "长期"}`
        );
        return { ok: true, content: lines.length ? `共有 ${lines.length} 个定时任务：\n${lines.join("\n")}` : "当前没有定时任务。" };
      }
      case "create": {
        const task = this.upsertTask(input);
        return { ok: true, content: `已创建定时任务「${task.name}」（${describeSchedule(task)}），下次执行 ${task.nextRunAt ?? "已过期"}` };
      }
      case "update": {
        if (!input.id) throw new Error("更新定时任务需要提供 id，可先用 list 查看。");
        const task = this.upsertTask(input);
        return { ok: true, content: `已更新定时任务「${task.name}」（${describeSchedule(task)}），下次执行 ${task.nextRunAt ?? "已过期"}` };
      }
      case "delete": {
        if (!input.id) throw new Error("删除定时任务需要提供 id，可先用 list 查看。");
        const task = this.#tasks.find((item) => item.id === input.id);
        this.deleteTask(input.id);
        return { ok: true, content: `已删除定时任务「${task?.name ?? input.id}」。` };
      }
      case "set_enabled": {
        if (!input.id) throw new Error("启停定时任务需要提供 id，可先用 list 查看。");
        const task = this.setEnabled(input.id, input.enabled !== false);
        return { ok: true, content: `定时任务「${task.name}」已${task.enabled ? "启用" : "暂停"}${task.enabled && task.nextRunAt ? `，下次执行 ${task.nextRunAt}` : ""}。` };
      }
      case "run_now": {
        if (!input.id) throw new Error("立即运行需要提供 id，可先用 list 查看。");
        const task = this.#tasks.find((item) => item.id === input.id);
        this.runNow(input.id);
        return { ok: true, content: `已触发定时任务「${task?.name ?? input.id}」立即运行，结果可在运行记录里查看。` };
      }
      default:
        throw new Error(`不支持的 scheduler_manage 操作：${String((input as { action?: unknown }).action)}`);
    }
  }

  #tick(): void {
    const now = new Date();
    for (const task of this.#tasks) {
      if (!task.enabled || !task.nextRunAt) continue;
      if (this.#activeTaskIds.has(task.id)) continue;
      const dueAt = Date.parse(task.nextRunAt);
      if (!Number.isFinite(dueAt) || dueAt > now.getTime()) continue;
      // 补跑判定：计划时间早于本进程启动时刻（含临界 1 分钟），说明是停摆期间漏掉的。
      const kind: SchedulerRunKind = dueAt < this.#startedAt - 60_000 ? "catchup" : "scheduled";
      this.#enqueue(task.id, kind, task.nextRunAt);
    }
    // 触发判定之后再推进：advanceAll 会把过期 nextRunAt 重写到未来，
    // 若排在循环前面，到点判断永远看不到过期任务（触发分支死代码）。
    this.#advanceAll(now);
    if (this.#dirtyTasks) {
      this.#dirtyTasks = false;
      void this.#persistTasks();
      this.#emit(this.getState());
    }
  }

  /** 把所有到点/过期任务的 nextRunAt 推进到未来，避免运行期间被 tick 反复触发。 */
  #advanceAll(now: Date): void {
    for (const task of this.#tasks) {
      if (!task.enabled) continue;
      if (!task.nextRunAt || Date.parse(task.nextRunAt) <= now.getTime()) {
        task.nextRunAt = this.#computeNextRunAt(task, now)?.toISOString() ?? null;
        this.#dirtyTasks = true;
      }
    }
  }

  #dirtyTasks = false;

  #enqueue(taskId: string, kind: SchedulerRunKind, scheduledAt: string): void {
    this.#activeTaskIds.add(taskId);
    this.#chain = this.#chain
      .then(() => this.#runTask(taskId, kind, scheduledAt))
      .catch((error) => {
        this.#log("scheduler.run_failed", { taskId, kind, error: String(error) });
      })
      .finally(() => {
        this.#activeTaskIds.delete(taskId);
      });
  }

  async #runTask(taskId: string, kind: SchedulerRunKind, scheduledAt: string): Promise<void> {
    const task = this.#tasks.find((item) => item.id === taskId);
    if (!task) return;
    const startedAt = new Date();
    const run: SchedulerRunRecord = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      status: "running",
      kind,
      scheduledAt,
      startedAt: startedAt.toISOString()
    };
    this.#runs.unshift(run);
    this.#trimRuns();
    task.lastRunAt = run.startedAt;
    void this.#persistRuns();
    this.#emit(this.getState());
    try {
      const result = await this.#exec({ ...task }, kind);
      run.threadId = result.threadId;
      run.error = result.error;
      run.status = resolveFinishedStatus(kind, result.ok);
    } catch (error) {
      run.status = resolveFinishedStatus(kind, false);
      run.error = error instanceof Error ? error.message : String(error);
    }
    const finishedAt = new Date();
    run.finishedAt = finishedAt.toISOString();
    run.durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    // 一次性任务跑完即自动停用，避免显示成「永远到点却不再执行」。
    if (task.scheduleType === "once") {
      task.enabled = false;
      task.nextRunAt = null;
    } else if (task.enabled) {
      task.nextRunAt = this.#computeNextRunAt(task, new Date())?.toISOString() ?? null;
    }
    await this.#persistRuns();
    await this.#persistTasks();
    this.#emit(this.getState());
    this.#log("scheduler.run_finished", { taskId: task.id, runId: run.id, status: run.status, durationMs: run.durationMs });
  }

  #trimRuns(): void {
    if (this.#runs.length > MAX_RUN_RECORDS) {
      this.#runs.length = MAX_RUN_RECORDS;
    }
  }

  /** 重启恢复：孤儿「运行中」记录按线程状态落定（completed = 成功，其余 = 中断）。 */
  #recoverInterruptedRuns(): boolean {
    let dirty = false;
    for (const run of this.#runs) {
      if (run.status !== "running") continue;
      const threadStatus = run.threadId && this.#getThreadStatus
        ? this.#getThreadStatus(run.threadId)
        : null;
      const ok = threadStatus === "completed";
      run.status = resolveFinishedStatus(run.kind, ok);
      run.error = ok ? undefined : "应用重启，执行被中断。";
      run.finishedAt = new Date().toISOString();
      const started = Date.parse(run.startedAt);
      run.durationMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : undefined;
      dirty = true;
      this.#log("scheduler.run_recovered", { runId: run.id, threadStatus: threadStatus ?? "unknown", status: run.status });
    }
    return dirty;
  }

  #computeNextRunAt(task: SchedulerTask, from: Date): Date | null {
    // 有效期到点后不再排程（已排的不撤销，只不再产生新的）。
    if (task.validUntil) {
      const limit = endOfDay(task.validUntil);
      if (Number.isFinite(limit) && from.getTime() > limit) return null;
    }
    switch (task.scheduleType) {
      case "once": {
        if (!task.runAt) return null;
        const runAt = Date.parse(task.runAt);
        if (Number.isNaN(runAt) || runAt <= from.getTime()) return null;
        return new Date(runAt);
      }
      case "weekly": {
        const target = atTime(from, task.time);
        const weekday = clampInt(task.weekday, 0, 6, 1);
        let dayShift = (weekday - target.getDay() + 7) % 7;
        if (dayShift === 0 && target.getTime() <= from.getTime()) dayShift = 7;
        target.setDate(target.getDate() + dayShift);
        return target;
      }
      case "monthly": {
        const monthDay = clampInt(task.monthDay, 1, 28, 1);
        const candidate = atTime(from, task.time);
        candidate.setDate(monthDay);
        if (candidate.getTime() <= from.getTime()) {
          candidate.setMonth(candidate.getMonth() + 1);
          candidate.setDate(monthDay);
        }
        return candidate;
      }
      default: {
        const candidate = atTime(from, task.time);
        if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
        return candidate;
      }
    }
  }

  async #load(): Promise<void> {
    this.#tasks = await this.#readStore<SchedulerTask>(TASKS_FILE, "tasks");
    this.#runs = await this.#readStore<SchedulerRunRecord>(RUNS_FILE, "runs");
  }

  async #readStore<T>(file: string, key: "tasks" | "runs"): Promise<T[]> {
    try {
      const raw = await fs.readFile(path.join(this.#dataDir, file), "utf8");
      const parsed = JSON.parse(raw) as { version?: number; [key: string]: unknown };
      const items = Array.isArray(parsed[key]) ? parsed[key] as T[] : [];
      // 结构宽松校验：手工编辑损坏的条目直接丢弃，不让整个存储挂掉。
      if (key === "tasks") {
        return (items as unknown as SchedulerTask[]).filter((task) =>
          task && typeof task.id === "string" && typeof task.name === "string" && typeof task.prompt === "string"
        ) as unknown as T[];
      }
      return (items as unknown as SchedulerRunRecord[]).filter((run) =>
        run && typeof run.id === "string" && typeof run.taskId === "string"
      ) as unknown as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      this.#log("scheduler.load_error", { file, error: String(error) });
      return [];
    }
  }

  async #persistTasks(): Promise<void> {
    await this.#writeStore(TASKS_FILE, "tasks", this.#tasks);
  }

  async #persistRuns(): Promise<void> {
    await this.#writeStore(RUNS_FILE, "runs", this.#runs.slice(0, MAX_RUN_RECORDS));
  }

  async #writeStore(file: string, key: "tasks" | "runs", items: unknown[]): Promise<void> {
    try {
      await fs.mkdir(this.#dataDir, { recursive: true });
      const target = path.join(this.#dataDir, file);
      const temp = `${target}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ version: STORE_VERSION, [key]: items }, null, 2), "utf8");
      await fs.rename(temp, target);
    } catch (error) {
      this.#log("scheduler.persist_error", { file, error: String(error) });
    }
  }
}

function resolveFinishedStatus(kind: SchedulerRunKind, ok: boolean): SchedulerRunRecord["status"] {
  if (kind === "catchup") return ok ? "catchup_success" : "catchup_failed";
  if (kind === "test") return ok ? "test_success" : "test_failed";
  return ok ? "success" : "failed";
}

function normalizeScheduleType(value: unknown): SchedulerScheduleType {
  return value === "once" || value === "weekly" || value === "monthly" ? value : "daily";
}

function normalizeRunAt(value: unknown, time: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const withTime = /[T ]\d{2}:\d{2}/.test(value) ? value : `${value}T${time}`;
  const parsed = Date.parse(withTime);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function normalizeValidUntil(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim().slice(0, 10);
  return Number.isNaN(Date.parse(`${trimmed}T00:00:00`)) ? null : trimmed;
}
