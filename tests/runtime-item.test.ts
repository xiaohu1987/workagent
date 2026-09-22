import { describe, expect, it } from "vitest";
import {
  RUNTIME_ITEM_KIND_COVERAGE,
  RUNTIME_ITEM_KINDS,
  RUNTIME_ITEM_SINGLE_FRAME_KINDS,
  getRuntimeItemKindLabel,
  isRuntimeItemEventType,
  readRuntimeItemPayload,
  resolveRuntimeItemKindForTool,
  type RuntimeEvent
} from "@shared-types";
import { RuntimeItemWriter } from "../apps/desktop/src/main/runtime-item-writer";
import {
  RuntimeItemStream,
  describeRuntimeItemDetail,
  describeRuntimeItemProgress,
  withRuntimeItemDetails
} from "../apps/desktop/src/renderer/lib/runtime-item-stream";
import type { RuntimeActivityEntry } from "../apps/desktop/src/renderer/core/app-types";

const CREATED_AT = "2026-09-22T00:00:00.000Z";

function evt(type: string, payload: Record<string, unknown>, threadId = "thread-1"): RuntimeEvent {
  return { type, threadId, payload, createdAt: CREATED_AT } as unknown as RuntimeEvent;
}

function readItemPayload(frame: RuntimeEvent) {
  const payload = readRuntimeItemPayload(frame.payload);
  if (!payload) throw new Error(`frame ${frame.type} carried no readable item payload`);
  return payload;
}

describe("runtime item coverage table", () => {
  it("keeps the 19 upstream variants in declaration order", () => {
    expect(RUNTIME_ITEM_KINDS).toHaveLength(19);
    expect(RUNTIME_ITEM_KINDS[0]).toBe("userMessage");
    expect(RUNTIME_ITEM_KINDS[18]).toBe("contextCompaction");
  });

  it("declares a writer status and a label for every variant", () => {
    for (const kind of RUNTIME_ITEM_KINDS) {
      expect(RUNTIME_ITEM_KIND_COVERAGE[kind], `coverage for ${kind}`).toBeTruthy();
      expect(getRuntimeItemKindLabel(kind).length, `label for ${kind}`).toBeGreaterThan(0);
    }
    expect(Object.keys(RUNTIME_ITEM_KIND_COVERAGE).sort()).toEqual([...RUNTIME_ITEM_KINDS].sort());
  });

  it("marks the single-frame variants as a subset of the known variants", () => {
    for (const kind of RUNTIME_ITEM_SINGLE_FRAME_KINDS) {
      expect(RUNTIME_ITEM_KINDS).toContain(kind);
    }
  });

  it("resolves a canonical tool name to its variant", () => {
    expect(resolveRuntimeItemKindForTool("shell.exec")).toBe("commandExecution");
    expect(resolveRuntimeItemKindForTool("apply_patch")).toBe("fileChange");
    expect(resolveRuntimeItemKindForTool("spawn_agent")).toBe("collabAgentToolCall");
    expect(resolveRuntimeItemKindForTool("tool_search")).toBe("dynamicToolCall");
    expect(resolveRuntimeItemKindForTool("web_search.search_query")).toBe("webSearch");
    expect(resolveRuntimeItemKindForTool("desktop.capture_screenshot")).toBe("imageView");
    expect(resolveRuntimeItemKindForTool("fs.read_file")).toBe("functionCallOutput");
  });
});

describe("runtime item writer: tool lifecycle", () => {
  it("projects a shell command into a commandExecution item", () => {
    const writer = new RuntimeItemWriter();
    const started = writer.project(
      evt("tool.started", {
        toolCallId: "call-1",
        toolName: "shell.exec",
        turnRunId: "turn-1",
        argumentsJson: JSON.stringify({ command: "pnpm test" }),
        startedAt: CREATED_AT
      }),
      { cwd: "D:\\workagent" }
    );

    expect(started).toHaveLength(1);
    expect(started[0].type).toBe("item.started");
    const startPayload = readItemPayload(started[0]);
    expect(startPayload.itemId).toBe("call-1");
    expect(startPayload.itemType).toBe("commandExecution");
    expect(startPayload.status).toBe("inProgress");
    expect(startPayload.command).toBe("pnpm test");
    expect(startPayload.cwd).toBe("D:\\workagent");
    expect(startPayload.turnId).toBe("turn-1");

    const completed = writer.project(evt("tool.completed", {
      toolCallId: "call-1",
      toolName: "shell.exec",
      resultJson: JSON.stringify({ exitCode: 1, content: "1 failing test" }),
      status: "failed",
      startedAt: CREATED_AT,
      completedAt: "2026-09-22T00:00:02.500Z"
    }));

    expect(completed).toHaveLength(1);
    expect(completed[0].type).toBe("item.completed");
    const endPayload = readItemPayload(completed[0]);
    expect(endPayload.itemType).toBe("commandExecution");
    expect(endPayload.status).toBe("failed");
    expect(endPayload.exitCode).toBe(1);
    expect(endPayload.aggregatedOutput).toBe("1 failing test");
    // The item must report the start time the tool record persisted, not the
    // moment the derived frame happened to be produced.
    expect(endPayload.durationMs).toBe(2500);
  });

  it("fills the fileChange changes that only exist in the tool record", () => {
    const writer = new RuntimeItemWriter();
    const frames = writer.project(evt("tool.completed", {
      toolCallId: "call-2",
      toolName: "apply_patch",
      argumentsJson: JSON.stringify({ path: "src/index.ts" }),
      resultJson: JSON.stringify({ changedFiles: ["src/other.ts"] }),
      status: "completed"
    }));

    const payload = readItemPayload(frames[0]);
    expect(payload.itemType).toBe("fileChange");
    expect(payload.changes).toEqual([
      { path: "src/index.ts", kind: "update" },
      { path: "src/other.ts", kind: "update" }
    ]);
  });

  it("resolves MCP server and tool out of the raw arguments", () => {
    const writer = new RuntimeItemWriter();
    const frames = writer.project(evt("tool.started", {
      toolCallId: "call-3",
      toolName: "mcp.call",
      argumentsJson: JSON.stringify({ server: "github", tool: "search", query: "x" })
    }));

    const payload = readItemPayload(frames[0]);
    expect(payload.itemType).toBe("mcpToolCall");
    expect(payload.server).toBe("github");
    expect(payload.tool).toBe("search");
  });

  it("canonicalizes provider aliases before choosing the variant", () => {
    const writer = new RuntimeItemWriter();
    const frames = writer.project(evt("tool.started", {
      toolCallId: "call-4",
      toolName: "image_gen",
      argumentsJson: JSON.stringify({ prompt: "a cat" })
    }));

    expect(readItemPayload(frames[0]).itemType).toBe("imageGeneration");
  });

  it("ignores tool events without an identity", () => {
    const writer = new RuntimeItemWriter();
    expect(writer.project(evt("tool.started", { toolName: "shell.exec" }))).toHaveLength(0);
    expect(writer.project(evt("tool.completed", { toolCallId: "call-5" }))).toHaveLength(0);
  });
});

describe("runtime item writer: streaming and single-frame variants", () => {
  it("routes terminal bytes into the open command item only", () => {
    const writer = new RuntimeItemWriter();
    expect(writer.project(evt("terminal.output", { chunk: "orphan\n" }))).toHaveLength(0);

    writer.project(evt("tool.started", { toolCallId: "call-6", toolName: "shell.exec" }));
    const delta = writer.project(evt("terminal.output", { chunk: "hello\n" }));

    expect(delta).toHaveLength(1);
    expect(delta[0].type).toBe("item.delta");
    const payload = readItemPayload(delta[0]);
    expect(payload.itemId).toBe("call-6");
    expect(payload.channel).toBe("commandExecution/outputDelta");
    expect(payload.delta).toBe("hello\n");

    // Closing the tool must stop further bytes from being attached to it.
    writer.project(evt("tool.completed", { toolCallId: "call-6", toolName: "shell.exec" }));
    expect(writer.project(evt("terminal.output", { chunk: "late\n" }))).toHaveLength(0);
  });

  it("opens one item per drafted stream and closes it on completion", () => {
    const writer = new RuntimeItemWriter();
    const first = writer.project(evt("assistant.draft.updated", {
      draftId: "draft-1",
      turnRunId: "turn-1",
      content: "hello",
      reasoning: "thinking"
    }));

    expect(first.map((frame) => frame.type)).toEqual(["item.started", "item.started"]);
    const kinds = first.map((frame) => readItemPayload(frame).itemType);
    expect(kinds).toEqual(["agentMessage", "reasoning"]);
    // Text and reasoning stay separate items with distinct identities even
    // though one legacy event carries both streams.
    expect(new Set(first.map((frame) => readItemPayload(frame).itemId)).size).toBe(2);

    // A later frame of the same draft must not re-open the items.
    expect(writer.project(evt("assistant.draft.updated", { draftId: "draft-1", delta: " world" }))).toHaveLength(0);

    const closed = writer.project(evt("assistant.completed", { draftId: "draft-1" }));
    expect(closed.map((frame) => frame.type)).toEqual(["item.completed", "item.completed"]);
    for (const frame of closed) {
      expect(readItemPayload(frame).status).toBe("completed");
    }
    expect(writer.project(evt("assistant.completed", { draftId: "draft-1" }))).toHaveLength(0);
  });

  it("streams plan snapshots as deltas because plan has no legacy channel", () => {
    const writer = new RuntimeItemWriter();
    const gpa = (tasks: Array<{ id: string; title: string; done: boolean }>) => ({
      gpa: { stage: "plan", planTasks: tasks }
    });

    const started = writer.project(evt("gpa.updated", gpa([{ id: "t1", title: "first", done: false }])));
    expect(started).toHaveLength(1);
    expect(started[0].type).toBe("item.started");
    expect(readItemPayload(started[0]).channel).toBe("plan/delta");

    const grown = gpa([{ id: "t1", title: "first", done: false }, { id: "t2", title: "second", done: false }]);
    const delta = writer.project(evt("gpa.updated", grown));
    expect(delta.map((frame) => frame.type)).toEqual(["item.delta"]);
    expect(readItemPayload(delta[0]).text).toBe("[ ] first\n[ ] second");

    // GPA writes are frequent and often redundant: an identical snapshot must
    // not produce a second delta frame.
    expect(writer.project(evt("gpa.updated", grown))).toHaveLength(0);

    const cleared = writer.project(evt("gpa.updated", gpa([])));
    expect(cleared.map((frame) => frame.type)).toEqual(["item.completed"]);
    expect(readItemPayload(cleared[0]).tasks).toEqual([]);
  });

  it("completes the plan item once every task is done", () => {
    const writer = new RuntimeItemWriter();
    const snapshot = (done: boolean) => evt("gpa.updated", {
      gpa: { stage: "plan", planTasks: [{ id: "t1", title: "first", done }] }
    });

    expect(writer.project(snapshot(false)).map((frame) => frame.type)).toEqual(["item.started"]);

    const finished = writer.project(snapshot(true));
    expect(finished.map((frame) => frame.type)).toEqual(["item.completed"]);
    expect(readItemPayload(finished[0]).text).toBe("[x] first");

    // A finished plan stays finished for the next identical write instead of
    // re-opening an item that is already closed.
    expect(writer.project(snapshot(true))).toHaveLength(0);

    // Genuinely new work starts a fresh plan item.
    const next = writer.project(evt("gpa.updated", {
      gpa: { stage: "plan", planTasks: [{ id: "t2", title: "follow-up", done: false }] }
    }));
    expect(next.map((frame) => frame.type)).toEqual(["item.started"]);
  });

  it("publishes subagent activity as a single completed frame", () => {
    const writer = new RuntimeItemWriter();
    const frames = writer.project(evt("agent.watchdog", { reason: "no_progress", childThreadId: "child-1" }));

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("item.completed");
    const payload = readItemPayload(frames[0]);
    expect(payload.itemType).toBe("subAgentActivity");
    expect(payload.agentThreadId).toBe("child-1");
    expect(RUNTIME_ITEM_SINGLE_FRAME_KINDS).toContain(payload.itemType);
  });

  it("reports context compaction as an already-finished item", () => {
    const writer = new RuntimeItemWriter();
    const frames = writer.project(evt("agent.context_compacted", { beforeTokens: 100, afterTokens: 40 }));

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("item.completed");
    expect(readItemPayload(frames[0]).itemType).toBe("contextCompaction");
  });

  it("opens a userMessage item for a persisted user message only", () => {
    const writer = new RuntimeItemWriter();
    const user = writer.project(evt("message.created", {
      message: { id: "msg-1", role: "user", content: "hi", createdAt: CREATED_AT }
    }));
    expect(user).toHaveLength(1);
    expect(readItemPayload(user[0]).itemType).toBe("userMessage");

    expect(writer.project(evt("message.created", {
      message: { id: "msg-2", role: "assistant", content: "hello" }
    }))).toHaveLength(0);
  });

  it("never re-projects its own output", () => {
    const writer = new RuntimeItemWriter();
    for (const type of ["item.started", "item.delta", "item.completed"]) {
      expect(isRuntimeItemEventType(type)).toBe(true);
      expect(writer.project(evt(type, { itemId: "x", itemType: "plan", status: "inProgress" }))).toHaveLength(0);
    }
  });

  it("leaves unmapped legacy events alone", () => {
    const writer = new RuntimeItemWriter();
    expect(writer.project(evt("turn.updated", { turn: {} }))).toHaveLength(0);
    expect(writer.project(evt("thread.updated", { thread: {} }))).toHaveLength(0);
  });
});

describe("renderer item stream", () => {
  it("folds a whole tool lifecycle into a single entry", () => {
    const writer = new RuntimeItemWriter();
    const stream = new RuntimeItemStream();
    const frames = [
      ...writer.project(evt("tool.started", {
        toolCallId: "call-1",
        toolName: "shell.exec",
        argumentsJson: JSON.stringify({ command: "pnpm test" })
      })),
      ...writer.project(evt("terminal.output", { chunk: "line1\n" })),
      ...writer.project(evt("terminal.output", { chunk: "line2\n" })),
      ...writer.project(evt("tool.completed", {
        toolCallId: "call-1",
        toolName: "shell.exec",
        resultJson: JSON.stringify({ exitCode: 0 }),
        status: "completed"
      }))
    ];

    expect(stream.apply(frames)).toHaveLength(frames.length);
    expect(stream.list()).toHaveLength(1);

    const entry = stream.get("call-1");
    expect(entry?.kind).toBe("commandExecution");
    expect(entry?.label.length).toBeGreaterThan(0);
    expect(entry?.channel).toBe("commandExecution/outputDelta");
    expect(entry?.command).toBe("pnpm test");
    expect(entry?.exitCode).toBe(0);
    // Two deltas arrived, and neither overwrote the other.
    expect(entry?.deltaCount).toBe(2);
    expect(entry?.deltaChars).toBe(12);
    expect(stream.openItems()).toHaveLength(0);
    expect(describeRuntimeItemProgress(entry!)).toContain("已完成");
  });

  it("reports an unfinished command as an open item", () => {
    const writer = new RuntimeItemWriter();
    const stream = new RuntimeItemStream();
    stream.apply(writer.project(evt("tool.started", {
      toolCallId: "call-2",
      toolName: "shell.exec",
      argumentsJson: JSON.stringify({ command: "npm run dev" })
    })));

    const open = stream.openItems();
    expect(open).toHaveLength(1);
    expect(open[0].itemId).toBe("call-2");
    expect(describeRuntimeItemProgress(open[0])).toBe("运行中");
  });

  it("keeps the drafted reply and its reasoning as separate entries", () => {
    const writer = new RuntimeItemWriter();
    const stream = new RuntimeItemStream();
    stream.apply(writer.project(evt("assistant.draft.updated", {
      draftId: "draft-9",
      content: "answer",
      reasoning: "because"
    })));

    expect(stream.list().map((entry) => entry.kind).sort()).toEqual(["agentMessage", "reasoning"]);
    expect(new Set(stream.list().map((entry) => entry.itemId)).size).toBe(2);
  });

  it("skips frames that carry no item identity and can be cleared", () => {
    const stream = new RuntimeItemStream();
    expect(stream.apply([
      evt("item.started", { itemType: "plan" }),
      evt("turn.updated", { turn: {} })
    ])).toHaveLength(0);
    expect(stream.list()).toHaveLength(0);

    stream.apply([evt("item.started", {
      itemId: "plan-1",
      itemType: "plan",
      status: "inProgress",
      channel: "plan/delta"
    })]);
    expect(stream.list()).toHaveLength(1);
    stream.clear();
    expect(stream.list()).toHaveLength(0);
  });
});

describe("runtime item details", () => {
  it("describes a finished command with its exit code and duration", () => {
    const stream = new RuntimeItemStream();
    stream.apply([
      evt("item.started", {
        itemId: "call-1",
        itemType: "commandExecution",
        status: "inProgress",
        command: "pnpm test"
      })
    ]);
    // While the command runs the panel already shows the command line itself.
    expect(describeRuntimeItemDetail(stream.get("call-1")!)).toBeNull();

    stream.apply([
      evt("item.completed", {
        itemId: "call-1",
        itemType: "commandExecution",
        status: "failed",
        exitCode: 1,
        durationMs: 2500
      })
    ]);
    expect(describeRuntimeItemDetail(stream.get("call-1")!)).toBe("退出码 1 · 2.5s");
  });

  it("counts the distinct files of a patch", () => {
    const stream = new RuntimeItemStream();
    stream.apply([evt("item.started", {
      itemId: "call-2",
      itemType: "fileChange",
      status: "inProgress",
      changes: [
        { path: "a.ts", kind: "update" },
        { path: "a.ts", kind: "update" },
        { path: "b.ts", kind: "add" }
      ]
    })]);

    expect(stream.get("call-2")?.changedPaths).toEqual(["a.ts", "b.ts"]);
    expect(describeRuntimeItemDetail(stream.get("call-2")!)).toBe("2 个文件");
  });

  it("names the MCP target and keeps its streamed progress", () => {
    const stream = new RuntimeItemStream();
    stream.apply([evt("item.started", {
      itemId: "call-3",
      itemType: "mcpToolCall",
      status: "inProgress",
      server: "repo",
      tool: "search"
    })]);
    expect(describeRuntimeItemDetail(stream.get("call-3")!)).toBe("repo / search");

    stream.apply([evt("item.delta", {
      itemId: "call-3",
      itemType: "mcpToolCall",
      status: "inProgress",
      progress: "索引中"
    })]);
    expect(describeRuntimeItemDetail(stream.get("call-3")!)).toBe("repo / search · 索引中");
  });

  it("upgrades only the matching tool row and reports whether it changed", () => {
    const stream = new RuntimeItemStream();
    stream.apply([evt("item.completed", {
      itemId: "call-9",
      itemType: "commandExecution",
      status: "completed",
      exitCode: 0,
      durationMs: 1000
    })]);
    const entries = [
      { id: "tool-call-9", kind: "tool", toolCall: { id: "call-9", toolName: "shell.exec" } },
      { id: "tool-other", kind: "tool", toolCall: { id: "call-other", toolName: "fs.read_file" } },
      { id: "status-1", kind: "status", label: "运行中", createdAt: CREATED_AT }
    ] as unknown as RuntimeActivityEntry[];

    const merged = withRuntimeItemDetails(entries, stream.list());
    expect(merged?.[0]).toMatchObject({ itemDetail: "退出码 0 · 1.0s" });
    expect((merged?.[1] as { itemDetail?: string }).itemDetail).toBeUndefined();
    expect(merged?.[2]).toBe(entries[2]);
    // Nothing left to change, so the caller can skip a redundant state update.
    expect(withRuntimeItemDetails(merged!, stream.list())).toBeNull();
  });

  it("leaves rows alone for items that have no tool row", () => {
    const stream = new RuntimeItemStream();
    stream.apply([evt("item.started", { itemId: "plan-1", itemType: "plan", status: "inProgress" })]);
    const entries = [
      { id: "tool-1", kind: "tool", toolCall: { id: "call-1", toolName: "shell.exec" } }
    ] as unknown as RuntimeActivityEntry[];

    expect(withRuntimeItemDetails(entries, stream.list())).toBeNull();
    expect(withRuntimeItemDetails([], stream.list())).toBeNull();
  });
});
