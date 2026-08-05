import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkillRoots, loadSkillsFromRoots, SkillsManager, type SkillRootDefinition } from "@skills-runtime";

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
  it("uses .codexh/skills as the canonical project skill directory", async () => {
    const root = await makeTempDir();
    const roots = discoverSkillRoots(path.join(root, "app-home"), root).map((entry) => entry.path);

    expect(roots).toContain(path.join(root, ".codexh", "skills"));
    expect(roots).not.toContain(path.join(root, ".claude", "skills"));
    expect(roots).not.toContain(path.join(root, ".grok", "skills"));
  });

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

  it("localizes and categorizes newly imported skills", async () => {
    const root = await makeTempDir();
    const figmaDir = path.join(root, "figma-implement-design");
    const securityDir = path.join(root, "security-threat-model");
    const deployDir = path.join(root, "vercel-deploy");
    await Promise.all([
      fs.mkdir(figmaDir, { recursive: true }),
      fs.mkdir(securityDir, { recursive: true }),
      fs.mkdir(deployDir, { recursive: true })
    ]);
    await fs.writeFile(
      path.join(figmaDir, "SKILL.md"),
      "---\nname: figma-implement-design\ndescription: Implement designs from Figma\n---\nFigma workflow.",
      "utf8"
    );
    await fs.writeFile(
      path.join(securityDir, "SKILL.md"),
      "---\nname: security-threat-model\ndescription: Build a repository threat model\n---\nSecurity workflow.",
      "utf8"
    );
    await fs.writeFile(
      path.join(deployDir, "SKILL.md"),
      "---\nname: vercel-deploy\ndescription: Deploy applications to Vercel\n---\nDeployment workflow.",
      "utf8"
    );

    const skills = await loadSkillsFromRoots([{ path: root, scope: "user" }]);

    expect(skills.find((skill) => skill.name === "figma-implement-design")).toMatchObject({
      domain: "前端",
      description: expect.stringContaining("Figma 设计")
    });
    expect(skills.find((skill) => skill.name === "security-threat-model")).toMatchObject({
      domain: "安全",
      description: expect.stringContaining("威胁模型")
    });
    expect(skills.find((skill) => skill.name === "vercel-deploy")).toMatchObject({
      domain: "交付运维",
      description: expect.stringContaining("Vercel")
    });
  });

  it("deduplicates standalone names while preserving project overrides and plugin namespaces", async () => {
    const appHome = await makeTempDir();
    const projectRoot = await makeTempDir();
    const systemDir = path.join(appHome, "skills", "system", "shared-skill");
    const importedDir = path.join(appHome, "skills", "imported", "shared-skill");
    const repoDir = path.join(projectRoot, ".codexh", "skills", "shared-skill");
    const pluginDir = path.join(appHome, "plugins", "shared-skill");
    await Promise.all([
      fs.mkdir(systemDir, { recursive: true }),
      fs.mkdir(importedDir, { recursive: true }),
      fs.mkdir(repoDir, { recursive: true }),
      fs.mkdir(pluginDir, { recursive: true })
    ]);
    await fs.writeFile(path.join(systemDir, "SKILL.md"), "---\nname: shared-skill\ndescription: System version\n---\nSystem.", "utf8");
    await fs.writeFile(path.join(importedDir, "SKILL.md"), "---\nname: shared-skill\ndescription: Imported version\n---\nImported.", "utf8");
    await fs.writeFile(path.join(repoDir, "SKILL.md"), "---\nname: shared-skill\ndescription: Project version\n---\nProject.", "utf8");
    await fs.writeFile(path.join(pluginDir, "SKILL.md"), "---\nname: shared-skill\ndescription: Plugin version\n---\nPlugin.", "utf8");

    const manager = new SkillsManager();
    const skills = await manager.refresh(appHome, projectRoot, [{
      path: pluginDir,
      scope: "user",
      pluginId: "example-plugin"
    }]);
    const standalone = skills.filter((skill) => !skill.pluginId && skill.name === "shared-skill");

    expect(standalone).toHaveLength(1);
    expect(standalone[0]).toMatchObject({ scope: "repo", description: "Project version" });
    expect(skills.find((skill) => skill.qualifiedName === "example-plugin:shared-skill")).toBeDefined();
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

  it("routes generic Word delivery to file skills without implicitly loading Notion", async () => {
    const appHome = await makeTempDir();
    const definitions = [
      ["artifact-writer", "Generate Word PDF and other user-visible deliverables", "系统"],
      ["file-protocol", "Return downloadable files", "输出与文件"],
      ["notion-knowledge-capture", "Capture conversations into Notion documentation", "文档"],
      ["notion-meeting-intelligence", "Prepare meetings from Notion", "文档"],
      ["notion-research-documentation", "Research Notion and produce reports", "文档"]
    ] as const;
    for (const [name, description, domain] of definitions) {
      const skillDir = path.join(appHome, "skills", "imported", name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\ndomain: ${domain}\n---\n${description}.`,
        "utf8"
      );
    }

    const manager = new SkillsManager();
    await manager.refresh(appHome);
    const wordSkills = manager.selectForThread({
      explicitSkillIds: [],
      query: "把刚刚找到的 A2 和 TM 代码总结成 Word doc 文档"
    });
    expect(wordSkills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["artifact-writer", "file-protocol"]));
    expect(wordSkills.some((skill) => skill.name.startsWith("notion-"))).toBe(false);

    const notionSkills = manager.selectForThread({
      explicitSkillIds: [],
      query: "把这次讨论整理到 Notion 文档"
    });
    expect(notionSkills.filter((skill) => skill.name.startsWith("notion-"))).toHaveLength(1);
  });

  it("does not recommend implicit Skills when the request has no relevance evidence", async () => {
    const appHome = await makeTempDir();
    const definitions = [
      ["deploy-static-site", "Deploy a local frontend project to a Linux server", "交付运维"],
      ["code-review", "Review a branch diff before merge", "代码协作"],
      ["api-card-editor", "Create or update an API request card", "通用"]
    ] as const;
    for (const [name, description, domain] of definitions) {
      const skillDir = path.join(appHome, "skills", "imported", name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\ndomain: ${domain}\n---\n${description}.`,
        "utf8"
      );
    }

    const manager = new SkillsManager();
    await manager.refresh(appHome);
    const selected = manager.selectForThread({
      explicitSkillIds: [],
      query: "给我找一下 国内有没有 一键生成精灵图的网站"
    });

    expect(selected).toEqual([]);
  });
});
