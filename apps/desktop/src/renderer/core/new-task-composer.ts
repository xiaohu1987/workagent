import type { GitBranchSummary, ThreadRecord } from "@shared-types";
import { getFileLeafName } from "../markdown";
import { normalizeHistoryGroupKey } from "../history/history-utils";

/**
 * 「新建任务」页底部状态栏里的工作空间选择。
 * unset = 还没选（显示占位提示），none = 明确选择「不使用工作空间」。
 */
export type NewTaskWorkspaceSelection =
  | { kind: "unset" }
  | { kind: "none" }
  | { kind: "folder"; cwd: string };

export type NewTaskWorkspaceOption = {
  cwd: string;
  name: string;
  threadCount: number;
};

/** 工作空间选择最终落到线程上：选中文件夹走项目模式，其余走普通聊天。 */
export function resolveNewTaskThreadInput(
  selection: NewTaskWorkspaceSelection
): { mode: "project" | "chat"; cwd?: string } {
  if (selection.kind === "folder" && selection.cwd.trim()) {
    return { mode: "project", cwd: selection.cwd };
  }
  return { mode: "chat" };
}

/**
 * 删除任务后回到「新建任务」页时，默认沿用被删任务所属项目的工作空间。
 * 传入候选线程（按优先级排序），返回第一个项目线程的文件夹；没有则返回 null。
 */
export function pickProjectWorkspaceCwd(
  threads: Array<Pick<ThreadRecord, "mode" | "cwd"> | null | undefined>
): string | null {
  for (const thread of threads) {
    if (thread && thread.mode === "project" && thread.cwd && thread.cwd.trim()) return thread.cwd;
  }
  return null;
}

/** 已有项目文件夹去重后按最近使用排序，供「新建任务」的工作空间下拉使用。 */
export function collectWorkspaceOptions(threads: ThreadRecord[]): NewTaskWorkspaceOption[] {
  const byFolder = new Map<string, { cwd: string; name: string; threadCount: number; updatedAt: string }>();
  for (const thread of threads) {
    if (thread.mode !== "project" || !thread.cwd) continue;
    const key = normalizeHistoryGroupKey(thread.cwd);
    const existing = byFolder.get(key);
    if (existing) {
      existing.threadCount += 1;
      if (thread.updatedAt > existing.updatedAt) existing.updatedAt = thread.updatedAt;
      continue;
    }
    byFolder.set(key, {
      cwd: thread.cwd,
      name: getFileLeafName(thread.cwd),
      threadCount: 1,
      updatedAt: thread.updatedAt
    });
  }
  return [...byFolder.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(({ cwd, name, threadCount }) => ({ cwd, name, threadCount }));
}

/** 搜索框过滤：文件夹名或完整路径命中即可，保持原有顺序。 */
export function filterWorkspaceOptions(options: NewTaskWorkspaceOption[], query: string): NewTaskWorkspaceOption[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return options;
  return options.filter((option) =>
    option.name.toLowerCase().includes(keyword) || option.cwd.toLowerCase().includes(keyword)
  );
}

/** 底部 chips 的文案与 tooltip。 */
export function describeWorkspaceSelection(selection: NewTaskWorkspaceSelection): { label: string; title: string } {
  if (selection.kind === "folder") {
    return { label: getFileLeafName(selection.cwd), title: selection.cwd };
  }
  if (selection.kind === "none") {
    return { label: "不使用工作空间", title: "本次任务不绑定项目文件夹" };
  }
  return { label: "选择工作空间", title: "选择工作空间" };
}

/** 下拉列表：当前选中的文件夹已不在列表里时（例如该项目的任务被全部删除）仍置顶保留，保证选中态可见。 */
export function withSelectedWorkspaceOption(
  options: NewTaskWorkspaceOption[],
  selection: NewTaskWorkspaceSelection
): NewTaskWorkspaceOption[] {
  if (selection.kind !== "folder") return options;
  const selectedCwd = selection.cwd.trim();
  if (!selectedCwd) return options;
  if (options.some((option) => normalizeHistoryGroupKey(option.cwd) === normalizeHistoryGroupKey(selectedCwd))) return options;
  return [{ cwd: selection.cwd, name: getFileLeafName(selection.cwd), threadCount: 0 }, ...options];
}

/** 空白任务页输入框的占位文案。 */
export const NEW_TASK_INPUT_PLACEHOLDER = "今天帮你做些什么？";

/** 还没选分支时状态栏的占位文案。 */
export const NEW_TASK_BRANCH_PLACEHOLDER = "分支";

export type NewTaskBranchOption = { name: string; isRemote: boolean; isCurrent: boolean };

/** 分支快照 → 可选分支列表；非 git 仓库或读取失败时没有可选项。 */
export function collectBranchOptions(summary: GitBranchSummary | null): NewTaskBranchOption[] {
  if (!summary?.available) return [];
  const remoteBranches = new Set(summary.remoteBranches);
  return summary.branches.map((name) => ({
    name,
    isRemote: remoteBranches.has(name),
    isCurrent: summary.branch === name
  }));
}

/** 分支搜索框过滤：按名称匹配，保持原有顺序。 */
export function filterBranchOptions(options: NewTaskBranchOption[], query: string): NewTaskBranchOption[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return options;
  return options.filter((option) => option.name.toLowerCase().includes(keyword));
}

export function describeBranchSelection(branch: string | null): string {
  return branch && branch.trim() ? branch : NEW_TASK_BRANCH_PLACEHOLDER;
}

/** 读取不到分支时的提示；正常仓库返回 null。 */
export function describeBranchHint(summary: GitBranchSummary | null): string | null {
  if (!summary || summary.available) return null;
  return summary.message?.trim() ? summary.message : "当前文件夹不是 Git 仓库";
}

/** 只有工作空间处于 Git 仓库且读取成功时才显示分支选择；未选择或非 Git 仓库时整块隐藏。 */
export function shouldShowNewTaskBranch(summary: GitBranchSummary | null): boolean {
  return summary?.available === true;
}
