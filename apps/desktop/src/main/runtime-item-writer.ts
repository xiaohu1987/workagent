import type { RuntimeEvent } from "@shared-types";
import {
  buildToolRuntimeItemPayload,
  isRuntimeItemEventType,
  resolveRuntimeItemKindForTool,
  type RuntimeItemKind,
  type RuntimeItemPayload,
  type RuntimeItemStatus
} from "@shared-types";
import { canonicalizeToolName } from "@tool-runtime";

/**
 * Dual-writes the item-level protocol frames (`item.started`, `item.delta`,
 * `item.completed`) next to the legacy flat runtime events.
 *
 * This is the staged half of the migration: the runtime keeps emitting exactly
 * what it emits today, the renderer keeps its legacy branches, and the derived
 * item frames ride along so both the renderer and the mapping tests can consume
 * a discriminated item stream. Nothing here renames or suppresses a legacy
 * event, so the change is reversible by removing a single call site.
 *
 * Volume policy: `item.delta` is only written for variants that have **no**
 * legacy streaming channel of their own (`plan`, plus future `mcpToolCall`
 * progress). Variants that already stream (`agentMessage`, `reasoning`,
 * `commandExecution`, `fileChange`) declare their legacy channel in
 * `payload.channel` instead of duplicating every frame over IPC.
 */

export interface RuntimeItemWriteContext {
  /** Project root of the subject thread, used for `commandExecution.cwd`. */
  cwd?: string | null;
}

interface OpenItem {
  kind: RuntimeItemKind;
  startedAtMs: number;
}

const DRAFT_ITEM_SEPARATOR = "::";

function nowMs(iso: string | undefined): number {
  if (!iso) return Date.now();
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function draftItemId(draftId: string, kind: "agentMessage" | "reasoning"): string {
  return `${draftId}${DRAFT_ITEM_SEPARATOR}${kind}`;
}

export class RuntimeItemWriter {
  /** Open draft-derived items, keyed by the synthesized item id. */
  readonly #openItems = new Map<string, OpenItem>();
  /** Last started command execution per thread, so terminal bytes have a home. */
  readonly #activeCommandItem = new Map<string, string>();
  /** Plan items that already received a started frame. */
  readonly #planItems = new Set<string>();
  /**
   * Last emitted plan snapshot per item, so unchanged GPA writes stay silent.
   */
  readonly #planSnapshots = new Map<string, string>();

  /**
   * Projects one legacy runtime event into zero or more item frames. Returns an
   * empty array when the event has no item counterpart, which keeps the call
   * site a simple loop with no branching.
   */
  public project(event: RuntimeEvent, context: RuntimeItemWriteContext = {}): RuntimeEvent[] {
    // Item frames are already the output format: never project them again.
    if (isRuntimeItemEventType(event.type)) return [];
    const createdAt = event.createdAt ?? new Date().toISOString();
    const threadId = event.threadId;

    switch (event.type) {
      case "tool.started":
        return this.#projectToolEvent(event, "started", context, createdAt);
      case "tool.completed":
        return this.#projectToolEvent(event, "completed", context, createdAt);
      case "terminal.output":
        return this.#projectTerminalOutput(event, createdAt);
      case "assistant.draft.updated":
        return this.#projectDraft(event, createdAt);
      case "assistant.completed":
        return this.#closeDraftItems(event, createdAt);
      case "gpa.updated":
        return threadId ? this.#projectPlan(event, createdAt) : [];
      case "agent.context_compacted":
        return [this.#frame(event, "completed", {
          itemId: `compaction${DRAFT_ITEM_SEPARATOR}${threadId ?? "thread"}`,
          itemType: "contextCompaction",
          status: "completed",
          startedAtMs: nowMs(createdAt),
          completedAtMs: nowMs(createdAt),
          threadId
        }, createdAt)];
      case "agent.watchdog":
        return this.#projectSubAgentActivity(event, createdAt);
      case "message.created":
        return this.#projectUserMessage(event, createdAt);
      default:
        return [];
    }
  }

  /** Drops per-thread bookkeeping when a thread is torn down. */
  public forgetThread(threadId: string): void {
    this.#activeCommandItem.delete(threadId);
  }

  #frame(
    source: RuntimeEvent,
    phase: "started" | "delta" | "completed",
    payload: RuntimeItemPayload,
    createdAt: string
  ): RuntimeEvent {
    return {
      type: phase === "started" ? "item.started" : phase === "delta" ? "item.delta" : "item.completed",
      ...(source.threadId ? { threadId: source.threadId } : {}),
      ...(source.notificationThreadId ? { notificationThreadId: source.notificationThreadId } : {}),
      ...(source.notificationChildThreadId ? { notificationChildThreadId: source.notificationChildThreadId } : {}),
      payload: { ...payload },
      createdAt
    };
  }

  #projectToolEvent(
    event: RuntimeEvent,
    phase: "started" | "completed",
    context: RuntimeItemWriteContext,
    createdAt: string
  ): RuntimeEvent[] {
    const payload = event.payload ?? {};
    const rawToolName = typeof payload.toolName === "string" ? payload.toolName : null;
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
    if (!rawToolName || !toolCallId) return [];

    const toolName = canonicalizeToolName(rawToolName);
    const itemPayload = buildToolRuntimeItemPayload(
      {
        toolCallId,
        toolName,
        turnRunId: typeof payload.turnRunId === "string" ? payload.turnRunId : null,
        argumentsJson: typeof payload.argumentsJson === "string" ? payload.argumentsJson : null,
        resultJson: typeof payload.resultJson === "string" ? payload.resultJson : null,
        status: typeof payload.status === "string" ? payload.status : null,
        startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
        completedAt:
          typeof payload.completedAt === "string" ? payload.completedAt : phase === "completed" ? createdAt : null,
        cwd: context.cwd ?? null
      },
      phase
    );

    if (phase === "started") {
      const startedAtMs = itemPayload.startedAtMs ?? nowMs(createdAt);
      this.#openItems.set(toolCallId, { kind: itemPayload.itemType, startedAtMs });
      if (itemPayload.itemType === "commandExecution" && event.threadId) {
        this.#activeCommandItem.set(event.threadId, toolCallId);
      }
      return [this.#frame(event, "started", itemPayload, createdAt)];
    }

    const open = this.#openItems.get(toolCallId);
    if (open) {
      this.#openItems.delete(toolCallId);
      // The tool record is authoritative for the start time; the derived frame
      // must not report a duration measured from the first observed frame.
      itemPayload.startedAtMs = open.startedAtMs;
      // `buildToolRuntimeItemPayload` already derives the duration from the tool
      // record's own timestamps; only fall back to the frame clock when the
      // record carried no completion time.
      if (!Number.isFinite(itemPayload.durationMs)) {
        itemPayload.durationMs = Math.max(0, nowMs(createdAt) - open.startedAtMs);
      }
    }
    if (itemPayload.itemType === "commandExecution" && event.threadId) {
      if (this.#activeCommandItem.get(event.threadId) === toolCallId) {
        this.#activeCommandItem.delete(event.threadId);
      }
    }
    return [this.#frame(event, "completed", itemPayload, createdAt)];
  }

  #projectTerminalOutput(event: RuntimeEvent, createdAt: string): RuntimeEvent[] {
    const threadId = event.threadId;
    if (!threadId) return [];
    const itemId = this.#activeCommandItem.get(threadId);
    if (!itemId) return [];
    const chunk = typeof event.payload?.chunk === "string"
      ? event.payload.chunk
      : typeof event.payload?.content === "string"
        ? event.payload.content
        : null;
    if (chunk === null) return [];
    return [
      this.#frame(event, "delta", {
        itemId,
        itemType: "commandExecution",
        status: "inProgress",
        channel: "commandExecution/outputDelta",
        delta: chunk
      }, createdAt)
    ];
  }

  #projectDraft(event: RuntimeEvent, createdAt: string): RuntimeEvent[] {
    const payload = event.payload ?? {};
    const draftId = typeof payload.draftId === "string" ? payload.draftId : null;
    if (!draftId) return [];
    const frames: RuntimeEvent[] = [];
    const hasVisibleText = typeof payload.content === "string" || typeof payload.delta === "string";
    const hasReasoning = typeof payload.reasoning === "string" || typeof payload.reasoningDelta === "string";

    const ensure = (kind: "agentMessage" | "reasoning", channel: string) => {
      const itemId = draftItemId(draftId, kind);
      if (this.#openItems.has(itemId)) return;
      this.#openItems.set(itemId, { kind, startedAtMs: nowMs(createdAt) });
      frames.push(this.#frame(event, "started", {
        itemId,
        itemType: kind,
        status: "inProgress",
        channel,
        ...(typeof payload.turnRunId === "string" ? { turnRunId: payload.turnRunId, turnId: payload.turnRunId } : {}),
        startedAtMs: nowMs(createdAt)
      }, createdAt));
    };

    // Only the first frame of a draft opens the item; the legacy
    // `assistant.draft.updated` event stays the sole carrier of the deltas.
    if (hasVisibleText) ensure("agentMessage", "agentMessage/delta");
    if (hasReasoning) ensure("reasoning", "reasoning/textDelta");
    return frames;
  }

  #closeDraftItems(event: RuntimeEvent, createdAt: string): RuntimeEvent[] {
    const draftId = typeof event.payload?.draftId === "string" ? event.payload.draftId : null;
    if (!draftId) return [];
    const status: RuntimeItemStatus = event.payload?.discarded === true ? "completed" : "completed";
    const frames: RuntimeEvent[] = [];
    for (const kind of ["agentMessage", "reasoning"] as const) {
      const itemId = draftItemId(draftId, kind);
      const open = this.#openItems.get(itemId);
      if (!open) continue;
      this.#openItems.delete(itemId);
      frames.push(this.#frame(event, "completed", {
        itemId,
        itemType: kind,
        status,
        startedAtMs: open.startedAtMs,
        completedAtMs: nowMs(createdAt),
        durationMs: Math.max(0, nowMs(createdAt) - open.startedAtMs)
      }, createdAt));
    }
    return frames;
  }

  #projectPlan(event: RuntimeEvent, createdAt: string): RuntimeEvent[] {
    const gpa = event.payload?.gpa;
    if (!gpa || typeof gpa !== "object") return [];
    const record = gpa as Record<string, unknown>;
    const tasks = Array.isArray(record.planTasks)
      ? record.planTasks.filter((task): task is { id: string; title: string; done: boolean } =>
        Boolean(task) && typeof (task as Record<string, unknown>).id === "string")
      : [];
    const itemId = `plan${DRAFT_ITEM_SEPARATOR}${event.threadId ?? "thread"}`;
    const text = tasks.map((task) => `${task.done ? "[x]" : "[ ]"} ${task.title}`).join("\n");
    const allDone = tasks.length > 0 && tasks.every((task) => task.done);
    const snapshot = tasks
      .map((task) => `${task.id}\u0000${task.title}\u0000${task.done ? 1 : 0}`)
      .join("\u0001");

    // `gpa.updated` fires on every GPA write, so an unchanged snapshot must not
    // be re-emitted as another delta frame.
    if (this.#planSnapshots.get(itemId) === snapshot) return [];

    if (tasks.length === 0) {
      this.#planSnapshots.delete(itemId);
      if (!this.#planItems.has(itemId)) return [];
      this.#planItems.delete(itemId);
      return [this.#frame(event, "completed", {
        itemId,
        itemType: "plan",
        status: "completed",
        text,
        tasks: [],
        completedAtMs: nowMs(createdAt),
        channel: "plan/delta"
      }, createdAt)];
    }

    const frames: RuntimeEvent[] = [];
    if (!this.#planItems.has(itemId)) {
      this.#planItems.add(itemId);
      this.#planSnapshots.set(itemId, snapshot);
      frames.push(this.#frame(event, "started", {
        itemId,
        itemType: "plan",
        status: "inProgress",
        text,
        tasks,
        startedAtMs: nowMs(createdAt),
        channel: "plan/delta"
      }, createdAt));
      return frames;
    }

    // `plan` has no legacy streaming channel, so this is the only variant whose
    // delta frame is written as a real snapshot update.
    if (allDone) {
      this.#planItems.delete(itemId);
      // The finished snapshot is remembered so the next identical GPA write does
      // not re-open a plan item that is already complete.
      this.#planSnapshots.set(itemId, snapshot);
      frames.push(this.#frame(event, "completed", {
        itemId,
        itemType: "plan",
        status: "completed",
        text,
        tasks,
        completedAtMs: nowMs(createdAt),
        channel: "plan/delta"
      }, createdAt));
      return frames;
    }

    this.#planSnapshots.set(itemId, snapshot);
    frames.push(this.#frame(event, "delta", {
      itemId,
      itemType: "plan",
      status: "inProgress",
      text,
      tasks,
      channel: "plan/delta"
    }, createdAt));
    return frames;
  }

  #projectSubAgentActivity(event: RuntimeEvent, createdAt: string): RuntimeEvent[] {
    const payload = event.payload ?? {};
    const childThreadId = event.notificationChildThreadId
      ?? (typeof payload.childThreadId === "string" ? payload.childThreadId : null);
    if (!childThreadId) return [];
    return [
      this.#frame(event, "completed", {
        itemId: `subagent${DRAFT_ITEM_SEPARATOR}${childThreadId}${DRAFT_ITEM_SEPARATOR}${createdAt}`,
        itemType: "subAgentActivity",
        status: "completed",
        kind: typeof payload.reason === "string" ? payload.reason : "watchdog",
        agentThreadId: childThreadId,
        agentPath: typeof payload.agentPath === "string" ? payload.agentPath : null,
        detail: typeof payload.detail === "string" ? payload.detail : null,
        completedAtMs: nowMs(createdAt)
      }, createdAt)
    ];
  }

  #projectUserMessage(event: RuntimeEvent, createdAt: string): RuntimeEvent[] {
    const message = event.payload?.message;
    if (!message || typeof message !== "object") return [];
    const record = message as Record<string, unknown>;
    if (record.role !== "user") return [];
    const messageId = typeof record.id === "string" ? record.id : null;
    if (!messageId) return [];
    const startedAtMs = nowMs(typeof record.createdAt === "string" ? record.createdAt : createdAt);
    return [
      this.#frame(event, "started", {
        itemId: messageId,
        itemType: "userMessage",
        status: "completed",
        content: typeof record.content === "string" ? record.content : "",
        startedAtMs,
        completedAtMs: startedAtMs
      }, createdAt)
    ];
  }
}

/** Convenience for a caller that only has a tool name and needs its variant. */
export function runtimeItemKindForTool(toolName: string): RuntimeItemKind {
  return resolveRuntimeItemKindForTool(canonicalizeToolName(toolName));
}
