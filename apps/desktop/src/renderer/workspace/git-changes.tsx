import type { GitActionResult, GitDiffLine, GitFileChange, GitHunk, GitSnapshot } from "@shared-types";
import { memo, useEffect, useMemo, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronLeft,
  IconComment,
  IconEye,
  IconFile,
  IconFileChanges,
  IconPlus,
  IconRefresh,
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
  onAction: (action: () => Promise<GitActionResult>) => void;
  onComment: (content: string) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openedPath, setOpenedPath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
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
    if (!threadId || busy) return;
    onAction(action);
  };
  const fileAction = (action: "stage" | "unstage" | "revert", file: GitFileChange) => {
    if (!threadId) return;
    if (action === "stage") run(() => window.codexh.stageGitFile({ threadId, rootPath, path: file.path }) as Promise<GitActionResult>);
    if (action === "unstage") run(() => window.codexh.unstageGitFile({ threadId, rootPath, path: file.path }) as Promise<GitActionResult>);
    if (action === "revert") run(() => window.codexh.revertGitFile({ threadId, rootPath, path: file.path, untracked: file.untracked }) as Promise<GitActionResult>);
  };

  return (
    <section className={`git-changes-workspace ${opened ? "is-diff-open" : ""}`} aria-label="Git 源代码管理">
      <header className="git-changes-header">
        {rootSelector ? <div className="git-header-root-row">{rootSelector}</div> : null}
        <div className="git-header-branch-row">
          <label className="git-branch-select" title="切换分支">
            <IconFileChanges />
            <select
              aria-label="切换 Git 分支"
              value={snapshot.branch ?? ""}
              disabled={busy || !threadId || snapshot.branches.length === 0}
              onChange={(event) => {
                const branch = event.target.value;
                if (threadId && branch && branch !== snapshot.branch) {
                  run(() => window.codexh.switchGitBranch({ threadId, rootPath, branch }) as Promise<GitActionResult>);
                }
              }}
            >
              {!snapshot.branch ? <option value="">detached HEAD</option> : null}
              {snapshot.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          </label>
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
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={hasStagedFiles ? "输入提交消息（必需）" : "输入提交消息，可先暂存全部变更"}
              disabled={busy}
              rows={3}
            />
            <div>
              <button type="button" className="git-stage-all-button" disabled={busy || !threadId || !hasUnstagedFiles} onClick={() => threadId && run(() => window.codexh.stageAllGitChanges({ threadId, rootPath }) as Promise<GitActionResult>)}><IconPlus /><span>暂存全部</span></button>
              <button type="button" className="git-commit-button" disabled={busy || !threadId || !hasStagedFiles || !commitMessage.trim()} onClick={() => threadId && run(() => window.codexh.commitGitChanges({ threadId, rootPath, message: commitMessage }) as Promise<GitActionResult>)}><IconCheck /><span>提交</span></button>
            </div>
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
