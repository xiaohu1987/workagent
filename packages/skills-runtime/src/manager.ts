import type { AvailableSkillsContext, SkillMetadata } from "@shared-types";
import { discoverSkillRoots, loadSkillsFromRoots } from "./loader";
import { renderAvailableSkills } from "./render";

export class SkillsManager {
  #skills: SkillMetadata[] = [];

  public async refresh(
    appHome: string,
    cwd?: string | null,
    extraRoots: Array<{ path: string; scope: "repo" | "user" | "system" | "admin"; pluginId?: string }> = []
  ): Promise<SkillMetadata[]> {
    const roots = [...discoverSkillRoots(appHome, cwd), ...extraRoots];
    this.#skills = await loadSkillsFromRoots(roots);
    return this.#skills;
  }

  public list(): SkillMetadata[] {
    return [...this.#skills];
  }

  public findByQualifiedName(name: string): SkillMetadata | undefined {
    return this.#skills.find((skill) => skill.qualifiedName === name || skill.name === name);
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
    const allowedPlugins = allowedPluginIds ? new Set(allowedPluginIds) : null;
    const visibleSkills = this.#skills.filter((skill) => {
      if (!skill.pluginId) {
        return true;
      }
      return allowedPlugins ? allowedPlugins.has(skill.pluginId) : false;
    });
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

  public buildContext(skills: SkillMetadata[]): AvailableSkillsContext | null {
    return renderAvailableSkills(skills);
  }
}
