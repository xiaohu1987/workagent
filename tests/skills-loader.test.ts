import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromRoots, SkillsManager, type SkillRootDefinition } from "@skills-runtime";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-skill-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadSkillsFromRoots", () => {
  it("loads skills and respects scope metadata", async () => {
    const root = await makeTempDir();
    const repoSkillDir = path.join(root, ".codexh", "skills", "local-skill");
    await fs.mkdir(path.join(repoSkillDir, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(repoSkillDir, "SKILL.md"),
      `---
name: local-skill
description: Local repository skill
---
Use the local repository workflow.
`,
      "utf8"
    );
    await fs.writeFile(
      path.join(repoSkillDir, "agents", "openai.yaml"),
      `interface:
  display_name: Local Skill
policy:
  allow_implicit_invocation: false
`,
      "utf8"
    );

    const roots: SkillRootDefinition[] = [
      { path: path.join(root, ".codexh", "skills"), scope: "repo" }
    ];

    const skills = await loadSkillsFromRoots(roots);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("local-skill");
    expect(skills[0]?.scope).toBe("repo");
    expect(skills[0]?.displayName).toBe("Local Skill");
    expect(skills[0]?.allowImplicitInvocation).toBe(false);
  });

  it("keeps system skills cached while exposing user domains for on-demand loading", async () => {
    const appHome = await makeTempDir();
    const systemSkillDir = path.join(appHome, "skills", "system", "release-skill");
    const userSkillDir = path.join(appHome, "skills", "imported", "data-skill");
    await fs.mkdir(systemSkillDir, { recursive: true });
    await fs.mkdir(userSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(systemSkillDir, "SKILL.md"),
      "---\nname: release-skill\ndescription: Prepare a software release\n---\nSystem release instructions.",
      "utf8"
    );
    await fs.writeFile(
      path.join(userSkillDir, "SKILL.md"),
      "---\nname: data-skill\ndescription: Analyze CSV files\ndomain: 数据分析\n---\nUse the CSV analysis workflow.",
      "utf8"
    );

    const manager = new SkillsManager();
    const skills = await manager.refresh(appHome);
    const userSkill = skills.find((skill) => skill.name === "data-skill");

    expect(skills.find((skill) => skill.name === "release-skill")?.domain).toBe("系统");
    expect(userSkill?.domain).toBe("数据分析");

    const catalog = manager.buildContext(skills, {
      explicitSkillIds: [userSkill!.id],
      recommendedSkillIds: []
    });
    expect(catalog?.text).toContain("priority: selected");
    expect(catalog?.text).toContain("parameters_schema");

    await expect(manager.loadInstructions(userSkill!.id)).resolves.toMatchObject({
      skill: { qualifiedName: "data-skill" },
      content: expect.stringContaining("CSV analysis workflow")
    });

    await fs.writeFile(
      path.join(systemSkillDir, "SKILL.md"),
      "---\nname: release-skill\ndescription: Changed after startup\n---\nChanged instructions.",
      "utf8"
    );
    const refreshed = await manager.refresh(appHome);
    expect(refreshed.find((skill) => skill.name === "release-skill")?.description).toBe(
      "Prepare a software release"
    );
  });

  it("recommends frontend-domain skills for Chinese web-game queries", async () => {
    const appHome = await makeTempDir();
    const frontendDir = path.join(appHome, "skills", "imported", "web-game");
    const dataDir = path.join(appHome, "skills", "imported", "csv-tool");
    const codingDir = path.join(appHome, "skills", "imported", "plan-and-patch");
    await fs.mkdir(frontendDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(codingDir, { recursive: true });
    await fs.writeFile(
      path.join(frontendDir, "SKILL.md"),
      "---\nname: web-game\ndescription: Build browser HTML CSS JS games\ndomain: 前端\n---\nFrontend workflow.",
      "utf8"
    );
    await fs.writeFile(
      path.join(dataDir, "SKILL.md"),
      "---\nname: csv-tool\ndescription: Analyze CSV spreadsheets\ndomain: 数据\n---\nData workflow.",
      "utf8"
    );
    await fs.writeFile(
      path.join(codingDir, "SKILL.md"),
      "---\nname: plan-and-patch\ndescription: Inspect a repository and make careful code edits\ncategory: 质量保障\n---\nPatch workflow.",
      "utf8"
    );

    const manager = new SkillsManager();
    await manager.refresh(appHome);
    const selected = manager.selectForThread({
      explicitSkillIds: [],
      query: "帮我写一个网页小游戏"
    });

    expect(selected.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["web-game", "plan-and-patch"])
    );
    expect(selected.find((skill) => skill.name === "plan-and-patch")?.domain).toBe("测试");

    const catalog = manager.buildContext(manager.list(), {
      recommendedSkillIds: selected.slice(0, 3).map((skill) => skill.id)
    });
    expect(catalog?.text).toContain("priority: recommended");
  });
});
