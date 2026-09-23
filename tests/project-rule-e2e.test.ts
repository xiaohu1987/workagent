import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_RULE_INJECTION_HEADING,
  resolveProjectRuleInjection,
  resolveProjectRuleState
} from "../packages/agent-runtime/src/project-rule-inject";
import {
  PROJECT_RULE_RELATIVE_PATH,
  readProjectRuleFile
} from "../packages/agent-runtime/src/project-rule-file";
import { PROJECT_RULE_PRECEDENCE_STATEMENT } from "../packages/agent-runtime/src/project-rule-precedence";
import { evaluateProjectRuleWriteCheck } from "../packages/agent-runtime/src/project-rule-guard";
import { editProjectRuleFile } from "../packages/agent-runtime/src/project-rule-edit";

const PLAN_RELATIVE_PATH = path.join(".codexh", "gpa-plan.md");

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

async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-rule-e2e-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "e2e-demo", packageManager: "pnpm@9.0.0" }, null, 2),
    "utf8"
  );
  await fs.mkdir(path.dirname(path.join(root, PLAN_RELATIVE_PATH)), { recursive: true });
  await fs.writeFile(
    path.join(root, PLAN_RELATIVE_PATH),
    "# GPA Plan\n\n- completed_task_ids: `T1`\n",
    "utf8"
  );
  return root;
}

describe("project rule end-to-end chain", () => {
  it("generates, injects, guards, refreshes and edits the rule file", async () => {
    const root = await createProject();
    const rulePath = path.join(root, PROJECT_RULE_RELATIVE_PATH);
    const planPath = path.join(root, PLAN_RELATIVE_PATH);
    const planBefore = await fs.readFile(planPath, "utf8");

    // 1. 缺失即生成并落盘
    const bootstrapped = await resolveProjectRuleState(root);
    expect(bootstrapped).not.toBeNull();
    expect(bootstrapped!.created).toBe(true);
    const stored = await fs.readFile(rulePath, "utf8");
    expect(stored.trim().length).toBeGreaterThan(0);

    // 2. 会话注入块带索引与优先序声明
    const injection = await resolveProjectRuleInjection(root);
    expect(injection).toContain(PROJECT_RULE_INJECTION_HEADING);
    expect(injection).toContain(PROJECT_RULE_PRECEDENCE_STATEMENT);
    expect(injection).toMatch(/R-[A-Z]+-\d{3}/);

    // 3. 写入前核对：源文件放行、计划文件硬拦截
    const firstIds = bootstrapped!.document.entries.map((entry) => entry.id).sort();
    const allowed = evaluateProjectRuleWriteCheck({
      document: bootstrapped!.document,
      toolName: "apply_patch",
      arguments: patchTargeting("packages/demo/src/index.ts")
    });
    expect(allowed.requiresConfirmation).toBe(false);
    const blocked = evaluateProjectRuleWriteCheck({
      document: bootstrapped!.document,
      toolName: "apply_patch",
      arguments: patchTargeting(".codexh/gpa-plan.md")
    });
    expect(blocked.requiresConfirmation).toBe(true);
    expect(blocked.conflicts.some((conflict) => conflict.severity === "block")).toBe(true);

    // 4. 项目变化后再对话：增量更新且旧条目不丢
    const manifestPath = path.join(root, "package.json");
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          name: "e2e-demo",
          packageManager: "pnpm@9.0.0",
          scripts: { test: "vitest run", lint: "eslint ." },
          devDependencies: { vitest: "^4.0.0", typescript: "^5.6.0" }
        },
        null,
        2
      ),
      "utf8"
    );
    const bumpedAt = new Date(Date.now() + 120_000);
    await fs.utimes(manifestPath, bumpedAt, bumpedAt);

    const refreshedState = await resolveProjectRuleState(root);
    expect(refreshedState).not.toBeNull();
    expect(refreshedState!.created).toBe(false);
    const refreshedMarkdown = await fs.readFile(rulePath, "utf8");
    expect(refreshedMarkdown).not.toBe(stored);
    const refreshedIds = refreshedState!.document.entries.map((entry) => entry.id);
    for (const id of firstIds) {
      expect(refreshedIds).toContain(id);
    }

    // 5. 自然语言改写立即持久化并在后续注入中生效
    const edited = await editProjectRuleFile(root, {
      kind: "add",
      category: "style",
      title: "日志规范",
      rules: ["新增模块统一使用结构化日志，禁止裸 console.log"]
    });
    expect(edited.rejected).toBe(false);
    expect(edited.changed).toHaveLength(1);
    const afterEdit = await resolveProjectRuleInjection(root);
    expect(afterEdit).toContain(edited.changed[0]!);
    const storedDoc = await readProjectRuleFile(root);
    expect(
      storedDoc!.entries.some((entry) => entry.rules.some((rule) => rule.includes("禁止裸 console.log")))
    ).toBe(true);

    // 6. 全链路结束后计划文件仍逐字节不变
    await expect(fs.readFile(planPath, "utf8")).resolves.toBe(planBefore);
  });
});
