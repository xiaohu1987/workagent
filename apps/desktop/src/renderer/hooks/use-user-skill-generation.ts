import { useState } from "react";
import type { ThreadRecord } from "@shared-types";
import type { UserSkillGenerationDialog } from "../core/app-types";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useUserSkillGeneration(
  refreshUserSkills: () => Promise<void>,
  refreshSkills: () => Promise<void>,
  showNotice: Notice,
  startNotification: (targetId: string, title: string) => void,
  finishNotification: (targetId: string, status: "completed" | "failed", detail: string, title?: string) => void
) {
  const [dialog, setDialog] = useState<UserSkillGenerationDialog | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  function open(thread: ThreadRecord) {
    if (thread.parentThreadId || thread.status === "running" || isGenerating) return;
    setDialog({ thread, name: thread.title.slice(0, 64) });
  }

  async function generate(target: UserSkillGenerationDialog) {
    const skillName = target.name.trim();
    if (!skillName || target.thread.parentThreadId || target.thread.status === "running" || isGenerating) return;
    setIsGenerating(true);
    const notificationTargetId = `${target.thread.id}:${skillName}`;
    const notificationTitle = `提炼技能 · ${skillName}`;
    startNotification(notificationTargetId, notificationTitle);
    try {
      const skill = await window.codexh.generateUserSkill(target.thread.id, skillName);
      await Promise.all([refreshUserSkills(), refreshSkills()]);
      setDialog(null);
      finishNotification(notificationTargetId, "completed", `${skill.displayName ?? skill.name} 已生成。`, `提炼技能 · ${skill.displayName ?? skill.name}`);
      showNotice(`已生成用户技能：${skill.displayName ?? skill.name}`, { tone: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishNotification(notificationTargetId, "failed", `生成用户技能失败：${message}`, notificationTitle);
      showNotice("生成用户技能失败", { message });
    } finally {
      setIsGenerating(false);
    }
  }

  return { dialog, setDialog, isGenerating, open, generate };
}
