import {
  getRuntimeItemKindLabel,
  readRuntimeItemPayload,
  type RuntimeEvent,
  type RuntimeItemKind,
  type RuntimeItemStatus
} from "@shared-types";
import type { RuntimeActivityEntry } from "../core/app-types";

/**
 * Renderer-side fold of the `item.started` / `item.delta` / `item.completed`
 * frames into per-item lifecycle entries.
 *
 * The legacy flat events still drive every existing branch, so this stream is
 * the additive consumer: a component asks for the items it cares about and gets
 * one entry per item id instead of having to re-correlate raw frames.
 */
export interface RuntimeItemStreamEntry {
  itemId: string;
  kind: RuntimeItemKind;
  /** Human label for the variant, shared with the writer's coverage table. */
  label: string;
  status: RuntimeItemStatus;
  /** Legacy channel that carries this item's deltas, when one exists. */
  channel: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
  deltaCount: number;
  deltaChars: number;
  /** `plan` snapshots and similar whole-value payloads. */
  text: string;
  command: string | null;
  cwd: string | null;
  exitCode: number | null;
  /** `fileChange.changes[].path`, deduplicated in payload order. */
  changedPaths: string[];
  mcpServer: string | null;
  mcpTool: string | null;
  /** `mcpToolCall/progress` message, when the server streamed one. */
  mcpProgress: string | null;
  /** Canonical tool name, present on every tool-derived variant. */
  toolName: string | null;
  lastEventAt: string;
}

/**
 * The renderer keeps one stream for the whole session, so completed items are
 * evicted oldest-first instead of growing without bound.
 */
const MAX_STREAM_ENTRIES = 600;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Later frames of a lifecycle often carry an empty placeholder for fields the
 * started frame already filled, so an empty string must not overwrite it.
 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readChangedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const change of value) {
    const path = readNonEmptyString((change as { path?: unknown } | null)?.path);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function createEntry(itemId: string, kind: RuntimeItemKind, status: RuntimeItemStatus, eventAt: string): RuntimeItemStreamEntry {
  return {
    itemId,
    kind,
    label: getRuntimeItemKindLabel(kind),
    status,
    channel: null,
    startedAtMs: null,
    completedAtMs: null,
    durationMs: null,
    deltaCount: 0,
    deltaChars: 0,
    text: "",
    command: null,
    cwd: null,
    exitCode: null,
    changedPaths: [],
    mcpServer: null,
    mcpTool: null,
    mcpProgress: null,
    toolName: null,
    lastEventAt: eventAt
  };
}

export class RuntimeItemStream {
  readonly #entries = new Map<string, RuntimeItemStreamEntry>();

  /**
   * Folds item frames into the stream and returns the entries this batch
   * touched, so a caller can re-render only what changed.
   */
  public apply(events: readonly RuntimeEvent[]): RuntimeItemStreamEntry[] {
    const touched: RuntimeItemStreamEntry[] = [];
    for (const event of events) {
      const payload = readRuntimeItemPayload(event.payload);
      if (!payload || !payload.itemId) continue;
      const eventAt = event.createdAt ?? new Date().toISOString();
      const entry = this.#entries.get(payload.itemId)
        ?? createEntry(payload.itemId, payload.itemType, payload.status, eventAt);

      entry.kind = payload.itemType;
      entry.status = payload.status;
      entry.label = getRuntimeItemKindLabel(payload.itemType);
      entry.channel = readString(payload.channel) ?? entry.channel;
      entry.startedAtMs = readNumber(payload.startedAtMs) ?? entry.startedAtMs;
      entry.completedAtMs = readNumber(payload.completedAtMs) ?? entry.completedAtMs;
      entry.durationMs = readNumber(payload.durationMs) ?? entry.durationMs;
      entry.command = readNonEmptyString(payload.command) ?? entry.command;
      entry.cwd = readNonEmptyString(payload.cwd) ?? entry.cwd;
      entry.exitCode = readNumber(payload.exitCode) ?? entry.exitCode;
      entry.text = readString(payload.text) ?? entry.text;
      const changedPaths = readChangedPaths(payload.changes);
      if (changedPaths.length > 0) entry.changedPaths = changedPaths;
      entry.mcpServer = readNonEmptyString(payload.server) ?? entry.mcpServer;
      entry.mcpTool = readNonEmptyString(payload.tool) ?? entry.mcpTool;
      entry.mcpProgress = readNonEmptyString(payload.progress)
        ?? readNonEmptyString(payload.message)
        ?? entry.mcpProgress;
      entry.toolName = readNonEmptyString(payload.toolName) ?? entry.toolName;
      const delta = readNonEmptyString(payload.delta);
      if (event.type === "item.delta" && delta) {
        entry.deltaCount += 1;
        entry.deltaChars += delta.length;
      }
      entry.lastEventAt = eventAt;

      this.#entries.set(entry.itemId, entry);
      touched.push(entry);
    }
    this.#prune();
    return touched;
  }

  #prune(): void {
    if (this.#entries.size <= MAX_STREAM_ENTRIES) return;
    const overflow = this.#entries.size - MAX_STREAM_ENTRIES;
    let dropped = 0;
    for (const [itemId, entry] of this.#entries) {
      if (dropped >= overflow) break;
      if (entry.status === "inProgress") continue;
      this.#entries.delete(itemId);
      dropped += 1;
    }
  }

  public list(): RuntimeItemStreamEntry[] {
    return [...this.#entries.values()];
  }

  public get(itemId: string): RuntimeItemStreamEntry | undefined {
    return this.#entries.get(itemId);
  }

  /** Items without a completed frame yet, newest activity first. */
  public openItems(): RuntimeItemStreamEntry[] {
    return this.list()
      .filter((entry) => entry.status === "inProgress")
      .sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
  }

  public clear(): void {
    this.#entries.clear();
  }
}

/** One-line progress summary for a tool or plan item header. */
export function describeRuntimeItemProgress(entry: RuntimeItemStreamEntry): string {
  const seconds = entry.durationMs === null ? null : `${(entry.durationMs / 1000).toFixed(1)}s`;
  switch (entry.kind) {
    case "commandExecution":
      if (entry.status === "inProgress") return "运行中";
      if (entry.exitCode !== null && entry.exitCode !== 0) return `失败 · 退出码 ${entry.exitCode}`;
      return seconds ? `已完成 · ${seconds}` : "已完成";
    case "fileChange":
      return entry.status === "inProgress" ? "正在修改文件" : "文件已修改";
    case "plan":
      return entry.status === "inProgress" ? "计划进行中" : "计划已完成";
    case "reasoning":
      return entry.status === "inProgress" ? "推理中" : "推理完成";
    case "agentMessage":
      return entry.status === "inProgress" ? "正在生成回复" : "回复已生成";
    default:
      return entry.status === "inProgress" ? "进行中" : "已完成";
  }
}

/**
 * Variant-specific detail the legacy flat events do not carry: exit code and
 * duration for a command, the changed file count for a patch, the MCP target
 * and its streamed progress. Returns null when the item adds nothing beyond its
 * label, so the caller keeps the legacy rendering unchanged.
 */
export function describeRuntimeItemDetail(entry: RuntimeItemStreamEntry): string | null {
  const parts: string[] = [];
  const duration = entry.durationMs === null ? null : `${(entry.durationMs / 1000).toFixed(1)}s`;
  switch (entry.kind) {
    case "commandExecution": {
      // While the command still runs the panel already shows the command line,
      // so only the terminal facts are worth a second line.
      if (entry.status === "inProgress") return null;
      if (entry.exitCode !== null) parts.push(`退出码 ${entry.exitCode}`);
      if (duration) parts.push(duration);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "fileChange":
      return entry.changedPaths.length > 0 ? `${entry.changedPaths.length} 个文件` : null;
    case "mcpToolCall": {
      const target = [entry.mcpServer, entry.mcpTool]
        .filter((part): part is string => Boolean(part))
        .join(" / ");
      if (target) parts.push(target);
      if (entry.mcpProgress) parts.push(entry.mcpProgress);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    default:
      return null;
  }
}

/**
 * Merges item-frame details onto the tool rows the legacy branches already
 * built, keyed by tool call id (which is also the item id). Returns null when
 * no row changed, so the caller can skip a redundant state update.
 */
export function withRuntimeItemDetails(
  entries: readonly RuntimeActivityEntry[],
  items: readonly RuntimeItemStreamEntry[]
): RuntimeActivityEntry[] | null {
  if (items.length === 0) return null;
  const detailByItemId = new Map<string, string | null>();
  for (const item of items) detailByItemId.set(item.itemId, describeRuntimeItemDetail(item));
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind !== "tool" || !detailByItemId.has(entry.toolCall.id)) return entry;
    const itemDetail = detailByItemId.get(entry.toolCall.id) ?? null;
    if ((entry.itemDetail ?? null) === itemDetail) return entry;
    changed = true;
    return { ...entry, itemDetail };
  });
  return changed ? next : null;
}
