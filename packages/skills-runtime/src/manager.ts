import type { AvailableSkillsContext, SkillMetadata } from "@shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverSkillRoots, loadSkillsFromRoots } from "./loader";
import { renderAvailableSkills } from "./render";

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
    const loweredQuery = query.toLowerCase();
    const explicit = new Set(explicitSkillIds);
    const visibleSkills = this.listForThread(allowedPluginIds);
    const selected = visibleSkills.filter((skill) => explicit.has(skill.id));

    const implicit = visibleSkills.filter((skill) => {
      if (!skill.allowImplicitInvocation || explicit.has(skill.id)) {
        return false;
      }

      const haystack = `${skill.qualifiedName} ${skill.description} ${skill.shortDescription ?? ""}`.toLowerCase();
      return loweredQuery.includes(skill.name.toLowerCase()) || haystack.includes(loweredQuery);
    });

    return [...selected, ...implicit];
  }

  public buildContext(
    skills: SkillMetadata[],
    options?: { explicitSkillIds?: string[] }
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
