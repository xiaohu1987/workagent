import { useEffect, useRef, useState } from "react";
import type { SkillLabEvent, SkillLabProgress, SkillMetadata } from "@shared-types";

type SkillLabMode = "create" | "optimize";
type SkillLabStatus = "idle" | "clarifying" | "running" | "completed" | "failed" | "cancelled";
type SkillLabClarification = Extract<SkillLabEvent, { type: "skill-lab.clarification" }> & {
  answers: Record<string, string>;
  custom: Record<string, boolean>;
};
type SkillLabModelOption = { value: string; label: string };

type UseSkillLabOptions = {
  userSkills: SkillMetadata[];
  modelOptions: SkillLabModelOption[];
  refreshSkills: () => Promise<void>;
  refreshUserSkills: () => Promise<void>;
  onEvent: (event: SkillLabEvent) => void;
  onStartNotification: (jobId: string, title: string, totalIterations: number) => void;
};

export function useSkillLab({
  userSkills,
  modelOptions,
  refreshSkills,
  refreshUserSkills,
  onEvent,
  onStartNotification
}: UseSkillLabOptions) {
  const [skillLabMode, setSkillLabMode] = useState<SkillLabMode>("create");
  const [skillLabTargetSkillId, setSkillLabTargetSkillId] = useState("");
  const [skillLabModelSelection, setSkillLabModelSelection] = useState("");
  const [skillLabLastRunMode, setSkillLabLastRunMode] = useState<SkillLabMode>("create");
  const [skillLabPrompt, setSkillLabPrompt] = useState("");
  const [skillLabName, setSkillLabName] = useState("");
  const [skillLabIterations, setSkillLabIterations] = useState(5);
  const [skillLabTotalIterations, setSkillLabTotalIterations] = useState(5);
  const [skillLabJobId, setSkillLabJobId] = useState<string | null>(null);
  const [skillLabProgress, setSkillLabProgress] = useState<SkillLabProgress[]>([]);
  const [skillLabStatus, setSkillLabStatus] = useState<SkillLabStatus>("idle");
  const [skillLabError, setSkillLabError] = useState<string | null>(null);
  const [skillLabResult, setSkillLabResult] = useState<SkillMetadata | null>(null);
  const [skillLabApproval, setSkillLabApproval] = useState<Extract<SkillLabEvent, { type: "skill-lab.approval" }> | null>(null);
  const [skillLabClarification, setSkillLabClarification] = useState<SkillLabClarification | null>(null);
  const [skillLabActivityLog, setSkillLabActivityLog] = useState<Array<{ id: string; phase: string; summary: string; state: "running" | "tested" }>>([]);
  const [skillLabStartedAt, setSkillLabStartedAt] = useState<number | null>(null);
  const [skillLabElapsedSeconds, setSkillLabElapsedSeconds] = useState(0);
  const skillLabJobIdRef = useRef<string | null>(null);
  const skillLabOptimizationTargetRef = useRef<string | null>(null);
  const notificationTitleRef = useRef("技能实验室");
  const onEventRef = useRef(onEvent);
  const refreshSkillsRef = useRef(refreshSkills);
  const refreshUserSkillsRef = useRef(refreshUserSkills);

  onEventRef.current = onEvent;
  refreshSkillsRef.current = refreshSkills;
  refreshUserSkillsRef.current = refreshUserSkills;

  const isSkillLabBusy = skillLabStatus === "clarifying" || skillLabStatus === "running";

  useEffect(() => window.codexh.onSkillLabEvent((event) => {
    const typed = event as SkillLabEvent;
    onEventRef.current(typed);
    if (skillLabJobIdRef.current && typed.jobId !== skillLabJobIdRef.current) return;

    if (typed.type === "skill-lab.clarification") {
      setSkillLabStatus("clarifying");
      setSkillLabClarification({
        ...typed,
        answers: Object.fromEntries(typed.questions.map((question) => [question.id, ""])),
        custom: Object.fromEntries(typed.questions.map((question) => [question.id, false]))
      });
      return;
    }

    if (typed.type === "skill-lab.progress") {
      setSkillLabStatus("running");
      setSkillLabClarification(null);
      setSkillLabActivityLog((current) => [...current.slice(-7), {
        id: `${typed.iteration}-${typed.state}-${Date.now()}`,
        phase: typed.phase,
        summary: typed.summary,
        state: typed.state
      }]);
      setSkillLabTotalIterations(typed.totalIterations);
      setSkillLabProgress((current) => {
        const next = current.filter((item) => item.iteration !== typed.iteration);
        next.push({ iteration: typed.iteration, totalIterations: typed.totalIterations, phase: typed.phase, summary: typed.summary, state: typed.state });
        return next.sort((left, right) => left.iteration - right.iteration);
      });
      return;
    }

    if (typed.type === "skill-lab.approval") {
      setSkillLabApproval(typed);
      return;
    }

    if (typed.type === "skill-lab.completed") {
      setSkillLabStatus("completed");
      setSkillLabResult(typed.skill);
      if (skillLabOptimizationTargetRef.current) setSkillLabTargetSkillId(typed.skill.id);
      skillLabOptimizationTargetRef.current = null;
      setSkillLabJobId(null);
      skillLabJobIdRef.current = null;
      setSkillLabApproval(null);
      setSkillLabClarification(null);
      setSkillLabStartedAt(null);
      void Promise.all([refreshSkillsRef.current(), refreshUserSkillsRef.current()]);
      return;
    }

    setSkillLabStatus(typed.type === "skill-lab.failed" ? "failed" : "cancelled");
    if (typed.type === "skill-lab.failed") setSkillLabError(typed.error);
    setSkillLabJobId(null);
    skillLabJobIdRef.current = null;
    setSkillLabApproval(null);
    setSkillLabClarification(null);
    setSkillLabStartedAt(null);
    skillLabOptimizationTargetRef.current = null;
  }), []);

  useEffect(() => {
    if (!skillLabStartedAt || !isSkillLabBusy) return;
    const updateElapsed = () => setSkillLabElapsedSeconds(Math.max(0, Math.floor((Date.now() - skillLabStartedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [isSkillLabBusy, skillLabStartedAt]);

  async function startSkillLab() {
    const prompt = skillLabPrompt.trim();
    const selectedModel = modelOptions.find((option) => option.value === skillLabModelSelection);
    if (skillLabJobId || !selectedModel || (skillLabMode === "create" && !prompt) || (skillLabMode === "optimize" && !skillLabTargetSkillId)) return;

    const [providerId, modelId] = skillLabModelSelection.split("::", 2);
    const targetSkill = userSkills.find((skill) => skill.id === skillLabTargetSkillId);
    const notificationTitle = skillLabMode === "optimize"
      ? `技能实验室 · ${targetSkill?.displayName ?? targetSkill?.name ?? "持续优化"}`
      : `技能实验室 · ${skillLabName.trim() || prompt.slice(0, 24)}`;
    notificationTitleRef.current = notificationTitle;
    setSkillLabLastRunMode(skillLabMode);
    setSkillLabStatus("clarifying");
    setSkillLabError(null);
    setSkillLabResult(null);
    setSkillLabProgress([]);
    setSkillLabTotalIterations(skillLabIterations);
    setSkillLabApproval(null);
    setSkillLabClarification(null);
    setSkillLabActivityLog([]);
    setSkillLabStartedAt(Date.now());
    setSkillLabElapsedSeconds(0);

    try {
      skillLabOptimizationTargetRef.current = skillLabMode === "optimize" ? skillLabTargetSkillId : null;
      const jobId = await window.codexh.startSkillLab({
        prompt,
        requestedName: skillLabMode === "create" ? skillLabName.trim() || undefined : undefined,
        iterations: skillLabIterations,
        targetSkillId: skillLabMode === "optimize" ? skillLabTargetSkillId : undefined,
        providerId,
        modelId
      });
      skillLabJobIdRef.current = jobId;
      setSkillLabJobId(jobId);
      onStartNotification(jobId, notificationTitle, skillLabIterations);
    } catch (error) {
      skillLabOptimizationTargetRef.current = null;
      setSkillLabStatus("failed");
      setSkillLabError(error instanceof Error ? error.message : String(error));
      setSkillLabStartedAt(null);
    }
  }

  async function cancelSkillLab() {
    if (!skillLabJobId) return;
    await window.codexh.cancelSkillLab(skillLabJobId);
  }

  async function resolveSkillLabApproval(approved: boolean) {
    if (!skillLabApproval) return;
    const approval = skillLabApproval;
    setSkillLabApproval(null);
    await window.codexh.resolveSkillLabApproval({ jobId: approval.jobId, approvalId: approval.approvalId, approved });
  }

  async function submitSkillLabClarification() {
    if (!skillLabClarification) return;
    const clarification = skillLabClarification;
    const missingRequired = clarification.questions.some((question) => question.required && !clarification.answers[question.id]?.trim());
    if (missingRequired) return;
    setSkillLabClarification(null);
    setSkillLabStatus("running");
    await window.codexh.resolveSkillLabClarification({ jobId: clarification.jobId, clarificationId: clarification.clarificationId, answers: clarification.answers });
  }

  return {
    skillLabMode,
    setSkillLabMode,
    skillLabTargetSkillId,
    setSkillLabTargetSkillId,
    skillLabModelSelection,
    setSkillLabModelSelection,
    skillLabLastRunMode,
    skillLabPrompt,
    setSkillLabPrompt,
    skillLabName,
    setSkillLabName,
    skillLabIterations,
    setSkillLabIterations,
    skillLabTotalIterations,
    skillLabProgress,
    skillLabStatus,
    skillLabError,
    skillLabResult,
    skillLabApproval,
    skillLabClarification,
    setSkillLabClarification,
    skillLabActivityLog,
    skillLabElapsedSeconds,
    isSkillLabBusy,
    startSkillLab,
    cancelSkillLab,
    resolveSkillLabApproval,
    submitSkillLabClarification
  };
}
