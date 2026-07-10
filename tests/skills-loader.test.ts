import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromRoots, type SkillRootDefinition } from "@skills-runtime";

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
});
