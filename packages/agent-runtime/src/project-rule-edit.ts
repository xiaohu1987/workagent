import {
  MAX_PROJECT_RULE_ENTRIES,
  MAX_PROJECT_RULE_ENTRY_CHARACTERS,
  getProjectRuleCategory,
  nextProjectRuleId,
  readProjectRuleFile,
  sortProjectRuleEntries,
  writeProjectRuleFile,
  type ProjectRuleCategoryId,
  type ProjectRuleDocument,
  type ProjectRuleEntry
} from "./project-rule-file";
import { buildProjectRuleEntrySkeleton } from "./project-rule-template";

/**
 * Natural-language rule editing.
 *
 * A user can ask for a rule in plain language ("把 XX 写进规则"). The runtime
 * turns that request into a structured edit, applies it to `.codexh/rule.md`,
 * and the next turn injects the new content. Entries created or rewritten this
 * way are marked `source: "user"` so the automatic updater never overwrites
 * them.
 */
export const PROJECT_RULE_EDIT_ACTION_KINDS = ["add", "update", "remove"] as const;

export type ProjectRuleEditActionKind = (typeof PROJECT_RULE_EDIT_ACTION_KINDS)[number];

export interface ProjectRuleEditAction {
  kind: ProjectRuleEditActionKind;
  /** Target entry id for `update` / `remove`; ignored for `add`. */
  entryId?: string;
  category?: ProjectRuleCategoryId;
  title?: string;
  scope?: string;
  rules?: string[];
}

export interface ProjectRuleEditResult {
  document: ProjectRuleDocument;
  /** Entry ids that were created, rewritten, or removed. */
  changed: string[];
  /** Human-readable summary of what happened, safe to show to the user. */
  summary: string;
  /** `true` when the edit could not be applied and the file was left alone. */
  rejected: boolean;
}

function normalizeRules(rules: readonly string[] | undefined): string[] {
  return (rules ?? [])
    .map((rule) => rule.trim())
    .filter(Boolean)
    .map((rule) =>
      rule.length > MAX_PROJECT_RULE_ENTRY_CHARACTERS
        ? rule.slice(0, MAX_PROJECT_RULE_ENTRY_CHARACTERS)
        : rule
    );
}

function findEntryIndex(entries: readonly ProjectRuleEntry[], entryId: string): number {
  const target = entryId.trim().toUpperCase();
  return entries.findIndex((entry) => entry.id.toUpperCase() === target);
}

/**
 * Applies one structured edit to a document. Pure and synchronous so the edit
 * rules can be verified without touching the file system.
 */
export function applyProjectRuleEdit(
  existing: ProjectRuleDocument,
  action: ProjectRuleEditAction,
  updatedAt: string
): ProjectRuleEditResult {
  const entries = sortProjectRuleEntries(existing.entries);

  if (action.kind === "add") {
    const category = action.category ?? "style";
    const rules = normalizeRules(action.rules);
    if (rules.length === 0) {
      return {
        document: existing,
        changed: [],
        summary: "没有可写入的规则内容，规则文件未改动。",
        rejected: true
      };
    }
    if (entries.length >= MAX_PROJECT_RULE_ENTRIES) {
      return {
        document: existing,
        changed: [],
        summary: `条目总数已达上限 ${MAX_PROJECT_RULE_ENTRIES} 条，请先合并或删除旧条目。`,
        rejected: true
      };
    }
    const entry = buildProjectRuleEntrySkeleton({
      category,
      id: nextProjectRuleId(category, entries),
      title: action.title?.trim() || getProjectRuleCategory(category)?.label || "用户规则",
      scope: action.scope?.trim() || "**/*",
      rules,
      source: "user",
      updatedAt
    });
    return {
      document: { version: existing.version, updatedAt, entries: [...entries, entry] },
      changed: [entry.id],
      summary: `已新增规则条目 \`${entry.id}\`（${entry.title}）。`,
      rejected: false
    };
  }

  const entryId = action.entryId?.trim();
  if (!entryId) {
    return {
      document: existing,
      changed: [],
      summary: "未指明要修改的规则条目，请先确认目标条目 ID。",
      rejected: true
    };
  }
  const index = findEntryIndex(entries, entryId);
  if (index < 0) {
    return {
      document: existing,
      changed: [],
      summary: `未找到规则条目 \`${entryId}\`，请确认条目 ID 后再试。`,
      rejected: true
    };
  }

  const current = entries[index]!;
  if (action.kind === "remove") {
    const next = entries.filter((_, position) => position !== index);
    return {
      document: { version: existing.version, updatedAt, entries: next },
      changed: [current.id],
      summary: `已删除规则条目 \`${current.id}\`。`,
      rejected: false
    };
  }

  const rules = normalizeRules(action.rules);
  if (rules.length === 0) {
    return {
      document: existing,
      changed: [],
      summary: "没有可写入的规则内容，规则文件未改动。",
      rejected: true
    };
  }
  const category = action.category ?? current.category;
  const updated: ProjectRuleEntry = {
    ...current,
    category,
    title: action.title?.trim() || current.title,
    scope: action.scope?.trim() || current.scope,
    rules,
    source: "user",
    stale: false,
    updatedAt
  };
  const next = [...entries];
  next[index] = updated;
  return {
    document: { version: existing.version, updatedAt, entries: next },
    changed: [updated.id],
    summary: `已更新规则条目 \`${updated.id}\`（${updated.title}）。`,
    rejected: false
  };
}

/**
 * Applies one edit to `.codexh/rule.md` and persists it immediately.
 *
 * A rejected edit never touches the file, so an ambiguous request cannot
 * silently corrupt the rules.
 */
export async function editProjectRuleFile(
  cwd: string,
  action: ProjectRuleEditAction
): Promise<ProjectRuleEditResult & { filePath: string | null; written: boolean }> {
  const existing = await readProjectRuleFile(cwd);
  if (!existing) {
    return {
      document: { version: 1, updatedAt: new Date().toISOString(), entries: [] },
      changed: [],
      summary: "规则文件不存在，请先生成规则后再修改。",
      rejected: true,
      filePath: null,
      written: false
    };
  }
  const result = applyProjectRuleEdit(existing, action, new Date().toISOString());
  if (result.rejected) {
    return { ...result, filePath: null, written: false };
  }
  const filePath = await writeProjectRuleFile(cwd, result.document);
  return { ...result, filePath, written: true };
}
