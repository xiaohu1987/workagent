import { memo, useMemo } from "react";
import type { ReactNode } from "react";
import type { GitActionResult, GitSnapshot, RuntimeThreadSnapshot, ToolCallRecord } from "@shared-types";
import type { ComposerAttachmentInput } from "../lib/conversation-utils";
import { getProjectRelativeGitFiles, type ProjectFileEntry } from "../lib/project-files";
import { IconChevronRight, IconFileChanges, IconFolder, IconGlobe } from "../icons";
import { BrowserWorkspace } from "./browser-workspace";
import { GitChangesWorkspace } from "./git-changes";
import { WorkspaceEmptyState } from "./panels";
import { ProjectFilesWorkspace } from "./project-files";

export type RightWorkspaceTab = "terminal" | "browser" | "files" | "changes";

export function hasRecognizedGitRepository(snapshot: GitSnapshot | null, projectRoot: string): boolean {
  if (snapshot?.available !== true || !snapshot.root?.trim() || !projectRoot.trim()) return false;
  return normalizeWorkspacePath(snapshot.root) === normalizeWorkspacePath(projectRoot);
}

export const RightWorkspacePanel = memo(function RightWorkspacePanel({
  hidden,
  activeTab,
  onTabChange,
  onExpandedTabChange,
  onHide,
  projectRoot,
  workspaceRoots,
  onProjectRootChange,
  gitRoot,
  onGitRootChange,
  onAddAttachment,
  projectFiles,
  projectFilesLoading,
  projectFilesRevision,
  gitSnapshot,
  gitLoading,
  gitActionBusy,
  gitActionMessage,
  onGitRefresh,
  onGitAction,
  onGitComment,
  selectedProjectFile,
  projectToolCalls,
  onSelectProjectFile,
  onOpenProjectFile,
  onLoadProjectDirectory,
  browserTabsByThread,
  onCloseBrowserTab,
  threadId
}: {
  hidden: boolean;
  activeTab: RightWorkspaceTab;
  onTabChange: (tab: RightWorkspaceTab) => void;
  expandedTab: RightWorkspaceTab | null;
  onExpandedTabChange: (tab: RightWorkspaceTab | null) => void;
  onHide: () => void;
  projectRoot: string;
  workspaceRoots: string[];
  onProjectRootChange: (rootPath: string) => void;
  gitRoot: string;
  onGitRootChange: (rootPath: string) => void;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
  projectFiles: ProjectFileEntry[];
  projectFilesLoading: boolean;
  projectFilesRevision: number;
  gitSnapshot: GitSnapshot | null;
  gitLoading: boolean;
  gitActionBusy: boolean;
  gitActionMessage: string | null;
  onGitRefresh: () => void;
  onGitAction: (action: () => Promise<GitActionResult>) => void;
  onGitComment: (content: string) => void;
  selectedProjectFile: string | null;
  projectToolCalls: ToolCallRecord[];
  onSelectProjectFile: (path: string) => void;
  onOpenProjectFile: (path: string) => void;
  onLoadProjectDirectory: (path: string) => Promise<boolean>;
  browserTabsByThread: Record<string, RuntimeThreadSnapshot["browserTabs"]>;
  onCloseBrowserTab: (threadId: string, tabId: string) => void;
  threadId: string | null;
}) {
  const showGitWorkspace = true;
  const projectGitFiles = useMemo(
    () => getProjectRelativeGitFiles(gitSnapshot, projectRoot),
    [gitSnapshot, projectRoot]
  );
  return (
    <aside className={`right-workspace-panel ${hidden ? "is-background" : ""}`} aria-label="Right workspace" aria-hidden={hidden}>
      <div className="right-workspace-tabs" role="tablist" aria-label="工作区切换">
        <WorkspaceTabButton
          id="files"
          label="文件夹"
          icon={<IconFolder />}
          active={activeTab === "files"}
          onClick={() => selectWorkspaceTab("files", onTabChange, onExpandedTabChange)}
        />
        <WorkspaceTabButton
          id="browser"
          label="浏览器"
          icon={<IconGlobe />}
          active={activeTab === "browser"}
          onClick={() => selectWorkspaceTab("browser", onTabChange, onExpandedTabChange)}
        />
        {showGitWorkspace ? (
          <WorkspaceTabButton
            id="changes"
            label="Git"
            icon={<IconFileChanges />}
            active={activeTab === "changes"}
            onClick={() => selectWorkspaceTab("changes", onTabChange, onExpandedTabChange)}
          />
        ) : null}
      </div>
      <div className="right-workspace-content">
        {showGitWorkspace ? (
          <div id="right-workspace-content-changes" className={`right-workspace-view ${activeTab === "changes" ? "active" : ""}`} role={activeTab === "changes" ? "tabpanel" : undefined} aria-labelledby={activeTab === "changes" ? "right-workspace-tab-changes" : undefined} aria-hidden={activeTab !== "changes"} inert={activeTab !== "changes"}>
            <GitChangesWorkspace
              threadId={threadId}
              workspaceRoots={workspaceRoots}
              rootPath={gitRoot}
              onRootChange={onGitRootChange}
              snapshot={gitSnapshot}
              loading={gitLoading}
              busy={gitActionBusy}
              message={gitActionMessage}
              onRefresh={onGitRefresh}
              onAction={onGitAction}
              onComment={onGitComment}
            />
          </div>
        ) : null}
        <div id="right-workspace-content-files" className={`right-workspace-view ${activeTab === "files" ? "active" : ""}`} role={activeTab === "files" ? "tabpanel" : undefined} aria-labelledby={activeTab === "files" ? "right-workspace-tab-files" : undefined} aria-hidden={activeTab !== "files"} inert={activeTab !== "files"}>
          <ProjectFilesWorkspace
            key={projectFilesRevision}
            files={projectFiles}
            toolCalls={projectToolCalls}
            gitFiles={projectGitFiles}
            loading={projectFilesLoading}
            loadRevision={projectFilesRevision}
            selectedPath={selectedProjectFile}
            onSelect={onSelectProjectFile}
            onOpen={onOpenProjectFile}
            onLoadDirectory={onLoadProjectDirectory}
            projectRoot={projectRoot}
            workspaceRoots={workspaceRoots}
            onProjectRootChange={onProjectRootChange}
            onAddAttachment={onAddAttachment}
          />
        </div>
        <div id="right-workspace-content-browser" className={`right-workspace-view ${activeTab === "browser" ? "active" : ""}`} role={activeTab === "browser" ? "tabpanel" : undefined} aria-labelledby={activeTab === "browser" ? "right-workspace-tab-browser" : undefined} aria-hidden={activeTab !== "browser"} inert={activeTab !== "browser"}>
            {Object.entries(browserTabsByThread).map(([browserThreadId, tabs]) => tabs.length > 0 ? (
              <BrowserWorkspace
                key={browserThreadId}
                tabs={tabs}
                threadId={browserThreadId}
                onCloseTab={(tabId) => onCloseBrowserTab(browserThreadId, tabId)}
                visible={!hidden && activeTab === "browser" && browserThreadId === threadId}
              />
            ) : null)}
            {threadId && (browserTabsByThread[threadId]?.length ?? 0) === 0 ? (
              <WorkspaceEmptyState icon={<IconGlobe />} title="打开网页" message="任务打开的网页会显示在这里。" />
            ) : null}
        </div>
      </div>
      <button
        type="button"
        className="right-workspace-hide-button"
        title="向右隐藏工作区"
        aria-label="向右隐藏工作区"
        onClick={onHide}
      >
        <IconChevronRight />
      </button>
    </aside>
  );
});

export function selectWorkspaceTab(
  tab: RightWorkspaceTab,
  onTabChange: (tab: RightWorkspaceTab) => void,
  onExpandedTabChange: (tab: RightWorkspaceTab | null) => void
): void {
  onTabChange(tab);
  onExpandedTabChange(tab);
}

function WorkspaceTabButton({
  id,
  label,
  icon,
  active,
  onClick
}: {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      id={`right-workspace-tab-${id}`}
      className={`right-workspace-tab ${active ? "active" : ""}`}
      role="tab"
      aria-selected={active}
      aria-controls={`right-workspace-content-${id}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

