import { useEffect, useRef, useState } from "react";
import type { GitBranchSummary } from "@shared-types";
import { IconCheck, IconChevronDown, IconClose, IconFolder, IconGitBranch, IconSearch } from "../icons";
import {
  collectBranchOptions,
  describeBranchHint,
  describeBranchSelection,
  describeWorkspaceSelection,
  filterBranchOptions,
  filterWorkspaceOptions,
  shouldShowNewTaskBranch,
  type NewTaskBranchOption,
  type NewTaskWorkspaceOption,
  type NewTaskWorkspaceSelection
} from "../core/new-task-composer";

type Props = {
  workspace: NewTaskWorkspaceSelection;
  workspaceOptions: NewTaskWorkspaceOption[];
  branch: string | null;
  branchSummary: GitBranchSummary | null;
  branchLoading?: boolean;
  isPickingFolder?: boolean;
  onSelectWorkspace: (selection: NewTaskWorkspaceSelection) => void;
  onPickFolder: () => void;
  onSelectBranch: (branch: string) => void;
};

const samePath = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

export function NewTaskStatusBar({
  workspace,
  workspaceOptions,
  branch,
  branchSummary,
  branchLoading = false,
  isPickingFolder = false,
  onSelectWorkspace,
  onPickFolder,
  onSelectBranch
}: Props) {
  const [openMenu, setOpenMenu] = useState<"workspace" | "branch" | null>(null);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenu]);

  const visibleWorkspaceOptions = filterWorkspaceOptions(workspaceOptions, workspaceQuery);
  const branchOptions = filterBranchOptions(collectBranchOptions(branchSummary), branchQuery);
  const branchHint = describeBranchHint(branchSummary);
  const workspaceLabel = describeWorkspaceSelection(workspace);
  const selectedCwd = workspace.kind === "folder" ? workspace.cwd : null;
  const showBranch = shouldShowNewTaskBranch(branchSummary);
  const toggleMenu = (menu: "workspace" | "branch") => {
    setWorkspaceQuery("");
    setBranchQuery("");
    setOpenMenu((current) => (current === menu ? null : menu));
  };
  const selectWorkspaceOption = (option: NewTaskWorkspaceOption) => {
    setOpenMenu(null);
    onSelectWorkspace({ kind: "folder", cwd: option.cwd });
  };
  const selectBranchOption = (option: NewTaskBranchOption) => {
    setOpenMenu(null);
    onSelectBranch(option.name);
  };

  return (
    <div className="composer-status-bar" ref={rootRef}>
      <div className="composer-status-segment">
        <button
          type="button"
          className={`composer-status-trigger ${openMenu === "workspace" ? "is-open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={openMenu === "workspace"}
          title={workspaceLabel.title}
          onClick={() => toggleMenu("workspace")}
        >
          <IconFolder />
          <span className="composer-status-label">{workspaceLabel.label}</span>
          <IconChevronDown />
        </button>
        {openMenu === "workspace" ? (
          <div className="composer-status-menu" role="menu">
            <label className="composer-status-search">
              <IconSearch />
              <input
                autoFocus
                value={workspaceQuery}
                onChange={(event) => setWorkspaceQuery(event.target.value)}
                placeholder="搜索工作空间"
              />
            </label>
            <div className="composer-status-list">
              {visibleWorkspaceOptions.length ? (
                visibleWorkspaceOptions.map((option) => (
                  <button
                    key={option.cwd}
                    type="button"
                    role="menuitem"
                    className={`composer-status-option ${selectedCwd && samePath(selectedCwd, option.cwd) ? "is-selected" : ""}`}
                    onClick={() => selectWorkspaceOption(option)}
                  >
                    <span className="composer-status-option-main">
                      <span className="composer-status-option-name">{option.name}</span>
                      {option.threadCount > 1 ? <span className="composer-status-option-note">{option.threadCount} 个任务</span> : null}
                      <span className="composer-status-option-path">{option.cwd}</span>
                    </span>
                    {selectedCwd && samePath(selectedCwd, option.cwd) ? (
                      <span className="composer-status-option-check"><IconCheck /></span>
                    ) : null}
                  </button>
                ))
              ) : (
                <p className="composer-status-empty">没有匹配的工作空间</p>
              )}
            </div>
            <div className="composer-status-divider" />
            <button type="button" role="menuitem" className="composer-status-action" disabled={isPickingFolder} onClick={() => { setOpenMenu(null); onPickFolder(); }}>
              <IconFolder />
              <span>打开本地文件夹</span>
            </button>
            <button type="button" role="menuitem" className="composer-status-action" onClick={() => { setOpenMenu(null); onSelectWorkspace({ kind: "none" }); }}>
              <IconClose />
              <span>不使用工作空间</span>
            </button>
          </div>
        ) : null}
      </div>

      {showBranch ? (
        <div className="composer-status-segment">
          <button
            type="button"
            className={`composer-status-trigger ${openMenu === "branch" ? "is-open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={openMenu === "branch"}
            title="选择分支"
            onClick={() => toggleMenu("branch")}
          >
            <IconGitBranch />
            <span className="composer-status-label">{describeBranchSelection(branch)}</span>
            <IconChevronDown />
          </button>
          {openMenu === "branch" ? (
            <div className="composer-status-menu" role="menu">
              <label className="composer-status-search">
                <IconSearch />
                <input
                  autoFocus
                  value={branchQuery}
                  onChange={(event) => setBranchQuery(event.target.value)}
                  placeholder="搜索分支"
                />
              </label>
              <div className="composer-status-list">
                {branchOptions.length ? (
                  branchOptions.map((option) => (
                    <button
                      key={option.name}
                      type="button"
                      role="menuitem"
                      className={`composer-status-option ${branch === option.name ? "is-selected" : ""}`}
                      onClick={() => selectBranchOption(option)}
                    >
                      <span className="composer-status-option-main">
                        <span className="composer-status-option-name">{option.name}</span>
                        {option.isCurrent ? <span className="composer-status-option-note">当前分支</span> : null}
                        {option.isRemote ? <span className="composer-status-option-note">远端</span> : null}
                      </span>
                      {branch === option.name ? (
                        <span className="composer-status-option-check"><IconCheck /></span>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <p className="composer-status-empty">{branchHint ?? "没有可选分支"}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {branchLoading ? <span className="composer-status-loading">正在读取分支…</span> : null}
    </div>
  );
}
