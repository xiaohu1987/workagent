import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AppConfig,
  MessageRecord,
  SelfImprovementMemoryRecord,
  ThreadRecord,
  ToolCallRecord
} from "@shared-types";
import type { ProviderFactory } from "@provider-adapters";
import { buildSelfImprovementContext } from "@agent-runtime";
import { DatabaseService } from "../apps/desktop/src/main/storage";
import {
  MemoryDistillerService,
  buildCandidateFingerprint,
  buildMemoryDigest,
  isDistillableThread,
  normalizeDistilledCandidates,
  parseDistilledMemories,
  summarizeToolCalls,
  type MemoryDistillStore
} from "../apps/desktop/src/main/memory-distiller";

const tempDirs: string[] = [];
const databases: DatabaseService[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-memory-scope-"));
  tempDirs.push(dir);
  return dir;
}

async function makeDatabase(): Promise<DatabaseService> {
  const dir = await makeTempDir();
  const db = new DatabaseService(path.join(dir, "codexh.sqlite"));
  databases.push(db);
  return db;
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = overrides.id ?? "thread-1";
  return {
    id,
    title: "任务标题",
    mode: "project",
    workspaceKind: "project",
    cwd: "D:\\work\\project-a",
    projectId: "project-a",
    workspaceId: null,
    modelId: "model-a",
    providerId: "provider-a",
    status: "completed",
    selectedSkillIds: [],
    selectedPluginIds: [],
    knowledgeBaseIds: [],
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:10:00.000Z",
    isPinned: false,
    pinnedAt: null,
    gpaStateJson: null,
    parentThreadId: null,
    rootThreadId: id,
    agentPath: "/root",
    agentRole: null,
    lastTaskMessage: null,
    multiAgentMode: "disabled",
    ...overrides
  };
}

function makeMessage(role: MessageRecord["role"], content: string): MessageRecord {
  return {
    id: `${role}-${Math.random().toString(36).slice(2)}`,
    threadId: "thread-1",
    turnRunId: null,
    role,
    content,
    metadataJson: null,
    createdAt: "2026-09-17T00:05:00.000Z"
  };
}

describe("memory scope separation", () => {
  it("lists project and global memories separately instead of merging them", async () => {
    const db = await makeDatabase();
    db.upsertSelfImprovementMemory({
      scope: "project", projectId: "project-a", kind: "experience",
      title: "仓库构建命令", content: "使用 pnpm build。", sourceThreadId: "t1"
    });
    db.upsertSelfImprovementMemory({
      scope: "project", projectId: "project-b", kind: "experience",
      title: "另一个仓库的约定", content: "使用 npm run build。", sourceThreadId: "t2"
    });
    db.upsertSelfImprovementMemory({
      scope: "global", projectId: null, kind: "preference",
      title: "回复偏好", content: "先给结论。", sourceThreadId: "t3"
    });

    expect(db.listSelfImprovementMemories({ scope: "global" }).map((row) => row.title)).toEqual(["回复偏好"]);
    expect(db.listSelfImprovementMemories({ scope: "project", projectId: "project-a" }).map((row) => row.title))
      .toEqual(["仓库构建命令"]);
    expect(db.listSelfImprovementMemories({ scope: "project", projectId: "project-b" }).map((row) => row.title))
      .toEqual(["另一个仓库的约定"]);
    // A project-scoped query without a project must not fall back to everything.
    expect(db.listSelfImprovementMemories({ scope: "project" })).toEqual([]);
    expect(db.countSelfImprovementMemories()).toEqual({ total: 3, global: 1, project: 2 });
  });

  it("keeps scoped search inside its scope", async () => {
    const db = await makeDatabase();
    db.upsertSelfImprovementMemory({
      scope: "project", projectId: "project-a", kind: "experience",
      title: "project deploy", content: "deploy with make release", sourceThreadId: "t1"
    });
    db.upsertSelfImprovementMemory({
      scope: "global", projectId: null, kind: "preference",
      title: "global deploy", content: "always ask before deploying", sourceThreadId: "t2"
    });

    expect(db.searchSelfImprovementMemories({ query: "deploy", scope: "global" }).map((row) => row.title))
      .toEqual(["global deploy"]);
    expect(db.searchSelfImprovementMemories({ query: "deploy", scope: "project", projectId: "project-a" }).map((row) => row.title))
      .toEqual(["project deploy"]);
    expect(db.searchSelfImprovementMemories({ query: "deploy", scope: "project", projectId: "project-z" })).toEqual([]);
    // Legacy combined recall still returns both, project first by usage.
    expect(db.searchSelfImprovementMemories({ query: "deploy", projectId: "project-a" }).map((row) => row.title))
      .toEqual(expect.arrayContaining(["project deploy", "global deploy"]));
  });

  it("merges by fingerprint so re-distilling updates instead of duplicating", async () => {
    const db = await makeDatabase();
    const first = db.mergeSelfImprovementMemory({
      scope: "project", projectId: "project-a", kind: "experience",
      title: "测试命令", content: "先跑 pnpm test。", sourceThreadId: "t1"
    });
    expect(first.action).toBe("created");
    const second = db.mergeSelfImprovementMemory({
      scope: "project", projectId: "project-a", kind: "experience",
      title: "测试命令", content: "先跑 pnpm test，再跑 pnpm typecheck。", sourceThreadId: "t2"
    });
    expect(second.action).toBe("updated");
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.content).toContain("typecheck");
    expect(db.listSelfImprovementMemories({ all: true })).toHaveLength(1);
    expect(db.findSelfImprovementMemoryByFingerprint({
      scope: "project", projectId: "project-a", fingerprint: first.record.fingerprint
    })?.id).toBe(first.record.id);

    // Identical content is a no-op refresh rather than a rewrite.
    const third = db.mergeSelfImprovementMemory({
      scope: "project", projectId: "project-a", kind: "experience",
      title: "测试命令", content: "先跑 pnpm test，再跑 pnpm typecheck。", sourceThreadId: "t3"
    });
    expect(third.action).toBe("unchanged");

    // The same title in another project stays a separate record.
    const otherProject = db.mergeSelfImprovementMemory({
      scope: "project", projectId: "project-b", kind: "experience",
      title: "测试命令", content: "使用 npm test。", sourceThreadId: "t4"
    });
    expect(otherProject.action).toBe("created");
    expect(otherProject.record.fingerprint).not.toBe(first.record.fingerprint);
    // Newest update wins the default ordering.
    expect(db.listSelfImprovementMemories({ scope: "project", projectId: "project-b" }).map((row) => row.id))
      .toEqual([otherProject.record.id]);
  });

  it("prunes per scope bucket so projects cannot evict global memories", async () => {
    const db = await makeDatabase();
    for (let index = 0; index < 30; index += 1) {
      db.upsertSelfImprovementMemory({
        scope: "global", projectId: null, kind: "experience",
        title: `全局经验 ${index}`, content: `global body ${index}`, sourceThreadId: "t"
      });
      db.upsertSelfImprovementMemory({
        scope: "project", projectId: "project-a", kind: "experience",
        title: `项目经验 ${index}`, content: `project body ${index}`, sourceThreadId: "t"
      });
    }
    // Budget 20 → global keeps 20, project keeps 20 as well.
    db.pruneSelfImprovementMemories(3650, 20);
    const stats = db.countSelfImprovementMemories();
    expect(stats.global).toBe(20);
    expect(stats.project).toBe(20);
  });
});

describe("memory distillation", () => {
  it("builds a digest only from a completed exchange", () => {
    const thread = makeThread();
    expect(buildMemoryDigest({ thread, messages: [makeMessage("user", "only a request")], toolCalls: [] })).toBeNull();
    const digest = buildMemoryDigest({
      thread,
      messages: [makeMessage("user", "修复构建"), makeMessage("assistant", "已修复")],
      toolCalls: []
    });
    expect(digest?.request).toBe("修复构建");
    expect(digest?.outcome).toBe("已修复");
    expect(digest?.projectId).toBe("project-a");
  });

  it("summarizes tool outcomes for the digest", () => {
    const toolCalls = [
      { toolName: "shell.exec", status: "completed" },
      { toolName: "shell.exec", status: "failed" },
      { toolName: "fs.read_file", status: "completed" }
    ] as ToolCallRecord[];
    expect(summarizeToolCalls(toolCalls)).toEqual(["shell.exec(成功1/失败1)", "fs.read_file(成功1/失败0)"]);
  });

  it("parses candidates from several response shapes", () => {
    expect(parseDistilledMemories('{"memories":[{"scope":"global","title":"a","content":"b"}]}')).toHaveLength(1);
    expect(parseDistilledMemories('```json\n{"memories":[{"title":"a","content":"b"}]}\n```')).toHaveLength(1);
    expect(parseDistilledMemories('[{"title":"a","content":"b"}]')).toHaveLength(1);
    expect(parseDistilledMemories('{"data":{"memories":[{"title":"a","content":"b"}]}}')).toHaveLength(1);
    expect(parseDistilledMemories("not json at all")).toEqual([]);
  });

  it("never writes project-specific facts to the global scope", () => {
    const digest = buildMemoryDigest({
      thread: makeThread(),
      messages: [makeMessage("user", "构建"), makeMessage("assistant", "完成")],
      toolCalls: []
    })!;
    const candidates = normalizeDistilledCandidates([
      { scope: "global", topic: "build-command", title: "构建命令", content: "该仓库使用 pnpm build；本项目的构建脚本在 scripts/ 下。" },
      { scope: "global", topic: "response-style", title: "沟通偏好", content: "用户希望先给结论再解释细节。" },
      { scope: "project", topic: "test-command", title: "测试命令", content: "先跑 vitest 再跑 typecheck。" },
      { scope: "project", topic: "leak", title: "密钥", content: "token = sk-abcdefghijklmnopqrst" },
      { scope: "project", topic: "test-command", title: "测试命令重复", content: "重复条目应被合并。" }
    ], digest);
    expect(candidates.map((entry) => [entry.scope, entry.topic])).toEqual([
      ["project", "build-command"],
      ["global", "response-style"],
      ["project", "test-command"]
    ]);
  });

  it("forces the global scope when the task belongs to no project", () => {
    const digest = buildMemoryDigest({
      thread: makeThread({ projectId: null, cwd: "D:\\work\\scratch" }),
      messages: [makeMessage("user", "看一下"), makeMessage("assistant", "看完了")],
      toolCalls: []
    })!;
    const candidates = normalizeDistilledCandidates(
      [{ scope: "project", topic: "note", title: "环境", content: "本机是 Windows。" }],
      digest
    );
    expect(candidates).toEqual([expect.objectContaining({ scope: "global" })]);
  });

  it("treats only finished root threads as distillable", () => {
    expect(isDistillableThread(makeThread())).toBe(true);
    expect(isDistillableThread(makeThread({ id: "child", parentThreadId: "root" }))).toBe(false);
    expect(isDistillableThread(makeThread({ rootThreadId: "root-other" }))).toBe(false);
  });

  it("writes scoped memories and stays idempotent for unchanged content", async () => {
    const response = {
      memories: [
        { scope: "global", kind: "preference", topic: "response-style", title: "沟通偏好", content: "先给结论。" },
        { scope: "project", kind: "experience", topic: "build-command", title: "构建命令", content: "使用 pnpm build。" }
      ]
    };
    const fake = createFakeStore(JSON.stringify(response));
    const distiller = new MemoryDistillerService({
      config: () => makeConfig(),
      providerFactory: fake.providerFactory,
      store: fake.store
    });

    const first = await distiller.distillThread("thread-1");
    expect(first).toMatchObject({ created: 2, updated: 0, skipped: false });
    expect(fake.records.map((record) => [record.scope, record.projectId, record.title])).toEqual([
      ["global", null, "沟通偏好"],
      ["project", "project-a", "构建命令"]
    ]);
    expect(fake.records.every((record) => record.source === "distilled" && record.fingerprint.length > 0)).toBe(true);

    // Same conversation → the job hash matches and the model is not called again.
    const second = await distiller.distillThread("thread-1");
    expect(second).toMatchObject({ skipped: true, reason: "already_distilled" });
    expect(fake.modelCalls).toBe(1);

    // New turn → re-distilled, and the unchanged facts are refreshed, not duplicated.
    fake.appendTurn("补充：还需要跑 lint");
    const third = await distiller.distillThread("thread-1");
    expect(third).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(fake.records).toHaveLength(2);
    expect(fake.modelCalls).toBe(2);
  });

  it("records an unparseable model response as a failure instead of a silent success", async () => {
    const fake = createFakeStore("完全不是 JSON");
    const distiller = new MemoryDistillerService({
      config: () => makeConfig(),
      providerFactory: fake.providerFactory,
      store: fake.store
    });
    const result = await distiller.distillThread("thread-1");
    expect(result).toMatchObject({ created: 0, updated: 0, skipped: false });
    expect(fake.records).toHaveLength(0);
    expect(fake.lastError).toContain("没有返回可解析");
  });

  it("skips subagent threads", async () => {
    const fake = createFakeStore('{"memories":[]}');
    fake.thread = makeThread({ id: "child", parentThreadId: "root" });
    const distiller = new MemoryDistillerService({
      config: () => makeConfig(),
      providerFactory: fake.providerFactory,
      store: fake.store
    });
    expect(await distiller.distillThread("child")).toBeNull();
    expect(fake.modelCalls).toBe(0);
  });
});

describe("memory prompt injection", () => {
  it("renders project and global memories as separate labelled blocks", () => {
    const context = buildSelfImprovementContext({
      globalMemories: [{ title: "偏好", content: "先给结论。" }],
      projectMemories: [{ title: "构建", content: "pnpm build。" }]
    });
    expect(context.indexOf("【全局记忆】")).toBeGreaterThanOrEqual(0);
    expect(context.indexOf("【项目记忆】")).toBeGreaterThan(context.indexOf("【全局记忆】"));
    expect(context).toContain("- 偏好: 先给结论。");
    expect(context).toContain("- 构建: pnpm build。");
    expect(buildSelfImprovementContext({ globalMemories: [], projectMemories: [] })).toBe("");
  });
});

function makeConfig(): AppConfig {
  return {
    defaultProvider: "provider-a",
    defaultModel: "model-a",
    providers: [{ id: "provider-a", type: "openai", baseUrl: "https://example.test" }],
    models: [{ id: "model-a", providerId: "provider-a" }],
    selfImprovement: {
      generateMemories: true,
      useMemories: true,
      dedicatedTools: false,
      autoDistillOnComplete: true,
      idleMinutes: 5,
      retentionDays: 180,
      maxMemories: 500
    }
  } as unknown as AppConfig;
}

function makeProviderFactory(response: string, onCall?: () => void): ProviderFactory {
  return {
    create: () => ({
      runTurn: async () => {
        onCall?.();
        return {
          assistantMessage: response,
          toolCalls: [],
          endTurn: true,
          goalCompleted: true
        };
      }
    })
  } as unknown as ProviderFactory;
}

/** In-memory store that also emulates the job-lease bookkeeping. */
function createFakeStore(modelResponse: string) {
  const records: SelfImprovementMemoryRecord[] = [];
  const jobs = new Map<string, { hash: string; status: string }>();
  const state = {
    thread: makeThread(),
    records,
    modelCalls: 0,
    lastError: null as string | null,
    messages: [
      makeMessage("user", "修复构建失败"),
      makeMessage("assistant", "已修复，原因是缺少依赖。")
    ] as MessageRecord[],
    appendTurn: (content: string) => {
      state.messages.push(makeMessage("assistant", content));
      state.thread = { ...state.thread, updatedAt: new Date(Date.now() + 60_000).toISOString() };
    },
    // Attached below so mutations stay visible through the returned object.
    store: null as unknown as MemoryDistillStore,
    providerFactory: null as unknown as ProviderFactory
  };
  const store: MemoryDistillStore = {
    getThread: (threadId) => (threadId === state.thread.id ? state.thread : null),
    listMessages: () => state.messages,
    listToolCalls: () => [],
    claimSelfImprovementJob: (threadId, options = {}) => {
      const existing = jobs.get(threadId);
      if (!options.force && existing?.status === "completed" && options.contentHash && existing.hash === options.contentHash) return false;
      jobs.set(threadId, { hash: options.contentHash ?? "", status: "running" });
      return true;
    },
    finishSelfImprovementJob: (threadId, error) => {
      const existing = jobs.get(threadId);
      jobs.set(threadId, { hash: existing?.hash ?? "", status: error ? "failed" : "completed" });
      state.lastError = error ?? null;
    },
    mergeSelfImprovementMemory: (input) => {
      const projectId = input.scope === "project" ? input.projectId : null;
      const fingerprint = input.fingerprint ?? buildCandidateFingerprint({ topic: input.title, scope: input.scope }, projectId);
      const existing = records.find((record) =>
        record.fingerprint === fingerprint && record.scope === input.scope && record.projectId === projectId
      );
      if (existing) {
        const action = existing.title === input.title && existing.content === input.content ? "unchanged" : "updated";
        if (action === "updated") {
          existing.title = input.title;
          existing.content = input.content;
        }
        return { record: existing, action };
      }
      const record: SelfImprovementMemoryRecord = {
        id: `memory-${records.length + 1}`,
        scope: input.scope,
        projectId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        sourceThreadId: input.sourceThreadId,
        fingerprint,
        source: input.source ?? "distilled",
        usageCount: 0,
        lastUsedAt: null,
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:00.000Z"
      };
      records.push(record);
      return { record, action: "created" };
    },
    pruneSelfImprovementMemories: () => 0
  };
  state.store = store;
  state.providerFactory = makeProviderFactory(modelResponse, () => {
    state.modelCalls += 1;
  });
  return state;
}
