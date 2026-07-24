import type { ThreadRecord } from "@shared-types";

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

export function isThreadExecutionInProgress(status?: ThreadRecord["status"] | null) {
  return status === "running" || status === "waiting";
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
  if (isThreadExecutionInProgress(status)) {
    return {
      kind: "interrupt",
      title: "停止执行",
      ariaLabel: "停止执行",
      disabled: false
    };
  }

  if (input.trim()) {
    return {
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
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
