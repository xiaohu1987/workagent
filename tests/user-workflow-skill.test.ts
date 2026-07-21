import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildUserWorkflowPrompt,
  loadSkillsFromRoots,
  normalizeUserSkillName,
  parseUserWorkflowDraft,
  renderUserWorkflowSkill
} from "@skills-runtime";

describe("user workflow skills", () => {
  it("builds a redacted extraction prompt with recorded tool calls", () => {
    const prompt = buildUserWorkflowPrompt({
      title: "查询报表",
      messages: [{ role: "user", content: "password=hunter2，请生成报表" }],
      toolCalls: [{ name: "database.query", argumentsJson: '{"sql":"SELECT 1","token":"abc123secret"}', resultJson: '{"ok":true}', status: "completed" }]
    });
    expect(prompt).toContain("database.query");
    expect(prompt).toContain("SELECT 1");
    expect(prompt).not.toContain("hunter2");
    expect(prompt).not.toContain("abc123secret");
  });

  it("normalizes model JSON into a valid concise SKILL.md", () => {
    const draft = parseUserWorkflowDraft(JSON.stringify({
      name: "Monthly Report!!!",
      description: "生成月度报表，并在用户要求复用报表流程时使用。",
      workflow: "1. 调用 `database.query` 读取数据。\n2. 验证结果行数。"
    }), "fallback");
    const skill = renderUserWorkflowSkill(draft);
    expect(draft.name).toBe("monthly-report");
    expect(skill).toContain("name: monthly-report");
    expect(skill).toContain("description: \"生成月度报表，并在用户要求复用报表流程时使用。\"");
    expect(skill).toContain("# Monthly Report");
    expect(skill.match(/^---$/gm)).toHaveLength(2);
  });

  it("redacts secrets returned by the model before writing the skill", () => {
    const draft = parseUserWorkflowDraft(JSON.stringify({
      name: "secure-workflow",
      description: "Reuse a workflow with token=top-secret-value when requested.",
      workflow: "# Secure Workflow\n\nSend Authorization: Bearer abcdefghijklmnop to the service."
    }), "fallback");

    const skill = renderUserWorkflowSkill(draft);
    expect(skill).not.toContain("top-secret-value");
    expect(skill).not.toContain("abcdefghijklmnop");
    expect(skill).toContain("[redacted]");
  });

  it("preserves a user-provided Chinese skill name while normalizing separators", () => {
    expect(normalizeUserSkillName(" 月度 报表 / 查询 ")).toBe("月度-报表-查询");
  });

  it("loads the generated file as an implicitly available user skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-user-skill-"));
    try {
      const skillDirectory = path.join(root, "monthly-report");
      await fs.mkdir(skillDirectory);
      await fs.writeFile(path.join(skillDirectory, "SKILL.md"), renderUserWorkflowSkill({
        name: "monthly-report",
        description: "生成月度报表，并在用户要求复用报表流程时使用。",
        workflow: "# Monthly Report\n\n1. 调用 `database.query` 读取数据。"
      }), "utf8");
      const skills = await loadSkillsFromRoots([{ path: root, scope: "user" }]);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({ name: "monthly-report", scope: "user", allowImplicitInvocation: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
