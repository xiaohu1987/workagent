/**
 * Item-level ("thread item") protocol layer for the desktop runtime.
 *
 * Upstream project derives every timeline entry from `ThreadItem`, which has
 * 19 native variants that all live through the `item/started` ->
 * per-variant-delta -> `item/completed` lifecycle. This runtime instead emits a
 * flat `RuntimeEvent` stream
 * whose `payload` carries no stable item identity, so a renderer has to guess
 * its branch from the payload shape (and, in practice, renders every tool call
 * through one flat summary row).
 *
 * This module is the discriminative layer that closes the gap **without
 * renaming a single existing event**: writers dual-emit `item.started`,
 * `item.delta` and `item.completed` next to the legacy event, and the renderer
 * prefers the item event while falling back to the legacy branch when the item
 * event is absent. That keeps the migration reversible at every step.
 */

/** The 19 native item variants, in upstream declaration order. */
export const RUNTIME_ITEM_KINDS = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction"
] as const;

export type RuntimeItemKind = (typeof RUNTIME_ITEM_KINDS)[number];

/**
 * The variants that own a dedicated streaming channel upstream. There are 9
 * channels over these 6 variants: `reasoning` alone owns three
 * (`summaryTextDelta`, `summaryPartAdded`, `textDelta`) and `commandExecution`
 * owns two (`outputDelta`, `terminalInteraction`).
 */
export const RUNTIME_ITEM_DELTA_KINDS = [
  "agentMessage",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall"
] as const;

export type RuntimeItemDeltaKind = (typeof RUNTIME_ITEM_DELTA_KINDS)[number];

/** Channel identifiers, spelled the way upstream names them. */
export const RUNTIME_ITEM_DELTA_CHANNELS = [
  "agentMessage/delta",
  "plan/delta",
  "reasoning/summaryTextDelta",
  "reasoning/summaryPartAdded",
  "reasoning/textDelta",
  "commandExecution/outputDelta",
  "commandExecution/terminalInteraction",
  "fileChange/patchUpdated",
  "mcpToolCall/progress"
] as const;

export type RuntimeItemDeltaChannel = (typeof RUNTIME_ITEM_DELTA_CHANNELS)[number];

/**
 * `fileChange/outputDelta` exists upstream but is no longer sent, so a writer
 * must publish `fileChange/patchUpdated` with a whole `changes` snapshot
 * instead of a byte stream.
 */
export const RUNTIME_ITEM_RETIRED_DELTA_CHANNELS = ["fileChange/outputDelta"] as const;

export type RuntimeItemEventType = "item.started" | "item.delta" | "item.completed";

export const RUNTIME_ITEM_EVENT_TYPES: readonly RuntimeItemEventType[] = [
  "item.started",
  "item.delta",
  "item.completed"
];

/**
 * Upstream `inProgress` / `completed` / `failed`, plus the local `blocked`
 * status that the runtime already persists for approvals and sandbox refusals.
 */
export type RuntimeItemStatus = "inProgress" | "completed" | "failed" | "blocked";

/**
 * Variants that upstream publishes as a single frame: `subAgentActivity` and
 * `dynamicToolCall` go straight to `item/completed` because the core event that
 * produces them is already terminal. Writers must not invent a started frame
 * for these, or the timeline flashes a row that never resolves.
 */
export const RUNTIME_ITEM_SINGLE_FRAME_KINDS = ["subAgentActivity", "dynamicToolCall"] as const;

export function isRuntimeItemSingleFrameKind(value: unknown): value is RuntimeItemKind {
  return typeof value === "string" && (RUNTIME_ITEM_SINGLE_FRAME_KINDS as readonly string[]).includes(value);
}

/**
 * How a variant is currently backed locally.
 * - `native`: a writer emits the item from its own real trigger.
 * - `declared`: the kind and its renderer exist, but no trigger writes it yet.
 */
export type RuntimeItemWriterStatus = "native" | "declared";

/**
 * Per-variant writer coverage. Kept next to the kind list so a mapping test can
 * assert that the two stay in sync when a variant is added.
 */
export const RUNTIME_ITEM_KIND_COVERAGE: Record<RuntimeItemKind, RuntimeItemWriterStatus> = {
  userMessage: "native",
  hookPrompt: "declared",
  agentMessage: "native",
  functionCallOutput: "native",
  plan: "native",
  reasoning: "native",
  commandExecution: "native",
  fileChange: "native",
  mcpToolCall: "native",
  dynamicToolCall: "native",
  collabAgentToolCall: "native",
  subAgentActivity: "native",
  webSearch: "native",
  imageView: "native",
  sleep: "declared",
  imageGeneration: "native",
  enteredReviewMode: "declared",
  exitedReviewMode: "declared",
  contextCompaction: "native"
};

export interface RuntimeItemPayload {
  /** Stable item identity. Reuses the draft id or the tool call id. */
  itemId: string;
  itemType: RuntimeItemKind;
  status: RuntimeItemStatus;
  /** Local turn identity; `turnId` mirrors the upstream field name. */
  turnRunId?: string;
  turnId?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
  /** Upstream delta channel this frame came from, e.g. `agentMessage/delta`. */
  channel?: string;
  /** 1-based, monotonic per item. Only present on `item.delta` frames. */
  deltaSequence?: number;
  [key: string]: unknown;
}

export function isRuntimeItemKind(value: unknown): value is RuntimeItemKind {
  return typeof value === "string" && (RUNTIME_ITEM_KINDS as readonly string[]).includes(value);
}

export function isRuntimeItemEventType(value: unknown): value is RuntimeItemEventType {
  return value === "item.started" || value === "item.delta" || value === "item.completed";
}

export function isRuntimeItemDeltaKind(value: unknown): value is RuntimeItemDeltaKind {
  return typeof value === "string" && (RUNTIME_ITEM_DELTA_KINDS as readonly string[]).includes(value);
}

/**
 * Reads a well-formed item payload, or returns null so a caller can fall back
 * to the legacy branch. Unknown `status` values degrade to `inProgress` rather
 * than dropping an otherwise valid frame.
 */
export function readRuntimeItemPayload(payload: unknown): RuntimeItemPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.itemId !== "string" || record.itemId.length === 0) return null;
  if (!isRuntimeItemKind(record.itemType)) return null;
  const status = record.status;
  const normalizedStatus: RuntimeItemStatus =
    status === "completed" || status === "failed" || status === "blocked" ? status : "inProgress";
  return { ...record, itemId: record.itemId, itemType: record.itemType, status: normalizedStatus };
}

export function isRuntimeItemEvent(event: { type?: unknown; payload?: unknown }): boolean {
  return isRuntimeItemEventType(event?.type) && readRuntimeItemPayload(event?.payload) !== null;
}

const COMMAND_EXECUTION_TOOLS = new Set(["shell.exec", "shell.cancel_active", "project.verify"]);

const FILE_CHANGE_TOOLS = new Set([
  "apply_patch",
  "fs.write_file",
  "search_replace",
  "fs.mkdir",
  "fs.rename",
  "fs.delete",
  "fs.copy"
]);

const COLLAB_AGENT_TOOLS = new Set([
  "spawn_agent",
  "wait_agent",
  "send_message",
  "followup_task",
  "interrupt_agent",
  "list_agents"
]);

const IMAGE_VIEW_TOOLS = new Set([
  "desktop.capture_screenshot",
  "browser.capture_screenshot",
  "browser.capture_snapshot"
]);

const IMAGE_GENERATION_TOOLS = new Set(["image.generate", "video.generate"]);

/**
 * Maps a **canonical** tool name to its item variant. Callers must canonicalize
 * first (`canonicalizeToolName` in the tool runtime) so provider aliases such as
 * `execute_command` or `applypatch` resolve here too; keeping the alias table in
 * one place avoids the two copies drifting apart.
 */
export function resolveRuntimeItemKindForTool(toolName: string): RuntimeItemKind {
  if (COMMAND_EXECUTION_TOOLS.has(toolName)) return "commandExecution";
  if (FILE_CHANGE_TOOLS.has(toolName)) return "fileChange";
  if (COLLAB_AGENT_TOOLS.has(toolName)) return "collabAgentToolCall";
  if (IMAGE_GENERATION_TOOLS.has(toolName)) return "imageGeneration";
  if (IMAGE_VIEW_TOOLS.has(toolName)) return "imageView";
  if (toolName === "mcp.call" || toolName.startsWith("mcp.")) return "mcpToolCall";
  if (toolName === "tool_search") return "dynamicToolCall";
  if (toolName.startsWith("web_search.")) return "webSearch";
  return "functionCallOutput";
}

const RUNTIME_ITEM_KIND_LABELS: Record<RuntimeItemKind, string> = {
  userMessage: "用户消息",
  hookPrompt: "插件提示",
  agentMessage: "回复正文",
  functionCallOutput: "工具输出",
  plan: "任务计划",
  reasoning: "思考过程",
  commandExecution: "命令执行",
  fileChange: "文件改动",
  mcpToolCall: "MCP 调用",
  dynamicToolCall: "动态工具调用",
  collabAgentToolCall: "子任务协作",
  subAgentActivity: "子任务进展",
  webSearch: "网络检索",
  imageView: "图片查看",
  sleep: "等待",
  imageGeneration: "图片生成",
  enteredReviewMode: "进入审查模式",
  exitedReviewMode: "退出审查模式",
  contextCompaction: "上下文压缩"
};

export function getRuntimeItemKindLabel(kind: RuntimeItemKind): string {
  return RUNTIME_ITEM_KIND_LABELS[kind];
}

export interface RuntimeItemToolCallInput {
  toolCallId: string;
  /** Canonical tool name. */
  toolName: string;
  turnRunId?: string | null;
  argumentsJson?: string | null;
  resultJson?: string | null;
  /** Persisted tool status, e.g. `running`, `completed`, `failed`, `blocked`. */
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  cwd?: string | null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readChangedPaths(args: Record<string, unknown>, result: Record<string, unknown>): string[] {
  const collected: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !collected.includes(value)) collected.push(value);
  };
  const pushAll = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(push);
  };

  push(readString(args, "path", "filePath", "file_path", "target"));
  pushAll(args.paths);
  pushAll(args.files);
  push(readString(result, "path", "filePath", "file_path"));
  pushAll(result.paths);
  pushAll(result.files);
  pushAll(result.changedFiles);
  return collected;
}

function resolveCompletedItemStatus(status: string | null | undefined): RuntimeItemStatus {
  if (status === "blocked" || status === "denied") return "blocked";
  if (status === "failed" || status === "error") return "failed";
  if (status === "running" || status === "pending" || status === "inProgress") return "inProgress";
  return "completed";
}

function readDurationMs(input: RuntimeItemToolCallInput): number | undefined {
  if (!input.startedAt || !input.completedAt) return undefined;
  const started = Date.parse(input.startedAt);
  const completed = Date.parse(input.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return undefined;
  return Math.max(0, completed - started);
}

/**
 * Derives a full item payload from an already-persisted tool call, filling the
 * variant-specific fields that only exist inside `ToolCallRecord.resultJson`
 * today and are therefore unreachable from the event stream.
 *
 * Fields that stay open: `commandActions` (upstream derives structured actions
 * from a parsed shell command) and `mcpToolCall.progress` frames.
 */
export function buildToolRuntimeItemPayload(
  input: RuntimeItemToolCallInput,
  phase: "started" | "completed"
): RuntimeItemPayload {
  const itemType = resolveRuntimeItemKindForTool(input.toolName);
  const args = parseJsonRecord(input.argumentsJson);
  const result = parseJsonRecord(input.resultJson);
  const completedAtMs = input.completedAt ? Date.parse(input.completedAt) : Number.NaN;
  const startedAtMs = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  const status: RuntimeItemStatus =
    phase === "started" ? resolveCompletedItemStatus(input.status ?? "running") : resolveCompletedItemStatus(input.status);
  const durationMs = readDurationMs(input);

  const base: RuntimeItemPayload = {
    itemId: input.toolCallId,
    itemType,
    status,
    ...(input.turnRunId ? { turnRunId: input.turnRunId, turnId: input.turnRunId } : {}),
    ...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
    ...(phase === "completed" && Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    toolName: input.toolName
  };

  if (itemType === "commandExecution") {
    return {
      ...base,
      command: readString(args, "command", "cmd", "script") ?? "",
      cwd: input.cwd ?? readString(args, "cwd", "workdir") ?? null,
      exitCode: readNumber(result, "exitCode", "exit_code", "code"),
      aggregatedOutput: readString(result, "content", "output", "stdout", "aggregatedOutput")
    };
  }

  if (itemType === "fileChange") {
    const changes = readChangedPaths(args, result).map((path) => ({ path, kind: "update" }));
    return { ...base, changes };
  }

  if (itemType === "mcpToolCall") {
    return {
      ...base,
      server: readString(args, "server", "serverName"),
      tool: readString(args, "tool", "toolName"),
      arguments: args,
      result: phase === "completed" ? result : null,
      error: phase === "completed" && status === "failed" ? readString(result, "error", "message") : null
    };
  }

  if (itemType === "collabAgentToolCall") {
    const receiver = readString(args, "threadId", "agentId", "childThreadId", "id");
    return { ...base, tool: input.toolName, receiverThreadIds: receiver ? [receiver] : [] };
  }

  if (itemType === "webSearch") {
    return { ...base, query: readString(args, "query", "search_query", "searchQuery") };
  }

  if (itemType === "imageView") {
    return { ...base, path: readString(args, "path", "url", "filePath") ?? readString(result, "path") };
  }

  if (itemType === "imageGeneration") {
    return { ...base, prompt: readString(args, "prompt", "description"), outputPath: readString(result, "path") };
  }

  if (itemType === "dynamicToolCall") {
    return {
      ...base,
      tool: readString(args, "tool", "name") ?? input.toolName,
      arguments: args,
      success: phase === "completed" ? status === "completed" : null
    };
  }

  return {
    ...base,
    name: input.toolName,
    output: phase === "completed" ? readString(result, "content", "output", "message") : null
  };
}
