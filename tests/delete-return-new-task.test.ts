import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url), "utf8");

// 取 App 组件内某个顶层函数的源码片段：从函数声明起，到下一个顶层函数为止。
function topLevelFunctionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}`);
  if (start === -1) {
    throw new Error(`未找到函数 ${name}`);
  }
  const candidates = ["\n  function ", "\n  async function "]
    .map((marker) => appSource.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : appSource.length;
  return appSource.slice(start, end);
}

describe("删除当前任务后的回落页面", () => {
  it("删除选中的任务后进入新建任务页，而不是旧欢迎页", () => {
    const source = topLevelFunctionSource("confirmDeleteHistoryThread");
    expect(source).toContain("await refreshThreads({ fallbackToFirst: false })");
    expect(source).toContain("openNewTaskComposer({ workspaceCwd: pickProjectWorkspaceCwd([thread]) })");
  });

  it("批量删除包含当前任务时同样进入新建任务页", () => {
    const source = topLevelFunctionSource("confirmBatchDeleteHistoryThreads");
    expect(source).toContain("pickProjectWorkspaceCwd([");
    expect(source).toContain("openNewTaskComposer({ workspaceCwd: deletedWorkspaceCwd })");
  });

  it("移除包含当前任务的项目后同样进入新建任务页", () => {
    const source = topLevelFunctionSource("removeProjectByCwd");
    expect(source).toContain("openNewTaskComposer({ workspaceCwd: cwd })");
  });

  it("新建任务页会默认沿用被删项目的工作空间与当前分支", () => {
    const source = topLevelFunctionSource("openNewTaskComposer");
    expect(source).toContain("preset?.workspaceCwd");
    expect(source).toContain('selectNewTaskWorkspace({ kind: "folder", cwd: workspaceCwd })');
  });
});

describe("项目右键「新建聊天」的入口", () => {
  it("进入空白任务页并预设该项目工作空间，而不是直接建线程打开旧默认页", () => {
    const source = topLevelFunctionSource("createProjectChat");
    expect(source).toContain("openNewTaskComposer({ workspaceCwd: cwd })");
    expect(source).not.toContain("createThreadRecord");
    expect(source).not.toContain("activateNewThread");
  });
});
