import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GitBranchSummary, ThreadRecord } from "@shared-types";
import {
  NEW_TASK_BRANCH_PLACEHOLDER,
  NEW_TASK_INPUT_PLACEHOLDER,
  collectBranchOptions,
  collectWorkspaceOptions,
  describeBranchHint,
  describeBranchSelection,
  describeWorkspaceSelection,
  filterBranchOptions,
  filterWorkspaceOptions,
  pickProjectWorkspaceCwd,
  resolveNewTaskThreadInput,
  shouldShowNewTaskBranch,
  withSelectedWorkspaceOption
} from "../apps/desktop/src/renderer/core/new-task-composer";

function thread(overrides: Partial<ThreadRecord> & { id: string }): ThreadRecord {
  return {
    title: "任务",
    mode: "project",
    cwd: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  } as unknown as ThreadRecord;
}

describe("resolveNewTaskThreadInput", () => {
  it("选中工作空间时创建项目线程", () => {
    expect(resolveNewTaskThreadInput({ kind: "folder", cwd: "D:/workagent" }))
      .toEqual({ mode: "project", cwd: "D:/workagent" });
  });

  it("未选择或明确不使用工作空间时创建普通聊天", () => {
    expect(resolveNewTaskThreadInput({ kind: "unset" })).toEqual({ mode: "chat" });
    expect(resolveNewTaskThreadInput({ kind: "none" })).toEqual({ mode: "chat" });
  });

  it("空白文件夹路径按普通聊天处理", () => {
    expect(resolveNewTaskThreadInput({ kind: "folder", cwd: "   " })).toEqual({ mode: "chat" });
  });
});

describe("pickProjectWorkspaceCwd", () => {
  it("优先返回第一个项目线程的文件夹", () => {
    expect(pickProjectWorkspaceCwd([
      thread({ id: "chat", mode: "chat" }),
      thread({ id: "a", cwd: "D:/workagent" }),
      thread({ id: "b", cwd: "D:/other" })
    ])).toBe("D:/workagent");
  });

  it("没有项目线程或文件夹为空时返回 null", () => {
    expect(pickProjectWorkspaceCwd([thread({ id: "chat", mode: "chat" }), null, undefined])).toBeNull();
    expect(pickProjectWorkspaceCwd([thread({ id: "blank", cwd: "   " })])).toBeNull();
  });
});

describe("withSelectedWorkspaceOption", () => {
  const options = [{ cwd: "D:/Alpha", name: "Alpha", threadCount: 2 }];

  it("选中的文件夹已在列表中时保持原列表", () => {
    expect(withSelectedWorkspaceOption(options, { kind: "folder", cwd: "d:/alpha" })).toBe(options);
  });

  it("选中的文件夹已不在列表中时置顶补一条", () => {
    expect(withSelectedWorkspaceOption(options, { kind: "folder", cwd: "D:/beta" })).toEqual([
      { cwd: "D:/beta", name: "beta", threadCount: 0 },
      ...options
    ]);
  });

  it("未选择或选择不使用工作空间时不追加", () => {
    expect(withSelectedWorkspaceOption(options, { kind: "unset" })).toBe(options);
    expect(withSelectedWorkspaceOption(options, { kind: "none" })).toBe(options);
  });
});

describe("collectWorkspaceOptions", () => {
  it("按规范化路径去重、统计线程数并保留最近更新时间", () => {
    expect(collectWorkspaceOptions([
      thread({ id: "a", cwd: "D:\\workagent", updatedAt: "2026-01-02T00:00:00.000Z" }),
      thread({ id: "b", cwd: "d:/workagent", updatedAt: "2026-01-03T00:00:00.000Z" })
    ])).toEqual([{ cwd: "D:\\workagent", name: "workagent", threadCount: 2 }]);
  });

  it("按最近使用排序并跳过没有文件夹的聊天", () => {
    const options = collectWorkspaceOptions([
      thread({ id: "a", cwd: "D:/alpha", updatedAt: "2026-01-01T00:00:00.000Z" }),
      thread({ id: "b", mode: "chat", cwd: null, updatedAt: "2026-01-09T00:00:00.000Z" }),
      thread({ id: "c", cwd: "D:/beta", updatedAt: "2026-01-05T00:00:00.000Z" })
    ]);
    expect(options.map((option) => option.name)).toEqual(["beta", "alpha"]);
  });
});

describe("filterWorkspaceOptions", () => {
  const options = [
    { cwd: "D:/workagent", name: "workagent", threadCount: 2 },
    { cwd: "D:/CodeXH/notes", name: "notes", threadCount: 1 }
  ];

  it("空关键词返回全部", () => {
    expect(filterWorkspaceOptions(options, "   ")).toHaveLength(2);
  });

  it("按名称或路径大小写不敏感过滤", () => {
    expect(filterWorkspaceOptions(options, "NOTES")).toEqual([options[1]]);
    expect(filterWorkspaceOptions(options, "d:/codexh")).toEqual([options[1]]);
  });
});

describe("describeWorkspaceSelection", () => {
  it("覆盖未选择、不使用与已选择三种文案", () => {
    expect(describeWorkspaceSelection({ kind: "unset" }).label).toBe("选择工作空间");
    expect(describeWorkspaceSelection({ kind: "none" }).label).toBe("不使用工作空间");
    expect(describeWorkspaceSelection({ kind: "folder", cwd: "D:\\workagent" }))
      .toEqual({ label: "workagent", title: "D:\\workagent" });
  });
});

const branchSummary = (overrides: Partial<GitBranchSummary>): GitBranchSummary => ({
  available: true,
  branches: [],
  localBranches: [],
  remoteBranches: [],
  ...overrides
});

describe("collectBranchOptions", () => {
  it("非 git 仓库或读取失败时没有可选分支", () => {
    expect(collectBranchOptions(null)).toEqual([]);
    expect(collectBranchOptions(branchSummary({ available: false, branches: ["main"] }))).toEqual([]);
  });

  it("标记当前分支与远端分支", () => {
    expect(collectBranchOptions(branchSummary({
      branch: "main",
      branches: ["main", "feature_01", "origin/main"],
      remoteBranches: ["origin/main"]
    }))).toEqual([
      { name: "main", isRemote: false, isCurrent: true },
      { name: "feature_01", isRemote: false, isCurrent: false },
      { name: "origin/main", isRemote: true, isCurrent: false }
    ]);
  });
});

describe("filterBranchOptions", () => {
  const options = [
    { name: "main", isRemote: false, isCurrent: true },
    { name: "feature_01", isRemote: false, isCurrent: false }
  ];

  it("空关键词返回全部，匹配大小写不敏感", () => {
    expect(filterBranchOptions(options, "   ")).toHaveLength(2);
    expect(filterBranchOptions(options, "FEATURE")).toEqual([options[1]]);
    expect(filterBranchOptions(options, "release")).toEqual([]);
  });
});

describe("describeBranchSelection", () => {
  it("未选分支显示占位文案，选中后显示分支名", () => {
    expect(describeBranchSelection(null)).toBe(NEW_TASK_BRANCH_PLACEHOLDER);
    expect(describeBranchSelection("   ")).toBe(NEW_TASK_BRANCH_PLACEHOLDER);
    expect(describeBranchSelection("feature_01")).toBe("feature_01");
  });
});

describe("describeBranchHint", () => {
  it("正常仓库没有提示，失败时给出仓库消息或兜底文案", () => {
    expect(describeBranchHint(null)).toBeNull();
    expect(describeBranchHint(branchSummary({}))).toBeNull();
    expect(describeBranchHint(branchSummary({ available: false, message: "不是 git 仓库" }))).toBe("不是 git 仓库");
    expect(describeBranchHint(branchSummary({ available: false }))).toBe("当前文件夹不是 Git 仓库");
  });
});

describe("shouldShowNewTaskBranch", () => {
  it("只有 Git 仓库才显示分支：未读取、非 git 或读取失败时隐藏", () => {
    expect(shouldShowNewTaskBranch(null)).toBe(false);
    expect(shouldShowNewTaskBranch(branchSummary({ available: false }))).toBe(false);
    expect(shouldShowNewTaskBranch(branchSummary({}))).toBe(true);
  });
});

describe("新建任务状态栏分支可见性", () => {
  const statusBarSource = readFileSync(
    new URL("../apps/desktop/src/renderer/new-task/new-task-status-bar.tsx", import.meta.url),
    "utf8"
  );

  it("分支块只在 Git 仓库时渲染，位于可见性开关之后", () => {
    const gateIndex = statusBarSource.indexOf("{showBranch ? (");
    const branchTriggerIndex = statusBarSource.indexOf('openMenu === "branch" ? "is-open"');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(branchTriggerIndex).toBeGreaterThan(gateIndex);
  });
});

describe("NEW_TASK_INPUT_PLACEHOLDER", () => {
  it("只保留问候语，不承诺输入框不存在的 @ / 触发能力", () => {
    expect(NEW_TASK_INPUT_PLACEHOLDER).toContain("今天帮你做些什么");
    expect(NEW_TASK_INPUT_PLACEHOLDER).not.toContain("@");
    expect(NEW_TASK_INPUT_PLACEHOLDER).not.toContain("/");
  });
});

describe("新建任务页输入框高度", () => {
  const stylesSource = readFileSync(
    new URL("../apps/desktop/src/renderer/styles.css", import.meta.url),
    "utf8"
  );

  it("初始页输入框比常规聊天更高，覆盖规则只作用于新建任务页", () => {
    const scoped = stylesSource.match(/\.chat-canvas\.is-new-task \.chat-composer textarea \{([^}]*)\}/);
    expect(scoped?.[1]).toContain("min-height: 96px");
  });

  it("常规聊天的输入框高度定义没有被改高", () => {
    const genericBodies = stylesSource
      .split("\n.chat-composer textarea {")
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf("}")));
    expect(genericBodies.length).toBeGreaterThan(0);
    expect(genericBodies.every((body) => !body.includes("min-height: 96px"))).toBe(true);
  });
});
