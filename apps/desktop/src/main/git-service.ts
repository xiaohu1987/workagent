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
  /** true = 这个文件的逐行差异被主动省略（hunk 行数超过 MAX_HUNK_LINES）。 */
  diffOmitted?: boolean;
};

type ParsedStatus = {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: Map<string, Omit<GitFileChange, "binary" | "additions" | "deletions" | "stagedHunks" | "unstagedHunks">>;
};

type BranchRefs = {
  local: Set<string>;
  remote: Set<string>;
};

type LineCount = {
  additions: number;
  deletions: number;
};

/**
 * 快照的逐行差异闸门。文件数由 `git status` 白送，所以在付 diff 的代价之前就能判断规模。
 *
 * 参照实测（2026-09-22，`D:\学习\Tools\tools`，11052 个已暂存文件、含整个 node_modules）：
 * - 全量 `git diff --cached`：156 MB / 167 万行 / 11.4 秒，逐行解析后整份交给渲染层 → 界面卡死；
 * - `git diff --cached --numstat -z`：617 KB / 6.2 秒，只给增删行数，不产生 hunks。
 */
type DiffMode = "full" | "numstat" | "status-only";

/** 变更文件数 ≤ 该值时正常解析逐行差异。 */
const MAX_FULL_DIFF_FILES = 400;
/** 变更文件数 ≤ 该值时只取增删行数（numstat）；再往上连 numstat 也跳过。 */
const MAX_NUMSTAT_FILES = 4000;
/** 单次 diff 输出体积上限，兜住"文件数不多但单个文件极大"的情况。 */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
/** 单个文件的 hunk 总行数上限，超过就只省略这个文件的逐行差异。 */
const MAX_HUNK_LINES = 20_000;

const EMPTY_SNAPSHOT: GitSnapshot = {
  available: false,
  ahead: 0,
  behind: 0,
  branches: [],
  localBranches: [],
  remoteBranches: [],
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
    // 先判断，再花钱：文件数决定要不要解析逐行差异。
    const diffMode: DiffMode = changedFiles.length > MAX_NUMSTAT_FILES
      ? "status-only"
      : changedFiles.length > MAX_FULL_DIFF_FILES ? "numstat" : "full";
    const hasStagedChanges = diffMode === "full" && changedFiles.some((file) => file.staged);
    const hasTrackedUnstagedChanges = diffMode === "full" && changedFiles.some((file) => file.unstaged && !file.untracked);
    const emptyDiff: GitCommandResult = { code: 0, stdout: "", stderr: "" };
    const [headResult, stagedResult, unstagedResult, remoteResult, branchesResult] = await Promise.all([
      runGit(root, ["rev-parse", "--short", "HEAD"]),
      hasStagedChanges
        ? runGit(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"])
        : Promise.resolve(emptyDiff),
      hasTrackedUnstagedChanges
        ? runGit(root, ["diff", "--no-ext-diff", "--no-color", "--unified=3"])
        : Promise.resolve(emptyDiff),
      status.branch ? runGit(root, ["remote", "get-url", "origin"]) : Promise.resolve(emptyDiff),
      runGit(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
    ]);
    // 文件数没超闸门时仍可能被单个巨型文件撑爆输出，用体积再兜一道底。
    const diffOmitted = diffMode !== "full"
      || stagedResult.stdout.length > MAX_DIFF_BYTES
      || unstagedResult.stdout.length > MAX_DIFF_BYTES;
    const stagedDiffs = diffOmitted ? null : parseDiff(stagedResult.stdout, "staged");
    const unstagedDiffs = diffOmitted ? null : parseDiff(unstagedResult.stdout, "unstaged");
    // 逐行差异被省略时改用 --numstat 补回增删行数：输出量与文件数成正比，与单个文件体量无关。
    // 两个 numstat 一起喂给解析器，同一路径在两处的计数会自然累加。
    const lineCounts = diffOmitted && diffMode !== "status-only"
      ? parseNumstat((await Promise.all([
        runGit(root, ["diff", "--cached", "--numstat", "-z"]),
        runGit(root, ["diff", "--numstat", "-z"])
      ])).map((result) => result.stdout).join(""))
      : new Map<string, LineCount>();
    const paths = new Set([...status.files.keys(), ...(stagedDiffs?.keys() ?? []), ...(unstagedDiffs?.keys() ?? [])]);
    const files = [...paths].map((path) => {
      const statusFile = status.files.get(path) ?? emptyFile(path);
      const staged = stagedDiffs?.get(path);
      const unstaged = unstagedDiffs?.get(path);
      const counts = lineCounts.get(path);
      const change: GitFileChange = {
        ...statusFile,
        binary: Boolean(staged?.binary || unstaged?.binary),
        additions: staged || unstaged ? (staged?.additions ?? 0) + (unstaged?.additions ?? 0) : counts?.additions ?? 0,
        deletions: staged || unstaged ? (staged?.deletions ?? 0) + (unstaged?.deletions ?? 0) : counts?.deletions ?? 0,
        stagedHunks: staged?.hunks.map((hunk) => hunk.publicHunk) ?? [],
        unstagedHunks: unstaged?.hunks.map((hunk) => hunk.publicHunk) ?? []
      };
      // 只在省略时打标记，避免给上万个文件各加一段无用字段。
      if (diffOmitted || staged?.diffOmitted || unstaged?.diffOmitted) change.diffOmitted = true;
      return change;
    }).sort((left, right) => left.path.localeCompare(right.path));
    const diffOmittedFiles = files.filter((file) => file.diffOmitted).length;
    const remoteUrl = remoteResult.code === 0 ? remoteResult.stdout.trim() : "";
    const comparison = buildPullRequestUrl(remoteUrl, status.branch, status.upstream);

    const branchRefs = branchesResult.code === 0
      ? parseBranchRefs(branchesResult.stdout)
      : { local: new Set(status.branch ? [status.branch] : []), remote: new Set<string>() };

    return {
      available: true,
      root,
      head: headResult.code === 0 ? headResult.stdout.trim() : undefined,
      branch: status.branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      branches: getSwitchableBranchNames(branchRefs),
      localBranches: [...branchRefs.local].sort((left, right) => left.localeCompare(right)),
      remoteBranches: [...branchRefs.remote].sort((left, right) => left.localeCompare(right)),
      canCreatePullRequest: Boolean(comparison),
      files,
      ...(diffOmitted ? { diffOmitted: true, diffOmittedFiles } : {})
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
    const root = await this.getRoot(cwd);
    if (!root) return this.failure(cwd, "当前项目不是 Git 仓库。");
    // 预检只需要分支名与上游，用两条轻量 rev-parse 代替一整份快照：
    // 「一键提交」会连着走 stageAll → commit → push，每一步都重建全量快照代价太高。
    const [branchResult, upstreamResult] = await Promise.all([
      runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    ]);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
    if (!branch || branch === "HEAD") return this.failure(root, "detached HEAD 状态下无法推送，请先创建分支。");
    const hasUpstream = upstreamResult.code === 0 && Boolean(upstreamResult.stdout.trim());
    const result = await runGit(root, hasUpstream ? ["push"] : ["push", "-u", "origin", branch]);
    if (result.code !== 0) return this.failure(root, result.stderr.trim() || "推送失败。");
    return { ok: true, message: "已推送分支", snapshot: await this.snapshot(root) };
  }

  public async pull(cwd: string): Promise<GitActionResult> {
    const snapshot = await this.snapshot(cwd);
    if (!snapshot.available || !snapshot.root) return { ok: false, message: snapshot.message ?? "当前项目不是 Git 仓库。", snapshot };
    if (!snapshot.upstream) return { ok: false, message: "当前分支没有上游分支，无法拉取。", snapshot };
    const result = await runGit(snapshot.root, ["pull", "--ff-only"]);
    if (result.code !== 0) return this.failure(snapshot.root, result.stderr.trim() || "拉取失败。请先处理本地修改或冲突。");
    return { ok: true, message: "已拉取远端更新", snapshot: await this.snapshot(snapshot.root) };
  }

  public async switchBranch(cwd: string, branch: string): Promise<GitActionResult> {
    const root = await this.getRoot(cwd);
    if (!root) return this.failure(cwd, "当前项目不是 Git 仓库。");
    const requested = branch.trim();
    if (!requested) return this.failure(root, "请选择要切换的分支。");
    let refs = await this.readBranchRefs(root);
    let target = resolveSwitchBranchTarget(requested, refs);
    let remoteRefsFresh = false;
    if (!target) {
      // 本地还没有该分支的远程引用（例如远端新建的分支）：先抓取一次再重试。
      const discovery = await this.fetchRemoteRefs(root, null);
      remoteRefsFresh = discovery.code === 0;
      refs = await this.readBranchRefs(root, refs);
      target = resolveSwitchBranchTarget(requested, refs);
      if (!target) return this.failure(root, `分支不存在：${requested}`);
    }

    let displayName = target.name;
    let args: string[];
    if (target.kind === "local") {
      args = ["switch", target.name];
    } else {
      const separator = target.name.indexOf("/");
      const remoteName = target.name.slice(0, separator);
      const localName = target.name.slice(separator + 1);
      if (!remoteName || !localName || localName === "HEAD") return this.failure(root, `无法直接切换远端引用：${target.name}`);
      if (!remoteRefsFresh) {
        // 先把远端分支拉取到本地，避免基于过期的远程引用创建无用的跟踪分支。
        const fetched = await this.fetchRemoteRefs(root, remoteName);
        if (fetched.code !== 0) {
          return this.failure(root, fetched.stderr.trim() || "从远端获取分支失败，请检查网络后重试。");
        }
        refs = await this.readBranchRefs(root, refs);
        if (!refs.remote.has(target.name)) {
          return this.failure(root, `分支不存在：${requested}（远端可能已删除该分支）`);
        }
      }
      if (refs.local.has(localName)) {
        displayName = localName;
        args = ["switch", localName];
      } else {
        displayName = localName;
        args = ["switch", "--track", "-c", localName, target.name];
      }
    }
    const result = await runGit(root, args);
    if (result.code !== 0) {
      return this.failure(root, result.stderr.trim() || "切换分支失败，请先处理会被覆盖的本地修改。");
    }
    return { ok: true, message: `已切换到分支 ${displayName}`, snapshot: await this.snapshot(root) };
  }

  private async readBranchRefs(root: string, fallback?: BranchRefs): Promise<BranchRefs> {
    const result = await runGit(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]);
    if (result.code !== 0) return fallback ?? { local: new Set<string>(), remote: new Set<string>() };
    return parseBranchRefs(result.stdout);
  }

  /** 拉取远端引用：指定远端时用通配 refspec 确保所有分支可见，否则抓取全部已配置远端。 */
  private async fetchRemoteRefs(root: string, remote: string | null): Promise<GitCommandResult> {
    const env = { GIT_TERMINAL_PROMPT: "0" };
    return remote
      ? runGit(root, ["fetch", "--prune", remote, `+refs/heads/*:refs/remotes/${remote}/*`], undefined, env)
      : runGit(root, ["fetch", "--all", "--prune"], undefined, env);
  }

  public async createBranch(cwd: string, branch: string): Promise<GitActionResult> {
    const root = await this.getRoot(cwd);
    if (!root) return this.failure(cwd, "当前项目不是 Git 仓库。");
    const name = branch.trim();
    if (!name) return this.failure(root, "请输入新分支名称。");

    const valid = await runGit(root, ["check-ref-format", "--branch", name]);
    if (valid.code !== 0) return this.failure(root, `分支名称无效：${name}`);

    const existing = await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    if (existing.code === 0) return this.failure(root, `本地分支已存在：${name}`);
    if (existing.code !== 1) return this.failure(root, existing.stderr.trim() || "无法检查分支是否存在。");

    const result = await runGit(root, ["switch", "-c", name]);
    if (result.code !== 0) return this.failure(root, result.stderr.trim() || "创建分支失败。");
    return { ok: true, message: `已创建并切换到分支 ${name}`, snapshot: await this.snapshot(root) };
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

function parseBranchRefs(output: string): BranchRefs {
  const refs: BranchRefs = { local: new Set(), remote: new Set() };
  for (const line of output.split(/\r?\n/)) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) {
      refs.local.add(ref.slice("refs/heads/".length));
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (!name.endsWith("/HEAD")) refs.remote.add(name);
    }
  }
  return refs;
}

function getSwitchableBranchNames(refs: BranchRefs): string[] {
  return [...new Set([...refs.local, ...refs.remote])].sort((left, right) => left.localeCompare(right));
}

function resolveSwitchBranchTarget(
  requested: string,
  refs: BranchRefs
): { kind: "local" | "remote"; name: string } | null {
  const explicitLocal = requested.startsWith("refs/heads/")
    ? requested.slice("refs/heads/".length)
    : requested.startsWith("heads/")
      ? requested.slice("heads/".length)
      : null;
  if (explicitLocal && refs.local.has(explicitLocal)) return { kind: "local", name: explicitLocal };

  const explicitRemote = requested.startsWith("refs/remotes/")
    ? requested.slice("refs/remotes/".length)
    : requested.startsWith("remotes/")
      ? requested.slice("remotes/".length)
      : null;
  if (explicitRemote && refs.remote.has(explicitRemote)) return { kind: "remote", name: explicitRemote };
  if (refs.local.has(requested)) return { kind: "local", name: requested };
  if (refs.remote.has(requested)) return { kind: "remote", name: requested };
  return null;
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
  const binary = lines.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
  const hunkIndexes = lines.map((line, index) => line.startsWith("@@ ") ? index : -1).filter((index) => index >= 0);
  const hunkStart = hunkIndexes[0] ?? lines.length;
  // 单个文件的 hunk 行数过大时提前放弃逐行差异（例如被误暂存的打包产物）。
  // 这里只做一次线性计数，不构造任何对象，因此比解析完再丢弃便宜得多。
  if (lines.length - hunkStart > MAX_HUNK_LINES) {
    let additions = 0;
    let deletions = 0;
    for (let index = hunkStart; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    return { path, binary, additions, deletions, hunks: [], diffOmitted: true };
  }
  const header = lines.slice(0, hunkStart).join("\n");
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
    // id 由 (来源, 路径, patch) 决定，两处完全相同 —— 只算一次 sha256。
    const id = createHash("sha256").update(`${source}\0${path}\0${patch}`).digest("hex").slice(0, 20);
    hunks.push({
      id,
      header: hunkLines[0],
      patch,
      publicHunk: { id, header: hunkLines[0], lines: parsedLines }
    });
  }
  return { path, binary, additions, deletions, hunks };
}

/**
 * 解析 `git diff --numstat -z` 的输出，用于「省略逐行差异」时仍然给出增删行数。
 * 格式：`<added>\t<deleted>\t<path>\0`；二进制文件的行数是 `-`；
 * 重命名时路径字段为空，改由后面两个字段带上旧路径与新路径。
 */
function parseNumstat(output: string): Map<string, LineCount> {
  const counts = new Map<string, LineCount>();
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const addedTab = field.indexOf("\t");
    if (addedTab < 0) continue;
    const deletedTab = field.indexOf("\t", addedTab + 1);
    if (deletedTab < 0) continue;
    let filePath = field.slice(deletedTab + 1);
    if (!filePath) {
      index += 2;
      filePath = fields[index] ?? "";
    }
    if (!filePath) continue;
    const additions = toLineCount(field.slice(0, addedTab));
    const deletions = toLineCount(field.slice(addedTab + 1, deletedTab));
    const current = counts.get(filePath);
    if (current) {
      current.additions += additions;
      current.deletions += deletions;
    } else {
      counts.set(filePath, { additions, deletions });
    }
  }
  return counts;
}

/** numstat 对二进制文件输出 `-`，按 0 计。 */
function toLineCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
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

function runGit(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : undefined });
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
