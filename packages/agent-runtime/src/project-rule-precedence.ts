import { PROJECT_RULE_RELATIVE_PATH } from "./project-rule-file";

/**
 * T10: precedence between the instruction sources that can compete on one turn.
 *
 * A project turn is shaped by four sources, and they do not have equal weight:
 *
 * 1. the user's explicit instruction for the current turn,
 * 2. the project rules in `.codexh/rule.md`,
 * 3. the project memory notes,
 * 4. the default behavior of the agent and the tooling.
 *
 * When the user's instruction contradicts a rule, the instruction wins for that
 * turn, but the conflict is not silent: it is registered as a pending rule
 * update so the rule file can be corrected afterwards.
 */
export type ProjectRulePrecedenceLevelId =
  | "user-instruction"
  | "project-rule"
  | "project-memory"
  | "default-behavior";

export interface ProjectRulePrecedenceLevel {
  id: ProjectRulePrecedenceLevelId;
  /** Lower rank wins. Ranks are explicit so tests can assert the order. */
  rank: number;
  label: string;
  statement: string;
}

export const PROJECT_RULE_PRECEDENCE: readonly ProjectRulePrecedenceLevel[] = [
  {
    id: "user-instruction",
    rank: 10,
    label: "当轮用户指令",
    statement: "以用户指令为准：当轮用户指令优先于任何规则条目；命中冲突时按指令执行并在回复中说明冲突。"
  },
  {
    id: "project-rule",
    rank: 20,
    label: "项目规则",
    statement: "项目规则优先于项目记忆与默认行为；改文件前先核对命中条目。"
  },
  {
    id: "project-memory",
    rank: 30,
    label: "项目记忆",
    statement: "项目记忆仅在与规则不冲突时生效，冲突时以规则为准。"
  },
  {
    id: "default-behavior",
    rank: 40,
    label: "默认行为",
    statement: "以上来源都未覆盖时，才按默认行为与工具惯例执行。"
  }
];

export function getProjectRulePrecedenceLevel(
  id: ProjectRulePrecedenceLevelId
): ProjectRulePrecedenceLevel | null {
  return PROJECT_RULE_PRECEDENCE.find((level) => level.id === id) ?? null;
}

/** Sorted by rank so the rendered order always matches the enforced order. */
export function sortProjectRulePrecedenceLevels(): ProjectRulePrecedenceLevel[] {
  return [...PROJECT_RULE_PRECEDENCE].sort((left, right) => left.rank - right.rank);
}

/** One-line summary injected into the project prompt. */
export const PROJECT_RULE_PRECEDENCE_STATEMENT =
  "指令优先序：当轮用户指令 > 项目规则（`.codexh/rule.md`）> 项目记忆 > 默认行为；"
  + "规则与当轮指令冲突时以用户指令为准，并把冲突登记为规则待更新项。";

/** Bullet list for the injected block, ordered by rank. */
export function renderProjectRulePrecedenceLines(): string[] {
  return sortProjectRulePrecedenceLevels().map((level) => `- ${level.rank}. ${level.statement}`);
}

/** Repository-relative path of the only project metadata file rules may write. */
export const PROJECT_RULE_WRITABLE_RELATIVE_PATH = PROJECT_RULE_RELATIVE_PATH.split("\\").join("/");

/** Project metadata directory: every file in it is owned by a dedicated writer. */
export const PROJECT_METADATA_DIRECTORY = PROJECT_RULE_WRITABLE_RELATIVE_PATH.split("/")[0]!;

export type ProjectRuleUpdateTargetDecision =
  | "rule-file"
  | "protected-project-metadata"
  | "outside-project-metadata";

export function normalizeProjectRuleUpdateTarget(target: string): string {
  return target.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Classifies a write target for the rule update path.
 *
 * Rule maintenance may only ever write `.codexh/rule.md`. Everything else under
 * `.codexh` (the GPA plan file, memory notes, scan artifacts) belongs to another
 * writer, so a rule update that targets it is a protection violation rather than
 * a merge candidate. In particular this keeps `gpa-plan.md` and its
 * `completed_task_ids` untouched by rule updates.
 */
export function checkProjectRuleUpdateTarget(target: string): ProjectRuleUpdateTargetDecision {
  const normalized = normalizeProjectRuleUpdateTarget(target);
  if (normalized === PROJECT_RULE_WRITABLE_RELATIVE_PATH) return "rule-file";
  if (normalized === PROJECT_METADATA_DIRECTORY || normalized.startsWith(`${PROJECT_METADATA_DIRECTORY}/`)) {
    return "protected-project-metadata";
  }
  return "outside-project-metadata";
}

export function isProjectRuleUpdateProtectedPath(target: string): boolean {
  return checkProjectRuleUpdateTarget(target) === "protected-project-metadata";
}
