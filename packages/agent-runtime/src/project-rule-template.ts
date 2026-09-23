import {
  PROJECT_RULE_CATEGORIES,
  PROJECT_RULE_FILE_VERSION,
  type ProjectRuleCategoryId,
  type ProjectRuleDocument,
  type ProjectRuleEntry,
  type ProjectRuleSource
} from "./project-rule-file";

/**
 * Template used to bootstrap `.codexh/rule.md`. It intentionally contains no
 * project-specific content so the same skeleton can seed any repository.
 */
export const PROJECT_RULE_TEMPLATE_HEADER = "# Project Rules";

export const PROJECT_RULE_TEMPLATE_NOTES: readonly string[] = [
  "本文件由 CodeXH 依据项目事实自动生成并增量维护，也可直接手改或用自然语言要求更新。",
  "每个条目是一条可执行规则，包含 id、分类、适用范围、来源与更新时间。",
  "source 为 user 的条目不会被自动更新覆盖；自动更新只新增或补充 auto 条目。",
  "stale 为 true 表示该条目可能已过期，自动更新只做标记，不会直接删除条目。"
];

/** Category guide reused by generation and by the injected rule index. */
export function buildProjectRuleCategoryGuide(): string {
  return PROJECT_RULE_CATEGORIES.map(
    (category) => `- ${category.label} (\`${category.prefix}-NNN\`): ${category.hint}`
  ).join("\n");
}

export function buildProjectRuleEntrySkeleton(input: {
  category: ProjectRuleCategoryId;
  id: string;
  title: string;
  scope?: string;
  rules?: string[];
  source?: ProjectRuleSource;
  updatedAt?: string;
  stale?: boolean;
}): ProjectRuleEntry {
  return {
    id: input.id,
    category: input.category,
    title: input.title,
    scope: input.scope ?? "**/*",
    rules: [...(input.rules ?? [])],
    source: input.source ?? "auto",
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    stale: input.stale ?? false
  };
}

export function buildEmptyProjectRuleDocument(input?: {
  updatedAt?: string;
}): ProjectRuleDocument {
  return {
    version: PROJECT_RULE_FILE_VERSION,
    updatedAt: input?.updatedAt ?? new Date().toISOString(),
    entries: []
  };
}
