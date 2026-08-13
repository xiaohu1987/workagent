import { memo } from "react";
import type { GitActionResult, GitSnapshot, RuntimeThreadSnapshot, ToolCallRecord } from "@shared-types";
import type { ComposerAttachmentInput } from "../lib/conversation-utils";
import type { ProjectFileEntry } from "../lib/project-files";
import { IconChevronRight, IconFileChanges, IconFolder, IconGlobe } from "../icons";
import { BrowserWorkspace } from "./browser-workspace";
import { GitChangesWorkspace } from "./git-changes";
import { WorkspaceAccordionSection, WorkspaceEmptyState } from "./panels";
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
  expandedTab,
  onExpandedTabChange,
  onHide,
  projectRoot,
  onAddAttachment,
  projectFiles,
  projectFilesLoading,
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
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
  projectFiles: ProjectFileEntry[];
  projectFilesLoading: boolean;
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
  browserTabsByThread: Record<string, RuntimeThreadSnapshot["browserTabs"]>;
  onCloseBrowserTab: (threadId: string, tabId: string) => void;
  threadId: string | null;
}) {
  const showGitWorkspace = hasRecognizedGitRepository(gitSnapshot, projectRoot);
  return (
    <aside className={`right-workspace-panel ${hidden ? "is-background" : ""}`} aria-label="Right workspace" aria-hidden={hidden}>
      <div className="right-workspace-accordion">
        {showGitWorkspace ? (
          <WorkspaceAccordionSection
            active={expandedTab === "changes"}
            id="git"
            label="Git"
            badge={gitSnapshot.files.length}
            icon={<IconFileChanges />}
            onClick={() => toggleWorkspaceSection("changes", activeTab, expandedTab, onTabChange, onExpandedTabChange)}
          >
            <GitChangesWorkspace
              threadId={threadId}
              snapshot={gitSnapshot}
              loading={gitLoading}
              busy={gitActionBusy}
              message={gitActionMessage}
              onRefresh={onGitRefresh}
              onAction={onGitAction}
              onComment={onGitComment}
            />
          </WorkspaceAccordionSection>
        ) : null}
        <WorkspaceAccordionSection
          active={expandedTab === "files"}
          id="files"
          label="文件夹"
          icon={<IconFolder />}
          onClick={() => toggleWorkspaceSection("files", activeTab, expandedTab, onTabChange, onExpandedTabChange)}
        >
          <ProjectFilesWorkspace
            files={projectFiles}
            toolCalls={projectToolCalls}
            loading={projectFilesLoading}
            selectedPath={selectedProjectFile}
            onSelect={onSelectProjectFile}
            onOpen={onOpenProjectFile}
            projectRoot={projectRoot}
            onAddAttachment={onAddAttachment}
          />
        </WorkspaceAccordionSection>
        <WorkspaceAccordionSection
          active={expandedTab === "browser"}
          id="browser"
          label="浏览器"
          icon={<IconGlobe />}
          onClick={() => toggleWorkspaceSection("browser", activeTab, expandedTab, onTabChange, onExpandedTabChange)}
        >
          {Object.entries(browserTabsByThread).map(([browserThreadId, tabs]) => tabs.length > 0 ? (
            <BrowserWorkspace
              key={browserThreadId}
              tabs={tabs}
              threadId={browserThreadId}
              onCloseTab={(tabId) => onCloseBrowserTab(browserThreadId, tabId)}
              visible={!hidden && expandedTab === "browser" && browserThreadId === threadId}
            />
          ) : null)}
          {threadId && (browserTabsByThread[threadId]?.length ?? 0) === 0 ? (
            <WorkspaceEmptyState icon={<IconGlobe />} title="打开网页" message="任务打开的网页会显示在这里。" />
          ) : null}
        </WorkspaceAccordionSection>
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

function toggleWorkspaceSection(
  tab: RightWorkspaceTab,
  activeTab: RightWorkspaceTab,
  expandedTab: RightWorkspaceTab | null,
  onTabChange: (tab: RightWorkspaceTab) => void,
  onExpandedTabChange: (tab: RightWorkspaceTab | null) => void
): void {
  if (expandedTab === tab) {
    onExpandedTabChange(null);
    return;
  }
  if (activeTab !== tab) {
    onTabChange(tab);
  }
  onExpandedTabChange(tab);
}

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

