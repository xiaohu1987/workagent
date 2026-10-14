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

describe("启动落地页面", () => {
  it("启动时列表刷新不自动定位到某个任务", () => {
    const source = topLevelFunctionSource("refreshAll");
    expect(source).toContain("refreshThreads({ fallbackToFirst: false })");
  });

  it("启动默认落在新建任务页（默认页面），而不是先进入某个任务", () => {
    expect(appSource).toContain("const [isNewTaskComposerOpen, setIsNewTaskComposerOpen] = useState(true);");
    expect(appSource).not.toContain("const [isNewTaskComposerOpen, setIsNewTaskComposerOpen] = useState(false);");
  });
});

describe("默认页面上的操作不再把用户定位到某个任务", () => {
  const cases: Array<[name: string, minimum: number]> = [
    ["saveProjectEdit", 1],
    ["toggleThreadPinned", 1],
    ["commitRenameHistoryThread", 1],
    ["confirmManagedRemoval", 1],
    ["saveConfigDraft", 1],
    ["confirmDeleteHistoryThread", 2],
    ["confirmBatchDeleteHistoryThreads", 2]
  ];

  it("删除/置顶/重命名/移除插件/保存配置/保存项目后仍留在当前页面", () => {
    for (const [name, minimum] of cases) {
      const source = topLevelFunctionSource(name);
      const count = source.split("fallbackToFirst: false").length - 1;
      expect(count, `${name} 应至少包含 ${minimum} 处 fallbackToFirst: false`).toBeGreaterThanOrEqual(minimum);
    }
  });
});

describe("新建任务首次发送", () => {
  it("等待创建线程期间保留空白新任务布局，避免先露出旧欢迎页", () => {
    const source = topLevelFunctionSource("sendMessage");
    const createThread = source.indexOf("await createThreadRecord(");
    const selectWithLayout = source.indexOf("selectThreadId(thread.id, { keepNewTaskLayout: true });");
    const seed = source.indexOf("seedOptimisticThreadSnapshot(thread);");
    const closeLayout = source.indexOf("if (isNewTaskComposerOpen) setIsNewTaskComposerOpen(false);");

    expect(createThread).toBeGreaterThan(0);
    // 建线程之前不得撤掉空白布局：此时 selectedThreadId 仍为 null，视图判定
    // 会回落到 welcome，旧的初始欢迎页就会闪一帧。
    expect(source.slice(0, createThread)).not.toContain("setIsNewTaskComposerOpen(false);");
    expect(selectWithLayout).toBeGreaterThan(createThread);
    expect(seed).toBeGreaterThan(selectWithLayout);
    // 视图已切到会话内容之后再撤掉空白布局。
    expect(closeLayout).toBeGreaterThan(seed);
  });

  it("线程切换入口默认仍会关闭空白新任务布局", () => {
    const selectSource = topLevelFunctionSource("selectThreadId");
    expect(selectSource).toContain("keepNewTaskLayout");
    expect(selectSource).toContain("if (nextThreadId && !options?.keepNewTaskLayout) setIsNewTaskComposerOpen(false);");
  });
});
