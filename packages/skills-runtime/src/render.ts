import type { AvailableSkillsContext, SkillMetadata } from "@shared-types";

export function renderAvailableSkills(
  skills: SkillMetadata[],
  options?: { explicitSkillIds?: string[]; recommendedSkillIds?: string[] }
): AvailableSkillsContext | null {
  if (skills.length === 0) {
    return null;
  }

  const visibleSkillIds: string[] = [];
  const omittedSkillIds: string[] = [];
  const explicitSkillIds = new Set(options?.explicitSkillIds ?? []);
  const recommendedSkillIds = new Set(options?.recommendedSkillIds ?? []);
  const ordered = [...skills].sort((left, right) => {
    const leftRank = skillPriorityRank(left.id, explicitSkillIds, recommendedSkillIds);
    const rightRank = skillPriorityRank(right.id, explicitSkillIds, recommendedSkillIds);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.qualifiedName.localeCompare(right.qualifiedName);
  });

  const lines = [
    "## Available Skills",
    "Skills are callable local instruction packs. Decide whether a skill is needed before responding or taking action.",
    "Call `skills.load` with the exact `skill_id` before following a skill. Its schema is { skill_id: string }.",
    "Skills marked `priority: selected` were explicitly chosen by the user and must be considered before any other skill.",
    "Skills marked `priority: recommended` are domain-matched for this task; load them with `skills.load` before related work.",
    "All listed skills are available; user-domain and plugin skills load their full instructions only after `skills.load`."
  ];

  for (const skill of ordered) {
    visibleSkillIds.push(skill.id);
    const priority = explicitSkillIds.has(skill.id)
      ? "selected"
      : recommendedSkillIds.has(skill.id)
        ? "recommended"
        : "normal";
    lines.push(
      `- skill_id: ${skill.id}; name: ${skill.qualifiedName}; domain: ${skill.domain ?? "通用"}; scope: ${skill.pluginId ? "plugin" : skill.scope}; priority: ${priority}; description: ${skill.description}; parameters_schema: {"skill_id":"${skill.id}"}`
    );
  }

  return {
    text: lines.join("\n"),
    visibleSkillIds,
    omittedSkillIds,
    warning: undefined
  };
}

function skillPriorityRank(
  skillId: string,
  explicitSkillIds: Set<string>,
  recommendedSkillIds: Set<string>
): number {
  if (explicitSkillIds.has(skillId)) {
    return 0;
  }
  if (recommendedSkillIds.has(skillId)) {
    return 1;
  }
  return 2;
}
