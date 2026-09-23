import path from "node:path";
import {
  MAX_PROJECT_RULE_ENTRY_CHARACTERS,
  nextProjectRuleId,
  projectRuleEntryText,
  readProjectRuleFile,
  sortProjectRuleEntries,
  truncateProjectRuleText,
  writeProjectRuleFile,
  type ProjectRuleDocument,
  type ProjectRuleEntry
} from "./project-rule-file";
import { buildProjectRuleEntrySkeleton } from "./project-rule-template";
import { GPA_PLAN_RELATIVE_PATH } from "./gpa-plan-file";
import {
  PROJECT_METADATA_DIRECTORY,
  PROJECT_RULE_WRITABLE_RELATIVE_PATH,
  checkProjectRuleUpdateTarget
} from "./project-rule-precedence";

/**
 * Pre-write rule check (`T5` expansion + `T6` conflict guard).
 *
 * The resident index injected on every turn answers "which conventions exist".
 * This module answers the narrower question asked right before a write: which
 * entries actually cover the files about to change, and does any of them forbid
 * the change? A conflicting call is never written silently: it is blocked with
 * an explanation and registered as a pending rule update.
 */
export const PROJECT_RULE_EXPANSION_HEADING = "## Project Rules（命中条目）";

export const PROJECT_RULE_PENDING_ENTRY_TITLE = "待确认的越界改动";

export const MAX_PROJECT_RULE_EXPANSION_ENTRIES = 20;
export const MAX_PROJECT_RULE_EXPANSION_CHARACTERS = 12_000;

const PROJECT_RULE_WRITE_TOOL_NAME_SET = new Set<string>([
  "apply_patch",
  "fs.write_file",
  "search_replace"
]);

/**
 * Entry id used for conflicts that come from the precedence rule itself rather
 * than from a stored entry: `.codexh` metadata has one writer per file, so the
 * rule mechanism must never rewrite the plan file or the memory notes.
 */
export const PROJECT_METADATA_GUARD_ENTRY_ID = "R-PRECEDENCE-METADATA";

/** Builds the always-on conflicts for writes into another writer's metadata file. */
export function collectProjectMetadataConflicts(
  targets: readonly string[]
): ProjectRuleWriteConflict[] {
  return targets
    .filter((target) => checkProjectRuleUpdateTarget(target) === "protected-project-metadata")
    .map((target) => ({
      entryId: PROJECT_METADATA_GUARD_ENTRY_ID,
      target,
      severity: "block" as const,
      detail:
        `\`${PROJECT_METADATA_DIRECTORY}\` 下的元数据文件各有唯一写入方，规则机制只写 `
        + `\`${PROJECT_RULE_WRITABLE_RELATIVE_PATH}\`；其中 `
        + `\`${GPA_PLAN_RELATIVE_PATH.split("\\").join("/")}\` 的 completed_task_ids 不可被规则更新改写`
    }));
}

/** Tool names whose arguments carry a repository path that is about to change. */
export const PROJECT_RULE_WRITE_TOOL_NAMES: readonly string[] = [...PROJECT_RULE_WRITE_TOOL_NAME_SET];

/** Hard boundary wording: the change must not happen without a new user decision. */
const HARD_BOUNDARY_PATTERN = /(禁止|严禁|不得|不要|不许|不可|forbid|must not|never (?:edit|modify|change))/i;

export function isProjectRuleWriteTool(toolName: string): boolean {
  return PROJECT_RULE_WRITE_TOOL_NAME_SET.has(toolName);
}

export function normalizeProjectRulePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Glob-ish scope match. Supports the scopes the rule file actually uses:
 * `**\/*` (repository-wide), `dir/**`, `dir/*` and single-segment `*` wildcards.
 */
export function isProjectRuleScopeMatch(scope: string, targetPath: string): boolean {
  const normalizedScope = normalizeProjectRulePath(scope);
  const target = normalizeProjectRulePath(targetPath);
  if (!normalizedScope || !target) return false;
  if (normalizedScope === "**/*" || normalizedScope === "**" || normalizedScope === "*") return true;
  if (normalizedScope.endsWith("/**")) {
    const prefix = normalizedScope.slice(0, -3);
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  if (normalizedScope.endsWith("/*")) {
    const prefix = normalizedScope.slice(0, -2);
    return target === prefix || (
      target.startsWith(`${prefix}/`) && !target.slice(prefix.length + 1).includes("/")
    );
  }
  if (normalizedScope.includes("*")) {
    const pattern = escapeRegExp(normalizedScope)
      .replace(/\\\*\\\*/g, ".*")
      .replace(/\\\*/g, "[^/]*");
    return new RegExp(`^${pattern}$`).test(target);
  }
  return target === normalizedScope || target.startsWith(`${normalizedScope}/`);
}

/** Converts an absolute or relative write target into a repo-relative path. */
export function toProjectRelativePath(cwd: string, target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;
  if (!path.isAbsolute(trimmed)) {
    return normalizeProjectRulePath(trimmed) || null;
  }
  if (!cwd) return null;
  const relative = path.relative(cwd, trimmed);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return normalizeProjectRulePath(relative) || null;
}

/**
 * Extracts the paths a write tool call is about to change.
 *
 * Returns `null` for every non-write tool, so unrelated calls pay no cost.
 */
export function resolveProjectRuleWriteTargets(
  toolName: string,
  argumentsJson: Record<string, unknown>
): string[] | null {
  if (!isProjectRuleWriteTool(toolName)) return null;
  if (toolName === "apply_patch") {
    const patch = [argumentsJson.patch, argumentsJson.patch_content, argumentsJson.patchText]
      .find((value): value is string => typeof value === "string") ?? "";
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map((match) => match[1].trim())
      .filter(Boolean);
  }
  const candidate = toolName === "search_replace" ? argumentsJson.file_path : argumentsJson.path;
  return typeof candidate === "string" && candidate.trim() ? [candidate.trim()] : [];
}

export interface ProjectRuleTargetSelection {
  entries: ProjectRuleEntry[];
  matchedEntryIds: string[];
  /** Entry ids dropped because the expansion budget was reached; boundary entries never appear here. */
  omittedIds: string[];
}

/**
 * Selects the entries covering the given targets, ordered by category priority so
 * `改动边界与禁改区` entries survive any truncation.
 */
export function selectProjectRuleEntriesForTargets(
  doc: ProjectRuleDocument | null,
  targets: readonly string[]
): ProjectRuleTargetSelection {
  const unique = [...new Set(targets.map(normalizeProjectRulePath).filter(Boolean))];
  if (!doc || doc.entries.length === 0 || unique.length === 0) {
    return { entries: [], matchedEntryIds: [], omittedIds: [] };
  }
  const matched = doc.entries.filter((entry) =>
    unique.some((target) => isProjectRuleScopeMatch(entry.scope, target))
  );
  if (matched.length === 0) return { entries: [], matchedEntryIds: [], omittedIds: [] };

  const sorted = sortProjectRuleEntries(matched);
  const kept: ProjectRuleEntry[] = sorted.slice(0, MAX_PROJECT_RULE_EXPANSION_ENTRIES);
  const omitted = sorted.slice(MAX_PROJECT_RULE_EXPANSION_ENTRIES);
  // Boundary rules are the ones a write must never silently override.
  for (const entry of omitted.filter((candidate) => candidate.category === "boundary")) {
    if (!kept.some((candidate) => candidate.id === entry.id)) kept.push(entry);
  }
  const keptIds = new Set(kept.map((entry) => entry.id));
  return {
    entries: kept,
    matchedEntryIds: sorted.map((entry) => entry.id),
    omittedIds: sorted.filter((entry) => !keptIds.has(entry.id)).map((entry) => entry.id)
  };
}

/**
 * Expands the matched entries for a write-intent turn. Returns `null` when no
 * entry covers the targets, so callers never inject an empty section.
 */
export function buildProjectRuleTargetExpansion(
  doc: ProjectRuleDocument | null,
  targets: readonly string[]
): string | null {
  const targets_ = [...new Set(targets.map(normalizeProjectRulePath).filter(Boolean))];
  const selection = selectProjectRuleEntriesForTargets(doc, targets_);
  if (selection.entries.length === 0) return null;
  const body = selection.entries
    .map((entry) => truncateProjectRuleText(projectRuleEntryText(entry), MAX_PROJECT_RULE_ENTRY_CHARACTERS))
    .join("\n\n");
  const bounded = truncateProjectRuleText(body, MAX_PROJECT_RULE_EXPANSION_CHARACTERS);
  return [
    PROJECT_RULE_EXPANSION_HEADING,
    "",
    `本次改动目标：${targets_.join("、")}`,
    "以下条目与本次改动直接相关，改动前必须逐条核对；与规则冲突时先向用户确认，不要静默落盘。",
    ...(selection.omittedIds.length > 0
      ? [`（另有 ${selection.omittedIds.length} 条命中条目未展开：${selection.omittedIds.join("、")}）`]
      : []),
    "",
    bounded
  ].join("\n");
}

export interface ProjectRuleWriteConflict {
  entryId: string;
  target: string;
  /** `block` = the rule forbids the change; `confirm` = the rule requires confirmation first. */
  severity: "block" | "confirm";
  detail: string;
}

export interface ProjectRuleWriteCheckInput {
  document: ProjectRuleDocument | null;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Workspace root used to relativize absolute arguments; optional. */
  cwd?: string;
}

export interface ProjectRuleWriteCheckResult {
  /** `null` when the call is not a write, or when nothing matched. */
  injection: string | null;
  matchedEntryIds: string[];
  conflicts: ProjectRuleWriteConflict[];
  requiresConfirmation: boolean;
  message: string | null;
}

/** A boundary entry whose wording forbids the change outright cannot be auto-confirmed. */
export function isHardProjectRuleBoundary(entry: ProjectRuleEntry): boolean {
  return entry.category === "boundary" && (
    HARD_BOUNDARY_PATTERN.test(entry.rules.join("\n")) || HARD_BOUNDARY_PATTERN.test(entry.title)
  );
}

/**
 * Whether the entry text itself names a path.
 *
 * Boundary entries are usually repository-wide (`**\/*`) and list the protected
 * directories in their rules, so a plain scope match would flag every write in
 * the project. Requiring the entry to name the target keeps the guard precise.
 */
export function projectRuleMentionsTarget(entry: ProjectRuleEntry, targetPath: string): boolean {
  const target = normalizeProjectRulePath(targetPath);
  if (!target) return false;
  const text = [entry.title, entry.scope, ...entry.rules].join("\n");
  if (text.includes(target)) return true;
  return target
    .split("/")
    .filter((segment) => segment.length > 2)
    .some((segment) => text.includes(segment));
}

export function buildProjectRuleWriteConflictMessage(
  conflicts: readonly ProjectRuleWriteConflict[],
  targets: readonly string[]
): string | null {
  if (conflicts.length === 0) return null;
  const targetLabel = [...new Set(targets.map(normalizeProjectRulePath).filter(Boolean))].join("、");
  return [
    `项目规则核对未通过：本次改动目标（${targetLabel}）命中以下禁改/边界条目。`,
    ...conflicts.map((conflict) => `- \`${conflict.entryId}\`（${conflict.severity}）← \`${conflict.target}\`：${conflict.detail}`),
    "不要静默写入。先把冲突告知用户并取得确认，冲突已登记为规则待更新项；用户确认后再执行改动。"
  ].join("\n");
}

/**
 * Pre-write rule check. Non-write calls and unmatched targets return quickly with
 * `injection: null` and `requiresConfirmation: false`.
 */
export function evaluateProjectRuleWriteCheck(
  input: ProjectRuleWriteCheckInput
): ProjectRuleWriteCheckResult {
  const empty: ProjectRuleWriteCheckResult = {
    injection: null,
    matchedEntryIds: [],
    conflicts: [],
    requiresConfirmation: false,
    message: null
  };
  const rawTargets = resolveProjectRuleWriteTargets(input.toolName, input.arguments);
  if (rawTargets === null) return empty;
  const targets = rawTargets
    .map((target) => (input.cwd ? toProjectRelativePath(input.cwd, target) ?? normalizeProjectRulePath(target) : normalizeProjectRulePath(target)))
    .filter(Boolean);
  if (targets.length === 0) return empty;

  const selection = selectProjectRuleEntriesForTargets(input.document, targets);
  const metadataConflicts = collectProjectMetadataConflicts(targets);
  if (selection.entries.length === 0 && metadataConflicts.length === 0) return empty;

  const conflicts: ProjectRuleWriteConflict[] = [...metadataConflicts];
  for (const entry of selection.entries) {
    if (entry.category !== "boundary") continue;
    const target = targets.find((candidate) => isProjectRuleScopeMatch(entry.scope, candidate)) ?? targets[0];
    const namedTarget = targets.find((candidate) => projectRuleMentionsTarget(entry, candidate));
    // A repository-wide boundary entry only conflicts when it names the target.
    if (!namedTarget && normalizeProjectRulePath(entry.scope) === "**/*") continue;
    conflicts.push({
      entryId: entry.id,
      target: namedTarget ?? target,
      severity: isHardProjectRuleBoundary(entry) ? "block" : "confirm",
      detail: entry.stale
        ? `${entry.title}（规则已标记 stale，需按当前仓库事实复核）`
        : entry.title
    });
  }
  return {
    injection: buildProjectRuleTargetExpansion(input.document, targets),
    matchedEntryIds: selection.matchedEntryIds,
    conflicts,
    requiresConfirmation: conflicts.length > 0,
    message: buildProjectRuleWriteConflictMessage(conflicts, targets)
  };
}

/**
 * Registers conflicts as a pending update inside the rule document. Repeated
 * conflicts are de-duplicated by `entryId + target`, so the same turn never
 * rewrites the file twice.
 */
export function registerProjectRuleWriteConflicts(
  doc: ProjectRuleDocument,
  conflicts: readonly ProjectRuleWriteConflict[],
  updatedAt: string
): { document: ProjectRuleDocument; entryId: string | null; added: number } {
  if (conflicts.length === 0) return { document: doc, entryId: null, added: 0 };
  const existing = doc.entries.find(
    (entry) => entry.category === "pitfall" && entry.title === PROJECT_RULE_PENDING_ENTRY_TITLE
  );
  const knownPrefixes = (existing?.rules ?? []).map((rule) => rule.split(" 登记于 ")[0]);
  const fresh: string[] = [];
  for (const conflict of [...conflicts].sort((left, right) => left.entryId.localeCompare(right.entryId))) {
    const prefix =
      `\`${conflict.target}\` 命中 \`${conflict.entryId}\`（${conflict.severity}）：${conflict.detail}`;
    if (knownPrefixes.includes(prefix) || fresh.some((line) => line.startsWith(prefix))) continue;
    fresh.push(`${prefix} 登记于 ${updatedAt}`);
  }
  if (fresh.length === 0) return { document: doc, entryId: existing?.id ?? null, added: 0 };

  if (!existing) {
    const entry = buildProjectRuleEntrySkeleton({
      category: "pitfall",
      id: nextProjectRuleId("pitfall", doc.entries),
      title: PROJECT_RULE_PENDING_ENTRY_TITLE,
      scope: "**/*",
      rules: fresh,
      source: "auto",
      updatedAt
    });
    return {
      document: { ...doc, updatedAt, entries: [...doc.entries, entry] },
      entryId: entry.id,
      added: fresh.length
    };
  }
  const updatedEntry: ProjectRuleEntry = {
    ...existing,
    rules: [...existing.rules, ...fresh],
    stale: false,
    updatedAt
  };
  return {
    document: {
      ...doc,
      updatedAt,
      entries: doc.entries.map((entry) => (entry.id === existing.id ? updatedEntry : entry))
    },
    entryId: existing.id,
    added: fresh.length
  };
}

/**
 * Persists registered conflicts into `.codexh/rule.md`. Returns the pending entry
 * id when the file changed, and `null` when there was nothing new to record.
 * Failures degrade to no registration instead of failing the caller.
 */
export async function recordProjectRuleWriteConflicts(
  cwd: string,
  conflicts: readonly ProjectRuleWriteConflict[]
): Promise<string | null> {
  if (!cwd || conflicts.length === 0) return null;
  try {
    const existing = await readProjectRuleFile(cwd);
    if (!existing) return null;
    const registered = registerProjectRuleWriteConflicts(existing, conflicts, new Date().toISOString());
    if (registered.added === 0) return null;
    await writeProjectRuleFile(cwd, registered.document);
    return registered.entryId;
  } catch {
    return null;
  }
}
