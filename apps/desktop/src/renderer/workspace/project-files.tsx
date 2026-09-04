import type { GitFileChange, ToolCallRecord } from "@shared-types";
import { useMotionPresence } from "../core/motion-presence";
import { createPortal } from "react-dom";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { IconChevronRight, IconSearch, IconCompose, IconCopy, IconFolder, IconFile, IconEye, IconSpinner } from "../icons";
import { ProjectFileChangeKind, ProjectFileEntry, ProjectFileTreeNode, buildFileSnapshotDiffPreview, buildProjectFileTree, buildProjectFolderManifest, getFileSnapshotDiffCounts, getFileSnapshotDiffMarker, getGitProjectFileChangeKinds, getLatestFileSnapshot, getProjectFileChangeKinds, getProjectFileGlyphClass, getProjectFileNodeChangeKind, mergeProjectFileEntries, projectFileChangeBadge, projectFileChangeLabel, projectFileNodeMatches, resolveProjectFilePath } from "../lib/project-files";
import { ComposerAttachmentInput } from "../lib/conversation-utils";
import { WorkspaceContextMenu, WorkspaceEmptyState } from "./panels";
import { renderCodePreviewLine } from "./file-preview";

export const ProjectFilesWorkspace = memo(function ProjectFilesWorkspace({
  files,
  toolCalls,
  gitFiles,
  loading,
  loadRevision,
  selectedPath,
  onSelect,
  onOpen,
  onLoadDirectory,
  projectRoot,
  workspaceRoots,
  onProjectRootChange,
  onAddAttachment
}: {
  files: ProjectFileEntry[];
  toolCalls: ToolCallRecord[];
  gitFiles: GitFileChange[];
  loading: boolean;
  loadRevision: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onLoadDirectory: (path: string) => Promise<boolean>;
  projectRoot: string;
  workspaceRoots: string[];
  onProjectRootChange: (rootPath: string) => void;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [expandedRootPath, setExpandedRootPath] = useState<string | null>(projectRoot || null);
  const [loadedDirectoryPaths, setLoadedDirectoryPaths] = useState<Set<string>>(() => new Set());
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: ProjectFileTreeNode } | null>(null);
  const [rootContextMenu, setRootContextMenu] = useState<{ x: number; y: number; rootPath: string } | null>(null);
  const [diffPreview, setDiffPreview] = useState<{
    node: ProjectFileTreeNode;
    snapshot: ReturnType<typeof getLatestFileSnapshot>;
    gitFile: GitFileChange | null;
    anchor: DOMRect;
  } | null>(null);
  const contextMenuPresence = useMotionPresence(contextMenu, 140);
  const visibleContextMenu = contextMenu ?? contextMenuPresence.value;
  const diffPreviewPresence = useMotionPresence(diffPreview, 140);
  const visibleDiffPreview = diffPreview ?? diffPreviewPresence.value;
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const gitFilesByPath = useMemo(
    () => new Map(gitFiles.map((file) => [file.path.replace(/\\/g, "/"), file])),
    [gitFiles]
  );
  const tree = useMemo(() => buildProjectFileTree(mergeProjectFileEntries(
    files,
    gitFiles.map((file) => ({ path: file.path, kind: "file" as const }))
  )), [files, gitFiles]);
  const changeKinds = useMemo(() => new Map([
    ...getGitProjectFileChangeKinds(gitFiles),
    ...getProjectFileChangeKinds(toolCalls)
  ]), [gitFiles, toolCalls]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const workspaceRootsKey = workspaceRoots.join("\u0000");

  useEffect(() => {
    setExpandedPaths(new Set());
    setLoadedDirectoryPaths(new Set());
    setLoadingDirectoryPaths(new Set());
    setExpandedRootPath(projectRoot || workspaceRoots[0] || null);
  }, [loadRevision, projectRoot, workspaceRootsKey]);

  useEffect(() => {
    if (workspaceRoots.length === 0) {
      setExpandedRootPath(null);
    } else if (expandedRootPath && !workspaceRoots.includes(expandedRootPath)) {
      setExpandedRootPath(projectRoot || workspaceRoots[0]);
    }
  }, [expandedRootPath, projectRoot, workspaceRootsKey]);

  const toggleRoot = (rootPath: string) => {
    if (expandedRootPath === rootPath) {
      setExpandedRootPath(null);
      return;
    }
    setExpandedRootPath(rootPath);
    onProjectRootChange(rootPath);
  };

  const toggleDirectory = async (path: string) => {
    if (expandedPaths.has(path)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpandedPaths((current) => new Set(current).add(path));
    if (loadedDirectoryPaths.has(path) || loadingDirectoryPaths.has(path)) return;
    setLoadingDirectoryPaths((current) => new Set(current).add(path));
    try {
      if (await onLoadDirectory(path)) {
        setLoadedDirectoryPaths((current) => new Set(current).add(path));
      }
    } finally {
      setLoadingDirectoryPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  };

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  const clearDiffPreviewCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const startDiffPreviewTimer = (node: ProjectFileTreeNode, anchor: DOMRect) => {
    if (node.kind !== "file") return;
    const snapshot = getLatestFileSnapshot(toolCalls, node.path);
    const gitFile = gitFilesByPath.get(node.path.replace(/\\/g, "/")) ?? null;
    if (!snapshot && !gitFile) return;
    clearDiffPreviewCloseTimer();
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setDiffPreview({ node, snapshot, gitFile, anchor });
      hoverTimerRef.current = null;
    }, 3_000);
  };
  const scheduleDiffPreviewClose = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    clearDiffPreviewCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setDiffPreview(null);
      closeTimerRef.current = null;
    }, 140);
  };

  const projectFilesContent = (
    <>
      {!loading && files.length > 0 ? <label className="project-files-filter">
        <IconSearch />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选文件..."
          aria-label="筛选项目文件"
          spellCheck={false}
        />
      </label> : null}
      {loading ? <WorkspaceEmptyState icon={<IconSpinner />} title="读取中" message="正在读取项目文件..." /> : files.length === 0 ? <WorkspaceEmptyState icon={<IconFolder />} title="空文件夹" message="这个协作目录没有可显示的文件" /> : <div className="project-files-list" role="tree" aria-label="项目文件">
        <ProjectFileTreeRows
          nodes={tree}
          depth={0}
          query={normalizedQuery}
          expandedPaths={expandedPaths}
          loadingDirectoryPaths={loadingDirectoryPaths}
          selectedPath={selectedPath}
          changeKinds={changeKinds}
          onToggle={(path) => void toggleDirectory(path)}
          onSelect={onSelect}
          onOpen={onOpen}
          onHover={startDiffPreviewTimer}
          onHoverEnd={scheduleDiffPreviewClose}
          onContextMenu={(event, node) => {
            event.preventDefault();
            setRootContextMenu(null);
            setContextMenu({ x: event.clientX, y: event.clientY, node });
          }}
        />
      </div>}
    </>
  );

  if (loading && workspaceRoots.length <= 1) {
    return <WorkspaceEmptyState icon={<IconSpinner />} title="读取中" message="正在读取项目文件..." />;
  }

  if (files.length === 0 && workspaceRoots.length <= 1) {
    return <WorkspaceEmptyState icon={<IconFolder />} title="打开文件" message="当前项目文件夹没有可显示的文件" />;
  }

  return (
    <section className="project-files-workspace" aria-label="项目文件夹">
      {workspaceRoots.length > 1 ? (
        <div className="project-root-list" aria-label="协作目录">
          {workspaceRoots.map((root) => (
            <div key={root} className={`project-root-item ${root === expandedRootPath ? "is-expanded" : ""}`}>
              <button type="button" className={`project-root-row ${root === projectRoot ? "active" : ""}`} aria-expanded={root === expandedRootPath} title={root} onClick={() => toggleRoot(root)} onContextMenu={(event) => { event.preventDefault(); setContextMenu(null); setRootContextMenu({ x: event.clientX, y: event.clientY, rootPath: root }); }}>
                <span className={`project-file-disclosure ${root === expandedRootPath ? "is-expanded" : ""}`} aria-hidden><IconChevronRight /></span>
                <IconFolder />
                <span>{root.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || root}</span>
                <small>{root}</small>
              </button>
              <div className={`project-root-accordion ${root === expandedRootPath ? "is-expanded" : "is-collapsed"}`} aria-hidden={root !== expandedRootPath} inert={root !== expandedRootPath}>
                {root === projectRoot ? projectFilesContent : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {workspaceRoots.length <= 1 ? <div className="project-root-accordion is-expanded">{projectFilesContent}</div> : null}
      {visibleDiffPreview ? (
        <ProjectFileDiffPopover
          node={visibleDiffPreview.node}
          snapshot={visibleDiffPreview.snapshot}
          gitFile={visibleDiffPreview.gitFile}
          anchor={visibleDiffPreview.anchor}
          motionPhase={diffPreviewPresence.phase}
          onMouseEnter={clearDiffPreviewCloseTimer}
          onMouseLeave={scheduleDiffPreviewClose}
        />
      ) : null}
      {visibleContextMenu ? (
        <WorkspaceContextMenu
          x={visibleContextMenu.x}
          y={visibleContextMenu.y}
          motionPhase={contextMenuPresence.phase}
          onClose={() => setContextMenu(null)}
          actions={[
            ...(visibleContextMenu.node.kind === "file"
              ? [{
                  id: "open-file-preview",
                  label: "查看",
                  icon: <IconEye />,
                  onSelect: () => onOpen(visibleContextMenu.node.path)
                }]
              : []),
            {
              id: "copy-path",
              label: "复制路径",
              icon: <IconCopy />,
              onSelect: () => void navigator.clipboard.writeText(resolveProjectFilePath(projectRoot, visibleContextMenu.node.path))
            },
            {
              id: "add-file-to-chat",
              label: "添加到聊天",
              icon: <IconCompose />,
              onSelect: () => {
                const target = resolveProjectFilePath(projectRoot, visibleContextMenu.node.path);
                const folderManifest = visibleContextMenu.node.kind === "directory"
                  ? buildProjectFolderManifest(visibleContextMenu.node)
                  : null;
                onAddAttachment({
                  kind: visibleContextMenu.node.kind === "directory" ? "folder" : "file",
                  path: target,
                  label: visibleContextMenu.node.name,
                  entries: folderManifest?.entries,
                  entriesTruncated: folderManifest?.truncated
                });
              }
            }
          ]}
        />
      ) : null}
      {rootContextMenu ? (
        <WorkspaceContextMenu
          x={rootContextMenu.x}
          y={rootContextMenu.y}
          onClose={() => setRootContextMenu(null)}
          actions={[{
            id: "add-root-to-chat",
            label: "添加到聊天",
            icon: <IconCompose />,
            onSelect: () => onAddAttachment({
              kind: "folder",
              path: rootContextMenu.rootPath,
              label: rootContextMenu.rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || rootContextMenu.rootPath
            })
          }, {
            id: "open-root-in-explorer",
            label: "资源管理器中打开",
            icon: <IconFolder />,
            onSelect: () => void window.codexh.openFolder(rootContextMenu.rootPath)
          }]}
        />
      ) : null}
    </section>
  );
});

export function ProjectFileTreeRows({
  nodes,
  depth,
  query,
  expandedPaths,
  loadingDirectoryPaths,
  selectedPath,
  changeKinds,
  onToggle,
  onSelect,
  onOpen,
  onHover,
  onHoverEnd,
  onContextMenu
}: {
  nodes: ProjectFileTreeNode[];
  depth: number;
  query: string;
  expandedPaths: Set<string>;
  loadingDirectoryPaths: Set<string>;
  selectedPath: string | null;
  changeKinds: Map<string, ProjectFileChangeKind>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onHover: (node: ProjectFileTreeNode, anchor: DOMRect) => void;
  onHoverEnd: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>, node: ProjectFileTreeNode) => void;
}): ReactNode {
  return nodes.map((node) => {
    const matches = projectFileNodeMatches(node, query);
    if (!matches) {
      return null;
    }

    const isDirectory = node.kind === "directory";
    const isExpanded = expandedPaths.has(node.path);
    const isLoading = isDirectory && loadingDirectoryPaths.has(node.path);
    const changeKind = getProjectFileNodeChangeKind(node, changeKinds);
    return (
      <div key={`${node.kind}:${node.path}`} className="project-file-tree-item">
        <button
          type="button"
          className={`project-file-row ${isDirectory ? "directory" : "file"} type-${getProjectFileGlyphClass(node)} ${changeKind ? `changed-${changeKind}` : ""} ${selectedPath === node.path ? "selected" : ""}`}
          style={{ "--project-file-depth": depth } as React.CSSProperties}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDirectory ? isExpanded : undefined}
          aria-busy={isLoading || undefined}
          aria-selected={isDirectory ? undefined : selectedPath === node.path}
          title={isDirectory ? node.path : `${node.path}（双击查看）`}
          onClick={() => {
            if (isDirectory) {
              onToggle(node.path);
              return;
            }
            onSelect(node.path);
          }}
          onDoubleClick={() => {
            if (!isDirectory) {
              onOpen(node.path);
            }
          }}
          onMouseEnter={(event) => onHover(node, event.currentTarget.getBoundingClientRect())}
          onMouseLeave={onHoverEnd}
          onContextMenu={(event) => onContextMenu(event, node)}
        >
          {isDirectory ? (
            <span className={`project-file-disclosure ${isExpanded ? "is-expanded" : ""}`} aria-hidden><IconChevronRight /></span>
          ) : <span className="project-file-disclosure-placeholder" aria-hidden />}
          <span className={`project-file-glyph ${getProjectFileGlyphClass(node)}`} aria-hidden>
            {isLoading ? <IconSpinner /> : isDirectory ? <IconFolder /> : <IconFile />}
          </span>
          <span>{node.name}</span>
          {changeKind ? <em className="project-file-change-badge" aria-label={projectFileChangeLabel(changeKind)}>{projectFileChangeBadge(changeKind)}</em> : null}
        </button>
        {isDirectory && isExpanded ? (
          <ProjectFileTreeRows
            nodes={node.children}
            depth={depth + 1}
            query={query}
            expandedPaths={expandedPaths}
            loadingDirectoryPaths={loadingDirectoryPaths}
            selectedPath={selectedPath}
            changeKinds={changeKinds}
            onToggle={onToggle}
            onSelect={onSelect}
            onOpen={onOpen}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            onContextMenu={onContextMenu}
          />
        ) : null}
      </div>
    );
  });
}

function ProjectFileDiffPopover({
  node,
  snapshot,
  gitFile,
  anchor,
  motionPhase,
  onMouseEnter,
  onMouseLeave
}: {
  node: ProjectFileTreeNode;
  snapshot: ReturnType<typeof getLatestFileSnapshot>;
  gitFile: GitFileChange | null;
  anchor: DOMRect;
  motionPhase?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const lines = snapshot
    ? buildFileSnapshotDiffPreview(snapshot.before, snapshot.after)
    : (gitFile ? [...gitFile.stagedHunks, ...gitFile.unstagedHunks].flatMap((hunk) => [
        { kind: "context" as const, content: hunk.header, lineNumber: null, omitted: true },
        ...hunk.lines.map((line) => ({
          kind: line.kind === "added" || line.kind === "removed" ? line.kind : "context" as const,
          content: line.content,
          lineNumber: line.newLine ?? line.oldLine,
          omitted: line.kind === "meta"
        }))
      ]) : []);
  const snapshotCounts = snapshot ? getFileSnapshotDiffCounts(snapshot.before, snapshot.after) : null;
  // The Git hunk rows are the content shown in this popover. Count those rows
  // directly so a stale aggregate from the Git snapshot cannot show +0/-0.
  const gitCounts = lines.reduce(
    (counts, line) => ({
      additions: counts.additions + (line.kind === "added" ? 1 : 0),
      deletions: counts.deletions + (line.kind === "removed" ? 1 : 0)
    }),
    { additions: 0, deletions: 0 }
  );
  const additions = snapshotCounts?.additions ?? gitCounts.additions;
  const deletions = snapshotCounts?.deletions ?? gitCounts.deletions;
  const width = Math.min(720, window.innerWidth - 32);
  const left = Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16));
  const placeAbove = anchor.top > Math.min(440, window.innerHeight * 0.56);
  const style: CSSProperties = placeAbove
    ? { left, width, bottom: Math.max(16, window.innerHeight - anchor.top + 8) }
    : { left, width, top: Math.min(window.innerHeight - 180, anchor.bottom + 8) };

  return createPortal(
    <aside
      className="generated-file-diff-popover project-file-diff-popover"
      data-motion={motionPhase}
      aria-label={`${node.path} diff 快照`}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <header className="generated-file-diff-head">
        <span title={node.path}>{node.path}{snapshot ? " · 任务快照" : " · Git Diff"}</span>
        <div><b>+{additions}</b><i>-{deletions}</i></div>
      </header>
      <div className="generated-file-diff-code">
        {lines.map((line, index) => (
          <div key={`${node.path}-tree-diff-${index}`} className={`is-${line.kind} ${line.omitted ? "is-omitted" : ""}`}>
            <span className="generated-file-diff-line-number" aria-hidden="true">{line.lineNumber ?? ""}</span>
            <span className="generated-file-diff-marker" aria-hidden="true">{line.omitted ? "" : getFileSnapshotDiffMarker(line.kind)}</span>
            <code>{line.omitted ? line.content : renderCodePreviewLine(line.content, `${node.path}-tree-${index}`)}</code>
          </div>
        ))}
      </div>
      {!snapshot && gitFile?.binary ? (
        <footer className="generated-file-diff-note">二进制文件不支持文本差异预览。</footer>
      ) : null}
      {!snapshot && gitFile && !gitFile.binary && lines.length === 0 ? (
        <footer className="generated-file-diff-note">当前 Git 快照没有可显示的文本差异。</footer>
      ) : null}
      {snapshot && (snapshot.beforeTruncated || snapshot.afterTruncated) ? (
        <footer className="generated-file-diff-note">快照内容过长，仅显示已保存的部分。</footer>
      ) : null}
    </aside>,
    document.body
  );
}
