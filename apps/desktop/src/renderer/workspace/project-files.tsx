import type { ToolCallRecord } from "@shared-types";
import { useMotionPresence } from "../motion-presence";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { IconChevronRight, IconSearch, IconCompose, IconCopy, IconFolder, IconFile, IconEye, IconSpinner } from "../icons";
import { ProjectFileChangeKind, ProjectFileEntry, ProjectFileTreeNode, buildProjectFileTree, buildProjectFolderManifest, getProjectFileChangeKinds, getProjectFileGlyphClass, getProjectFileNodeChangeKind, projectFileChangeBadge, projectFileChangeLabel, projectFileNodeMatches, resolveProjectFilePath } from "../lib/project-files";
import { ComposerAttachmentInput } from "../lib/conversation-utils";
import { WorkspaceContextMenu, WorkspaceEmptyState } from "./panels";

export function ProjectFilesWorkspace({
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
  const contextMenuPresence = useMotionPresence(contextMenu, 140);
  const visibleContextMenu = contextMenu ?? contextMenuPresence.value;
  const tree = useMemo(() => buildProjectFileTree(files), [files]);
  const changeKinds = useMemo(() => getProjectFileChangeKinds(toolCalls), [toolCalls]);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    setExpandedPaths(new Set(tree.filter((node) => node.kind === "directory").map((node) => node.path)));
  }, [tree]);

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
          onContextMenu={(event, node) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY, node });
          }}
        />
      </div>
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
}

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
            onContextMenu={onContextMenu}
          />
        ) : null}
      </div>
    );
  });
}
