import path from "node:path";
import type { AvailableSkillsContext, SkillMetadata } from "@shared-types";

const DEFAULT_BUDGET = 8_000;

export function renderAvailableSkills(
  skills: SkillMetadata[],
  budget = DEFAULT_BUDGET
): AvailableSkillsContext | null {
  if (skills.length === 0) {
    return null;
  }

  const visibleSkillIds: string[] = [];
  const omittedSkillIds: string[] = [];
  const lines = [
    "## Skills",
    "A skill is a set of local instructions stored in a `SKILL.md` file.",
    "Use explicitly selected skills first, then infer matching skills when helpful.",
    "Read the full `SKILL.md` before using a skill."
  ];

  let remaining = budget - lines.join("\n").length;
  for (const skill of skills) {
    const line = `- ${skill.qualifiedName}: ${skill.description} (path: ${path.dirname(skill.skillPath)})`;
    if (line.length <= remaining) {
      visibleSkillIds.push(skill.id);
      lines.push(line);
      remaining -= line.length;
    } else {
      omittedSkillIds.push(skill.id);
    }
  }

  return {
    text: lines.join("\n"),
    visibleSkillIds,
    omittedSkillIds,
    warning:
      omittedSkillIds.length > 0
        ? "部分 skill 描述因上下文预算被省略，系统仍可通过显式选择使用它们。"
        : undefined
  };
}
