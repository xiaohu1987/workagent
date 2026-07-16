import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { GitActionResult, GitDiffLine, GitFileChange, GitHunk, GitSnapshot } from "@shared-types";

type GitCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type ParsedHunk = {
  id: string;
  header: string;
  patch: string;
  publicHunk: GitHunk;
};

type ParsedDiffFile = {
  path: string;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: ParsedHunk[];
};

type ParsedStatus = {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: Map<string, Omit<GitFileChange, "binary" | "additions" | "deletions" | "stagedHunks" | "unstagedHunks">>;
};

const EMPTY_SNAPSHOT: GitSnapshot = {
  available: false,
  ahead: 0,
  behind: 0,
  canCreatePullRequest: false,
  files: []
};

/** Git operations used by the desktop Changes workspace. Commands are always argument based. */
export class GitService {
  public async snapshot(cwd: string | null): Promise<GitSnapshot> {
    if (!cwd) {
      return {
        ...EMPTY_SNAPSHOT,
        message: "当前任务未选择项目文件夹。"
      };
    }

    const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (rootResult.code !== 0) {
      return {
        ...EMPTY_SNAPSHOT,
        message: rootResult.error?.includes("ENOENT") ? "未找到 Git，请安装 Git 后重试。" : "当前项目不是 Git 仓库。"
      };
    }

    const root = rootResult.stdout.trim();
    const statusResult = await runGit(root, ["status", "--porcelain=v2", "-z", "--branch"]);
    if (statusResult.code !== 0) {
      return { ...EMPTY_SNAPSHOT, message: statusResult.stderr.trim() || "无法读取 Git 状态。" };
    }

    const status = parseStatus(statusResult.stdout);
    const changedFiles = [...status.files.values()];
    const hasStagedChanges = changedFiles.some((file) => file.staged);
    const hasTrackedUnstagedChanges = changedFiles.some((file) => file.unstaged && !file.untracked);
    const emptyDiff: GitCommandResult = { code: 0, stdout: "", stderr: "" };
    const [headResult, stagedResult, unstagedResult, remoteResult] = await Promise.all([
      runGit(root, ["rev-parse", "--short", "HEAD"]),
      hasStagedChanges
        ? runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"])
        : Promise.resolve(emptyDiff),
      hasTrackedUnstagedChanges
        ? runGit(root, ["diff", "--no-ext-diff", "--no-color", "--unified=3"])
        : Promise.resolve(emptyDiff),
      status.branch ? runGit(root, ["remote", "get-url", "origin"]) : Promise.resolve(emptyDiff)
    ]);
    const stagedDiffs = parseDiff(stagedResult.stdout, "staged");
    const unstagedDiffs = parseDiff(unstagedResult.stdout, "unstaged");
    const paths = new Set([...status.files.keys(), ...stagedDiffs.keys(), ...unstagedDiffs.keys()]);
    const files = [...paths].map((path) => {
      const statusFile = status.files.get(path) ?? emptyFile(path);
      const staged = stagedDiffs.get(path);
      const unstaged = unstagedDiffs.get(path);
      return {
        ...statusFile,
        binary: Boolean(staged?.binary || unstaged?.binary),
        additions: (staged?.additions ?? 0) + (unstaged?.additions ?? 0),
        deletions: (staged?.deletions ?? 0) + (unstaged?.deletions ?? 0),
        stagedHunks: staged?.hunks.map((hunk) => hunk.publicHunk) ?? [],
        unstagedHunks: unstaged?.hunks.map((hunk) => hunk.publicHunk) ?? []
      } satisfies GitFileChange;
    }).sort((left, right) => left.path.localeCompare(right.path));
    const remoteUrl = remoteResult.code === 0 ? remoteResult.stdout.trim() : "";
    const comparison = buildPullRequestUrl(remoteUrl, status.branch, status.upstream);

    return {
      available: true,
      root,
      head: headResult.code === 0 ? headResult.stdout.trim() : undefined,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      canCreatePullRequest: Boolean(comparison),
      files
    };
  }

  public async stageFile(cwd: string, filePath: string): Promise<GitActionResult> {
    return this.mutate(cwd, ["add", "--", filePath], `已暂存 ${filePath}`);
  }

  public async stageAll(cwd: string): Promise<GitActionResult> {
    return this.mutate(cwd, ["add", "-A"], "已暂存所有变更");
  }

  public async unstageFile(cwd: string, filePath: string): Promise<GitActionResult> {
    return this.mutate(cwd, ["restore", "--staged", "--", filePath], `已取消暂存 ${filePath}`);
  }

  public async revertFile(cwd: string, filePath: string, untracked = false): Promise<GitActionResult> {
    return this.mutate(
      cwd,
      untracked ? ["clean", "-f", "--", filePath] : ["restore", "--worktree", "--", filePath],
      untracked ? `已删除未跟踪文件 ${filePath}` : `已撤销 ${filePath} 的未暂存修改`
    );
  }

  public async applyHunk(cwd: string, filePath: string, hunkId: string, source: "staged" | "unstaged", action: "stage" | "unstage" | "revert"): Promise<GitActionResult> {
    const root = await this.getRoot(cwd);
    if (!root) {
      return this.failure(cwd, "当前项目不是 Git 仓库。");
    }
    const diff = await runGit(root, source === "staged"
      ? ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"]
      : ["diff", "--no-ext-diff", "--no-color", "--unified=3"]);
    const target = parseDiff(diff.stdout, source).get(filePath)?.hunks.find((hunk) => hunk.id === hunkId);
    if (!target) {
      return this.failure(root, "修改已变化，无法应用此块。请刷新后重试。");
    }
    const args = ["apply"];
    if (action !== "stage") args.push("-R");
    if (action === "stage" || action === "unstage") args.push("--cached");
    const result = await runGit(root, args, target.patch);
    if (result.code !== 0) {
      return this.failure(root, result.stderr.trim() || "无法应用此修改块。请刷新后重试。");
    }
    const label = action === "stage" ? "已暂存修改块" : action === "unstage" ? "已取消暂存修改块" : "已撤销修改块";
    return { ok: true, message: label, snapshot: await this.snapshot(root) };
  }

  public async commit(cwd: string, message: string): Promise<GitActionResult> {
    const root = await this.getRoot(cwd);
    if (!root) return this.failure(cwd, "当前项目不是 Git 仓库。");
    const subject = message.trim();
    if (!subject) return this.failure(root, "请输入提交说明。");
    const staged = await runGit(root, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return this.failure(root, "没有已暂存的修改可提交。");
    if (staged.code !== 1) return this.failure(root, staged.stderr.trim() || "无法检查暂存区。");
    const result = await runGit(root, ["commit", "-m", subject]);
    if (result.code !== 0) return this.failure(root, result.stderr.trim() || "提交失败。");
    return { ok: true, message: "已创建提交", snapshot: await this.snapshot(root) };
  }

  public async push(cwd: string): Promise<GitActionResult> {
    const snapshot = await this.snapshot(cwd);
    if (!snapshot.available || !snapshot.root) return { ok: false, message: snapshot.message ?? "当前项目不是 Git 仓库。", snapshot };
    if (!snapshot.branch) return { ok: false, message: "detached HEAD 状态下无法推送，请先创建分支。", snapshot };
    const args = snapshot.upstream ? ["push"] : ["push", "-u", "origin", snapshot.branch];
    const result = await runGit(snapshot.root, args);
    if (result.code !== 0) return this.failure(snapshot.root, result.stderr.trim() || "推送失败。");
    return { ok: true, message: "已推送分支", snapshot: await this.snapshot(snapshot.root) };
  }

  public async pull(cwd: string): Promise<GitActionResult> {
    const snapshot = await this.snapshot(cwd);
    if (!snapshot.available || !snapshot.root) return { ok: false, message: snapshot.message ?? "当前项目不是 Git 仓库。", snapshot };
    if (!snapshot.upstream) return { ok: false, message: "当前分支没有上游分支，无法拉取。", snapshot };
    const result = await runGit(snapshot.root, ["pull", "--ff-only"]);
    if (result.code !== 0) return this.failure(snapshot.root, result.stderr.trim() || "拉取失败。请先处理本地修改或冲突。");
    return { ok: true, message: "已拉取远端更新", snapshot: await this.snapshot(snapshot.root) };
  }

  public async createPullRequest(cwd: string): Promise<GitActionResult> {
    const snapshot = await this.snapshot(cwd);
    if (!snapshot.available || !snapshot.root) return { ok: false, message: snapshot.message ?? "当前项目不是 Git 仓库。", snapshot };
    const remote = await runGit(snapshot.root, ["remote", "get-url", "origin"]);
    const url = remote.code === 0 ? buildPullRequestUrl(remote.stdout.trim(), snapshot.branch, snapshot.upstream) : null;
    if (!url) return { ok: false, message: "当前远端不是可识别的 GitHub 仓库，无法创建 Pull Request。", snapshot };
    return { ok: true, message: "已打开创建 Pull Request 页面", snapshot, pullRequestUrl: url };
  }

  private async mutate(cwd: string, args: string[], success: string): Promise<GitActionResult> {
    const root = await this.getRoot(cwd);
    if (!root) return this.failure(cwd, "当前项目不是 Git 仓库。");
    const result = await runGit(root, args);
    if (result.code !== 0) return this.failure(root, result.stderr.trim() || "Git 操作失败。");
    return { ok: true, message: success, snapshot: await this.snapshot(root) };
  }

  private async failure(cwd: string, message: string): Promise<GitActionResult> {
    return { ok: false, message, snapshot: await this.snapshot(cwd) };
  }

  private async getRoot(cwd: string): Promise<string | null> {
    const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return result.code === 0 ? result.stdout.trim() : null;
  }
}

function emptyFile(path: string): Omit<GitFileChange, "binary" | "additions" | "deletions" | "stagedHunks" | "unstagedHunks"> {
  return { path, indexStatus: ".", worktreeStatus: ".", staged: false, unstaged: false, untracked: false, conflicted: false };
}

function parseStatus(output: string): ParsedStatus {
  const parsed: ParsedStatus = { ahead: 0, behind: 0, files: new Map() };
  const tokens = output.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith("# branch.head ")) {
      const branch = token.slice("# branch.head ".length);
      parsed.branch = branch === "(detached)" ? undefined : branch;
      continue;
    }
    if (token.startsWith("# branch.upstream ")) {
      parsed.upstream = token.slice("# branch.upstream ".length);
      continue;
    }
    if (token.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(token);
      parsed.ahead = Number(match?.[1] ?? 0);
      parsed.behind = Number(match?.[2] ?? 0);
      continue;
    }
    if (token.startsWith("? ")) {
      const path = token.slice(2);
      parsed.files.set(path, { ...emptyFile(path), worktreeStatus: "?", untracked: true, unstaged: true });
      continue;
    }
    if (!/^[12u] /.test(token)) continue;
    const parts = token.split(" ");
    const xy = parts[1] ?? "..";
    const pathOffset = token.startsWith("u ") ? 10 : token.startsWith("2 ") ? 9 : 8;
    const filePath = parts.slice(pathOffset).join(" ");
    const originalPath = token.startsWith("2 ") ? tokens[++index] || undefined : undefined;
    const indexStatus = xy[0] ?? ".";
    const worktreeStatus = xy[1] ?? ".";
    parsed.files.set(filePath, {
      path: filePath,
      originalPath,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== ".",
      unstaged: worktreeStatus !== ".",
      untracked: false,
      conflicted: token.startsWith("u ") || xy.includes("U")
    });
  }
  return parsed;
}

function parseDiff(output: string, source: "staged" | "unstaged"): Map<string, ParsedDiffFile> {
  const result = new Map<string, ParsedDiffFile>();
  const lines = output.split("\n");
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const parsed = parseDiffFile(current, source);
    if (parsed) result.set(parsed.path, parsed);
    current = [];
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) flush();
    current.push(line);
  }
  flush();
  return result;
}

function parseDiffFile(lines: string[], source: "staged" | "unstaged"): ParsedDiffFile | null {
  const oldPath = lines.find((line) => line.startsWith("--- "));
  const newPath = lines.find((line) => line.startsWith("+++ "));
  const path = normalizeDiffPath(newPath?.slice(4)) ?? normalizeDiffPath(oldPath?.slice(4));
  if (!path) return null;
  const hunkIndexes = lines.map((line, index) => line.startsWith("@@ ") ? index : -1).filter((index) => index >= 0);
  const header = lines.slice(0, hunkIndexes[0] ?? lines.length).join("\n");
  const hunks: ParsedHunk[] = [];
  let additions = 0;
  let deletions = 0;
  for (let hunkIndex = 0; hunkIndex < hunkIndexes.length; hunkIndex += 1) {
    const start = hunkIndexes[hunkIndex];
    const end = hunkIndexes[hunkIndex + 1] ?? lines.length;
    const hunkLines = lines.slice(start, end);
    const parsedLines = parseHunkLines(hunkLines);
    additions += parsedLines.filter((line) => line.kind === "added").length;
    deletions += parsedLines.filter((line) => line.kind === "removed").length;
    const patch = `${header}\n${hunkLines.join("\n")}\n`;
    hunks.push({
      id: createHash("sha256").update(`${source}\0${path}\0${patch}`).digest("hex").slice(0, 20),
      header: hunkLines[0],
      patch,
      publicHunk: {
        id: createHash("sha256").update(`${source}\0${path}\0${patch}`).digest("hex").slice(0, 20),
        header: hunkLines[0],
        lines: parsedLines
      }
    });
  }
  return { path, binary: lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch"), additions, deletions, hunks };
}

function parseHunkLines(lines: string[]): GitDiffLine[] {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[0] ?? "");
  let oldLine = Number(header?.[1] ?? 0);
  let newLine = Number(header?.[3] ?? 0);
  return lines.map((content, index) => {
    if (index === 0) return { kind: "meta", content, oldLine: null, newLine: null };
    if (content.startsWith("+")) return { kind: "added", content: content.slice(1), oldLine: null, newLine: newLine++ };
    if (content.startsWith("-")) return { kind: "removed", content: content.slice(1), oldLine: oldLine++, newLine: null };
    if (content.startsWith("\\")) return { kind: "meta", content, oldLine: null, newLine: null };
    return { kind: "context", content: content.startsWith(" ") ? content.slice(1) : content, oldLine: oldLine++, newLine: newLine++ };
  });
}

function normalizeDiffPath(value?: string): string | null {
  if (!value || value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

function buildPullRequestUrl(remoteUrl: string, branch?: string, upstream?: string): string | null {
  if (!branch) return null;
  const match = /(?:github\.com[/:])([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(remoteUrl);
  if (!match) return null;
  const base = upstream?.replace(/^[^/]+\//, "") || "main";
  return `https://github.com/${match[1]}/${match[2]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}

function runGit(cwd: string, args: string[], input?: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr, error: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input) child.stdin.end(input, "utf8");
    else child.stdin.end();
  });
}
