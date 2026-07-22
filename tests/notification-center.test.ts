import { describe, expect, it } from "vitest";
import {
  EMPTY_NOTIFICATION_CENTER_STATE,
  NOTIFICATION_HISTORY_LIMIT,
  reduceNotificationCenter,
  resolveRuntimeNotificationThreadId,
  resolveThreadStatusTransition,
  sortNotificationItems,
  type NotificationCenterItem
} from "../apps/desktop/src/renderer/notification-center";

function item(id: string, status: NotificationCenterItem["status"] = "running", updatedAt = "2026-07-22T10:00:00.000Z"): NotificationCenterItem {
  return {
    id,
    source: "thread",
    targetId: id,
    title: id,
    detail: "Working",
    status,
    createdAt: updatedAt,
    updatedAt,
    startedAt: updatedAt,
    unread: status === "completed" || status === "failed"
  };
}

describe("notification center state", () => {
  it("moves an activity through attention, running, and completed states", () => {
    let state = reduceNotificationCenter(EMPTY_NOTIFICATION_CENTER_STATE, { type: "start", item: item("thread-1") });
    state = reduceNotificationCenter(state, {
      type: "update",
      source: "thread",
      targetId: "thread-1",
      updatedAt: "2026-07-22T10:01:00.000Z",
      patch: { status: "attention", detail: "Needs approval", unread: true, attentionKind: "approval" }
    });
    expect(state.items[0]).toMatchObject({ status: "attention", detail: "Needs approval", unread: true });

    state = reduceNotificationCenter(state, {
      type: "update",
      source: "thread",
      targetId: "thread-1",
      updatedAt: "2026-07-22T10:02:00.000Z",
      patch: { status: "running", detail: "Continuing", unread: false, attentionKind: undefined }
    });
    state = reduceNotificationCenter(state, {
      type: "finish",
      source: "thread",
      targetId: "thread-1",
      updatedAt: "2026-07-22T10:03:00.000Z",
      status: "completed",
      detail: "Done",
      unread: true
    });
    expect(state.items[0]).toMatchObject({ status: "completed", detail: "Done", unread: true });
    expect(reduceNotificationCenter(state, { type: "mark-all-read" }).items[0]?.unread).toBe(false);
  });

  it("does not mark unresolved attention items as read", () => {
    const attention = { ...item("waiting", "attention"), unread: true };
    const state = reduceNotificationCenter({ items: [attention] }, { type: "mark-all-read" });
    expect(state.items[0]?.unread).toBe(true);
  });

  it("keeps active items while limiting terminal history", () => {
    let state = reduceNotificationCenter(EMPTY_NOTIFICATION_CENTER_STATE, { type: "start", item: item("active") });
    for (let index = 0; index < NOTIFICATION_HISTORY_LIMIT + 8; index += 1) {
      state = reduceNotificationCenter(state, {
        type: "start",
        item: item(`done-${index}`, "completed", `2026-07-22T10:${String(index).padStart(2, "0")}:00.000Z`)
      });
    }
    expect(state.items.filter((entry) => entry.status === "running")).toHaveLength(1);
    expect(state.items.filter((entry) => entry.status === "completed")).toHaveLength(NOTIFICATION_HISTORY_LIMIT);
  });

  it("orders attention before running and terminal messages", () => {
    const sorted = sortNotificationItems([
      item("complete", "completed"),
      item("run", "running"),
      item("attention", "attention")
    ]);
    expect(sorted.map((entry) => entry.status)).toEqual(["attention", "running", "completed"]);
  });

  it("only reports terminal transitions for active root execution", () => {
    expect(resolveThreadStatusTransition({ nextStatus: "completed", previousStatus: "completed", hasActive: false })).toBeNull();
    expect(resolveThreadStatusTransition({ nextStatus: "completed", previousStatus: "running", hasActive: true })).toBe("completed");
    expect(resolveThreadStatusTransition({ nextStatus: "running", previousStatus: "completed", hasActive: false, pluginChanged: true })).toBeNull();
    expect(resolveThreadStatusTransition({ nextStatus: "running", previousStatus: "idle", hasActive: false, isSubagent: true })).toBeNull();
    expect(resolveThreadStatusTransition({ nextStatus: "idle", previousStatus: "running", hasActive: true })).toBe("cancelled");
  });

  it("routes child activity to the root item without treating child completion as terminal", () => {
    const childEvent = {
      type: "tool.started" as const,
      threadId: "child-1",
      notificationThreadId: "root-1",
      notificationChildThreadId: "child-1",
      createdAt: "2026-07-22T10:00:00.000Z",
      payload: { toolName: "shell_command" }
    };
    expect(resolveRuntimeNotificationThreadId(childEvent)).toBe("root-1");
    expect(resolveThreadStatusTransition({
      previousStatus: "running",
      nextStatus: "completed",
      hasActive: true,
      isSubagent: true
    })).toBeNull();

    let state = reduceNotificationCenter(EMPTY_NOTIFICATION_CENTER_STATE, {
      type: "start",
      item: { ...item("root-1"), targetId: resolveRuntimeNotificationThreadId(childEvent)! }
    });
    state = reduceNotificationCenter(state, {
      type: "update",
      source: "thread",
      targetId: resolveRuntimeNotificationThreadId(childEvent)!,
      updatedAt: "2026-07-22T10:01:00.000Z",
      patch: { detail: "Child tool is running" }
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ targetId: "root-1", detail: "Child tool is running", status: "running" });
  });
});
