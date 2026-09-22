import type { ReactNode } from "react";
import type {
  AssistantDraftPhase,
  GpaState,
  KnowledgeImportSource,
  McpServerConfig,
  OpenAiApiFormat,
  PluginRecord,
  SkillMetadata,
  ThreadRecord,
  ToolCallRecord
} from "@shared-types";

export type SettingsTab =
  | "general"
  | "appearance"
  | "usage"
  | "knowledge"
  | "memory"
  | "apiFavorites"
  | "provider"
  | "multimodal"
  | "capabilities"
  | "mcp"
  | "database"
  | "cloudNotes"
  | "update";

export type CapabilityTab = "skills" | "userSkills" | "plugins" | "lab";

export type ManagedRemoval =
  | { kind: "plugin"; plugin: PluginRecord }
  | { kind: "skill"; skill: SkillMetadata };

export type UserSkillGenerationDialog = {
  thread: ThreadRecord;
  name: string;
};

export type WelcomeCard = {
  id: string;
  title: string;
  prompt: string;
  accentClass: string;
  icon: ReactNode;
};

export type AppNoticeTone = "success" | "warning";

export type AppNotice = {
  id: number;
  title: string;
  message?: string;
  tone: AppNoticeTone;
};

export type GpaPlanResumePreview = {
  status: "awaiting_confirmation" | "in_progress" | "completed" | "abandoned";
  sourceThreadId: string;
  currentThreadId: string;
  sameSession: boolean;
  updatedAt: string;
  tasks: Array<{ id: string; title: string; done: boolean }>;
  body: string;
  doneCount: number;
  pendingCount: number;
  pendingTasks: Array<{ id: string; title: string; done: boolean }>;
};

export type GpaPlanResumeDialogState = {
  step: "ask" | "review";
  plan: GpaPlanResumePreview;
  threadId: string;
};

export type GpaPlanResumeRetryPrompt = {
  plan: GpaPlanResumePreview;
  threadId: string;
};

export type ModelTestResult = {
  latencyMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  agentCapability: "verified" | "unsupported";
  agentCapabilityReason?: string;
  verifiedApiFormats?: OpenAiApiFormat[];
  preferredApiFormat?: OpenAiApiFormat;
  apiFormatCheckedAt?: string;
};

export type RuntimeProgress = {
  threadId: string;
  phase: "preparing" | "thinking" | "generating" | "tool";
  /**
   * Finer-grained state of the streaming draft. `phase` above only selects the
   * coarse indicator, so the runtime's four real work states
   * (generating / validating / auditing / retrying) had no slot and were
   * flattened to `generating` for the whole turn.
   */
  draftPhase?: AssistantDraftPhase;
  runtimeObserved: boolean;
};

export type ComposerSubmission = {
  content: string;
  startedAt: string;
};

export type RuntimeActivityEntry =
  | { id: string; kind: "status"; label: string; createdAt: string }
  | { id: string; kind: "output"; label: string; content: string; createdAt: string }
  | {
      id: string;
      kind: "tool";
      toolCall: ToolCallRecord;
      /**
       * Variant-specific fact derived from the item frames, such as a command's
       * exit code and duration or a patch's changed-file count. Absent for any
       * tool whose events produced no item frame, which is the legacy path.
       */
      itemDetail?: string | null;
    };

export type RuntimeActivity = {
  threadId: string;
  startedAt: string;
  entries: RuntimeActivityEntry[];
};

export type McpRuntimeServer = McpServerConfig & {
  status: { state: "idle" | "connecting" | "connected" | "error" | "disabled"; error?: string };
  authStatus?: "not_configured" | "signed_out" | "signed_in";
};

export type HistorySearchResult = {
  thread: ThreadRecord;
  snippet: string | null;
  score: number;
};

export type KnowledgeSourceAttachment = KnowledgeImportSource;

export function isGeneratedUserSkill(skill: Pick<SkillMetadata, "pluginId" | "scope" | "skillPath">): boolean {
  return !skill.pluginId && skill.scope === "user" && /[\\/]skills[\\/]drafts[\\/]/i.test(skill.skillPath);
}
