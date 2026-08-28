import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitService } from "../apps/desktop/src/main/git-service";

const execFileAsync = promisify(execFile);

describe("GitService", () => {
  it("returns an unavailable snapshot when the task has no project folder", async () => {
    await expect(new GitService().snapshot(null)).resolves.toEqual({
      available: false,
      message: "当前任务未选择项目文件夹。",
      ahead: 0,
      behind: 0,
      branches: [],
      canCreatePullRequest: false,
      files: []
    });
  });

  it("lists local branches and switches to an existing branch", async () => {
    await withGitRepository(async (root) => {
      await git(root, "branch", "feature/test");

      const service = new GitService();
      const snapshot = await service.snapshot(root);
      expect(snapshot.branches).toEqual(expect.arrayContaining(["main", "feature/test"]));

      const result = await service.switchBranch(root, "feature/test");
      expect(result.ok).toBe(true);
      expect(result.snapshot.branch).toBe("feature/test");
    });
  });

  it("rejects an unknown branch without changing the current branch", async () => {
    await withGitRepository(async (root) => {
      const service = new GitService();
      const result = await service.switchBranch(root, "missing-branch");

      expect(result.ok).toBe(false);
      expect(result.message).toBe("本地分支不存在：missing-branch");
      expect(result.snapshot.branch).toBe("main");
      await expect(git(root, "branch", "--show-current")).resolves.toBe("main");
    });
  });
});

async function withGitRepository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-git-service-"));
  try {
    await git(root, "init", "--initial-branch=main");
    await git(root, "config", "user.email", "codexh-test@example.invalid");
    await git(root, "config", "user.name", "CodeXH Test");
    await fs.writeFile(path.join(root, "README.md"), "initial\n", "utf8");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "initial");
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return result.stdout.trim();
}
