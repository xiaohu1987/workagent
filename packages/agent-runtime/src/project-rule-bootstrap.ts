import {
  PROJECT_RULE_FILE_VERSION,
  readProjectRuleFile,
  writeProjectRuleFile,
  type ProjectRuleDocument,
  type ProjectRuleEntry
} from "./project-rule-file";
import { scanProjectFacts, type ProjectScanFacts } from "./project-rule-scan";
import { buildProjectRuleEntrySkeleton } from "./project-rule-template";

/**
 * First-run bootstrap for `.codexh/rule.md`.
 *
 * A project conversation must never start without rules, so when the file is
 * missing we scan the repository once and persist a draft. Later turns only
 * update the file incrementally, which is why this module stays read-only with
 * respect to an existing document.
 */

export interface ProjectRuleBootstrapResult {
  /** Absolute path of the rule file that now exists on disk. */
  filePath: string;
  /** `true` when this call created the file, `false` when it already existed. */
  created: boolean;
  /** The document that is now persisted (freshly generated or read back). */
  document: ProjectRuleDocument;
  /** Facts used for generation; `null` when the file already existed. */
  facts: ProjectScanFacts | null;
}

function joinOrFallback(values: readonly string[], fallback: string): string {
  return values.length > 0 ? values.join("、") : fallback;
}

/**
 * Turns scanned facts into executable rule entries.
 *
 * Every entry is derived from an observed fact, so a freshly generated file is
 * immediately actionable instead of a placeholder skeleton.
 */
export function buildProjectRuleEntriesFromFacts(
  facts: ProjectScanFacts,
  updatedAt: string
): ProjectRuleEntry[] {
  const entries: ProjectRuleEntry[] = [];
  const push = (input: {
    category: ProjectRuleEntry["category"];
    title: string;
    scope?: string;
    rules: string[];
  }) => {
    const rules = input.rules.filter((rule) => rule.trim().length > 0);
    if (rules.length === 0) return;
    entries.push(
      buildProjectRuleEntrySkeleton({
        category: input.category,
        id: `${categoryPrefix(input.category)}-${String(entries.length + 1).padStart(3, "0")}`,
        title: input.title,
        scope: input.scope,
        rules,
        source: "auto",
        updatedAt
      })
    );
  };

  if (facts.protectedPaths.length > 0) {
    push({
      category: "boundary",
      title: "只读与禁改路径",
      rules: [
        `以下路径视为只读，除非用户明确要求，否则不要修改：${facts.protectedPaths.join("、")}。`,
        "改动生成物目录中的文件无效，应改其源文件后重新生成。"
      ]
    });
  }

  push({
    category: "tech-stack",
    title: "技术栈与包管理器",
    rules: [
      `语言：${joinOrFallback(facts.languages, "未识别，需人工补充")}。`,
      facts.packageManager
        ? `包管理器使用 ${facts.packageManager}，不要混用其他包管理器的锁文件。`
        : "未检测到包管理器锁文件，安装依赖前先与用户确认。",
      facts.frameworks.length > 0 ? `主要框架：${facts.frameworks.join("、")}。` : ""
    ]
  });

  const testCommand = facts.commands.find((command) => command.kind === "test");
  const typecheckCommand = facts.commands.find((command) => command.kind === "typecheck");
  push({
    category: "verify",
    title: "改动后的验证命令",
    rules: [
      typecheckCommand
        ? `改动后执行 \`${typecheckCommand.command}\` 做类型检查。`
        : "未发现类型检查脚本，改动后需人工确认类型安全。",
      testCommand
        ? `改动后执行 \`${testCommand.command}\`，并以真实通过结果作为完成依据。`
        : "未发现测试脚本，改动后需显式约定验证方式。",
      facts.testFramework ? `测试框架为 ${facts.testFramework}。` : ""
    ]
  });

  if (facts.sourceDirectories.length > 0) {
    push({
      category: "layout",
      title: "源码目录职责",
      rules: [
        `源码位于：${facts.sourceDirectories.join("、")}；新增文件应落在对应目录内。`,
        facts.workspaces.length > 0
          ? `本仓库为 workspace（${facts.workspaces.join("、")}），共 ${facts.packages.length} 个包，跨包改动需同步检查依赖方。`
          : "本仓库为单包结构，避免新增平行目录。"
      ]
    });
  }

  if (facts.configFiles.length > 0) {
    push({
      category: "style",
      title: "关键配置与风格约束",
      rules: [
        `关键配置文件：${facts.configFiles.join("、")}；改动需与既有配置保持一致。`,
        "沿用仓库既有命名与导入风格，不引入新的格式化工具。"
      ]
    });
  }

  if (facts.notes.length > 0) {
    push({
      category: "pitfall",
      title: "扫描发现的注意事项",
      rules: facts.notes.map((note) => `${note}`)
    });
  }

  return entries;
}

function categoryPrefix(category: ProjectRuleEntry["category"]): string {
  switch (category) {
    case "boundary":
      return "R-GUARD";
    case "tech-stack":
      return "R-TECH";
    case "verify":
      return "R-VERIFY";
    case "layout":
      return "R-LAYOUT";
    case "style":
      return "R-STYLE";
    default:
      return "R-PITFALL";
  }
}

/**
 * Ensures `.codexh/rule.md` exists for a project conversation.
 *
 * Returns the existing document untouched when the file is present, so this is
 * safe to call on every project turn.
 */
export async function ensureProjectRuleFile(
  cwd: string,
  options?: { maxDepth?: number }
): Promise<ProjectRuleBootstrapResult> {
  const existing = await readProjectRuleFile(cwd);
  if (existing) {
    return { filePath: resolveRulePath(cwd), created: false, document: existing, facts: null };
  }

  const facts = await scanProjectFacts(cwd, options);
  const updatedAt = new Date().toISOString();
  const document: ProjectRuleDocument = {
    version: PROJECT_RULE_FILE_VERSION,
    updatedAt,
    entries: buildProjectRuleEntriesFromFacts(facts, updatedAt)
  };
  const filePath = await writeProjectRuleFile(cwd, document);
  return { filePath, created: true, document, facts };
}

function resolveRulePath(cwd: string): string {
  return require("node:path").join(cwd, ".codexh", "rule.md");
}
