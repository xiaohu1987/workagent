import type { GitActionResult, GitDiffLine, GitFileChange, GitHunk, GitSnapshot } from "@shared-types";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconComment,
  IconEye,
  IconFile,
  IconFileChanges,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSpinner,
  IconTrash,
  IconUndo
} from "../icons";
import { WorkspaceEmptyState } from "./panels";

type SideBySideDiffRow = {
  oldLine: number | null;
  oldContent: string;
  oldKind: GitDiffLine["kind"] | "empty";
  newLine: number | null;
  newContent: string;
  newKind: GitDiffLine["kind"] | "empty";
};

export type GitCommitProgress = {
  percent: number;
  label: string;
  state: "running" | "success" | "error";
};

type OneClickGitCommitOptions = {
  hasUnstagedFiles: boolean;
  stageAll: () => Promise<GitActionResult>;
  commit: () => Promise<GitActionResult>;
  push: () => Promise<GitActionResult>;
  onProgress: (progress: GitCommitProgress) => void;
  onCommitted: () => void;
};

export async function runOneClickGitCommit({
  hasUnstagedFiles,
  stageAll,
  commit,
  push,
  onProgress,
  onCommitted
}: OneClickGitCommitOptions): Promise<GitActionResult> {
  try {
    if (hasUnstagedFiles) {
      onProgress({ percent: 12, label: "正在暂存全部变更", state: "running" });
      const staged = await stageAll();
      if (!staged.ok) {
        onProgress({ percent: 12, label: staged.message, state: "error" });
        return staged;
      }
    }

    onProgress({ percent: 45, label: "正在创建提交", state: "running" });
    const committed = await commit();
    if (!committed.ok) {
      onProgress({ percent: 45, label: committed.message, state: "error" });
      return committed;
    }
    onCommitted();

    onProgress({ percent: 76, label: "提交已创建，正在推送", state: "running" });
    const pushed = await push();
    if (!pushed.ok) {
      onProgress({ percent: 76, label: pushed.message, state: "error" });
      return pushed;
    }

    const result = { ...pushed, message: "已提交并推送" };
    onProgress({ percent: 100, label: result.message, state: "success" });
    return result;
  } catch (error) {
    onProgress({
      percent: 0,
      label: error instanceof Error ? error.message : String(error),
      state: "error"
    });
    throw error;
  }
}

export function GitBranchPicker({
  snapshot,
  threadId,
  rootPath,
  busy,
  onAction
}: {
  snapshot: GitSnapshot;
  threadId: string | null;
  rootPath: string;
  busy: boolean;
  onAction: (action: () => Promise<GitActionResult>) => Promise<GitActionResult | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"local" | "remote">("local");
  const [query, setQuery] = useState("");
  const [createMode, setCreateMode] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const localBranches = snapshot.localBranches ?? snapshot.branches;
  const remoteBranches = snapshot.remoteBranches ?? [];
  const branches = tab === "local" ? localBranches : remoteBranches;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleBranches = normalizedQuery
    ? branches.filter((branch) => branch.toLocaleLowerCase().includes(normalizedQuery))
    : branches;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setQuery("");
    setCreateMode(false);
    setNewBranchName("");
    setBranchError(null);
  }, [rootPath, threadId]);

  const openPicker = () => {
    setOpen((current) => {
      const next = !current;
      if (next) {
        setBranchError(null);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      return next;
    });
  };
  const finishBranchAction = (result: GitActionResult | undefined) => {
    if (!result?.ok) {
      if (result?.message) setBranchError(result.message);
      return;
    }
    setOpen(false);
    setQuery("");
    setCreateMode(false);
    setNewBranchName("");
    setBranchError(null);
  };
  const switchBranch = async (branch: string) => {
    if (!threadId || busy) return;
    if (tab === "local" && branch === snapshot.branch) {
      setOpen(false);
      return;
    }
    setBranchError(null);
    finishBranchAction(await onAction(() => window.codexh.switchGitBranch({ threadId, rootPath, branch }) as Promise<GitActionResult>));
  };
  const createBranch = async () => {
    if (!threadId || busy || !newBranchName.trim()) return;
    setBranchError(null);
    finishBranchAction(await onAction(() => window.codexh.createGitBranch({
      threadId,
      rootPath,
      branch: newBranchName.trim()
    }) as Promise<GitActionResult>));
  };

  return (
    <div className="git-branch-picker" ref={pickerRef}>
      <button
        type="button"
        className="git-branch-trigger"
        title="切换或新建分支"
        aria-label="切换或新建 Git 分支"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={busy || !threadId}
        onClick={openPicker}
      >
        <IconFileChanges />
        <span>{snapshot.branch ?? "detached HEAD"}</span>
        <IconChevronDown />
      </button>
      {open ? (
        <div className="git-branch-popover" role="dialog" aria-label="选择 Git 分支">
          <div className="git-branch-search-row">
            <label className="git-branch-search">
              <IconSearch />
              <input
                ref={searchRef}
                value={query}
                placeholder="筛选分支"
                aria-label="筛选分支"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="git-branch-create-button"
              disabled={busy || !threadId}
              onClick={() => {
                setCreateMode(true);
                setBranchError(null);
                window.setTimeout(() => pickerRef.current?.querySelector<HTMLInputElement>(".git-branch-create-form input")?.focus(), 0);
              }}
            >
              <IconPlus />
              <span>新建分支</span>
            </button>
          </div>
          {createMode ? (
            <form className="git-branch-create-form" onSubmit={(event) => { event.preventDefault(); void createBranch(); }}>
              <input
                value={newBranchName}
                placeholder="输入新分支名称"
                aria-label="新分支名称"
                disabled={busy}
                onChange={(event) => { setNewBranchName(event.target.value); setBranchError(null); }}
              />
              <button type="submit" disabled={busy || !newBranchName.trim()}>创建并切换</button>
              <button type="button" className="git-branch-create-cancel" disabled={busy} onClick={() => { setCreateMode(false); setNewBranchName(""); }}>取消</button>
            </form>
          ) : null}
          {branchError ? <p className="git-branch-error" role="alert">{branchError}</p> : null}
          <div className="git-branch-tabs" role="tablist" aria-label="分支来源">
            <button type="button" role="tab" aria-selected={tab === "local"} className={tab === "local" ? "active" : ""} onClick={() => setTab("local")}>本地 <span>{localBranches.length}</span></button>
            <button type="button" role="tab" aria-selected={tab === "remote"} className={tab === "remote" ? "active" : ""} onClick={() => setTab("remote")}>远程 <span>{remoteBranches.length}</span></button>
          </div>
          <div className="git-branch-list" role="tabpanel" aria-label={tab === "local" ? "本地分支" : "远程分支"}>
            {visibleBranches.map((branch) => {
              const remoteSeparator = branch.indexOf("/");
              const remoteName = tab === "remote" && remoteSeparator > 0 ? branch.slice(0, remoteSeparator) : null;
              const displayName = remoteName ? branch.slice(remoteSeparator + 1) : branch;
              const current = tab === "local" && branch === snapshot.branch;
              return (
                <button
                  type="button"
                  key={`${tab}:${branch}`}
                  className={`git-branch-option ${current ? "is-current" : ""}`}
                  title={branch}
                  aria-current={current ? "true" : undefined}
                  disabled={busy}
                  onClick={() => void switchBranch(branch)}
                >
                  <IconFileChanges />
                  <span>{displayName}</span>
                  {remoteName ? <small>{remoteName}</small> : null}
                  {current ? <IconCheck /> : null}
                </button>
              );
            })}
            {visibleBranches.length === 0 ? <p className="git-branch-empty">{normalizedQuery ? "没有匹配的分支" : `没有${tab === "local" ? "本地" : "远程"}分支`}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const GitChangesWorkspace = memo(function GitChangesWorkspace({
  threadId,
  workspaceRoots,
  rootPath,
  onRootChange,
  snapshot,
  loading,
  busy,
  message,
  onRefresh,
  onAction,
  onComment
}: {
  threadId: string | null;
  workspaceRoots: string[];
  rootPath: string;
  onRootChange: (rootPath: string) => void;
  snapshot: GitSnapshot | null;
  loading: boolean;
  busy: boolean;
  message: string | null;
  onRefresh: () => void;
  onAction: (action: () => Promise<GitActionResult>) => Promise<GitActionResult | undefined>;
  onComment: (content: string) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitProgress, setCommitProgress] = useState<GitCommitProgress | null>(null);
  const files = snapshot?.files ?? [];
  const selected = files.find((file) => file.path === selectedPath) ?? null;
  const opened = files.find((file) => file.path === openedPath) ?? null;
  const hasStagedFiles = files.some((file) => file.staged);
  const hasUnstagedFiles = files.some((file) => file.unstaged || file.untracked);
  const canPush = Boolean(snapshot?.branch && (!snapshot.upstream || (snapshot.ahead ?? 0) > 0));
  const groups = useMemo(() => [
    { id: "conflicted", label: "冲突", files: files.filter((file) => file.conflicted) },
    { id: "staged", label: "暂存的更改", files: files.filter((file) => file.staged && !file.conflicted) },
    { id: "changes", label: "更改", files: files.filter((file) => file.unstaged && !file.untracked && !file.conflicted) },
    { id: "untracked", label: "未跟踪", files: files.filter((file) => file.untracked) }
  ], [files]);

  useEffect(() => {
    if (openedPath && !files.some((file) => file.path === openedPath)) setOpenedPath(null);
    if (selectedPath && !files.some((file) => file.path === selectedPath)) setSelectedPath(null);
  }, [files, openedPath, selectedPath]);

  useEffect(() => {
    setCommitMessage("");
    setCommitProgress(null);
  }, [rootPath, threadId]);

  const rootSelector = workspaceRoots.length > 1 ? (
    <select className="workspace-root-select" aria-label="Git 目录" title="切换 Git 目录" value={rootPath} disabled={busy} onChange={(event) => onRootChange(event.target.value)}>
      {workspaceRoots.map((root) => <option key={root} value={root}>{root}</option>)}
    </select>
  ) : null;

  if (loading && !snapshot) {
    return <section className="git-changes-workspace"><header className="git-changes-header">{rootSelector}</header><WorkspaceEmptyState icon={<IconSpinner />} title="Git 源代码管理" message="正在读取 Git 状态..." /></section>;
  }
  if (!snapshot?.available) {
    return <section className="git-changes-workspace"><header className="git-changes-header">{rootSelector}</header><WorkspaceEmptyState icon={<IconFileChanges />} title="Git 源代码管理" message={snapshot?.message ?? "当前项目不是 Git 仓库。"} /></section>;
  }

  const run = (action: () => Promise<GitActionResult>) => {
    if (!threadId || busy) return Promise.resolve(undefined);
    return onAction(action);
  };
  const fileAction = (action: "stage" | "unstage" | "revert", file: GitFileChange) => {
    if (!threadId) return;
    if (action === "stage") run(() => window.codexh.stageGitFile({ threadId, rootPath, path: file.path }) as Promise<GitActionResult>);
    if (action === "unstage") run(() => window.codexh.unstageGitFile({ threadId, rootPath, path: file.path }) as Promise<GitActionResult>);
    if (action === "revert") run(() => window.codexh.revertGitFile({ threadId, rootPath, path: file.path, untracked: file.untracked }) as Promise<GitActionResult>);
  };
  const oneClickCommit = () => {
    if (!threadId) return;
    const message = commitMessage.trim();
    run(() => runOneClickGitCommit({
      hasUnstagedFiles,
      stageAll: () => window.codexh.stageAllGitChanges({ threadId, rootPath }) as Promise<GitActionResult>,
      commit: () => window.codexh.commitGitChanges({ threadId, rootPath, message }) as Promise<GitActionResult>,
      push: () => window.codexh.pushGitChanges({ threadId, rootPath }) as Promise<GitActionResult>,
      onProgress: setCommitProgress,
      onCommitted: () => setCommitMessage("")
    }));
  };

  return (
    <section className={`git-changes-workspace ${opened ? "is-diff-open" : ""}`} aria-label="Git 源代码管理">
      <header className="git-changes-header">
        {rootSelector ? <div className="git-header-root-row">{rootSelector}</div> : null}
        <div className="git-header-branch-row">
          <GitBranchPicker snapshot={snapshot} threadId={threadId} rootPath={rootPath} busy={busy} onAction={onAction} />
          <div className="git-header-actions">
            <button type="button" className="git-icon-button" title="拉取" aria-label="拉取" disabled={busy || !threadId || !snapshot.upstream} onClick={() => threadId && run(() => window.codexh.pullGitChanges({ threadId, rootPath }) as Promise<GitActionResult>)}><IconArrowDown /></button>
            <button type="button" className="git-icon-button" title="推送" aria-label="推送" disabled={busy || !threadId || !canPush} onClick={() => threadId && run(() => window.codexh.pushGitChanges({ threadId, rootPath }) as Promise<GitActionResult>)}><IconArrowUp /></button>
            <button type="button" className="git-icon-button" title="刷新变更" aria-label="刷新变更" disabled={loading || busy} onClick={onRefresh}><IconRefresh /></button>
            {snapshot.canCreatePullRequest ? <button type="button" className="git-text-action" title="创建 Pull Request" disabled={busy} onClick={() => threadId && run(() => window.codexh.createGitPullRequest({ threadId, rootPath }) as Promise<GitActionResult>)}>PR</button> : null}
          </div>
        </div>
      </header>

      <div className="git-sync-summary">
        <span>↑ {snapshot.ahead ?? 0}</span>
        <span>↓ {snapshot.behind ?? 0}</span>
        <span title={snapshot.upstream ?? "没有上游分支"}>{snapshot.upstream ?? "未设置上游"}</span>
      </div>
      {message ? <p className="git-action-message" role="status">{message}</p> : null}

      {opened ? (
        <GitDiffView
          file={opened}
          busy={busy}
          threadId={threadId}
          rootPath={rootPath}
          onBack={() => setOpenedPath(null)}
          onFileAction={fileAction}
          onAction={onAction}
          onComment={onComment}
        />
      ) : (
        <>
          <section className="git-commit-panel" aria-label="提交更改">
            <textarea
              value={commitMessage}
              onChange={(event) => {
                setCommitMessage(event.target.value);
                if (commitProgress?.state !== "running") setCommitProgress(null);
              }}
              placeholder="输入提交消息（必需）"
              disabled={busy}
              rows={3}
            />
            <div className="git-commit-actions">
              <button
                type="button"
                className="git-one-click-commit-button"
                title="暂存全部变更、创建提交并推送"
                disabled={busy || !threadId || (!hasStagedFiles && !hasUnstagedFiles) || !commitMessage.trim()}
                onClick={oneClickCommit}
              >
                {busy && commitProgress?.state === "running" ? <IconSpinner /> : <IconCheck />}
                <span>{busy && commitProgress?.state === "running" ? "正在提交" : "一键提交"}</span>
              </button>
            </div>
            {commitProgress ? (
              <div className={`git-commit-progress is-${commitProgress.state}`} aria-live="polite">
                <div
                  className="git-commit-progress-track"
                  role="progressbar"
                  aria-label="Git 提交进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={commitProgress.percent}
                >
                  <span style={{ width: `${commitProgress.percent}%` }} />
                </div>
                <span>{commitProgress.label}</span>
                <b>{commitProgress.percent}%</b>
              </div>
            ) : null}
          </section>

          <div className="git-change-list" aria-label="变更文件">
            <p className="git-change-list-hint">双击文件查看变更前后对比</p>
            {groups.map((group) => group.files.length ? (
              <section key={group.id} className={`git-file-group ${group.id}`}>
                <h3>{group.label}<span>{group.files.length}</span></h3>
                {group.files.map((file) => (
                  <div key={`${group.id}:${file.path}`} className={`git-file-row-wrap ${selected?.path === file.path ? "active" : ""}`}>
                    <button
                      type="button"
                      className="git-file-row"
                      onClick={() => setSelectedPath(file.path)}
                      onDoubleClick={() => { setSelectedPath(file.path); setOpenedPath(file.path); }}
                      title={`${file.path}\n双击查看差异`}
                    >
                      <IconFile />
                      <span>{file.path}</span>
                      <small>{file.additions ? `+${file.additions}` : ""}{file.deletions ? ` −${file.deletions}` : ""}</small>
                      <b>{getFileStatusLabel(file)}</b>
                    </button>
                    <div className="git-file-row-actions">
                      {file.unstaged || file.untracked ? <button type="button" title="暂存文件" aria-label={`暂存 ${file.path}`} disabled={busy} onClick={() => fileAction("stage", file)}><IconPlus /></button> : null}
                      {file.staged ? <button type="button" title="取消暂存" aria-label={`取消暂存 ${file.path}`} disabled={busy} onClick={() => fileAction("unstage", file)}><IconUndo /></button> : null}
                    </div>
                  </div>
                ))}
              </section>
            ) : null)}
            {files.length === 0 ? <WorkspaceEmptyState icon={<IconFileChanges />} title="没有变更" message="工作区没有未提交的修改。" /> : null}
          </div>
        </>
      )}
    </section>
  );
}, (previous, next) =>
  previous.threadId === next.threadId &&
  previous.snapshot === next.snapshot &&
  previous.loading === next.loading &&
  previous.busy === next.busy &&
  previous.message === next.message
);

function GitDiffView({
  file,
  busy,
  threadId,
  rootPath,
  onBack,
  onFileAction,
  onAction,
  onComment
}: {
  file: GitFileChange;
  busy: boolean;
  threadId: string | null;
  rootPath: string;
  onBack: () => void;
  onFileAction: (action: "stage" | "unstage" | "revert", file: GitFileChange) => void;
  onAction: (action: () => Promise<GitActionResult>) => void;
  onComment: (content: string) => void;
}) {
  return (
    <div className="git-diff-pane">
      <header className="git-diff-header">
        <button type="button" className="git-diff-back" title="返回变更列表" aria-label="返回变更列表" onClick={onBack}><IconChevronLeft /></button>
        <span title={file.path}>{file.path}</span>
        <div>
          {file.unstaged || file.untracked ? <button type="button" disabled={busy} title="暂存文件" onClick={() => onFileAction("stage", file)}><IconPlus /></button> : null}
          {file.staged ? <button type="button" disabled={busy} title="取消暂存" onClick={() => onFileAction("unstage", file)}><IconUndo /></button> : null}
          {file.unstaged || file.untracked ? <button type="button" disabled={busy} title="撤销未暂存修改" onClick={() => onFileAction("revert", file)}><IconTrash /></button> : null}
        </div>
      </header>
      {file.conflicted ? <p className="git-conflict-notice">此文件存在冲突，请先解决冲突。</p> : null}
      {file.binary ? <p className="git-binary-notice">二进制文件不支持文本差异对比。</p> : null}
      <div className="git-diff-scroll">
        <GitSideBySideHunks file={file} source="staged" busy={busy} threadId={threadId} rootPath={rootPath} onAction={onAction} onComment={onComment} />
        <GitSideBySideHunks file={file} source="unstaged" busy={busy} threadId={threadId} rootPath={rootPath} onAction={onAction} onComment={onComment} />
        {!file.binary && file.stagedHunks.length + file.unstagedHunks.length === 0 ? <WorkspaceEmptyState icon={<IconEye />} title="没有文本差异" message="此文件没有可显示的文本差异。" /> : null}
      </div>
    </div>
  );
}

export const GitSideBySideHunks = memo(function GitSideBySideHunks({
  file,
  source,
  busy,
  threadId,
  rootPath,
  onAction,
  onComment
}: {
  file: GitFileChange;
  source: "staged" | "unstaged";
  busy: boolean;
  threadId: string | null;
  rootPath: string;
  onAction: (action: () => Promise<GitActionResult>) => void;
  onComment: (content: string) => void;
}) {
  const hunks = source === "staged" ? file.stagedHunks : file.unstagedHunks;
  if (hunks.length === 0) return null;
  return (
    <section className={`git-hunk-list ${source}`}>
      <h3>{source === "staged" ? "已暂存" : "未暂存"}</h3>
      {hunks.map((hunk) => (
        <article className="git-hunk" key={hunk.id}>
          <header>
            <code>{hunk.header}</code>
            <div>
              {source === "unstaged" ? <button type="button" disabled={busy || !threadId} title="暂存此块" onClick={() => threadId && onAction(() => window.codexh.applyGitHunk({ threadId, rootPath, path: file.path, hunkId: hunk.id, source, action: "stage" }) as Promise<GitActionResult>)}><IconPlus /></button> : null}
              {source === "staged" ? <button type="button" disabled={busy || !threadId} title="取消暂存此块" onClick={() => threadId && onAction(() => window.codexh.applyGitHunk({ threadId, rootPath, path: file.path, hunkId: hunk.id, source, action: "unstage" }) as Promise<GitActionResult>)}><IconUndo /></button> : null}
              {source === "unstaged" ? <button type="button" disabled={busy || !threadId} title="撤销此块" onClick={() => threadId && onAction(() => window.codexh.applyGitHunk({ threadId, rootPath, path: file.path, hunkId: hunk.id, source, action: "revert" }) as Promise<GitActionResult>)}><IconTrash /></button> : null}
              <button type="button" title="让 Codex 处理此块" onClick={() => onComment(`请审查并处理以下 Git 修改：\n文件：${file.path}\n范围：${hunk.header}\n\n${hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.content}`).join("\n")}`)}><IconComment /></button>
            </div>
          </header>
          <div className="git-side-diff-head"><span>变更前</span><span>变更后</span></div>
          <div className="git-side-diff-rows">
            {buildSideBySideDiffRows(hunk).map((row, index) => (
              <div className="git-side-diff-row" key={`${hunk.id}:${index}`}>
                <span>{row.oldLine ?? ""}</span><code className={row.oldKind}>{row.oldContent}</code>
                <span>{row.newLine ?? ""}</span><code className={row.newKind}>{row.newContent}</code>
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
});

export function buildSideBySideDiffRows(hunk: GitHunk): SideBySideDiffRow[] {
  const lines = hunk.lines.filter((line) => line.kind !== "meta");
  const rows: SideBySideDiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      rows.push({ oldLine: line.oldLine, oldContent: line.content, oldKind: "context", newLine: line.newLine, newContent: line.content, newKind: "context" });
      index += 1;
      continue;
    }
    const removed: GitDiffLine[] = [];
    while (index < lines.length && lines[index].kind === "removed") removed.push(lines[index++]);
    const added: GitDiffLine[] = [];
    while (index < lines.length && lines[index].kind === "added") added.push(lines[index++]);
    if (removed.length === 0 && added.length === 0) {
      index += 1;
      continue;
    }
    for (let pairIndex = 0; pairIndex < Math.max(removed.length, added.length); pairIndex += 1) {
      const oldLine = removed[pairIndex];
      const newLine = added[pairIndex];
      rows.push({
        oldLine: oldLine?.oldLine ?? null,
        oldContent: oldLine?.content ?? "",
        oldKind: oldLine ? "removed" : "empty",
        newLine: newLine?.newLine ?? null,
        newContent: newLine?.content ?? "",
        newKind: newLine ? "added" : "empty"
      });
    }
  }
  return rows;
}

function getFileStatusLabel(file: GitFileChange): string {
  if (file.conflicted) return "!";
  if (file.untracked) return "U";
  if (file.indexStatus === "A" || file.worktreeStatus === "A") return "A";
  if (file.indexStatus === "D" || file.worktreeStatus === "D") return "D";
  if (file.originalPath) return "R";
  return "M";
}
