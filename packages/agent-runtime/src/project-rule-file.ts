import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Project rule file: the single source of truth for project-level conventions.
 * It is auto-generated from project facts, then kept up to date incrementally,
 * and injected into project-mode turns before any file change happens.
 */
export const PROJECT_RULE_RELATIVE_PATH = path.join(".codexh", "rule.md");
export const PROJECT_RULE_FILE_VERSION = 1;

/** Budgets keep the常驻 index small while still allowing full entry expansion. */
export const MAX_PROJECT_RULE_FILE_CHARACTERS = 60_000;
export const MAX_PROJECT_RULE_ENTRIES = 120;
export const MAX_PROJECT_RULE_INDEX_ENTRIES = 40;
export const MAX_PROJECT_RULE_INDEX_CHARACTERS = 4_000;
export const MAX_PROJECT_RULE_ENTRY_CHARACTERS = 2_000;

export type ProjectRuleCategoryId =
  | "boundary"
  | "tech-stack"
  | "verify"
  | "layout"
  | "style"
  | "pitfall";

/** `user` entries are hand-written or requested by the user and stay protected. */
export type ProjectRuleSource = "auto" | "user";

export interface ProjectRuleCategory {
  id: ProjectRuleCategoryId;
  label: string;
  prefix: string;
  /** Lower priority numbers survive index truncation first. */
  priority: number;
  hint: string;
}

export const PROJECT_RULE_CATEGORIES: readonly ProjectRuleCategory[] = [
  {
    id: "boundary",
    label: "改动边界与禁改区",
    prefix: "R-GUARD",
    priority: 5,
    hint: "不可改写的目录、文件、生成物，以及需要先确认的改动"
  },
  {
    id: "tech-stack",
    label: "技术栈与版本",
    prefix: "R-TECH",
    priority: 10,
    hint: "运行时、包管理器、框架与关键依赖版本"
  },
  {
    id: "verify",
    label: "验证与测试命令",
    prefix: "R-VERIFY",
    priority: 20,
    hint: "改动后必须执行的类型检查、单测与构建命令"
  },
  {
    id: "layout",
    label: "目录职责",
    prefix: "R-LAYOUT",
    priority: 30,
    hint: "各目录与包的职责边界，以及新增文件的落点"
  },
  {
    id: "style",
    label: "命名与代码风格",
    prefix: "R-STYLE",
    priority: 40,
    hint: "命名、导入、注释与格式化约定"
  },
  {
    id: "pitfall",
    label: "已知坑",
    prefix: "R-PITFALL",
    priority: 50,
    hint: "已经踩过的坑与规避方式"
  }
];

export interface ProjectRuleEntry {
  id: string;
  category: ProjectRuleCategoryId;
  title: string;
  /** Glob-ish path scope used to match a write target. `**\/*` means repository-wide. */
  scope: string;
  rules: string[];
  source: ProjectRuleSource;
  updatedAt: string;
  /** Stale entries are only marked, never deleted, by automatic updates. */
  stale: boolean;
}

export interface ProjectRuleDocument {
  version: number;
  updatedAt: string;
  entries: ProjectRuleEntry[];
}

const ENTRY_HEADING_PATTERN = /^###\s+`?(R-[A-Z]+-\d{3})`?\s*(.*)$/;
const META_LINE_PATTERN = /^\s*[-*]\s*(category|source|scope|updated_at|stale)\s*:\s*(.+?)\s*$/i;
const ENTRY_ID_PATTERN = /^R-([A-Z]+)-\d{3}$/;

export function getProjectRuleCategory(id: string): ProjectRuleCategory | null {
  return PROJECT_RULE_CATEGORIES.find((category) => category.id === id) ?? null;
}

export function resolveProjectRuleCategoryFromId(id: string): ProjectRuleCategory | null {
  const prefix = ENTRY_ID_PATTERN.exec(id.trim())?.[1];
  if (!prefix) return null;
  return PROJECT_RULE_CATEGORIES.find((category) => category.prefix === `R-${prefix}`) ?? null;
}

export function sortProjectRuleEntries(entries: readonly ProjectRuleEntry[]): ProjectRuleEntry[] {
  const priorityOf = (entry: ProjectRuleEntry) =>
    getProjectRuleCategory(entry.category)?.priority ?? Number.MAX_SAFE_INTEGER;
  return [...entries].sort(
    (left, right) => priorityOf(left) - priorityOf(right) || left.id.localeCompare(right.id)
  );
}

/** Allocates the next free entry id for a category, e.g. `R-VERIFY-002`. */
export function nextProjectRuleId(
  category: ProjectRuleCategoryId,
  entries: readonly ProjectRuleEntry[]
): string {
  const target = getProjectRuleCategory(category) ?? PROJECT_RULE_CATEGORIES[0];
  let max = 0;
  for (const entry of entries) {
    if (!entry.id.startsWith(`${target.prefix}-`)) continue;
    const numeric = Number.parseInt(entry.id.slice(target.prefix.length + 1), 10);
    if (Number.isFinite(numeric) && numeric > max) max = numeric;
  }
  return `${target.prefix}-${String(max + 1).padStart(3, "0")}`;
}

export function buildProjectRuleIndexLine(entry: ProjectRuleEntry): string {
  const label = getProjectRuleCategory(entry.category)?.label ?? entry.category;
  const staleMark = entry.stale ? " · stale" : "";
  return `- \`${entry.id}\` · ${label} · ${entry.title} · scope: \`${entry.scope}\`${staleMark}`;
}

export function projectRuleEntryText(entry: ProjectRuleEntry): string {
  return [
    `### \`${entry.id}\` ${entry.title}`,
    "",
    `- category: \`${entry.category}\``,
    `- source: \`${entry.source}\``,
    `- scope: \`${entry.scope}\``,
    `- updated_at: \`${entry.updatedAt}\``,
    `- stale: \`${entry.stale}\``,
    "",
    ...entry.rules.map((rule) => `- ${rule.trim()}`)
  ].join("\n");
}

export function truncateProjectRuleText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const keep = Math.max(0, maxCharacters - 24);
  return `${text.slice(0, keep).trimEnd()}\n…（内容过长已截断）`;
}

/**
 * Serializes the document. The `## Index` section is always derived from the
 * entries, so the same document always produces byte-identical output and an
 * unchanged project never rewrites the file.
 */
export function formatProjectRuleMarkdown(doc: ProjectRuleDocument): string {
  const entries = sortProjectRuleEntries(doc.entries);
  const lines: string[] = [
    "# Project Rules",
    "",
    `- **version**: \`${doc.version}\``,
    `- **updated_at**: \`${doc.updatedAt}\``,
    "",
    "## Index",
    "",
    ...(entries.length > 0 ? entries.map(buildProjectRuleIndexLine) : ["- （暂无条目）"]),
    "",
    "## Entries",
    ""
  ];
  for (const entry of entries) {
    lines.push(projectRuleEntryText(entry), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function stripRuleValue(value: string): string {
  const trimmed = value.trim();
  const unquoted = trimmed.replace(/^`+|`+$/g, "").trim();
  return unquoted;
}

export function parseProjectRuleMarkdown(content: string): ProjectRuleDocument | null {
  const text = content.trim();
  if (!text) return null;

  const versionMatch = text.match(/\*\*version\*\*:\s*`?([^`\n]+?)`?\s*$/m);
  const updatedMatch = text.match(/\*\*updated_at\*\*:\s*`?([^`\n]+?)`?\s*$/m);
  const entrySection = text.split(/^##\s*Entries\b/m)[1] ?? text;

  const entries: ProjectRuleEntry[] = [];
  let current: ProjectRuleEntry | null = null;

  const push = () => {
    if (!current) return;
    const normalized: ProjectRuleEntry = {
      ...current,
      title: current.title.trim(),
      scope: current.scope.trim() || "**/*",
      rules: current.rules.map((rule) => rule.trim()).filter(Boolean)
    };
    if (normalized.rules.length > 0) entries.push(normalized);
    current = null;
  };

  for (const line of entrySection.split(/\r?\n/)) {
    const heading = ENTRY_HEADING_PATTERN.exec(line);
    if (heading) {
      push();
      const category = resolveProjectRuleCategoryFromId(heading[1]);
      if (!category) continue;
      current = {
        id: heading[1],
        category: category.id,
        title: heading[2] ?? "",
        scope: "**/*",
        rules: [],
        source: "auto",
        updatedAt: updatedMatch?.[1]?.trim() ?? new Date().toISOString(),
        stale: false
      };
      continue;
    }
    if (!current) continue;
    if (/^#{1,3}\s/.test(line)) continue;
    const meta = META_LINE_PATTERN.exec(line);
    if (meta) {
      const key = meta[1].toLowerCase();
      const value = stripRuleValue(meta[2]);
      if (key === "category") {
        const category = getProjectRuleCategory(value);
        if (category) current.category = category.id;
      } else if (key === "source") {
        current.source = value === "user" ? "user" : "auto";
      } else if (key === "scope") {
        current.scope = value;
      } else if (key === "updated_at") {
        current.updatedAt = value;
      } else if (key === "stale") {
        current.stale = /^(true|yes|是)$/i.test(value);
      }
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (bullet) current.rules.push(bullet[1]);
  }
  push();

  if (entries.length === 0) return null;
  const parsedVersion = Number.parseInt(versionMatch?.[1]?.trim() ?? "", 10);
  return {
    version: Number.isFinite(parsedVersion) ? parsedVersion : PROJECT_RULE_FILE_VERSION,
    updatedAt: updatedMatch?.[1]?.trim() ?? new Date().toISOString(),
    entries
  };
}

export function resolveProjectRuleFilePath(cwd: string): string {
  return path.join(cwd, PROJECT_RULE_RELATIVE_PATH);
}

export async function readProjectRuleFile(cwd: string): Promise<ProjectRuleDocument | null> {
  try {
    const content = await fs.readFile(resolveProjectRuleFilePath(cwd), "utf8");
    return parseProjectRuleMarkdown(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Writes the rule file atomically so an interrupted write never leaves a stub. */
export async function writeProjectRuleFile(
  cwd: string,
  doc: ProjectRuleDocument
): Promise<string> {
  const filePath = resolveProjectRuleFilePath(cwd);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, formatProjectRuleMarkdown(doc), "utf8");
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return filePath;
}
