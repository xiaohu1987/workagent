import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Read-only project fact scanner feeding `.codexh/rule.md`.
 *
 * The scanner is best-effort: every failure degrades to "unknown" instead of
 * throwing, so it can run automatically when a project turn starts. It never
 * reads secret content such as `.env`; it only records that such a path exists.
 */

export const PROJECT_SCAN_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv"
];

export const PROJECT_SCAN_GENERATED_DIRECTORIES: readonly string[] = [
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  "release",
  "artifacts"
];

/** Paths that must stay untouched; existence is checked, content never read. */
export const PROJECT_SCAN_PROTECTED_FILES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production"
];

export const PROJECT_SCAN_CONFIG_FILES: readonly string[] = [
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "electron.vite.config.ts",
  "playwright.config.ts",
  "eslint.config.js",
  ".eslintrc.json",
  ".prettierrc",
  "pnpm-workspace.yaml",
  "turbo.json",
  "next.config.js",
  "tailwind.config.js"
];

export const PROJECT_SCAN_DEFAULT_MAX_DEPTH = 3;
export const MAX_PROJECT_SCAN_PACKAGES = 40;
export const MAX_PROJECT_SCAN_KEY_DEPENDENCIES = 24;
const MAX_PROJECT_SCAN_ENTRIES = 800;

const PACKAGE_MANAGER_LOCKFILES: ReadonlyArray<{ file: string; manager: string }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "bun.lockb", manager: "bun" }
];

const TEST_FRAMEWORK_NAMES: readonly string[] = [
  "vitest",
  "jest",
  "mocha",
  "ava",
  "playwright",
  "@playwright/test"
];

const FRAMEWORK_NAMES: readonly string[] = [
  "electron",
  "react",
  "vue",
  "svelte",
  "@angular/core",
  "next",
  "nuxt"
];

const KEY_DEPENDENCY_NAMES: readonly string[] = [
  "typescript",
  "vite",
  "electron",
  "electron-builder",
  "vitest",
  "jest",
  "@playwright/test",
  "eslint",
  "prettier",
  "react",
  "vue",
  "svelte",
  "next",
  "tailwindcss",
  "zod",
  "cheerio",
  "express",
  "fastify",
  "@nestjs/core",
  "prisma",
  "typeorm",
  "sequelize",
  "better-sqlite3",
  "xlsx"
];

const SOURCE_EXTENSION_LANGUAGES: ReadonlyArray<{ extension: string; language: string }> = [
  { extension: ".tsx", language: "TypeScript" },
  { extension: ".ts", language: "TypeScript" },
  { extension: ".mts", language: "TypeScript" },
  { extension: ".cts", language: "TypeScript" },
  { extension: ".jsx", language: "JavaScript" },
  { extension: ".mjs", language: "JavaScript" },
  { extension: ".cjs", language: "JavaScript" },
  { extension: ".js", language: "JavaScript" },
  { extension: ".vue", language: "Vue" },
  { extension: ".svelte", language: "Svelte" },
  { extension: ".py", language: "Python" },
  { extension: ".cs", language: "C#" },
  { extension: ".go", language: "Go" },
  { extension: ".rs", language: "Rust" },
  { extension: ".java", language: "Java" }
];

const SCRIPT_KIND_PATTERNS: ReadonlyArray<{ kind: ProjectScanCommandKind; pattern: RegExp }> = [
  { kind: "typecheck", pattern: /(^|:)(typecheck|type-check|tsc|check-types)(:|$)/i },
  { kind: "test", pattern: /(^|:)(test|tests|vitest|jest|mocha|spec)(:|$)/i },
  { kind: "lint", pattern: /(^|:)(lint|eslint|biome)(:|$)/i },
  { kind: "build", pattern: /(^|:)(build|compile)(:|$)/i },
  { kind: "format", pattern: /(^|:)(format|prettier)(:|$)/i }
];

export type ProjectScanCommandKind = "typecheck" | "test" | "lint" | "build" | "format";

export interface ProjectScanCommand {
  /** package.json script name, e.g. `typecheck`. */
  name: string;
  command: string;
  kind: ProjectScanCommandKind;
}

export interface ProjectScanPackage {
  name: string;
  /** Repository-relative path using `/` separators. */
  relativePath: string;
  scripts: string[];
}

export interface ProjectScanKeyDependency {
  name: string;
  version: string;
  scope: "dependencies" | "devDependencies";
}

export interface ProjectScanFacts {
  root: string;
  packageName: string | null;
  packageManager: string | null;
  packageManagerEvidence: string[];
  languages: string[];
  frameworks: string[];
  testFramework: string | null;
  workspaces: string[];
  packages: ProjectScanPackage[];
  commands: ProjectScanCommand[];
  keyDependencies: ProjectScanKeyDependency[];
  topLevelDirectories: string[];
  sourceDirectories: string[];
  generatedDirectories: string[];
  protectedPaths: string[];
  configFiles: string[];
  notes: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringRecord(
  record: Record<string, unknown> | null,
  key: string
): Record<string, string> {
  const source = asRecord(record?.[key]);
  if (!source) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function isIgnoredDirectory(name: string): boolean {
  return PROJECT_SCAN_IGNORED_DIRECTORIES.includes(name);
}

async function listDirectory(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const content = await readTextFile(filePath);
  if (content === null) return null;
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return null;
  }
}

export function classifyProjectScriptKind(name: string): ProjectScanCommandKind | null {
  const normalized = name.trim();
  if (!normalized) return null;
  for (const candidate of SCRIPT_KIND_PATTERNS) {
    if (candidate.pattern.test(normalized)) return candidate.kind;
  }
  return null;
}

function languageForFile(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  for (const candidate of SOURCE_EXTENSION_LANGUAGES) {
    if (lower.endsWith(candidate.extension)) return candidate.language;
  }
  return null;
}

function parsePnpmWorkspaceYaml(content: string): string[] {
  const globs: string[] = [];
  let insidePackages = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/#.*$/, "");
    if (!withoutComment.trim()) continue;
    if (/^packages\s*:/.test(withoutComment.trim())) {
      insidePackages = true;
      continue;
    }
    if (!insidePackages) continue;
    const item = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(withoutComment);
    if (item) {
      const glob = item[1].trim();
      if (glob && !globs.includes(glob)) globs.push(glob);
      continue;
    }
    // A new top-level key ends the packages list.
    if (!/^\s/.test(withoutComment)) insidePackages = false;
  }
  return globs;
}

async function readWorkspaceGlobs(
  root: string,
  packageJson: Record<string, unknown> | null
): Promise<string[]> {
  const globs: string[] = [];
  const workspaceFile = await readTextFile(path.join(root, "pnpm-workspace.yaml"));
  if (workspaceFile) {
    for (const glob of parsePnpmWorkspaceYaml(workspaceFile)) {
      if (!globs.includes(glob)) globs.push(glob);
    }
  }
  const rawWorkspaces = packageJson?.["workspaces"];
  const list = Array.isArray(rawWorkspaces) ? rawWorkspaces : asRecord(rawWorkspaces)?.["packages"];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== "string") continue;
      const glob = item.trim();
      if (glob && !globs.includes(glob)) globs.push(glob);
    }
  }
  return globs;
}

async function expandWorkspaceGlob(root: string, glob: string): Promise<string[]> {
  const normalized = glob
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!normalized) return [];
  const segments = normalized.split("/");
  if (segments[segments.length - 1] !== "*") {
    const dirPath = path.join(root, ...segments);
    return (await pathExists(path.join(dirPath, "package.json"))) ? [normalized] : [];
  }
  const base = path.join(root, ...segments.slice(0, -1));
  const results: string[] = [];
  for (const entry of await listDirectory(base)) {
    if (!entry.isDirectory() || isIgnoredDirectory(entry.name)) continue;
    const dirPath = path.join(base, entry.name);
    if (!(await pathExists(path.join(dirPath, "package.json")))) continue;
    const relative = path.relative(root, dirPath).split(path.sep).join("/");
    if (relative) results.push(relative);
  }
  return results.sort();
}

async function directoryContainsSource(
  dir: string,
  depth: number,
  budget: { remaining: number },
  languages: Set<string>
): Promise<boolean> {
  if (depth < 0 || budget.remaining <= 0) return false;
  const entries = await listDirectory(dir);
  let found = false;
  for (const entry of entries) {
    budget.remaining -= 1;
    if (budget.remaining < 0) break;
    if (entry.isDirectory()) {
      if (depth === 0 || isIgnoredDirectory(entry.name)) continue;
      const nested = await directoryContainsSource(
        path.join(dir, entry.name),
        depth - 1,
        budget,
        languages
      );
      found = found || nested;
      continue;
    }
    const language = languageForFile(entry.name);
    if (!language) continue;
    languages.add(language);
    found = true;
  }
  return found;
}

async function scanSourceDirectories(
  root: string,
  candidates: readonly string[],
  maxDepth: number
): Promise<{ directories: string[]; languages: string[] }> {
  const languages = new Set<string>();
  const directories: string[] = [];
  const budget = { remaining: MAX_PROJECT_SCAN_ENTRIES };
  for (const candidate of candidates) {
    const contains = await directoryContainsSource(
      path.join(root, candidate),
      maxDepth,
      budget,
      languages
    );
    if (contains) directories.push(candidate);
    if (budget.remaining <= 0) break;
  }
  return { directories, languages: [...languages].sort() };
}

/** Scans a repository and returns the facts used to draft `.codexh/rule.md`. */
export async function scanProjectFacts(
  root: string,
  options?: { maxDepth?: number }
): Promise<ProjectScanFacts> {
  const maxDepth = Math.max(1, options?.maxDepth ?? PROJECT_SCAN_DEFAULT_MAX_DEPTH);
  const packageJson = await readJsonFile(path.join(root, "package.json"));

  const packageManagerEvidence: string[] = [];
  const lockfileManagers: string[] = [];
  for (const candidate of PACKAGE_MANAGER_LOCKFILES) {
    if (!(await pathExists(path.join(root, candidate.file)))) continue;
    packageManagerEvidence.push(candidate.file);
    lockfileManagers.push(candidate.manager);
  }
  const declaredManager = readStringField(packageJson, "packageManager");
  if (declaredManager) packageManagerEvidence.push("package.json#packageManager");
  const packageManager = declaredManager?.split("@")[0]?.trim() || lockfileManagers[0] || null;

  const rootEntries = await listDirectory(root);
  const topLevelDirectories = rootEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !isIgnoredDirectory(entry.name))
    .map((entry) => entry.name)
    .sort();

  const generatedDirectories = PROJECT_SCAN_GENERATED_DIRECTORIES.filter((name) =>
    rootEntries.some((entry) => entry.isDirectory() && entry.name === name)
  );

  const workspaces = await readWorkspaceGlobs(root, packageJson);
  const packagePaths: string[] = [];
  for (const glob of workspaces) {
    for (const relative of await expandWorkspaceGlob(root, glob)) {
      if (!packagePaths.includes(relative)) packagePaths.push(relative);
    }
  }
  packagePaths.sort();

  const packages: ProjectScanPackage[] = [];
  for (const relative of packagePaths.slice(0, MAX_PROJECT_SCAN_PACKAGES)) {
    const manifest = await readJsonFile(path.join(root, relative, "package.json"));
    packages.push({
      name: readStringField(manifest, "name") ?? relative,
      relativePath: relative,
      scripts: Object.keys(readStringRecord(manifest, "scripts")).sort()
    });
  }

  const rootScripts = readStringRecord(packageJson, "scripts");
  const commands: ProjectScanCommand[] = [];
  for (const [name, command] of Object.entries(rootScripts).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const kind = classifyProjectScriptKind(name);
    if (!kind) continue;
    commands.push({ name, command, kind });
  }

  const dependencies = readStringRecord(packageJson, "dependencies");
  const devDependencies = readStringRecord(packageJson, "devDependencies");
  const keyDependencies: ProjectScanKeyDependency[] = [];
  for (const name of KEY_DEPENDENCY_NAMES) {
    if (keyDependencies.length >= MAX_PROJECT_SCAN_KEY_DEPENDENCIES) break;
    const runtimeVersion = dependencies[name];
    if (runtimeVersion) {
      keyDependencies.push({ name, version: runtimeVersion, scope: "dependencies" });
      continue;
    }
    const devVersion = devDependencies[name];
    if (devVersion) keyDependencies.push({ name, version: devVersion, scope: "devDependencies" });
  }

  let testFramework =
    TEST_FRAMEWORK_NAMES.find((name) => Boolean(dependencies[name] ?? devDependencies[name])) ?? null;
  if (!testFramework) {
    const testCommand = commands.find((command) => command.kind === "test");
    testFramework = TEST_FRAMEWORK_NAMES.find((name) => testCommand?.command.includes(name)) ?? null;
  }
  const frameworks = FRAMEWORK_NAMES.filter((name) =>
    Boolean(dependencies[name] ?? devDependencies[name])
  );

  const source = await scanSourceDirectories(root, topLevelDirectories, maxDepth);
  const languages = new Set(source.languages);
  // 源码直接放在仓库根目录的项目（单文件脚本、非 Node 项目）也要识别语言。
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const language = languageForFile(entry.name);
    if (language) languages.add(language);
  }
  if (await pathExists(path.join(root, "tsconfig.json"))) languages.add("TypeScript");

  const protectedPaths: string[] = [];
  for (const name of [".git", "node_modules"]) {
    if (rootEntries.some((entry) => entry.isDirectory() && entry.name === name)) {
      protectedPaths.push(name);
    }
  }
  protectedPaths.push(...generatedDirectories);
  for (const name of PROJECT_SCAN_PROTECTED_FILES) {
    if (rootEntries.some((entry) => entry.isFile() && entry.name === name)) protectedPaths.push(name);
  }

  const configFiles: string[] = [];
  for (const name of PROJECT_SCAN_CONFIG_FILES) {
    if (await pathExists(path.join(root, name))) configFiles.push(name);
  }

  const notes: string[] = [];
  if (!packageJson) notes.push("未发现 package.json：按非 Node 项目处理，验证命令需人工补充。");
  if (!commands.some((command) => command.kind === "test")) {
    notes.push("package.json 中没有测试脚本：改动后的验证方式需要显式约定。");
  }
  if (workspaces.length > 0) {
    const preview = packagePaths.slice(0, 5).join("、");
    notes.push(`检测到 workspace：共 ${packages.length} 个包${preview ? `（${preview}）` : ""}。`);
  }
  if (generatedDirectories.length > 0) {
    notes.push(`生成物目录 ${generatedDirectories.join("、")} 应视为只读。`);
  }
  if (packageManagerEvidence.length > 0) {
    notes.push(`包管理器依据：${packageManagerEvidence.join("、")}。`);
  }

  return {
    root: path.resolve(root),
    packageName: readStringField(packageJson, "name"),
    packageManager,
    packageManagerEvidence,
    languages: [...languages].sort(),
    frameworks,
    testFramework,
    workspaces,
    packages,
    commands,
    keyDependencies,
    topLevelDirectories,
    sourceDirectories: source.directories,
    generatedDirectories,
    protectedPaths,
    configFiles,
    notes
  };
}

/** Renders the scanned facts as human-readable lines for prompts and previews. */
export function describeProjectFacts(facts: ProjectScanFacts): string[] {
  const lines: string[] = [
    facts.packageName ? `- 项目名称：${facts.packageName}` : "- 项目名称：未在 package.json 中声明"
  ];
  lines.push(
    facts.packageManager
      ? `- 包管理器：${facts.packageManager}${
          facts.packageManagerEvidence.length > 0
            ? `（依据：${facts.packageManagerEvidence.join("、")}）`
            : ""
        }`
      : "- 包管理器：未检测到锁文件或 packageManager 字段"
  );
  lines.push(`- 语言：${facts.languages.length > 0 ? facts.languages.join("、") : "未识别"}`);
  if (facts.frameworks.length > 0) lines.push(`- 框架：${facts.frameworks.join("、")}`);
  if (facts.testFramework) lines.push(`- 测试框架：${facts.testFramework}`);
  lines.push(
    facts.workspaces.length > 0
      ? `- workspace：${facts.workspaces.join("、")}，共 ${facts.packages.length} 个包`
      : "- workspace：单包仓库"
  );
  for (const item of facts.packages.slice(0, 10)) {
    lines.push(
      `  - ${item.relativePath}${item.name !== item.relativePath ? `（${item.name}）` : ""}`
    );
  }
  if (facts.commands.length > 0) {
    lines.push("- 验证命令：");
    for (const command of facts.commands) {
      lines.push(`  - ${command.kind}: \`${command.command}\`（script: \`${command.name}\`）`);
    }
  } else {
    lines.push("- 验证命令：package.json 中没有可识别的 typecheck/test/lint/build 脚本");
  }
  lines.push(
    facts.sourceDirectories.length > 0
      ? `- 源码目录：${facts.sourceDirectories.join("、")}`
      : "- 源码目录：未在顶层目录中发现源码文件"
  );
  if (facts.generatedDirectories.length > 0) {
    lines.push(`- 生成物目录：${facts.generatedDirectories.join("、")}`);
  }
  if (facts.protectedPaths.length > 0) {
    lines.push(`- 只读/禁改路径：${facts.protectedPaths.join("、")}`);
  }
  if (facts.configFiles.length > 0) lines.push(`- 关键配置：${facts.configFiles.join("、")}`);
  for (const note of facts.notes) lines.push(`- 备注：${note}`);
  return lines;
}
