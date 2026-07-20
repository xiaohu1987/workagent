import type { AvailableSkillsContext, SkillMetadata } from "@shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverSkillRoots, loadSkillsFromRoots, normalizeSkillDomain } from "./loader";
import { renderAvailableSkills } from "./render";

const DOMAIN_HINTS: Array<{ domain: string; patterns: RegExp[] }> = [
  {
    domain: "前端",
    patterns: [/网页|前端|html|css|javascript|js|ui|界面|小游戏|纯前端|react|vue|落地页|页面/i]
  },
  { domain: "规划", patterns: [/规划|计划|拆解|brainstorm|需求|goal|plan/i] },
  { domain: "测试", patterns: [/测试|test|vitest|playwright|qa|验收|验证|debug|调试|修 bug|修bug/i] },
  { domain: "编程", patterns: [/写代码|编程|开发|实现|重构|patch|小游戏|网页|应用|功能|项目/i] },
  { domain: "数据", patterns: [/数据|csv|excel|sql|数据库|分析/i] },
  { domain: "多媒体", patterns: [/图像|图片|视频|image|video|多媒体|视觉/i] },
  { domain: "代码协作", patterns: [/git|pr|review|commit|代码审查|github/i] },
  { domain: "交付运维", patterns: [/部署|发布|deploy|release|ci|cd|运维/i] }
];

const CODING_PRIORITY_SKILLS = [
  "plan-and-patch",
  "verification-before-completion",
  "systematic-debugging",
  "executing-plans",
  "writing-plans",
  "test-driven-development"
] as const;

/** Map skill domains / categories onto the task-domain vocabulary used for scoring. */
export function skillDomainAliases(domain: string | undefined): string[] {
  const normalized = normalizeSkillDomain(domain ?? "通用");
  const aliases = new Set<string>([normalized]);
  if (normalized === "质量保障" || normalized === "测试") {
    aliases.add("测试");
    aliases.add("编程");
  }
  if (normalized === "输出与文件" || normalized === "前端") {
    aliases.add("前端");
  }
  if (normalized === "编程" || normalized === "系统") {
    aliases.add("编程");
  }
  if (normalized === "规划") {
    aliases.add("规划");
    aliases.add("编程");
  }
  return [...aliases];
}

export function inferTaskDomains(query: string): string[] {
  const matched = DOMAIN_HINTS
    .filter((entry) => entry.patterns.some((pattern) => pattern.test(query)))
    .map((entry) => entry.domain);
  // Web/coding tasks should also surface programming skills.
  if (matched.includes("前端") && !matched.includes("编程")) {
    matched.push("编程");
  }
  if (matched.includes("编程") && !matched.includes("规划") && /计划|拆|实现|开发|小游戏|网页/.test(query)) {
    matched.push("规划");
  }
  return matched.length > 0 ? matched : [];
}

export function tokenizeSkillQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function scoreSkillForQuery(skill: SkillMetadata, query: string, domains: string[]): number {
  let score = 0;
  const aliases = skillDomainAliases(skill.domain);
  if (domains.some((domain) => aliases.includes(domain))) {
    score += 12;
  }

  const loweredQuery = query.toLowerCase();
  const name = skill.name.toLowerCase();
  const qualified = skill.qualifiedName.toLowerCase();
  if (loweredQuery.includes(name) || loweredQuery.includes(qualified)) {
    score += 8;
  }

  if (
    CODING_PRIORITY_SKILLS.includes(skill.name as (typeof CODING_PRIORITY_SKILLS)[number]) &&
    (domains.includes("编程") || domains.includes("前端") || domains.includes("测试"))
  ) {
    score += 10;
  }

  const haystack = `${skill.qualifiedName} ${skill.description} ${skill.shortDescription ?? ""} ${skill.domain ?? ""}`.toLowerCase();
  for (const token of tokenizeSkillQuery(query)) {
    if (haystack.includes(token)) {
      score += token.length >= 4 ? 2 : 1;
    }
  }

  if (skill.allowImplicitInvocation) {
    score += 1;
  }
  return score;
}

export class SkillsManager {
  #skills: SkillMetadata[] = [];
  #systemSkills: SkillMetadata[] = [];
  #systemInitialized = false;

  public async initializeSystemSkills(appHome: string): Promise<SkillMetadata[]> {
    if (!this.#systemInitialized) {
      this.#systemSkills = await loadSkillsFromRoots([
        { path: path.join(appHome, "skills", "system"), scope: "system" }
      ]);
      this.#systemInitialized = true;
    }
    return [...this.#systemSkills];
  }

  public async refresh(
    appHome: string,
    cwd?: string | null,
    extraRoots: Array<{ path: string; scope: "repo" | "user" | "system" | "admin"; pluginId?: string }> = []
  ): Promise<SkillMetadata[]> {
    await this.initializeSystemSkills(appHome);
    const roots = [...discoverSkillRoots(appHome, cwd), ...extraRoots].filter((root) => root.scope !== "system");
    const dynamicSkills = await loadSkillsFromRoots(roots);
    this.#skills = dedupeSkills([...this.#systemSkills, ...dynamicSkills]);
    return this.#skills;
  }

  public list(): SkillMetadata[] {
    return [...this.#skills];
  }

  public findByQualifiedName(name: string): SkillMetadata | undefined {
    return this.#skills.find((skill) => skill.qualifiedName === name || skill.name === name);
  }

  public listForThread(allowedPluginIds?: string[]): SkillMetadata[] {
    const allowedPlugins = allowedPluginIds ? new Set(allowedPluginIds) : null;
    return this.#skills.filter((skill) =>
      !skill.pluginId || (allowedPlugins ? allowedPlugins.has(skill.pluginId) : false)
    );
  }

  public selectForThread({
    explicitSkillIds,
    query,
    allowedPluginIds
  }: {
    explicitSkillIds: string[];
    query: string;
    allowedPluginIds?: string[];
  }): SkillMetadata[] {
    const explicit = new Set(explicitSkillIds);
    const visibleSkills = this.listForThread(allowedPluginIds);
    const selected = visibleSkills.filter((skill) => explicit.has(skill.id));

    const domains = inferTaskDomains(query);
    const scored = visibleSkills
      .filter((skill) => !explicit.has(skill.id))
      .map((skill) => ({ skill, score: scoreSkillForQuery(skill, query, domains) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));

    const recommended: SkillMetadata[] = [];
    const pushUnique = (skill: SkillMetadata | undefined) => {
      if (!skill || recommended.some((entry) => entry.id === skill.id) || recommended.length >= 3) {
        return;
      }
      recommended.push(skill);
    };

    // Prefer coding priority skills when the task is coding/frontend oriented.
    if (domains.includes("编程") || domains.includes("前端") || domains.includes("测试")) {
      for (const name of CODING_PRIORITY_SKILLS) {
        pushUnique(scored.find((entry) => entry.skill.name === name)?.skill);
      }
    }
    for (const entry of scored) {
      pushUnique(entry.skill);
    }

    return [...selected, ...recommended];
  }

  public buildContext(
    skills: SkillMetadata[],
    options?: { explicitSkillIds?: string[]; recommendedSkillIds?: string[] }
  ): AvailableSkillsContext | null {
    return renderAvailableSkills(skills, options);
  }

  public async loadInstructions(skillId: string, allowedSkillIds?: string[]): Promise<{ skill: SkillMetadata; content: string }> {
    const skill = this.#skills.find((entry) => entry.id === skillId || entry.qualifiedName === skillId || entry.name === skillId);
    if (!skill || (allowedSkillIds && !allowedSkillIds.includes(skill.id))) {
      throw new Error("Requested skill is not available in this task.");
    }
    const content = await fs.readFile(skill.skillPath, "utf8");
    return { skill, content };
  }
}

function dedupeSkills(skills: SkillMetadata[]): SkillMetadata[] {
  const unique = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    unique.set(skill.skillPath, skill);
  }
  return [...unique.values()];
}
