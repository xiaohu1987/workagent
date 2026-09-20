import { describe, expect, it } from "vitest";
import type { AppConfig, ThreadRecord } from "@shared-types";
import type { ProviderFactory } from "@provider-adapters";
import {
  DEFAULT_THREAD_TITLE,
  ThreadTitleService,
  buildThreadTitleFromFirstMessage,
  parseThreadTitleResponse,
  resolveThreadTitleModel,
  shouldGenerateThreadTitle,
  type ThreadTitleStore
} from "../apps/desktop/src/main/thread-title";

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-1",
    title: DEFAULT_THREAD_TITLE,
    mode: "chat",
    workspaceKind: "projectless",
    cwd: null,
    workspaceRoots: [],
    projectId: null,
    providerId: "provider-a",
    modelId: "model-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  } as unknown as ThreadRecord;
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    defaultProvider: "provider-a",
    defaultModel: "model-a",
    providers: [{ id: "provider-a", type: "openai", baseUrl: "https://example.test" }],
    models: [{ id: "model-a", providerId: "provider-a" }],
    desktop: { autoTitleGeneration: true },
    ...overrides
  } as unknown as AppConfig;
}

/** Provider factory that answers with a canned title and counts calls. */
function makeProviderFactory(response: string, state: { calls: number }, failure?: Error): ProviderFactory {
  return {
    create: () => ({
      runTurn: async () => {
        state.calls += 1;
        if (failure) throw failure;
        return { assistantMessage: response, toolCalls: [], endTurn: true };
      }
    })
  } as unknown as ProviderFactory;
}

/** Store whose `getThread` walks a scripted sequence of thread snapshots. */
function makeStore(threads: ThreadRecord[]) {
  const state = {
    patches: [] as Array<{ threadId: string; patch: { title: string } }>,
    applied: [] as ThreadRecord[],
    reads: 0
  };
  const store: ThreadTitleStore = {
    getThread: () => {
      const index = Math.min(state.reads, threads.length - 1);
      state.reads += 1;
      return threads[index] ?? null;
    },
    updateThread: (threadId, patch) => {
      state.patches.push({ threadId, patch });
      return { ...threads[threads.length - 1], title: patch.title } as ThreadRecord;
    }
  };
  return { store, state };
}

describe("buildThreadTitleFromFirstMessage", () => {
  it("distils the topic out of a polite, constraint-heavy request", () => {
    expect(buildThreadTitleFromFirstMessage("帮我用 Python 写一个贪吃蛇游戏，要求支持键盘操作和计分")).toBe(
      "用 Python 写一个贪吃蛇游戏"
    );
  });

  it("stops before a follow-up clause that would blow the character budget", () => {
    expect(buildThreadTitleFromFirstMessage("麻烦把报表页的导出改成分页，顺便把筛选条件和排序也一起加上")).toBe(
      "把报表页的导出改成分页"
    );
  });

  it("drops trailing politeness clauses", () => {
    expect(buildThreadTitleFromFirstMessage("帮我把这个函数改成 async，谢谢")).toBe("把这个函数改成 async");
  });

  it("ignores fenced code blocks and keeps the prose intent", () => {
    const title = buildThreadTitleFromFirstMessage("```ts\nconst a = 1;\n```\n帮我修复 storage.ts 的类型报错");
    expect(title).toBe("修复 storage.ts 的类型报错");
  });

  it("cuts long messages at a word boundary for Latin text", () => {
    const title = buildThreadTitleFromFirstMessage(
      "Please add a dark mode toggle to the settings page and persist the choice"
    );
    expect(title.endsWith("...")).toBe(true);
    expect(title).not.toContain("  ");
    expect(title).toBe("Please add a dark mode...");
  });

  it("falls back to the placeholder for empty input", () => {
    expect(buildThreadTitleFromFirstMessage("   \n  ")).toBe(DEFAULT_THREAD_TITLE);
  });
});

describe("shouldGenerateThreadTitle", () => {
  it("skips greetings and very short messages", () => {
    expect(shouldGenerateThreadTitle("你好")).toBe(false);
    expect(shouldGenerateThreadTitle("hi")).toBe(false);
    expect(shouldGenerateThreadTitle("！！！")).toBe(false);
  });

  it("accepts a substantive request", () => {
    expect(shouldGenerateThreadTitle("把报表导出的编码问题修一下")).toBe(true);
  });
});

describe("parseThreadTitleResponse", () => {
  it("unwraps quotes, prefixes and punctuation", () => {
    expect(parseThreadTitleResponse('"排查 OKF 召回误报"')).toBe("排查 OKF 召回误报");
    expect(parseThreadTitleResponse("标题：给报表补 Excel 导出。")).toBe("给报表补 Excel 导出");
    expect(parseThreadTitleResponse("```\n修复登录超时\n```")).toBe("修复登录超时");
  });

  it("rejects placeholders, empty answers and over-long answers", () => {
    expect(parseThreadTitleResponse("")).toBeNull();
    expect(parseThreadTitleResponse("无法概括")).toBeNull();
    expect(parseThreadTitleResponse("未命名")).toBeNull();
    expect(parseThreadTitleResponse("一".repeat(60))).toBeNull();
  });
});

describe("resolveThreadTitleModel", () => {
  it("prefers the thread's own model", () => {
    const selection = resolveThreadTitleModel(makeConfig(), makeThread());
    expect(selection?.model.id).toBe("model-a");
  });
});

describe("ThreadTitleService", () => {
  it("overwrites the fallback title with the model summary", async () => {
    const state = { calls: 0 };
    const { store, state: storeState } = makeStore([makeThread({ title: "排查查询超时问题" })]);
    const service = new ThreadTitleService({
      config: () => makeConfig(),
      providerFactory: makeProviderFactory("定位查询超时根源", state),
      store,
      applyTitle: (thread) => storeState.applied.push(thread)
    });

    const title = await service.generate("thread-1", "SQL 查询一到大表就超时，帮我定位原因", "排查查询超时问题");

    expect(title).toBe("定位查询超时根源");
    expect(state.calls).toBe(1);
    expect(storeState.patches).toEqual([{ threadId: "thread-1", patch: { title: "定位查询超时根源" } }]);
    expect(storeState.applied).toHaveLength(1);
  });

  it("keeps a title the user renamed while the model was thinking", async () => {
    const state = { calls: 0 };
    const { store, state: storeState } = makeStore([
      makeThread({ title: "排查查询超时问题" }),
      makeThread({ title: "我自己的标题" })
    ]);
    const service = new ThreadTitleService({
      config: () => makeConfig(),
      providerFactory: makeProviderFactory("定位查询超时根源", state),
      store,
      applyTitle: () => undefined
    });

    expect(await service.generate("thread-1", "SQL 查询一到大表就超时，帮我定位原因", "排查查询超时问题")).toBeNull();
    expect(storeState.patches).toHaveLength(0);
  });

  it("does not call the model when auto naming is disabled", async () => {
    const state = { calls: 0 };
    const { store } = makeStore([makeThread()]);
    const service = new ThreadTitleService({
      config: () => makeConfig({ desktop: { autoTitleGeneration: false } } as unknown as Partial<AppConfig>),
      providerFactory: makeProviderFactory("不该出现", state),
      store,
      applyTitle: () => undefined
    });

    expect(await service.generate("thread-1", "把报表导出的编码问题修一下", "报表导出编码")).toBeNull();
    expect(state.calls).toBe(0);
  });

  it("does not call the model for greeting-only messages", async () => {
    const state = { calls: 0 };
    const { store } = makeStore([makeThread()]);
    const service = new ThreadTitleService({
      config: () => makeConfig(),
      providerFactory: makeProviderFactory("问候", state),
      store,
      applyTitle: () => undefined
    });

    expect(await service.generate("thread-1", "你好", "你好")).toBeNull();
    expect(state.calls).toBe(0);
  });

  it("keeps the fallback title when the provider fails", async () => {
    const state = { calls: 0 };
    const { store, state: storeState } = makeStore([makeThread({ title: "报表导出编码" })]);
    const service = new ThreadTitleService({
      config: () => makeConfig(),
      providerFactory: makeProviderFactory("", state, new Error("provider down")),
      store,
      applyTitle: () => undefined
    });

    expect(await service.generate("thread-1", "把报表导出的编码问题修一下", "报表导出编码")).toBeNull();
    expect(state.calls).toBe(2);
    expect(storeState.patches).toHaveLength(0);
  });

  it("keeps the fallback title when the answer is unusable", async () => {
    const state = { calls: 0 };
    const { store, state: storeState } = makeStore([makeThread({ title: "报表导出编码" })]);
    const service = new ThreadTitleService({
      config: () => makeConfig(),
      providerFactory: makeProviderFactory("无法概括", state),
      store,
      applyTitle: () => undefined
    });

    expect(await service.generate("thread-1", "把报表导出的编码问题修一下", "报表导出编码")).toBeNull();
    expect(storeState.patches).toHaveLength(0);
  });

  it("never throws from schedule", async () => {
    const { store } = makeStore([makeThread()]);
    const service = new ThreadTitleService({
      config: () => makeConfig(),
      providerFactory: {
        create: () => {
          throw new Error("no adapter");
        }
      } as unknown as ProviderFactory,
      store,
      applyTitle: () => undefined
    });

    expect(() => service.schedule("thread-1", "把报表导出的编码问题修一下", "报表导出编码")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
