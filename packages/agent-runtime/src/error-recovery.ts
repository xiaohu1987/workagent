import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CompletionEvidenceKind,
  ErrorSolutionRecord,
  RuntimeToolCall
} from "@shared-types";

export const MAX_TARGET_FAILURE_ATTEMPTS = 2;
export const MAX_PREMATURE_COMPLETION_ATTEMPTS = 5;
export const NEGATIVE_MEMORY_HALF_LIFE_DAYS = 30;
export const NEGATIVE_MEMORY_HARD_BLOCK_DAYS = 90;

export interface RecoveryEpisodeStep {
  toolName: string;
  targetKey: string;
  approach: string;
  evidenceKinds: CompletionEvidenceKind[];
  completedAt: string;
}

export interface RecoveryEpisodeFailure {
  toolName: string;
  taskKey: string;
  errorSignature: string;
  errorSummary: string;
  strategyFingerprint: string;
  failedApproach: string;
  observedAt: string;
}

export interface RecoveryEpisode {
  id: string;
  targetKey: string;
  failedToolName: string;
  failedTaskKey: string;
  errorSignature: string;
  errorSummary: string;
  strategyFingerprint: string;
  failedApproach: string;
  failureCount: number;
  failures: RecoveryEpisodeFailure[];
  steps: RecoveryEpisodeStep[];
  openedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
}

export function createRecoveryEpisode(input: {
  targetKey: string;
  toolName: string;
  taskKey: string;
  errorSignature: string;
  errorSummary: string;
  strategyFingerprint: string;
  failedApproach: string;
  now?: string;
}): RecoveryEpisode {
  const now = input.now ?? new Date().toISOString();
  return {
    id: randomUUID(),
    targetKey: input.targetKey,
    failedToolName: input.toolName,
    failedTaskKey: input.taskKey,
    errorSignature: input.errorSignature,
    errorSummary: input.errorSummary.slice(0, 800),
    strategyFingerprint: input.strategyFingerprint,
    failedApproach: input.failedApproach.slice(0, 500),
    failureCount: 1,
    failures: [{
      toolName: input.toolName,
      taskKey: input.taskKey,
      errorSignature: input.errorSignature,
      errorSummary: input.errorSummary.slice(0, 800),
      strategyFingerprint: input.strategyFingerprint,
      failedApproach: input.failedApproach.slice(0, 500),
      observedAt: now
    }],
    steps: [],
    openedAt: now,
    lastObservedAt: now,
    resolvedAt: null
  };
}

export function updateRecoveryEpisodeFailure(
  episode: RecoveryEpisode,
  input: {
    toolName: string;
    taskKey: string;
    errorSignature: string;
    errorSummary: string;
    strategyFingerprint: string;
    failedApproach: string;
    now?: string;
  }
): RecoveryEpisode {
  const now = input.now ?? new Date().toISOString();
  episode.failedToolName = input.toolName;
  episode.failedTaskKey = input.taskKey;
  episode.errorSignature = input.errorSignature;
  episode.errorSummary = input.errorSummary.slice(0, 800);
  episode.strategyFingerprint = input.strategyFingerprint;
  episode.failedApproach = input.failedApproach.slice(0, 500);
  episode.failureCount += 1;
  episode.failures.push({
    toolName: input.toolName,
    taskKey: input.taskKey,
    errorSignature: input.errorSignature,
    errorSummary: input.errorSummary.slice(0, 800),
    strategyFingerprint: input.strategyFingerprint,
    failedApproach: input.failedApproach.slice(0, 500),
    observedAt: now
  });
  episode.lastObservedAt = now;
  return episode;
}

export function appendRecoveryEpisodeStep(
  episode: RecoveryEpisode,
  input: Omit<RecoveryEpisodeStep, "completedAt"> & { completedAt?: string }
): boolean {
  const step: RecoveryEpisodeStep = {
    ...input,
    completedAt: input.completedAt ?? new Date().toISOString()
  };
  episode.steps.push(step);
  episode.lastObservedAt = step.completedAt;
  const resolvesEpisode = input.targetKey === episode.targetKey && (
    input.evidenceKinds.includes("delivery") ||
    (
      input.evidenceKinds.includes("verification") &&
      (episode.failedToolName === "project.verify" || episode.steps.some((candidate) => candidate.evidenceKinds.includes("delivery")))
    )
  );
  if (resolvesEpisode) {
    episode.resolvedAt = step.completedAt;
  }
  return resolvesEpisode;
}

export function getToolCallRecoveryTargetKey(
  name: string,
  argumentsJson: Record<string, unknown>,
  workspaceCwd = ""
): string {
  const patch = [argumentsJson.patch, argumentsJson.patch_content, argumentsJson.patchText].find(
    (value): value is string => typeof value === "string"
  );
  if (patch) {
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map((match) => normalizeTargetPath(match[1].trim(), workspaceCwd))
      .filter(Boolean)
      .sort();
    if (paths.length > 0) return `file:${paths.join("|")}`;
  }

  const filePath = argumentsJson.path ?? argumentsJson.file_path ?? argumentsJson.filePath;
  if (typeof filePath === "string" && filePath.trim()) {
    return `file:${normalizeTargetPath(filePath, workspaceCwd)}`;
  }
  const tabId = argumentsJson.tabId ?? argumentsJson.tab_id;
  if (typeof tabId === "string" && tabId.trim()) return `browser:${tabId.trim()}`;
  const server = argumentsJson.server ?? argumentsJson.serverId;
  const tool = argumentsJson.tool ?? argumentsJson.toolName;
  if (typeof server === "string" && server.trim()) {
    return `mcp:${server.trim()}:${typeof tool === "string" ? tool.trim() : name}`;
  }
  if (name === "project.verify") return `project:${normalizeTargetPath(workspaceCwd || ".", workspaceCwd)}`;
  return `task:${name}:${createHash("sha256").update(stableSerialize(argumentsJson)).digest("hex").slice(0, 24)}`;
}

export function createRecoveryStrategyFingerprint(
  name: string,
  argumentsJson: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(`${name}:${stableSerialize(argumentsJson)}`)
    .digest("hex");
}

export function calculateErrorSolutionConfidence(
  memory: Pick<ErrorSolutionRecord, "memoryKind" | "confidence" | "lastObservedAt">,
  now = new Date()
): number {
  const base = Number.isFinite(memory.confidence) ? Math.max(0, Math.min(1, memory.confidence)) : 1;
  if (memory.memoryKind !== "blocked_strategy") return base;
  const observedAt = Date.parse(memory.lastObservedAt);
  if (!Number.isFinite(observedAt)) return base;
  const ageDays = Math.max(0, now.getTime() - observedAt) / 86_400_000;
  return base * Math.pow(0.5, ageDays / NEGATIVE_MEMORY_HALF_LIFE_DAYS);
}

export function shouldHardBlockRememberedStrategy(
  memory: ErrorSolutionRecord,
  now = new Date()
): boolean {
  if (memory.memoryKind !== "blocked_strategy" || memory.matchKind !== "exact_strategy") return false;
  const observedAt = Date.parse(memory.lastObservedAt);
  if (!Number.isFinite(observedAt)) return false;
  const ageDays = Math.max(0, now.getTime() - observedAt) / 86_400_000;
  return ageDays <= NEGATIVE_MEMORY_HARD_BLOCK_DAYS && calculateErrorSolutionConfidence(memory, now) >= 0.125;
}

export function shouldBlockPreviouslyFailedRecoveredStrategy(memory: ErrorSolutionRecord): boolean {
  return memory.memoryKind === "recovered" && memory.matchKind === "exact_strategy";
}

export function buildRecoverySolutionSummary(
  episode: RecoveryEpisode,
  failure: RecoveryEpisodeFailure = episode.failures[0] ?? {
    toolName: episode.failedToolName,
    taskKey: episode.failedTaskKey,
    errorSignature: episode.errorSignature,
    errorSummary: episode.errorSummary,
    strategyFingerprint: episode.strategyFingerprint,
    failedApproach: episode.failedApproach,
    observedAt: episode.lastObservedAt
  }
): string {
  const steps = episode.steps
    .map((step) => `${step.toolName} using ${step.approach}`)
    .join(" -> ");
  return [
    `Failure: ${failure.toolName} -> ${failure.errorSummary.slice(0, 180)}`,
    `Avoid: ${failure.failedApproach}`,
    `Proven recovery: ${steps || "use a materially different verified approach"}`,
    "Apply the prerequisite inspection before retrying this target."
  ].join(" | ").slice(0, 1_500);
}

export function buildBlockedStrategySummary(
  episode: RecoveryEpisode,
  failure: RecoveryEpisodeFailure = episode.failures.at(-1) ?? {
    toolName: episode.failedToolName,
    taskKey: episode.failedTaskKey,
    errorSignature: episode.errorSignature,
    errorSummary: episode.errorSummary,
    strategyFingerprint: episode.strategyFingerprint,
    failedApproach: episode.failedApproach,
    observedAt: episode.lastObservedAt
  }
): string {
  return [
    `Known ineffective strategy for ${episode.targetKey}.`,
    `Avoid: ${failure.failedApproach}.`,
    `Observed failure: ${failure.errorSummary.slice(0, 240)}.`,
    "Inspect prerequisites or use a materially different tool and arguments."
  ].join(" ").slice(0, 1_500);
}

export function createRecoveryPrerequisiteToolCall(
  toolCall: Pick<RuntimeToolCall, "name" | "arguments">,
  workspaceCwd: string,
  id: string
): RuntimeToolCall | null {
  if (toolCall.name === "fs.write_file") {
    const requestedPath = toolCall.arguments.path ?? toolCall.arguments.filePath;
    if (typeof requestedPath !== "string" || !requestedPath.trim()) return null;
    return { id, name: "fs.read_file", arguments: { path: normalizeTargetPath(requestedPath, workspaceCwd) } };
  }
  if (toolCall.name !== "apply_patch") return null;
  const patch = [toolCall.arguments.patch, toolCall.arguments.patch_content, toolCall.arguments.patchText].find(
    (value): value is string => typeof value === "string"
  );
  if (!patch) return null;
  const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/m.exec(patch);
  if (!match) return null;
  const targetPath = normalizeTargetPath(match[2].trim(), workspaceCwd);
  return match[1] === "Add"
    ? { id, name: "fs.read_directory", arguments: { path: path.dirname(targetPath) } }
    : { id, name: "fs.read_file", arguments: { path: targetPath } };
}

function normalizeTargetPath(candidate: string, workspaceCwd: string): string {
  const normalized = workspaceCwd && !path.isAbsolute(candidate)
    ? path.resolve(workspaceCwd, candidate)
    : path.normalize(candidate);
  const slashes = normalized.replace(/\\/g, "/");
  return process.platform === "win32" ? slashes.toLowerCase() : slashes;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
