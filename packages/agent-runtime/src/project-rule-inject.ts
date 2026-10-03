import {
  MAX_PROJECT_RULE_INDEX_CHARACTERS,
  MAX_PROJECT_RULE_INDEX_ENTRIES,
  PROJECT_RULE_RELATIVE_PATH,
  buildProjectRuleIndexLine,
  sortProjectRuleEntries,
  truncateProjectRuleText,
  type ProjectRuleDocument
} from "./project-rule-file";
import { ensureProjectRuleFile } from "./project-rule-bootstrap";
import { PROJECT_RULE_PRECEDENCE_STATEMENT } from "./project-rule-precedence";
import {
  collectProjectRuleProbeModifiedAt,
  projectRuleNeedsRefresh,
  refreshProjectRuleFile
} from "./project-rule-update";

/**
 * Session-level injection of `.codexh/rule.md`.
 *
 * Every project turn carries a bounded index of the project rules so the model
 * can respect existing conventions before its first write. The full entries stay
 * on disk and are read on demand, which keeps the常驻 prompt small.
 */
export const PROJECT_RULE_INJECTION_HEADING = "## Project Rules";

export const PROJECT_RULE_INJECTION_PATH_LABEL = PROJECT_RULE_RELATIVE_PATH.split("\\").join("/");

const PROJECT_RULE_INJECTION_PREAMBLE: readonly string[] = [
  `本项目的约定集中维护在 \`${PROJECT_RULE_INJECTION_PATH_LABEL}\`，改动文件前先核对相关条目。`,
  PROJECT_RULE_PRECEDENCE_STATEMENT,
  "标记为 stale 的条目表示可能已过期：命中时先按当前仓库事实判断，不要直接照搬。",
  "下列条目是常驻索引；需要完整条目（适用范围、例外与细节）时用 fs.read_file 读取该规则文件。"
];

/**
 * Builds the injected rule block for one turn.
 *
 * Returns `null` when there is nothing to inject, so callers can append the
 * block only when it exists and never emit an empty section.
 */
export function buildProjectRuleInjection(doc: ProjectRuleDocument | null): string | null {
  if (!doc || doc.entries.length === 0) return null;
  const sorted = sortProjectRuleEntries(doc.entries);
  const shown = sorted.slice(0, MAX_PROJECT_RULE_INDEX_ENTRIES);
  const omitted = sorted.length - shown.length;
  const index = [
    ...shown.map(buildProjectRuleIndexLine),
    ...(omitted > 0 ? [`- （另有 ${omitted} 条条目未展开，完整内容见规则文件）`] : [])
  ].join("\n");
  const body = truncateProjectRuleText(index, MAX_PROJECT_RULE_INDEX_CHARACTERS);
  return [
    PROJECT_RULE_INJECTION_HEADING,
    "",
    ...PROJECT_RULE_INJECTION_PREAMBLE,
    "",
    body
  ].join("\n");
}

/**
 * Reads (generating on first use) the rule document for a project.
 *
 * A stored document that is older than the project manifests is re-scanned and
 * merged first, so the injected index keeps following the project without a
 * manual update step.
 *
 * Returns `null` instead of throwing, so an unreadable project degrades to "no
 * rules injected" and never blocks the conversation.
 */
export async function resolveProjectRuleState(
  cwd: string
): Promise<{ document: ProjectRuleDocument; created: boolean } | null> {
  if (!cwd) return null;
  try {
    const bootstrapped = await ensureProjectRuleFile(cwd);
    if (bootstrapped.created) {
      return { document: bootstrapped.document, created: true };
    }
    const probeModifiedAt = await collectProjectRuleProbeModifiedAt(cwd);
    if (!projectRuleNeedsRefresh(bootstrapped.document, probeModifiedAt)) {
      return { document: bootstrapped.document, created: false };
    }
    const refreshed = await refreshProjectRuleFile(cwd);
    return { document: refreshed.document, created: false };
  } catch {
    return null;
  }
}

/**
 * Reads (generating on first use) the rule file for a project and returns the
 * block to inject. Failures degrade to no injection instead of failing the turn.
 */
export async function resolveProjectRuleInjection(cwd: string): Promise<string | null> {
  const state = await resolveProjectRuleState(cwd);
  return buildProjectRuleInjection(state?.document ?? null);
}

/** Appends the injected block to an existing project policy prompt. */
export function appendProjectRuleInjection<T extends { systemPrompt: string }>(
  policy: T,
  injection: string | null
): T {
  if (!injection) return policy;
  const systemPrompt = `${policy.systemPrompt.trimEnd()}\n\n${injection}`;
  return { ...policy, systemPrompt };
}
