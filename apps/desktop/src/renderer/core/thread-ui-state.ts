import type { GpaState, RuntimeThreadSnapshot, ThreadRecord } from "@shared-types";

const RENDERER_DEFAULT_GPA_STATE: GpaState = {
  stage: "off",
  fullAccess: false,
  knowledgeEnabled: false,
  awaitingConfirmation: null,
  confirmationExpiresAt: null,
  planTasks: [],
  updatedAt: ""
};

export function normalizeGpaStateForThread(
  threadMode: ThreadRecord["mode"],
  state: GpaState | null | undefined
): GpaState {
  const next = state
    ? { ...state, planTasks: [...state.planTasks] }
    : { ...RENDERER_DEFAULT_GPA_STATE, planTasks: [] };
  if (threadMode !== "project" && next.stage !== "off") {
    return {
      ...next,
      stage: "off",
      awaitingConfirmation: null,
      planTasks: []
    };
  }
  return next;
}

/**
 * fullAccess / knowledgeEnabled are durable per-thread preferences. A thread
 * switch resets the renderer GPA state first and restores the rest from
 * snapshots asynchronously, so these two flags are merged back explicitly.
 */
export function mergeDurableGpaFlags(
  current: GpaState,
  persisted: Pick<GpaState, "fullAccess" | "knowledgeEnabled">
): GpaState {
  if (current.fullAccess === persisted.fullAccess && current.knowledgeEnabled === persisted.knowledgeEnabled) {
    return current;
  }
  return { ...current, fullAccess: persisted.fullAccess, knowledgeEnabled: persisted.knowledgeEnabled };
}

export function replaceThreadSnapshotGpa(
  snapshot: RuntimeThreadSnapshot | null,
  threadId: string,
  gpa: GpaState
): RuntimeThreadSnapshot | null {
  if (!snapshot || snapshot.thread.id !== threadId) return snapshot;
  return { ...snapshot, gpa };
}

export type HistoryItemAffordance =
  | {
      kind: "running-indicator";
      title: string;
    }
  | {
      kind: "delete";
      title: string;
    };

export type ComposerPrimaryActionState = {
  kind: "interrupt" | "send";
  title: string;
  ariaLabel: string;
  disabled: boolean;
};

export type ThreadContentView = "switching" | "welcome" | "transcript";

export function getThreadContentView(
  selectedThreadId: string | null,
  snapshotThreadId: string | null,
  timelineEntryCount: number,
  activity?: {
    sending?: boolean;
    threadStatus?: ThreadRecord["status"] | null;
  }
): ThreadContentView {
  if (!selectedThreadId) {
    return "welcome";
  }
  if (snapshotThreadId !== selectedThreadId) {
    return "switching";
  }
  if (
    timelineEntryCount > 0 ||
    activity?.sending ||
    isThreadExecutionInProgress(activity?.threadStatus)
  ) {
    return "transcript";
  }
  return "welcome";
}

export function shouldCommitThreadSnapshotImmediately(
  selectedThreadId: string | null,
  renderedSnapshotThreadId: string | null,
  incomingThreadId: string,
  hasPendingOptimisticMessages = false
): boolean {
  if (selectedThreadId !== incomingThreadId) {
    return false;
  }
  if (renderedSnapshotThreadId !== incomingThreadId) {
    return true;
  }
  // A transition can be starved by runtime events. Keep an in-flight edited
  // send visible instead of letting a later truncated snapshot replace it.
  return hasPendingOptimisticMessages;
}

/** Whether a runtime event can change the currently selected task's snapshot. */
export function shouldRefreshSelectedSnapshotForRuntimeEvent(
  selectedThreadId: string | null,
  eventThreadId?: string,
  notificationThreadId?: string | null
): boolean {
  return Boolean(selectedThreadId) && (
    !eventThreadId ||
    eventThreadId === selectedThreadId ||
    notificationThreadId === selectedThreadId
  );
}

/** Child-status echoes must not abort an in-flight parent snapshot refresh. */
export function shouldInvalidateSnapshotForThreadUpdate(payload: {
  childThread?: ThreadRecord | null;
}): boolean {
  return !payload.childThread;
}

function isLiveSubagent(
  child: Pick<ThreadRecord, "id" | "status">,
  queuedSubagentIds: readonly string[]
): boolean {
  return child.status === "running"
    || child.status === "waiting"
    || child.status === "idle"
    || queuedSubagentIds.includes(child.id);
}

export function upsertSubagentIntoSnapshot(
  snapshot: RuntimeThreadSnapshot,
  child: ThreadRecord
): RuntimeThreadSnapshot {
  const parentId = child.parentThreadId ?? child.rootThreadId;
  if (snapshot.thread.id !== parentId && snapshot.thread.id !== child.rootThreadId) {
    return snapshot;
  }
  const subagents = snapshot.subagents.some((item) => item.id === child.id)
    ? snapshot.subagents.map((item) => item.id === child.id ? child : item)
    : [...snapshot.subagents, child];
  const isQueued = child.status === "idle";
  const queuedSubagentIds = isQueued
    ? Array.from(new Set([...snapshot.queuedSubagentIds, child.id]))
    : snapshot.queuedSubagentIds.filter((id) => id !== child.id);
  return { ...snapshot, subagents, queuedSubagentIds };
}

/** Keep spawned children visible when a stale/empty parent snapshot arrives. */
export function mergeSnapshotSubagents(
  known: Pick<RuntimeThreadSnapshot, "subagents" | "queuedSubagentIds">,
  incoming: Pick<RuntimeThreadSnapshot, "subagents" | "queuedSubagentIds">
): Pick<RuntimeThreadSnapshot, "subagents" | "queuedSubagentIds"> {
  if (incoming.subagents.length === 0) {
    const subagents = known.subagents.filter((item) => isLiveSubagent(item, known.queuedSubagentIds));
    return {
      subagents,
      queuedSubagentIds: known.queuedSubagentIds.filter((id) => subagents.some((item) => item.id === id))
    };
  }
  const incomingIds = new Set(incoming.subagents.map((item) => item.id));
  const leftovers = known.subagents.filter((item) =>
    !incomingIds.has(item.id) && isLiveSubagent(item, known.queuedSubagentIds)
  );
  return {
    subagents: [...incoming.subagents, ...leftovers],
    queuedSubagentIds: Array.from(new Set([
      ...incoming.queuedSubagentIds,
      ...leftovers.filter((item) => known.queuedSubagentIds.includes(item.id)).map((item) => item.id)
    ]))
  };
}

/** Knowledge content changes (imports or agent note writes) must refresh the knowledge base list. */
export function shouldRefreshKnowledgeBasesForRuntimeEvent(eventType: string): boolean {
  return eventType === "knowledge.imported";
}

export function invalidateThreadSnapshotForFullRefresh<TCursor, TSnapshot, TRuntimeMessages>(
  threadId: string,
  state: {
    cursorByThread: Record<string, TCursor>;
    requestIdsByThread: Record<string, number>;
    cacheByThread: Map<string, TSnapshot>;
    runtimeMessagesByThread: Record<string, TRuntimeMessages>;
  },
  options?: { preserveRuntimeMessages?: boolean }
): void {
  state.requestIdsByThread[threadId] = (state.requestIdsByThread[threadId] ?? 0) + 1;
  delete state.cursorByThread[threadId];
  state.cacheByThread.delete(threadId);
  if (!options?.preserveRuntimeMessages) {
    delete state.runtimeMessagesByThread[threadId];
  }
}

export function prunePersistedRuntimeMessageMap<T extends { id: string; createdAt?: string }>(
  persisted: Map<string, T> | undefined,
  snapshotMessages: Array<{ id: string }>,
  limit = 64
): Map<string, T> | undefined {
  if (!persisted || persisted.size === 0) return persisted;
  const next = new Map(persisted);
  for (const message of snapshotMessages) next.delete(message.id);
  if (next.size === 0) return undefined;
  if (next.size <= limit) return next;
  const kept = [...next.values()]
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")))
    .slice(-limit);
  return new Map(kept.map((message) => [message.id, message]));
}

export function isThreadExecutionInProgress(status?: ThreadRecord["status"] | null) {
  return status === "running" || status === "waiting";
}

/** Child-agent threads belong to the active task panel, never the history list. */
export function shouldIncludeRuntimeThreadInHistory(thread: Pick<ThreadRecord, "parentThreadId">): boolean {
  return !thread.parentThreadId;
}

/** Whether the chat should show the live "执行中/正在请求模型决策" processing UI. */
export function shouldPreservePreparingRuntime(
  status: ThreadRecord["status"] | null | undefined,
  queuedMessageCount: number,
  runtimeObserved: boolean
): boolean {
  return !isThreadExecutionInProgress(status) && queuedMessageCount > 0 && !runtimeObserved;
}

export function shouldShowTaskProcessing(
  status: ThreadRecord["status"] | null | undefined,
  isPreparing: boolean
): boolean {
  if (isThreadExecutionInProgress(status)) {
    return true;
  }
  if (status === "completed" || status === "failed") {
    return false;
  }
  // Allow the brief preparing overlay before the backend flips to running.
  // Never keep "执行中" alive from stale runtimeProgress after stop/complete.
  return isPreparing;
}

export function getHistoryItemAffordance(status?: ThreadRecord["status"] | null): HistoryItemAffordance {
  if (status === "waiting") {
    return {
      kind: "running-indicator",
      title: "任务等待中"
    };
  }

  if (status === "running") {
    return {
      kind: "running-indicator",
      title: "任务执行中"
    };
  }

  return {
    kind: "delete",
    title: "删除任务"
  };
}

export function getComposerPrimaryActionState(
  status: ThreadRecord["status"] | null | undefined,
  input: string
): ComposerPrimaryActionState {
  if (input.trim()) {
    return {
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: false
    };
  }

  if (isThreadExecutionInProgress(status)) {
    return {
      kind: "interrupt",
      title: "停止执行",
      ariaLabel: "停止执行",
      disabled: false
    };
  }

  return { kind: "send", title: "发送", ariaLabel: "发送", disabled: true };
}

export function canDeleteThread(status?: ThreadRecord["status"] | null, deletingThreadId?: string | null) {
  return !deletingThreadId && !isThreadExecutionInProgress(status);
}

export function getDeleteThreadBlockedMessage(status?: ThreadRecord["status"] | null, deletingThreadId?: string | null) {
  if (deletingThreadId) {
    return null;
  }

  if (isThreadExecutionInProgress(status)) {
    return "任务正在执行，暂时不能删除。";
  }

  return null;
}
