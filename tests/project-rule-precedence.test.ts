import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_RULE_PRECEDENCE_STATEMENT,
  PROJECT_RULE_WRITABLE_RELATIVE_PATH,
  checkProjectRuleUpdateTarget,
  isProjectRuleUpdateProtectedPath,
  sortProjectRulePrecedenceLevels
} from "../packages/agent-runtime/src/project-rule-precedence";
import { buildProjectRuleInjection } from "../packages/agent-runtime/src/project-rule-inject";
import {
  PROJECT_METADATA_GUARD_ENTRY_ID,
  evaluateProjectRuleWriteCheck
} from "../packages/agent-runtime/src/project-rule-guard";
import { refreshProjectRuleFile } from "../packages/agent-runtime/src/project-rule-update";
import type { ProjectRuleDocument } from "../packages/agent-runtime/src/project-rule-file";

const PLAN_RELATIVE_PATH = path.join(".codexh", "gpa-plan.md");

function createDocument(): ProjectRuleDocument {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries: [
      {
        id: "R-GUARD-001",
        category: "boundary",
        title: "只读路径",
        scope: "**/*",
        rules: ["不要修改 dist 目录"],
        source: "auto",
        updatedAt: "2026-01-01T00:00:00.000Z",
        stale: false
      }
    ]
  };
}

function patchTargeting(target: string): Record<string, unknown> {
  return {
    patch: [
      "*** Begin Patch",
      `*** Update File: ${target}`,
      "@@",
      "-old",
      "+new",
      "*** End Patch"
    ].join("\n")
  };
}

async function createTempProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-rule-precedence-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
  return root;
}

describe("project rule precedence", () => {
  it("orders the competing instruction sources deterministically", () => {
    expect(sortProjectRulePrecedenceLevels().map((level) => level.id)).toEqual([
      "user-instruction",
      "project-rule",
      "project-memory",
      "default-behavior"
    ]);
    const ranks = sortProjectRulePrecedenceLevels().map((level) => level.rank);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("states the order in the injected block on every turn", () => {
    const injection = buildProjectRuleInjection(createDocument());
    expect(injection).not.toBeNull();
    expect(injection).toContain(PROJECT_RULE_PRECEDENCE_STATEMENT);
    expect(injection).toContain("当轮用户指令");
    expect(injection).toContain("项目记忆");
  });

  it("keeps project metadata off the rule update path", () => {
    expect(checkProjectRuleUpdateTarget(PROJECT_RULE_WRITABLE_RELATIVE_PATH)).toBe("rule-file");
    expect(checkProjectRuleUpdateTarget(".codexh/gpa-plan.md")).toBe("protected-project-metadata");
    expect(checkProjectRuleUpdateTarget(".codexh\\gpa-plan.md")).toBe("protected-project-metadata");
    expect(checkProjectRuleUpdateTarget("./.codexh/memory/notes.md")).toBe("protected-project-metadata");
    expect(checkProjectRuleUpdateTarget("packages/agent-runtime/src/index.ts")).toBe(
      "outside-project-metadata"
    );
    expect(isProjectRuleUpdateProtectedPath("packages/agent-runtime/src/index.ts")).toBe(false);
  });

  it("blocks a write into the plan file but still allows the rule file", () => {
    const blocked = evaluateProjectRuleWriteCheck({
      document: createDocument(),
      toolName: "apply_patch",
      arguments: patchTargeting(".codexh/gpa-plan.md")
    });
    expect(blocked.requiresConfirmation).toBe(true);
    expect(blocked.conflicts).toHaveLength(1);
    expect(blocked.conflicts[0]!.entryId).toBe(PROJECT_METADATA_GUARD_ENTRY_ID);
    expect(blocked.conflicts[0]!.severity).toBe("block");
    expect(blocked.message).toContain("completed_task_ids");

    const allowed = evaluateProjectRuleWriteCheck({
      document: createDocument(),
      toolName: "apply_patch",
      arguments: patchTargeting(".codexh/rule.md")
    });
    expect(allowed.requiresConfirmation).toBe(false);
    expect(allowed.conflicts).toHaveLength(0);
  });

  it("leaves the plan file byte-identical across rule refreshes", async () => {
    const planContent = [
      "# GPA Plan",
      "",
      "- **status**: `in_progress`",
      "",
      "- completed_task_ids: `T1`, `T2`",
      ""
    ].join("\n");
    const root = await createTempProject({
      "package.json": JSON.stringify({ name: "demo" }),
      [PLAN_RELATIVE_PATH]: planContent
    });
    const planPath = path.join(root, PLAN_RELATIVE_PATH);

    const first = await refreshProjectRuleFile(root, { maxChangedEntries: 40 });
    expect(first.document.entries.length).toBeGreaterThan(0);
    await expect(fs.readFile(planPath, "utf8")).resolves.toBe(planContent);

    const manifestPath = path.join(root, "package.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }),
      "utf8"
    );
    const bumpedAt = new Date(Date.parse(first.document.updatedAt) + 60_000);
    await fs.utimes(manifestPath, bumpedAt, bumpedAt);

    const second = await refreshProjectRuleFile(root, { maxChangedEntries: 40 });
    expect(second.changed).toBeGreaterThan(0);
    await expect(fs.readFile(planPath, "utf8")).resolves.toBe(planContent);
  });
});
