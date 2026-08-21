import type { MutableRefObject } from "react";
import type { RuntimeEvent, SkillLabEvent, ThreadRecord } from "@shared-types";
import {
  findActiveNotification,
  resolveThreadStatusTransition,
  type NotificationCenterAction,
  type NotificationCenterState
} from "../core/notification-center";

type UseThreadNotificationsOptions = {
  threadsRef: MutableRefObject<ThreadRecord[]>;
  threadStatusRef: MutableRefObject<Map<string, ThreadRecord["status"]>>;
  notificationStateRef: MutableRefObject<NotificationCenterState>;
  dispatch: (action: NotificationCenterAction) => void;
};

export function useThreadNotifications({ threadsRef, threadStatusRef, notificationStateRef, dispatch }: UseThreadNotificationsOptions) {
  const getThreadTitle = (threadId: string, fallback?: string) => fallback?.trim() || threadsRef.current.find((thread) => thread.id === threadId)?.title || "后台任务";

  function updateThreadNotification(threadId: string, detail: string, updatedAt?: string) {
    const active = findActiveNotification(notificationStateRef.current.items, "thread", threadId);
    if (!active || active.status === "attention") return;
    dispatch({ type: "update", source: "thread", targetId: threadId, updatedAt: updatedAt ?? new Date().toISOString(), patch: { detail, status: "running", unread: false } });
  }

  function setThreadNotificationAttention(threadId: string, detail: string, kind: "approval" | "input" | "gpa", anchorId?: string, updatedAt?: string) {
    const timestamp = updatedAt ?? new Date().toISOString();
    const active = findActiveNotification(notificationStateRef.current.items, "thread", threadId);
    if (active) {
      dispatch({ type: "update", source: "thread", targetId: threadId, updatedAt: timestamp, patch: { detail, status: "attention", unread: true, attentionKind: kind, anchorId } });
      return;
    }
    dispatch({
      type: "start",
      item: {
        id: `thread:${threadId}:${timestamp}`,
        source: "thread",
        targetId: threadId,
        title: getThreadTitle(threadId),
        detail,
        status: "attention",
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        unread: true,
        attentionKind: kind,
        anchorId
      }
    });
  }

  function resumeThreadNotification(threadId: string, detail: string, updatedAt?: string) {
    if (!findActiveNotification(notificationStateRef.current.items, "thread", threadId)) return;
    dispatch({
      type: "update",
      source: "thread",
      targetId: threadId,
      updatedAt: updatedAt ?? new Date().toISOString(),
      patch: { detail, status: "running", unread: false, attentionKind: undefined, anchorId: undefined }
    });
  }

  function finishThreadNotification(threadId: string, status: "completed" | "failed" | "cancelled", updatedAt: string, title?: string) {
    dispatch({
      type: "finish",
      source: "thread",
      targetId: threadId,
      updatedAt,
      status,
      title,
      detail: status === "completed" ? "任务已完成，可以查看结果。" : status === "failed" ? "任务执行失败，请打开任务查看详情。" : "任务已停止。",
      unread: status !== "cancelled"
    });
  }

  function applyThreadStatusNotification(event: RuntimeEvent) {
    if (event.type !== "thread.updated" || !event.threadId) return;
    const thread = event.payload.thread as ThreadRecord | undefined;
    if (!thread) return;
    const active = findActiveNotification(notificationStateRef.current.items, "thread", event.threadId);
    const transition = resolveThreadStatusTransition({
      previousStatus: threadStatusRef.current.get(event.threadId),
      nextStatus: thread.status,
      hasActive: Boolean(active),
      pluginChanged: Boolean(event.payload.pluginChanged),
      isSubagent: Boolean(thread.parentThreadId)
    });
    threadStatusRef.current.set(event.threadId, thread.status);
    if (!transition) return;
    const timestamp = thread.updatedAt || event.createdAt;
    const title = getThreadTitle(event.threadId, thread.title);

    if (transition === "start") {
      const waiting = thread.status === "waiting";
      dispatch({
        type: "start",
        item: {
          id: `thread:${event.threadId}:${timestamp}`,
          source: "thread",
          targetId: event.threadId,
          title,
          detail: waiting ? "任务正在等待你的处理。" : "正在理解任务并准备执行。",
          status: waiting ? "attention" : "running",
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: timestamp,
          unread: waiting
        }
      });
    } else if (transition === "running") {
      resumeThreadNotification(event.threadId, active?.detail || "任务正在运行。", timestamp);
    } else if (transition === "attention") {
      if (active?.status !== "attention") setThreadNotificationAttention(event.threadId, "任务正在等待你的处理。", "input", undefined, timestamp);
    } else {
      finishThreadNotification(event.threadId, transition, timestamp, title);
    }
  }

  function syncThreadNotifications(nextThreads: ThreadRecord[]) {
    const timestamp = new Date().toISOString();
    const rootThreads = nextThreads.filter((thread) => !thread.parentThreadId);
    const byId = new Map(rootThreads.map((thread) => [thread.id, thread]));

    for (const thread of rootThreads) {
      threadStatusRef.current.set(thread.id, thread.status);
      const active = findActiveNotification(notificationStateRef.current.items, "thread", thread.id);
      if (thread.status === "running" || thread.status === "waiting") {
        if (active) {
          if (thread.status === "waiting" && active.status !== "attention") {
            setThreadNotificationAttention(thread.id, active.detail || "任务正在等待你的处理。", active.attentionKind ?? "input", active.anchorId, timestamp);
          } else if (thread.status === "running" && active.status === "attention" && !active.attentionKind) {
            resumeThreadNotification(thread.id, active.detail || "任务正在运行。", timestamp);
          }
          continue;
        }
        const waiting = thread.status === "waiting";
        dispatch({
          type: "start",
          item: {
            id: `thread:${thread.id}:${timestamp}`,
            source: "thread",
            targetId: thread.id,
            title: getThreadTitle(thread.id, thread.title),
            detail: waiting ? "任务正在等待你的处理。" : "任务正在运行。",
            status: waiting ? "attention" : "running",
            createdAt: timestamp,
            updatedAt: timestamp,
            startedAt: timestamp,
            unread: waiting
          }
        });
      } else if (active) {
        finishThreadNotification(thread.id, thread.status === "completed" ? "completed" : thread.status === "failed" ? "failed" : "cancelled", timestamp, getThreadTitle(thread.id, thread.title));
      }
    }

    for (const item of notificationStateRef.current.items) {
      if (item.source !== "thread" || (item.status !== "running" && item.status !== "attention") || byId.has(item.targetId)) continue;
      dispatch({ type: "finish", source: "thread", targetId: item.targetId, updatedAt: timestamp, status: "cancelled", detail: "任务已停止。", unread: false });
    }
  }

  function updateSkillLabNotification(event: SkillLabEvent) {
    const active = findActiveNotification(notificationStateRef.current.items, "skill-lab", event.jobId);
    const base = { id: `skill-lab:${event.jobId}`, source: "skill-lab" as const, targetId: event.jobId, title: active?.title ?? "技能实验室", createdAt: event.createdAt, updatedAt: event.createdAt, startedAt: event.createdAt };
    if (event.type === "skill-lab.progress") {
      const completed = event.state === "tested" ? event.iteration : Math.max(0, event.iteration - 1);
      const progress = { current: Math.min(event.totalIterations, completed), total: event.totalIterations, percent: event.totalIterations > 0 ? Math.round((Math.min(event.totalIterations, completed) / event.totalIterations) * 100) : 0 };
      dispatch({ type: "start", item: { ...base, detail: `${event.phase} · ${event.summary}`, status: "running", unread: false, progress, attentionKind: undefined, anchorId: undefined } });
      return;
    }
    if (event.type === "skill-lab.approval" || event.type === "skill-lab.clarification") {
      dispatch({ type: "start", item: { ...base, detail: event.type === "skill-lab.approval" ? event.description : event.summary, status: "attention", unread: true, attentionKind: event.type === "skill-lab.approval" ? "approval" : "input" } });
      return;
    }
    const status = event.type === "skill-lab.completed" ? "completed" : event.type === "skill-lab.failed" ? "failed" : "cancelled";
    const detail = event.type === "skill-lab.completed" ? `${event.skill.displayName ?? event.skill.name} 已生成并通过测试。` : event.type === "skill-lab.failed" ? event.error : "技能实验室任务已取消。";
    const title = event.type === "skill-lab.completed" ? `技能实验室 · ${event.skill.displayName ?? event.skill.name}` : base.title;
    if (active) {
      dispatch({ type: "finish", source: "skill-lab", targetId: event.jobId, updatedAt: event.createdAt, status, detail, title, unread: status !== "cancelled", progress: status === "completed" && active.progress ? { ...active.progress, current: active.progress.total, percent: 100 } : active.progress });
    } else {
      dispatch({ type: "start", item: { ...base, title, detail, status, unread: status !== "cancelled" } });
    }
  }

  function startSkillLabNotification(jobId: string, title: string, totalIterations: number) {
    if (findActiveNotification(notificationStateRef.current.items, "skill-lab", jobId)) return;
    const timestamp = new Date().toISOString();
    dispatch({ type: "start", item: { id: `skill-lab:${jobId}`, source: "skill-lab", targetId: jobId, title, detail: "正在分析需求并准备生成 Skill。", status: "running", createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp, unread: false, progress: { current: 0, total: totalIterations, percent: 0 } } });
  }

  function startUserSkillGenerationNotification(targetId: string, title: string) {
    if (findActiveNotification(notificationStateRef.current.items, "user-skill", targetId)) return;
    const timestamp = new Date().toISOString();
    dispatch({
      type: "start",
      item: {
        id: `user-skill:${targetId}:${timestamp}`,
        source: "user-skill",
        targetId,
        title,
        detail: "正在根据聊天记录提炼用户技能。",
        status: "running",
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        unread: false
      }
    });
  }

  function finishUserSkillGenerationNotification(
    targetId: string,
    status: "completed" | "failed",
    detail: string,
    title?: string
  ) {
    dispatch({
      type: "finish",
      source: "user-skill",
      targetId,
      updatedAt: new Date().toISOString(),
      status,
      title,
      detail,
      unread: true
    });
  }

  return {
    updateThreadNotification,
    setThreadNotificationAttention,
    resumeThreadNotification,
    applyThreadStatusNotification,
    syncThreadNotifications,
    updateSkillLabNotification,
    startSkillLabNotification,
    startUserSkillGenerationNotification,
    finishUserSkillGenerationNotification
  };
}
