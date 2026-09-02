import type { GpaState, ThreadRecord } from "@shared-types";

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
  timelineEntryCount: number
): ThreadContentView {
  if (!selectedThreadId) {
    return "welcome";
  }
  if (snapshotThreadId !== selectedThreadId) {
    return "switching";
  }
  return timelineEntryCount === 0 ? "welcome" : "transcript";
}

export function shouldCommitThreadSnapshotImmediately(
  selectedThreadId: string | null,
  renderedSnapshotThreadId: string | null,
  incomingThreadId: string
): boolean {
  return selectedThreadId === incomingThreadId && renderedSnapshotThreadId !== incomingThreadId;
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
