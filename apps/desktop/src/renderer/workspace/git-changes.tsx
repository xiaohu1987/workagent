import type { GitActionResult, GitFileChange, GitSnapshot } from "@shared-types";
import { memo, useState } from "react";
import { IconCheck, IconFile, IconEye, IconFileChanges, IconPlus, IconTrash, IconRefresh, IconUndo, IconComment, IconSpinner, IconArrowUp, IconArrowDown } from "../icons";
import { WorkspaceEmptyState } from "./panels";

export const GitChangesWorkspace = memo(function GitChangesWorkspace({
  threadId,
  snapshot,
  loading,
  busy,
  message,
  onRefresh,
  onAction,
  onComment
}: {
  threadId: string | null;
  snapshot: GitSnapshot | null;
  loading: boolean;
  busy: boolean;
  message: string | null;
  onRefresh: () => void;
  onAction: (action: () => Promise<GitActionResult>) => void;
  onComment: (content: string) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const files = snapshot?.files ?? [];
  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const hasStagedFiles = files.some((file) => file.staged);
  const hasUnstagedFiles = files.some((file) => file.unstaged || file.untracked);
  const hasCommitsToPush = snapshot?.upstream ? (snapshot.ahead ?? 0) > 0 : Boolean(snapshot?.head);
  const groups = [
    { id: "conflicted", label: "冲突", files: files.filter((file) => file.conflicted) },
    { id: "staged", label: "暂存", files: files.filter((file) => file.staged && !file.conflicted) },
    { id: "changes", label: "更改", files: files.filter((file) => file.unstaged && !file.untracked && !file.conflicted) },
    { id: "untracked", label: "未跟踪", files: files.filter((file) => file.untracked) }
  ];

  if (loading && !snapshot) {
    return <WorkspaceEmptyState icon={<IconSpinner />} title="Git 变更" message="正在读取 Git 变更..." />;
  }
  if (!snapshot?.available) {
    return <WorkspaceEmptyState icon={<IconFileChanges />} title="Git 变更" message={snapshot?.message ?? "选择项目后查看 Git 变更。"} />;
  }

  const run = (action: () => Promise<GitActionResult>) => {
    if (!threadId || busy) return;
    onAction(action);
  };
  const fileAction = (action: "stage" | "unstage" | "revert", file: GitFileChange) => {
    if (!threadId) return;
    if (action === "stage") run(() => window.codexh.stageGitFile({ threadId, path: file.path }) as Promise<GitActionResult>);
    if (action === "unstage") run(() => window.codexh.unstageGitFile({ threadId, path: file.path }) as Promise<GitActionResult>);
    if (action === "revert") run(() => window.codexh.revertGitFile({ threadId, path: file.path, untracked: file.untracked }) as Promise<GitActionResult>);
  };

  return (
    <section className="git-changes-workspace" aria-label="Git 变更">
      <header className="git-changes-header">
        <div className="git-branch-summary">
          <IconFileChanges />
          <span>{snapshot.branch ?? "detached HEAD"}</span>
          {snapshot.ahead || snapshot.behind ? <small>{snapshot.ahead ? `↑${snapshot.ahead}` : ""}{snapshot.behind ? ` ↓${snapshot.behind}` : ""}</small> : null}
        </div>
        <div className="git-header-actions">
          <button
            type="button"
            className="git-text-action"
            title={snapshot.upstream ? "拉取远端更新" : "当前分支没有上游分支"}
            disabled={busy || !threadId || !snapshot.upstream}
            onClick={() => threadId && run(() => window.codexh.pullGitChanges(threadId) as Promise<GitActionResult>)}
          >
            <IconArrowDown />
            <span>拉取</span>
          </button>
          <button type="button" className="git-icon-button" title="刷新变更" aria-label="刷新变更" disabled={loading || busy} onClick={onRefresh}><IconRefresh /></button>
          {snapshot.canCreatePullRequest ? <button type="button" className="git-text-action" disabled={busy} onClick={() => threadId && run(() => window.codexh.createGitPullRequest(threadId) as Promise<GitActionResult>)}>PR</button> : null}
        </div>
      </header>
      {message ? <p className="git-action-message" role="status">{message}</p> : null}
      <div className="git-changes-body">
        <aside className="git-file-list" aria-label="变更文件">
          {groups.map((group) => group.files.length ? (
            <section key={group.id} className={`git-file-group ${group.id}`}>
              <h3>{group.label}<span>{group.files.length}</span></h3>
              {group.files.map((file) => (
                <button
                  key={`${group.id}:${file.path}`}
                  type="button"
                  className={`git-file-row ${selected?.path === file.path ? "active" : ""}`}
                  onClick={() => setSelectedPath(file.path)}
                  title={file.path}
                >
                  <IconFile />
                  <span>{file.path}</span>
                  <small>{file.additions ? `+${file.additions}` : ""}{file.deletions ? ` −${file.deletions}` : ""}</small>
                </button>
              ))}
            </section>
          ) : null)}
          {files.length === 0 ? <WorkspaceEmptyState icon={<IconFileChanges />} title="没有变更" message="工作区没有未提交的修改。" /> : null}
        </aside>
        <div className="git-diff-pane">
          {selected ? (
            <>
              <header className="git-diff-header">
                <span title={selected.path}>{selected.path}</span>
                <div>
                  {selected.unstaged || selected.untracked ? <button type="button" disabled={busy} title="暂存文件" onClick={() => fileAction("stage", selected)}><IconPlus /></button> : null}
                  {selected.staged ? <button type="button" disabled={busy} title="取消暂存" onClick={() => fileAction("unstage", selected)}><IconUndo /></button> : null}
                  {selected.unstaged || selected.untracked ? <button type="button" disabled={busy} title="撤销未暂存修改" onClick={() => fileAction("revert", selected)}><IconTrash /></button> : null}
                </div>
              </header>
              {selected.conflicted ? <p className="git-conflict-notice">此文件存在冲突，请先在编辑器或终端中解决。</p> : null}
              {selected.binary ? <p className="git-binary-notice">二进制文件不支持按块查看，可使用文件级操作。</p> : null}
              <div className="git-diff-scroll">
                <GitHunkList file={selected} source="staged" busy={busy} threadId={threadId} onAction={onAction} onComment={onComment} />
                <GitHunkList file={selected} source="unstaged" busy={busy} threadId={threadId} onAction={onAction} onComment={onComment} />
                {!selected.binary && selected.stagedHunks.length + selected.unstagedHunks.length === 0 ? <WorkspaceEmptyState icon={<IconEye />} title="没有文本差异" message="此文件没有可显示的文本差异。" /> : null}
              </div>
            </>
          ) : <WorkspaceEmptyState icon={<IconFileChanges />} title="选择文件" message="选择一个文件查看差异。" />}
        </div>
      </div>
      <footer className="git-commit-bar">
        <button
          type="button"
          className="git-stage-all-button"
          title={hasUnstagedFiles ? "暂存所有工作区变更" : "没有可暂存的变更"}
          disabled={busy || !threadId || !hasUnstagedFiles}
          onClick={() => threadId && run(() => window.codexh.stageAllGitChanges(threadId) as Promise<GitActionResult>)}
        >
          <IconPlus />
          <span>暂存全部</span>
        </button>
        <input
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder={hasStagedFiles ? "提交说明" : "提交说明（可先暂存全部）"}
          disabled={busy}
        />
        <button
          type="button"
          className="git-commit-button"
          title={hasStagedFiles ? "提交已暂存变更" : "请先暂存文件"}
          aria-label={hasStagedFiles ? "提交已暂存变更" : "请先暂存文件"}
          disabled={busy || !commitMessage.trim() || !hasStagedFiles || !threadId}
          onClick={() => threadId && run(() => window.codexh.commitGitChanges({ threadId, message: commitMessage }) as Promise<GitActionResult>)}
        >
          <IconCheck />
          <span>提交</span>
        </button>
        <button
          type="button"
          className="git-push-button"
          title={hasCommitsToPush ? "推送提交" : "没有待推送的提交"}
          aria-label={hasCommitsToPush ? "推送提交" : "没有待推送的提交"}
          disabled={busy || !snapshot.branch || !hasCommitsToPush || !threadId}
          onClick={() => threadId && run(() => window.codexh.pushGitChanges(threadId) as Promise<GitActionResult>)}
        >
          <IconArrowUp />
          <span>推送</span>
        </button>
      </footer>
    </section>
  );
}, (previous, next) =>
  previous.threadId === next.threadId &&
  previous.snapshot === next.snapshot &&
  previous.loading === next.loading &&
  previous.busy === next.busy &&
  previous.message === next.message
);

export const GitHunkList = memo(function GitHunkList({
  file,
  source,
  busy,
  threadId,
  onAction,
  onComment
}: {
  file: GitFileChange;
  source: "staged" | "unstaged";
  busy: boolean;
  threadId: string | null;
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
              {source === "unstaged" ? <button type="button" disabled={busy || !threadId} title="暂存此块" onClick={() => threadId && onAction(() => window.codexh.applyGitHunk({ threadId, path: file.path, hunkId: hunk.id, source, action: "stage" }) as Promise<GitActionResult>)}><IconPlus /></button> : null}
              {source === "staged" ? <button type="button" disabled={busy || !threadId} title="取消暂存此块" onClick={() => threadId && onAction(() => window.codexh.applyGitHunk({ threadId, path: file.path, hunkId: hunk.id, source, action: "unstage" }) as Promise<GitActionResult>)}><IconUndo /></button> : null}
              {source === "unstaged" ? <button type="button" disabled={busy || !threadId} title="撤销此块" onClick={() => threadId && onAction(() => window.codexh.applyGitHunk({ threadId, path: file.path, hunkId: hunk.id, source, action: "revert" }) as Promise<GitActionResult>)}><IconTrash /></button> : null}
              <button type="button" title="让 Codex 处理此块" onClick={() => onComment(`请审查并处理以下 Git 修改：\n文件：${file.path}\n范围：${hunk.header}\n\n${hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.content}`).join("\n")}`)}><IconComment /></button>
            </div>
          </header>
          <ol>
            {hunk.lines.map((line, index) => (
              <li key={`${hunk.id}:${index}`} className={line.kind}>
                <span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><code>{line.content}</code>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
});
