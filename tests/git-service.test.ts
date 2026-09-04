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
      localBranches: [],
      remoteBranches: [],
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
      expect(snapshot.localBranches).toEqual(expect.arrayContaining(["main", "feature/test"]));
      expect(snapshot.remoteBranches).toEqual([]);

      const result = await service.switchBranch(root, "feature/test");
      expect(result.ok).toBe(true);
      expect(result.snapshot.branch).toBe("feature/test");
    });
  });

  it("lists a remote branch and creates its local tracking branch when selected", async () => {
    await withGitRepository(async (root) => {
      const remote = path.join(root, ".test-remote.git");
      await git(root, "init", "--bare", remote);
      await git(root, "remote", "add", "origin", remote);
      await git(root, "push", "origin", "main:refs/heads/remote-only");
      await git(root, "fetch", "origin");

      const service = new GitService();
      const snapshot = await service.snapshot(root);
      expect(snapshot.branches).toContain("origin/remote-only");
      expect(snapshot.localBranches).toEqual(["main"]);
      expect(snapshot.remoteBranches).toContain("origin/remote-only");

      const result = await service.switchBranch(root, "refs/remotes/origin/remote-only");
      expect(result.ok).toBe(true);
      expect(result.snapshot.branch).toBe("remote-only");
      await expect(git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"))
        .resolves.toBe("origin/remote-only");
    });
  });

  it("normalizes a full local ref before passing it to git switch", async () => {
    await withGitRepository(async (root) => {
      await git(root, "branch", "feature/full-ref");

      const result = await new GitService().switchBranch(root, "refs/heads/feature/full-ref");

      expect(result.ok).toBe(true);
      expect(result.snapshot.branch).toBe("feature/full-ref");
    });
  });

  it("rejects an unknown branch without changing the current branch", async () => {
    await withGitRepository(async (root) => {
      const service = new GitService();
      const result = await service.switchBranch(root, "missing-branch");

      expect(result.ok).toBe(false);
      expect(result.message).toBe("分支不存在：missing-branch");
      expect(result.snapshot.branch).toBe("main");
      await expect(git(root, "branch", "--show-current")).resolves.toBe("main");
    });
  });

  it("creates and switches to a valid local branch", async () => {
    await withGitRepository(async (root) => {
      const result = await new GitService().createBranch(root, "feature/new-branch");

      expect(result.ok).toBe(true);
      expect(result.message).toBe("已创建并切换到分支 feature/new-branch");
      expect(result.snapshot.branch).toBe("feature/new-branch");
      expect(result.snapshot.localBranches).toContain("feature/new-branch");
      await expect(git(root, "branch", "--show-current")).resolves.toBe("feature/new-branch");
    });
  });

  it("rejects an existing local branch without switching", async () => {
    await withGitRepository(async (root) => {
      await git(root, "branch", "feature/existing");

      const result = await new GitService().createBranch(root, "feature/existing");

      expect(result.ok).toBe(false);
      expect(result.message).toBe("本地分支已存在：feature/existing");
      await expect(git(root, "branch", "--show-current")).resolves.toBe("main");
    });
  });

  it("rejects an invalid branch name without changing the repository", async () => {
    await withGitRepository(async (root) => {
      const result = await new GitService().createBranch(root, "feature bad");

      expect(result.ok).toBe(false);
      expect(result.message).toBe("分支名称无效：feature bad");
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
