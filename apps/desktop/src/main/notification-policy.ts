import type {
  NotificationNavigationTarget,
  RuntimeEvent,
  SkillLabEvent,
  ThreadStatus
} from "@shared-types";

export interface SystemNotificationRequest {
  key: string;
  title: string;
  body: string;
  target: NotificationNavigationTarget;
}

export function takeSystemNotificationForDelivery(
  request: SystemNotificationRequest | null,
  isWindowHidden: boolean,
  deliveredKeys: Set<string>,
  maxRememberedKeys = 500
): SystemNotificationRequest | null {
  if (!request || deliveredKeys.has(request.key)) return null;
  deliveredKeys.add(request.key);
  if (deliveredKeys.size > maxRememberedKeys) {
    deliveredKeys.delete(deliveredKeys.values().next().value!);
  }
  return isWindowHidden ? request : null;
}

export function resolveRuntimeSystemNotification(
  event: RuntimeEvent,
  previousThreadStatus?: ThreadStatus
): SystemNotificationRequest | null {
  const notificationThreadId = event.notificationThreadId ?? event.threadId;
  if (!notificationThreadId) return null;

  if (event.type === "approval.requested") {
    const approval = event.payload.approval as { id?: string; title?: string } | undefined;
    return {
      key: `approval:${approval?.id ?? event.createdAt}`,
      title: "需要确认操作",
      body: approval?.title?.trim() || "任务正在等待你的操作确认。",
      target: { source: "thread", targetId: notificationThreadId, anchorId: approval?.id }
    };
  }

  if (event.type === "user-input.requested") {
    const prompt = event.payload.prompt as { id?: string; title?: string } | undefined;
    return {
      key: `user-input:${prompt?.id ?? event.createdAt}`,
      title: "需要补充信息",
      body: prompt?.title?.trim() || "任务正在等待你的回答后继续执行。",
      target: { source: "thread", targetId: notificationThreadId, anchorId: prompt?.id }
    };
  }

  if (event.type === "gpa.updated") {
    const gpa = event.payload.gpa as { awaitingConfirmation?: unknown; updatedAt?: string } | undefined;
    if (gpa?.awaitingConfirmation === "goal" || gpa?.awaitingConfirmation === "plan") {
      return {
        key: `gpa:${notificationThreadId}:${gpa.awaitingConfirmation}:${gpa.updatedAt ?? event.createdAt}`,
        title: "GPA 计划待确认",
        body: "请确认目标或计划以继续执行任务。",
        target: { source: "thread", targetId: notificationThreadId }
      };
    }
    return null;
  }

  if (event.type !== "thread.updated") return null;
  const thread = event.payload.thread as {
    id?: string;
    title?: string;
    status?: ThreadStatus;
    updatedAt?: string;
    parentThreadId?: string | null;
  } | undefined;
  if (!thread?.status || thread.parentThreadId) return null;
  if (previousThreadStatus !== "running" && previousThreadStatus !== "waiting") return null;
  if (thread.status !== "completed" && thread.status !== "failed") return null;

  const failed = thread.status === "failed";
  return {
    key: `thread:${event.threadId}:${thread.status}:${thread.updatedAt ?? event.createdAt}`,
    title: failed ? "任务执行失败" : "任务已完成",
    body: thread.title?.trim()
      ? `${thread.title}${failed ? "执行失败，请查看详情。" : "执行完成，可以查看结果。"}`
      : failed ? "任务执行失败，请查看详情。" : "任务执行完成，可以查看结果。",
    target: { source: "thread", targetId: notificationThreadId }
  };
}

export function resolveSkillLabSystemNotification(event: SkillLabEvent): SystemNotificationRequest | null {
  const target: NotificationNavigationTarget = { source: "skill-lab", targetId: event.jobId };
  if (event.type === "skill-lab.approval") {
    return {
      key: `skill-lab-approval:${event.approvalId}`,
      title: "技能实验室需要确认",
      body: event.title,
      target
    };
  }
  if (event.type === "skill-lab.clarification") {
    return {
      key: `skill-lab-clarification:${event.clarificationId}`,
      title: "技能实验室需要补充信息",
      body: event.summary,
      target
    };
  }
  if (event.type === "skill-lab.completed") {
    return {
      key: `skill-lab-completed:${event.jobId}`,
      title: "技能实验室已完成",
      body: `${event.skill.displayName ?? event.skill.name} 已生成并通过测试。`,
      target
    };
  }
  if (event.type === "skill-lab.failed") {
    return {
      key: `skill-lab-failed:${event.jobId}`,
      title: "技能实验室执行失败",
      body: event.error,
      target
    };
  }
  return null;
}
