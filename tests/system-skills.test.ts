import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedSystemSkills } from "../apps/desktop/src/main/storage";
import { loadSkillsFromRoots } from "@skills-runtime";

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-system-skills-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("seedSystemSkills", () => {
  it("installs Code Change Test Report as an implicitly available testing skill", async () => {
    const skillsRoot = await makeTempDir();

    await seedSystemSkills(skillsRoot);

    const skills = await loadSkillsFromRoots([{ path: skillsRoot, scope: "system" }]);
    const skill = skills.find((entry) => entry.name === "code-change-test-report");
    const metadata = await fs.readFile(
      path.join(skillsRoot, "programming", "code-change-test-report", "agents", "openai.yaml"),
      "utf8"
    );

    expect(skill).toMatchObject({
      displayName: "Code Change Test Report",
      domain: "测试",
      allowImplicitInvocation: true
    });
    expect(skill?.description).toContain("代码修改后");
    expect(metadata).toContain("default_prompt: 检查最终代码改动");
  });

  it("does not overwrite a customized Code Change Test Report skill", async () => {
    const skillsRoot = await makeTempDir();
    const skillDirectory = path.join(skillsRoot, "programming", "code-change-test-report");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      skillPath,
      "---\nname: code-change-test-report\ndescription: Customized workflow\n---\nKeep this version.\n",
      "utf8"
    );

    await seedSystemSkills(skillsRoot);

    await expect(fs.readFile(skillPath, "utf8")).resolves.toContain("Keep this version.");
  });
});
