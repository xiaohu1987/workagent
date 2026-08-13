import type { ToolCallRecord } from "@shared-types";
import { useMotionPresence } from "../core/motion-presence";
import { createPortal } from "react-dom";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { IconChevronRight, IconSearch, IconCompose, IconCopy, IconFolder, IconFile, IconEye, IconSpinner } from "../icons";
import { ProjectFileChangeKind, ProjectFileEntry, ProjectFileTreeNode, buildFileSnapshotDiffPreview, buildProjectFileTree, buildProjectFolderManifest, getFileSnapshotDiffMarker, getLatestFileSnapshot, getProjectFileChangeKinds, getProjectFileGlyphClass, getProjectFileNodeChangeKind, projectFileChangeBadge, projectFileChangeLabel, projectFileNodeMatches, resolveProjectFilePath } from "../lib/project-files";
import { ComposerAttachmentInput } from "../lib/conversation-utils";
import { WorkspaceContextMenu, WorkspaceEmptyState } from "./panels";
import { renderCodePreviewLine } from "./file-preview";

export const ProjectFilesWorkspace = memo(function ProjectFilesWorkspace({
  files,
  toolCalls,
  loading,
  selectedPath,
  onSelect,
  onOpen,
  projectRoot,
  onAddAttachment
}: {
  files: ProjectFileEntry[];
  toolCalls: ToolCallRecord[];
  loading: boolean;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  projectRoot: string;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: ProjectFileTreeNode } | null>(null);
  const [diffPreview, setDiffPreview] = useState<{ node: ProjectFileTreeNode; snapshot: NonNullable<ReturnType<typeof getLatestFileSnapshot>>; anchor: DOMRect } | null>(null);
  const contextMenuPresence = useMotionPresence(contextMenu, 140);
  const visibleContextMenu = contextMenu ?? contextMenuPresence.value;
  const diffPreviewPresence = useMotionPresence(diffPreview, 140);
  const visibleDiffPreview = diffPreview ?? diffPreviewPresence.value;
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const tree = useMemo(() => buildProjectFileTree(files), [files]);
  const changeKinds = useMemo(() => getProjectFileChangeKinds(toolCalls), [toolCalls]);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    setExpandedPaths(new Set(tree.filter((node) => node.kind === "directory").map((node) => node.path)));
  }, [tree]);

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
    if (!snapshot) return;
    clearDiffPreviewCloseTimer();
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setDiffPreview({ node, snapshot, anchor });
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

  if (loading) {
    return <WorkspaceEmptyState icon={<IconSpinner />} title="读取中" message="正在读取项目文件..." />;
  }

  if (files.length === 0) {
    return <WorkspaceEmptyState icon={<IconFolder />} title="打开文件" message="当前项目文件夹没有可显示的文件" />;
  }

  return (
    <section className="project-files-workspace" aria-label="项目文件夹">
      <label className="project-files-filter">
        <IconSearch />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选文件..."
          aria-label="筛选项目文件"
          spellCheck={false}
        />
      </label>
      <div className="project-files-list" role="tree" aria-label="项目文件">
        <ProjectFileTreeRows
          nodes={tree}
          depth={0}
          query={normalizedQuery}
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          changeKinds={changeKinds}
          onToggle={(path) => {
            setExpandedPaths((current) => {
              const next = new Set(current);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          onSelect={onSelect}
          onOpen={onOpen}
          onHover={startDiffPreviewTimer}
          onHoverEnd={scheduleDiffPreviewClose}
          onContextMenu={(event, node) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY, node });
          }}
        />
      </div>
      {visibleDiffPreview ? (
        <ProjectFileDiffPopover
          node={visibleDiffPreview.node}
          snapshot={visibleDiffPreview.snapshot}
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
    </section>
  );
});

export function ProjectFileTreeRows({
  nodes,
  depth,
  query,
  expandedPaths,
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
    const isExpanded = query.length > 0 || expandedPaths.has(node.path);
    const changeKind = getProjectFileNodeChangeKind(node, changeKinds);
    return (
      <div key={`${node.kind}:${node.path}`} className="project-file-tree-item">
        <button
          type="button"
          className={`project-file-row ${isDirectory ? "directory" : "file"} ${changeKind ? `changed-${changeKind}` : ""} ${selectedPath === node.path ? "selected" : ""}`}
          style={{ "--project-file-depth": depth } as React.CSSProperties}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDirectory ? isExpanded : undefined}
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
            {isDirectory ? <IconFolder /> : <IconFile />}
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
  anchor,
  motionPhase,
  onMouseEnter,
  onMouseLeave
}: {
  node: ProjectFileTreeNode;
  snapshot: NonNullable<ReturnType<typeof getLatestFileSnapshot>>;
  anchor: DOMRect;
  motionPhase?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const lines = buildFileSnapshotDiffPreview(snapshot.before, snapshot.after);
  const additions = lines.filter((line) => line.kind === "added").length;
  const deletions = lines.filter((line) => line.kind === "removed").length;
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
        <span title={node.path}>{node.path}</span>
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
      {snapshot.beforeTruncated || snapshot.afterTruncated ? (
        <footer className="generated-file-diff-note">快照内容过长，仅显示已保存的部分。</footer>
      ) : null}
    </aside>,
    document.body
  );
}
