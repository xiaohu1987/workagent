import type { AvailableSkillsContext, SkillMetadata } from "@shared-types";

export function renderAvailableSkills(
  skills: SkillMetadata[],
  options?: { explicitSkillIds?: string[] }
): AvailableSkillsContext | null {
  if (skills.length === 0) {
    return null;
  }

  const visibleSkillIds: string[] = [];
  const omittedSkillIds: string[] = [];
  const explicitSkillIds = new Set(options?.explicitSkillIds ?? []);
  const lines = [
    "## Available Skills",
    "Skills are callable local instruction packs. Decide whether a skill is needed before responding or taking action.",
    "Call `skills.load` with the exact `skill_id` before following a skill. Its schema is { skill_id: string }.",
    "Skills marked `priority: selected` were explicitly chosen by the user and must be considered before any other skill.",
    "All listed skills are available; user-domain and plugin skills load their full instructions only after `skills.load`."
  ];

  for (const skill of skills) {
    visibleSkillIds.push(skill.id);
    lines.push(
      `- skill_id: ${skill.id}; name: ${skill.qualifiedName}; domain: ${skill.domain ?? "通用"}; scope: ${skill.pluginId ? "plugin" : skill.scope}; priority: ${explicitSkillIds.has(skill.id) ? "selected" : "normal"}; description: ${skill.description}; parameters_schema: {"skill_id":"${skill.id}"}`
    );
  }

  return {
    text: lines.join("\n"),
    visibleSkillIds,
    omittedSkillIds,
    warning: undefined
  };
}
