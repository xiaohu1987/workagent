import { describe, expect, it } from "vitest";
import type { RuntimeEvent, SkillLabEvent } from "@shared-types";
import {
  resolveRuntimeSystemNotification,
  resolveSkillLabSystemNotification,
  takeSystemNotificationForDelivery
} from "../apps/desktop/src/main/notification-policy";

describe("background system notification policy", () => {
  it("only delivers while hidden and suppresses duplicate events", () => {
    const request = {
      key: "thread:root-1:completed:1",
      title: "任务已完成",
      body: "可以查看结果。",
      target: { source: "thread" as const, targetId: "root-1" }
    };
    const deliveredKeys = new Set<string>();

    expect(takeSystemNotificationForDelivery(request, false, deliveredKeys)).toBeNull();
    expect(takeSystemNotificationForDelivery(request, true, deliveredKeys)).toBeNull();

    const hiddenRequest = { ...request, key: "thread:root-2:completed:1" };
    expect(takeSystemNotificationForDelivery(hiddenRequest, true, deliveredKeys)).toEqual(hiddenRequest);
    expect(takeSystemNotificationForDelivery(hiddenRequest, true, deliveredKeys)).toBeNull();
  });

  it("notifies for a root task only when active execution reaches a terminal state", () => {
    const event: RuntimeEvent = {
      type: "thread.updated",
      threadId: "thread-1",
      createdAt: "2026-07-22T10:00:00.000Z",
      payload: { thread: { id: "thread-1", title: "整理报表", status: "completed", updatedAt: "2026-07-22T10:00:00.000Z", parentThreadId: null } }
    };
    expect(resolveRuntimeSystemNotification(event, "completed")).toBeNull();
    expect(resolveRuntimeSystemNotification(event, "running")).toMatchObject({
      title: "任务已完成",
      target: { source: "thread", targetId: "thread-1" }
    });
  });

  it("routes pending input to the original task and anchor", () => {
    const event: RuntimeEvent = {
      type: "user-input.requested",
      threadId: "thread-2",
      createdAt: "2026-07-22T10:00:00.000Z",
      payload: { prompt: { id: "prompt-1", title: "请选择输出格式" } }
    };
    expect(resolveRuntimeSystemNotification(event)).toMatchObject({
      title: "需要补充信息",
      body: "请选择输出格式",
      target: { source: "thread", targetId: "thread-2", anchorId: "prompt-1" }
    });
  });

  it("routes child attention to its root task and ignores child completion", () => {
    const childInput: RuntimeEvent = {
      type: "user-input.requested",
      threadId: "child-1",
      notificationThreadId: "root-1",
      notificationChildThreadId: "child-1",
      createdAt: "2026-07-22T10:00:00.000Z",
      payload: { prompt: { id: "prompt-child", title: "请选择处理方式" } }
    };
    expect(resolveRuntimeSystemNotification(childInput)).toMatchObject({
      target: { source: "thread", targetId: "root-1", anchorId: "prompt-child" }
    });

    const childCompleted: RuntimeEvent = {
      type: "thread.updated",
      threadId: "child-1",
      notificationThreadId: "root-1",
      notificationChildThreadId: "child-1",
      createdAt: "2026-07-22T10:01:00.000Z",
      payload: {
        thread: {
          id: "child-1",
          title: "后台子任务",
          status: "completed",
          updatedAt: "2026-07-22T10:01:00.000Z",
          parentThreadId: "root-1"
        }
      }
    };
    expect(resolveRuntimeSystemNotification(childCompleted, "running")).toBeNull();
  });

  it("notifies for skill lab attention and terminal states but not progress or cancellation", () => {
    const progress: SkillLabEvent = {
      type: "skill-lab.progress",
      jobId: "job-1",
      createdAt: "2026-07-22T10:00:00.000Z",
      iteration: 1,
      totalIterations: 5,
      phase: "第 1 轮",
      summary: "测试中",
      state: "running"
    };
    expect(resolveSkillLabSystemNotification(progress)).toBeNull();
    expect(resolveSkillLabSystemNotification({ ...progress, type: "skill-lab.cancelled" })).toBeNull();
    expect(resolveSkillLabSystemNotification({
      type: "skill-lab.failed",
      jobId: "job-1",
      createdAt: progress.createdAt,
      error: "模型超时"
    })).toMatchObject({
      title: "技能实验室执行失败",
      target: { source: "skill-lab", targetId: "job-1" }
    });
  });
});
