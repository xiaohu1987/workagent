import type { RuntimeEvent, ThreadStatus } from "@shared-types";

export type NotificationSource = "thread" | "skill-lab";
export type NotificationStatus = "running" | "attention" | "completed" | "failed" | "cancelled";

export interface NotificationProgress {
  current: number;
  total: number;
  percent: number;
}

export interface NotificationCenterItem {
  id: string;
  source: NotificationSource;
  targetId: string;
  title: string;
  detail: string;
  status: NotificationStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  unread: boolean;
  progress?: NotificationProgress;
  attentionKind?: "approval" | "input" | "gpa";
  anchorId?: string;
}

export interface NotificationCenterState {
  items: NotificationCenterItem[];
}

export type NotificationCenterAction =
  | { type: "start"; item: NotificationCenterItem }
  | {
      type: "update";
      source: NotificationSource;
      targetId: string;
      updatedAt: string;
      patch: Partial<Pick<NotificationCenterItem, "title" | "detail" | "status" | "unread" | "progress" | "attentionKind" | "anchorId">>;
    }
  | {
      type: "finish";
      source: NotificationSource;
      targetId: string;
      updatedAt: string;
      status: Extract<NotificationStatus, "completed" | "failed" | "cancelled">;
      detail: string;
      title?: string;
      unread: boolean;
      progress?: NotificationProgress;
    }
  | { type: "mark-all-read" }
  | { type: "clear-finished" };

export const EMPTY_NOTIFICATION_CENTER_STATE: NotificationCenterState = { items: [] };
export const NOTIFICATION_HISTORY_LIMIT = 50;

export function resolveRuntimeNotificationThreadId(event: RuntimeEvent): string | null {
  return event.notificationThreadId ?? event.threadId ?? null;
}

export function reduceNotificationCenter(
  state: NotificationCenterState,
  action: NotificationCenterAction
): NotificationCenterState {
  if (action.type === "mark-all-read") {
    return {
      items: state.items.map((item) => isFinishedNotification(item)
        ? { ...item, unread: false }
        : item)
    };
  }

  if (action.type === "clear-finished") {
    return { items: state.items.filter((item) => !isFinishedNotification(item)) };
  }

  if (action.type === "start") {
    const active = findActiveNotification(state.items, action.item.source, action.item.targetId);
    const items = active
      ? state.items.map((item) => item.id === active.id
        ? { ...item, ...action.item, id: item.id, createdAt: item.createdAt, startedAt: item.startedAt }
        : item)
      : [...state.items, action.item];
    return { items: trimNotificationHistory(items) };
  }

  const active = findActiveNotification(state.items, action.source, action.targetId);
  if (!active) return state;

  if (action.type === "finish") {
    return {
      items: trimNotificationHistory(state.items.map((item) => item.id === active.id
        ? {
            ...item,
            title: action.title ?? item.title,
            detail: action.detail,
            status: action.status,
            updatedAt: action.updatedAt,
            unread: action.unread,
            progress: action.progress ?? item.progress,
            attentionKind: undefined,
            anchorId: undefined
          }
        : item))
    };
  }

  return {
    items: state.items.map((item) => item.id === active.id
      ? { ...item, ...action.patch, updatedAt: action.updatedAt }
      : item)
  };
}

export function findActiveNotification(
  items: NotificationCenterItem[],
  source: NotificationSource,
  targetId: string
): NotificationCenterItem | null {
  return items.find((item) =>
    item.source === source &&
    item.targetId === targetId &&
    (item.status === "running" || item.status === "attention")
  ) ?? null;
}

export function sortNotificationItems(items: NotificationCenterItem[]): NotificationCenterItem[] {
  const rank: Record<NotificationStatus, number> = {
    attention: 0,
    running: 1,
    failed: 2,
    completed: 3,
    cancelled: 4
  };
  return [...items].sort((left, right) =>
    rank[left.status] - rank[right.status] ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}

export function isFinishedNotification(item: NotificationCenterItem): boolean {
  return item.status === "completed" || item.status === "failed" || item.status === "cancelled";
}

export function resolveThreadStatusTransition(input: {
  previousStatus?: ThreadStatus;
  nextStatus: ThreadStatus;
  hasActive: boolean;
  pluginChanged?: boolean;
  isSubagent?: boolean;
}): "start" | "running" | "attention" | "completed" | "failed" | "cancelled" | null {
  if (input.pluginChanged || input.isSubagent) return null;
  if (input.nextStatus === "running") return input.hasActive ? "running" : "start";
  if (input.nextStatus === "waiting") return input.hasActive ? "attention" : "start";
  if (!input.hasActive) return null;
  if (input.nextStatus === "completed") return "completed";
  if (input.nextStatus === "failed") return "failed";
  if (input.nextStatus === "idle" && (input.previousStatus === "running" || input.previousStatus === "waiting")) {
    return "cancelled";
  }
  return null;
}

function trimNotificationHistory(items: NotificationCenterItem[]): NotificationCenterItem[] {
  const active = items.filter((item) => !isFinishedNotification(item));
  const history = items
    .filter(isFinishedNotification)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, NOTIFICATION_HISTORY_LIMIT);
  return [...active, ...history];
}
