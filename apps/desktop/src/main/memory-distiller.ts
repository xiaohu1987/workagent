import { createHash } from "node:crypto";
import type {
  AppConfig,
  MessageRecord,
  ModelProfile,
  ProviderDefinition,
  SelfImprovementMemoryKind,
  SelfImprovementMemoryRecord,
  SelfImprovementMemoryScope,
  ThreadRecord,
  ToolCallRecord
} from "@shared-types";
import { modelJsonCandidates, tryParseModelJson } from "@shared-types";
import type { ProviderFactory } from "@provider-adapters";

/** Wall-clock budget for one distillation model call. */
export const MEMORY_DISTILL_TIMEOUT_MS = 90_000;
/** Total attempts per distillation call (1 initial + retries). */
export const MEMORY_DISTILL_ATTEMPTS = 2;
/** Wait for follow-up turns before distilling a finished task. */
export const MEMORY_DISTILL_DEBOUNCE_MS = 20_000;
/** Upper bound on memories written per thread and scope. */
export const MEMORY_DISTILL_MAX_PER_SCOPE = 3;
/** Transcript budget handed to the processing model. */
const MEMORY_DISTILL_MAX_DIGEST_CHARS = 14_000;
const MEMORY_DISTILL_MAX_MESSAGES = 12;
const MEMORY_DISTILL_MAX_MESSAGE_CHARS = 2_400;
const MEMORY_DISTILL_MAX_TOOL_CALLS = 40;

export type DistilledMemoryCandidate = {
  scope: SelfImprovementMemoryScope;
  kind: SelfImprovementMemoryKind;
  /** Stable topic key. Repeated tasks on the same topic refresh one record. */
  topic: string;
  title: string;
  content: string;
};

export type MemoryDistillOutcome = {
  threadId: string;
  created: number;
  updated: number;
  unchanged: number;
  skipped: boolean;
  reason?: string;
};

export type MemoryDigest = {
  threadId: string;
  projectId: string | null;
  projectRoot: string | null;
  threadTitle: string;
  request: string;
  outcome: string;
  toolHighlights: string[];
  transcript: string;
};

/** Persistence port used by the distiller. Keeps the service unit-testable. */
export interface MemoryDistillStore {
  getThread(threadId: string): ThreadRecord | null;
  listMessages(threadId: string): MessageRecord[];
  listToolCalls(threadId: string): ToolCallRecord[];
  claimSelfImprovementJob(
    threadId: string,
    options?: { leaseMinutes?: number; contentHash?: string; force?: boolean }
  ): boolean;
  finishSelfImprovementJob(threadId: string, error?: string): void;
  mergeSelfImprovementMemory(input: {
    scope: SelfImprovementMemoryScope;
    projectId: string | null;
    kind: SelfImprovementMemoryKind;
    title: string;
    content: string;
    sourceThreadId: string | null;
    fingerprint?: string;
    source?: "distilled" | "manual";
  }): { record: SelfImprovementMemoryRecord; action: "created" | "updated" | "unchanged" };
  pruneSelfImprovementMemories(retentionDays: number, maxMemories: number): number;
}

export interface MemoryDistillerServices {
  config: () => AppConfig;
  providerFactory: ProviderFactory;
  store: MemoryDistillStore;
  log?: (kind: string, payload: Record<string, unknown>) => Promise<void>;
  /** Notified after a run that changed the store. */
  onMemoriesChanged?: () => void;
}

/**
 * Distills durable memories out of finished root tasks.
 *
 * Two properties matter here and are enforced structurally:
 * 1. Project and global memories are decided per candidate, then validated
 *    against the thread's project — a repo-specific fact can never be written
 *    to the shared global scope.
 * 2. Each candidate maps to a stable fingerprint, so re-distilling an evolving
 *    task updates the existing record instead of appending near-duplicates.
 */
export class MemoryDistillerService {
  readonly #services: MemoryDistillerServices;
  readonly #scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #inFlight = new Set<string>();

  public constructor(services: MemoryDistillerServices) {
    this.#services = services;
  }

  /** Queue a distillation for one thread, collapsing bursts of turn completions. */
  public schedule(threadId: string, options: { delayMs?: number } = {}): void {
    if (this.#inFlight.has(threadId)) return;
    const existing = this.#scheduled.get(threadId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, options.delayMs ?? MEMORY_DISTILL_DEBOUNCE_MS);
    const timer = setTimeout(() => {
      this.#scheduled.delete(threadId);
      void this.distillThread(threadId).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.#scheduled.set(threadId, timer);
  }

  public cancelScheduled(): void {
    for (const timer of this.#scheduled.values()) clearTimeout(timer);
    this.#scheduled.clear();
  }

  public get pendingCount(): number {
    return this.#scheduled.size;
  }

  /** Distill one thread now. Returns null when the thread is not eligible. */
  public async distillThread(
    threadId: string,
    options: { force?: boolean } = {}
  ): Promise<MemoryDistillOutcome | null> {
    if (this.#inFlight.has(threadId)) return null;
    this.#inFlight.add(threadId);
    try {
      return await this.#distill(threadId, options);
    } finally {
      this.#inFlight.delete(threadId);
    }
  }

  /**
   * Sweep finished root threads: prune expired memories, then distill any thread
   * that changed since its last run. Acts as the safety net for turns that never
   * reported completion (crashes, interrupted runs).
   */
  public async sweep(options: { idleMinutes?: number; threads?: ThreadRecord[]; force?: boolean } = {}): Promise<{
    processed: number;
    pruned: number;
    outcomes: MemoryDistillOutcome[];
  }> {
    const config = this.#services.config();
    const settings = config.selfImprovement;
    if (!settings.generateMemories) return { processed: 0, pruned: 0, outcomes: [] };
    const pruned = this.#services.store.pruneSelfImprovementMemories(settings.retentionDays, settings.maxMemories);
    const forced = options.force === true;
    const idleMinutes = forced ? 0 : Math.max(0, options.idleMinutes ?? settings.idleMinutes);
    const idleBefore = Date.now() - idleMinutes * 60_000;
    const outcomes: MemoryDistillOutcome[] = [];
    for (const thread of options.threads ?? []) {
      if (!isDistillableThread(thread)) continue;
      if (thread.status === "running") continue;
      if (!forced && Date.parse(thread.updatedAt) > idleBefore) continue;
      const outcome = await this.distillThread(thread.id, { force: forced }).catch(() => null);
      if (outcome && !outcome.skipped) outcomes.push(outcome);
    }
    const changed = outcomes.some((outcome) => outcome.created > 0 || outcome.updated > 0);
    if (changed) this.#services.onMemoriesChanged?.();
    return { processed: outcomes.length, pruned, outcomes };
  }

  async #distill(threadId: string, options: { force?: boolean }): Promise<MemoryDistillOutcome | null> {
    const config = this.#services.config();
    if (!config.selfImprovement.generateMemories) return null;
    const thread = this.#services.store.getThread(threadId);
    if (!thread || !isDistillableThread(thread)) return null;
    const digest = buildMemoryDigest({
      thread,
      messages: this.#services.store.listMessages(threadId),
      toolCalls: this.#services.store.listToolCalls(threadId)
    });
    if (!digest) return { threadId, created: 0, updated: 0, unchanged: 0, skipped: true, reason: "no_completed_exchange" };
    const contentHash = hashDistillContent(digest);
    const claimed = this.#services.store.claimSelfImprovementJob(threadId, {
      leaseMinutes: 10,
      contentHash,
      force: options.force === true
    });
    if (!claimed) {
      return { threadId, created: 0, updated: 0, unchanged: 0, skipped: true, reason: "already_distilled" };
    }
    try {
      const selection = resolveMemoryProcessingModel(config, thread);
      if (!selection) throw new Error("没有可用于提炼记忆的推理模型。");
      const response = await this.#runModel(selection, digest);
      const parsed = parseDistilledMemoriesResult(response);
      if (!parsed.parsed) throw new Error("模型没有返回可解析的记忆结果。");
      const candidates = normalizeDistilledCandidates(parsed.records, digest);
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      for (const candidate of candidates) {
        const result = this.#services.store.mergeSelfImprovementMemory({
          scope: candidate.scope,
          projectId: candidate.scope === "project" ? digest.projectId : null,
          kind: candidate.kind,
          title: candidate.title,
          content: candidate.content,
          sourceThreadId: threadId,
          fingerprint: buildCandidateFingerprint(candidate, digest.projectId),
          source: "distilled"
        });
        if (result.action === "created") created += 1;
        else if (result.action === "updated") updated += 1;
        else unchanged += 1;
      }
      this.#services.store.finishSelfImprovementJob(threadId);
      await this.#services.log?.("memory.distilled", {
        threadId,
        projectId: digest.projectId,
        created,
        updated,
        unchanged,
        scopes: candidates.map((candidate) => candidate.scope)
      });
      return { threadId, created, updated, unchanged, skipped: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#services.store.finishSelfImprovementJob(threadId, message);
      await this.#services.log?.("memory.distill_failed", { threadId, error: message });
      return { threadId, created: 0, updated: 0, unchanged: 0, skipped: false, reason: message };
    }
  }

  async #runModel(
    selection: { provider: ProviderDefinition; model: ModelProfile },
    digest: MemoryDigest
  ): Promise<string> {
    const adapter = this.#services.providerFactory.create(selection.provider);
    let lastError: unknown;
    for (let attempt = 1; attempt <= MEMORY_DISTILL_ATTEMPTS; attempt += 1) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), MEMORY_DISTILL_TIMEOUT_MS);
      try {
        const decision = await adapter.runTurn({
          systemPrompt: buildMemoryDistillerSystemPrompt(),
          transcript: [{ role: "user", content: buildMemoryDistillerPrompt(digest) }],
          availableTools: [],
          model: { ...selection.model, supportsStreaming: false },
          provider: selection.provider,
          stream: false,
          abortSignal: timeout.signal
        });
        return decision.assistantMessage ?? "";
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Root, non-running threads that carry a project assignment are distillable. */
export function isDistillableThread(thread: ThreadRecord): boolean {
  return thread.parentThreadId === null && thread.rootThreadId === thread.id;
}

export function hashDistillContent(digest: MemoryDigest): string {
  return createHash("sha256")
    .update([digest.request, digest.outcome, digest.toolHighlights.join("|")].join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Fingerprint of one distilled fact. `topic:` namespace keeps it disjoint from
 * title-derived fingerprints written by manual note creation.
 */
export function buildCandidateFingerprint(
  candidate: Pick<DistilledMemoryCandidate, "topic" | "scope">,
  projectId: string | null
): string {
  const topic = candidate.topic.trim().toLowerCase().replace(/[\s\u3000]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "") || "topic";
  const key = `topic:${candidate.scope}:${candidate.scope === "project" ? projectId ?? "__none__" : "__global__"}:${topic}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Builds the distilled transcript digest. Returns null when the thread has no
 * completed user/assistant exchange worth remembering.
 */
export function buildMemoryDigest(input: {
  thread: ThreadRecord;
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}): MemoryDigest | null {
  const { thread, messages, toolCalls } = input;
  const users = messages.filter((message) => message.role === "user" && message.content.trim().length > 0);
  const assistants = messages.filter((message) => message.role === "assistant" && message.content.trim().length > 0);
  const request = users.at(-1)?.content.trim() ?? "";
  const outcome = assistants.at(-1)?.content.trim() ?? "";
  if (!request || !outcome) return null;
  const window = messages.slice(-MEMORY_DISTILL_MAX_MESSAGES);
  const transcript = window
    .map((message) => `${message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role}：${truncate(message.content.trim(), MEMORY_DISTILL_MAX_MESSAGE_CHARS)}`)
    .join("\n\n")
    .slice(-MEMORY_DISTILL_MAX_DIGEST_CHARS);
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    projectRoot: thread.cwd ?? thread.workspaceRoots?.[0] ?? null,
    threadTitle: thread.title,
    request: truncate(request, MEMORY_DISTILL_MAX_MESSAGE_CHARS),
    outcome: truncate(outcome, MEMORY_DISTILL_MAX_MESSAGE_CHARS),
    toolHighlights: summarizeToolCalls(toolCalls),
    transcript
  };
}

export function summarizeToolCalls(toolCalls: ToolCallRecord[]): string[] {
  const stats = new Map<string, { ok: number; failed: number }>();
  for (const call of toolCalls.slice(-MEMORY_DISTILL_MAX_TOOL_CALLS)) {
    const entry = stats.get(call.toolName) ?? { ok: 0, failed: 0 };
    if (call.status === "completed") entry.ok += 1;
    else if (call.status === "failed" || call.status === "denied" || call.status === "blocked") entry.failed += 1;
    stats.set(call.toolName, entry);
  }
  return [...stats.entries()]
    .map(([name, entry]) => `${name}(成功${entry.ok}/失败${entry.failed})`)
    .slice(0, 20);
}

export function buildMemoryDistillerSystemPrompt(): string {
  return [
    "你负责把一个已完成的桌面 Agent 任务压缩成长期记忆。只保留跨任务仍然有用、且已被本次执行验证过的信息。",
    "记忆分两种作用域，必须严格区分：",
    "- global：与具体项目无关的通用事实。例如用户的长期偏好、沟通与交付习惯、环境约束（操作系统、包管理器、常用命令）、跨项目通用的排错结论。",
    "- project：只对该项目成立的事实。例如这个仓库的目录结构、构建与测试命令、依赖与版本约定、模块职责、已知坑与规避方式。",
    "判定规则：只要这条事实换到另一个项目就不成立或不适用，就必须是 project。拿不准时选择 project，绝不要把项目细节写成 global。",
    "只返回 JSON，不要解释，不要调用工具：{\"memories\":[{\"scope\":\"global|project\",\"kind\":\"experience|preference|error_solution\",\"topic\":\"稳定的英文短标识\",\"title\":\"不超过 40 字的一句话\",\"content\":\"可复用的结论，包含触发条件与做法\"}]}",
    "topic 用来去重：同一个知识点必须复用同一个 topic，后续任务会用它更新原有记忆而不是新增。",
    "没有值得长期保留的信息时返回 {\"memories\":[]}。",
    "硬性禁止：不要写入密钥、令牌、口令、内网地址、真实客户或业务数据；不要写入一次性任务细节、闲聊内容、模型自我描述；不要复述本次任务的原文摘要。"
  ].join("\n");
}

export function buildMemoryDistillerPrompt(digest: MemoryDigest): string {
  return [
    `会话标题：${digest.threadTitle}`,
    `作用域提示：${digest.projectId ? `本次任务属于项目，projectId=${digest.projectId}${digest.projectRoot ? `，项目根目录=${digest.projectRoot}` : ""}` : "本次任务没有绑定项目，所有记忆只能是 global"}`,
    `用户请求：\n${digest.request}`,
    `最终结果：\n${digest.outcome}`,
    digest.toolHighlights.length ? `工具调用统计：${digest.toolHighlights.join("，")}` : "",
    `最近对话：\n${digest.transcript}`,
    "请提炼 0-5 条记忆。优先保留可复用的做法、约定和排错结论，不要复述任务本身。"
  ].filter(Boolean).join("\n\n");
}

/** Parses the processing model response into raw candidate records. */
export function parseDistilledMemories(text: string): unknown[] {
  return parseDistilledMemoriesResult(text).records;
}

/**
 * Like `parseDistilledMemories`, but also reports whether any JSON envelope was
 * recognised at all — an unparseable response must not be recorded as a
 * successful (and therefore never-retried) distillation.
 */
export function parseDistilledMemoriesResult(text: string): { parsed: boolean; records: unknown[] } {
  for (const candidate of modelJsonCandidates(text)) {
    const value = tryParseModelJson(candidate);
    const records = collectMemoryRecords(value);
    if (records) return { parsed: true, records };
  }
  return { parsed: false, records: [] };
}

function collectMemoryRecords(value: unknown, depth = 0): unknown[] | null {
  if (depth > 2) return null;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["memories", "items", "results", "data"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
    const deeper = collectMemoryRecords(nested, depth + 1);
    if (deeper) return deeper;
  }
  const single = collectMemoryRecords(record.memory, depth + 1);
  return single;
}

/**
 * Validates candidates and enforces the scope contract against the thread's
 * project. Repo-specific wording is downgraded to the project scope instead of
 * polluting the shared global scope.
 */
export function normalizeDistilledCandidates(
  raw: unknown[],
  digest: MemoryDigest
): DistilledMemoryCandidate[] {
  const seen = new Set<string>();
  const globalCount = { value: 0 };
  const projectCount = { value: 0 };
  const result: DistilledMemoryCandidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const title = readText(record, "title") || readText(record, "summary");
    const content = readText(record, "content", "detail", "body");
    if (!title || !content) continue;
    if (looksLikeSecret(`${title}\n${content}`)) continue;
    const kind = normalizeMemoryKind(readText(record, "kind"));
    let scope: SelfImprovementMemoryScope = readText(record, "scope").toLowerCase() === "global" ? "global" : "project";
    if (!digest.projectId) scope = "global";
    else if (scope === "global" && mentionsProject(digest, `${title} ${content}`)) scope = "project";
    const topic = readText(record, "topic", "key", "id") || title;
    const key = buildCandidateFingerprint({ topic, scope }, digest.projectId);
    if (seen.has(key)) continue;
    if (scope === "global") {
      if (globalCount.value >= MEMORY_DISTILL_MAX_PER_SCOPE) continue;
      globalCount.value += 1;
    } else {
      if (projectCount.value >= MEMORY_DISTILL_MAX_PER_SCOPE) continue;
      projectCount.value += 1;
    }
    seen.add(key);
    result.push({
      scope,
      kind,
      topic,
      title: truncate(title, 120),
      content: truncate(content, 900)
    });
  }
  return result;
}

export function resolveMemoryProcessingModel(
  config: AppConfig,
  thread: Pick<ThreadRecord, "providerId" | "modelId">
): { provider: ProviderDefinition; model: ModelProfile } | null {
  const candidates: Array<{ providerId?: string; modelId?: string }> = [
    { providerId: undefined, modelId: config.selfImprovement.processingModelId },
    { providerId: thread.providerId, modelId: thread.modelId },
    { providerId: config.defaultProvider, modelId: config.defaultModel }
  ];
  for (const candidate of candidates) {
    if (!candidate.modelId) continue;
    const model = config.models.find((entry) =>
      entry.id === candidate.modelId && (!candidate.providerId || entry.providerId === candidate.providerId)
    );
    if (!model) continue;
    const provider = config.providers.find((entry) => entry.id === model.providerId);
    if (!provider) continue;
    return { provider, model };
  }
  return null;
}

function normalizeMemoryKind(value: string): SelfImprovementMemoryKind {
  const normalized = value.trim().toLowerCase();
  if (normalized === "preference" || normalized === "error_solution") return normalized;
  return "experience";
}

function mentionsProject(digest: MemoryDigest, text: string): boolean {
  const lowered = text.toLowerCase();
  if (digest.projectRoot && lowered.includes(digest.projectRoot.toLowerCase())) return true;
  // No \b here: CJK characters are all non-word characters for JS regex, so a
  // word boundary never matches between 该 and 仓.
  return /this repo|this repository|repository root|该仓库|本仓库|本项目|这个项目|本工程|该项目/.test(lowered);
}

function looksLikeSecret(text: string): boolean {
  return /(?:Bearer\s+[A-Za-z0-9._~-]{12,}|\b(?:sk|rk|pk|ghp)-[A-Za-z0-9_-]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{16,})/i.test(text);
}

function readText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
