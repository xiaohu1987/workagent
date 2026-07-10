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

  return {
    kind: "send",
    title: "发送",
    ariaLabel: "发送",
    disabled: !input.trim()
  };
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
