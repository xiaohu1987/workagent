import { describe, expect, it, vi } from "vitest";
import type { BrowserRecordingAction, RuntimeEvent } from "@shared-types";
import { BrowserRecordingChatBridge, parseCandidate } from "../apps/desktop/src/main/browser-recording-chat";
import { applyCandidateOperations } from "../apps/desktop/src/main/browser-recording-runtime";

describe("browser recording chat bridge", () => {
  it("parses a constrained repair candidate and rejects unknown operations", () => {
    const parsed = parseCandidate(JSON.stringify({
      operations: [{ op: "replace", actionId: "a1", action: { id: "a2", pageId: "page-1", type: "waitFor", locator: { strategy: "css", value: "#ready" }, state: "visible" } }],
      rationale: ["等待联动字段出现"],
      confidence: 0.85
    }));
    expect(parsed?.operations).toHaveLength(1);
    expect(parsed?.confidence).toBe(0.85);
    expect(parseCandidate(JSON.stringify({ operations: [{ op: "evaluate", actionId: "a1" }] }))).toBeNull();
    expect(parseCandidate(JSON.stringify({ operations: [{ op: "replace", actionId: "a1" }] }))).toBeNull();
    expect(parseCandidate(JSON.stringify({
      operations: [{ op: "replace", actionId: "a1", action: { id: "a2", pageId: "page-1", type: "click", locator: { strategy: "css", value: "#ready", unexpected: true } } }]
    }))).toBeNull();
  });

  it("writes model narration to the bound thread and emits streaming draft events", async () => {
    const events: RuntimeEvent[] = [];
    const messages: Array<Record<string, unknown>> = [];
    const db = {
      getThread: vi.fn(() => ({ id: "thread-1", providerId: "provider-1", modelId: "model-1" })),
      startTurn: vi.fn(() => ({ id: "turn-1" })),
      finishTurn: vi.fn(),
      listRecentMessages: vi.fn(() => []),
      createMessage: vi.fn((input: Record<string, unknown>) => {
        const message = { id: `message-${messages.length + 1}`, createdAt: new Date().toISOString(), ...input };
        messages.push(message);
        return message;
      })
    };
    const adapter = {
      runTurn: vi.fn(async (input: { onTextDelta?: (delta: string) => Promise<void> }) => {
        await input.onTextDelta?.("页面已打开");
        return { assistantMessage: "页面已打开", toolCalls: [], endTurn: true, goalCompleted: true, isStructured: true };
      })
    };
    const providerFactory = { create: vi.fn(() => adapter) };
    const model = { id: "model-1", providerId: "provider-1", role: "reasoning", supportsStreaming: true, supportsMultimodalInput: false };
    const provider = { id: "provider-1", type: "mock", apiFormat: "openai_chat" };
    const bridge = new BrowserRecordingChatBridge({
      db: db as never,
      getConfig: () => ({ defaultProvider: "provider-1", defaultModel: "model-1", providers: [provider], models: [model] } as never),
      providerFactory: providerFactory as never,
      emit: async (event) => { events.push(event); },
      isThreadBusy: () => false
    });
    const handle = await bridge.begin({ threadId: "thread-1", recordingId: "recording-1", operation: "playback" });
    await bridge.narrate(handle, "总结当前步骤");
    await bridge.complete(handle, "回放完成");

    expect(messages[0]?.threadId).toBe("thread-1");
    expect(messages.every((message) => message.metadataJson?.toString().includes("recording-1"))).toBe(true);
    expect(events.some((event) => event.type === "assistant.draft.updated")).toBe(true);
    expect(events.some((event) => event.type === "assistant.completed")).toBe(true);
    expect(db.finishTurn).toHaveBeenCalledWith("turn-1", expect.objectContaining({ status: "completed" }));
  });

  it("retries repair generation with a compact JSON-only request after an output-limit failure", async () => {
    const db = {
      getThread: vi.fn(() => ({ id: "thread-1", providerId: "provider-1", modelId: "model-1" })),
      startTurn: vi.fn(() => ({ id: "turn-1" })),
      finishTurn: vi.fn(),
      listRecentMessages: vi.fn(() => []),
      createMessage: vi.fn((input: Record<string, unknown>) => ({ id: "message-1", createdAt: new Date().toISOString(), ...input }))
    };
    const candidate = { operations: [], rationale: ["等待菜单展开"], confidence: 0.6 };
    const adapter = { runTurn: vi.fn()
      .mockRejectedValueOnce(new Error("response reached its output limit"))
      .mockResolvedValueOnce({ assistantMessage: JSON.stringify(candidate), toolCalls: [], endTurn: true, goalCompleted: true, isStructured: true }) };
    const provider = { id: "provider-1", type: "mock", apiFormat: "openai_chat" };
    const model = { id: "model-1", providerId: "provider-1", role: "reasoning", supportsStreaming: false, supportsMultimodalInput: false };
    const bridge = new BrowserRecordingChatBridge({
      db: db as never,
      getConfig: () => ({ defaultProvider: "provider-1", defaultModel: "model-1", providers: [provider], models: [model] } as never),
      providerFactory: { create: vi.fn(() => adapter) } as never,
      emit: async () => undefined,
      isThreadBusy: () => false
    });
    const handle = await bridge.begin({ threadId: "thread-1", recordingId: "recording-1", operation: "playback" });
    const result = await bridge.requestRepairCandidate(handle, {
      actions: Array.from({ length: 20 }, (_, index) => ({ id: `a${index}`, pageId: "page-1", type: "click", locator: { strategy: "css", value: `#item-${index}` }, createdAt: "now" } as BrowserRecordingAction)),
      failedAction: { id: "a10", pageId: "page-1", type: "click", locator: { strategy: "role", role: "menuitem", value: "特殊立项", exact: true }, createdAt: "now" },
      context: { summary: "页面上下文" }, baseRevision: "r1"
    });
    expect(result?.rationale).toEqual(["等待菜单展开"]);
    expect(adapter.runTurn).toHaveBeenCalledTimes(2);
    expect(String(adapter.runTurn.mock.calls[1][0].transcript[0].content)).toContain("只返回一行 JSON");
    expect(adapter.runTurn.mock.calls[1][0].transcript[0].attachments).toBeUndefined();
  });

  it("passes a transcript to the compact retry when the first repair response is not JSON", async () => {
    const db = {
      getThread: vi.fn(() => ({ id: "thread-1", providerId: "provider-1", modelId: "model-1" })),
      startTurn: vi.fn(() => ({ id: "turn-1" })),
      finishTurn: vi.fn(),
      listRecentMessages: vi.fn(() => []),
      createMessage: vi.fn((input: Record<string, unknown>) => ({ id: "message-1", createdAt: new Date().toISOString(), ...input }))
    };
    const candidate = { operations: [], rationale: ["页面状态已确认"], confidence: 0.5 };
    const adapter = { runTurn: vi.fn()
      .mockResolvedValueOnce({ assistantMessage: "我先分析一下", toolCalls: [], endTurn: true, goalCompleted: true, isStructured: true })
      .mockResolvedValueOnce({ assistantMessage: JSON.stringify(candidate), toolCalls: [], endTurn: true, goalCompleted: true, isStructured: true }) };
    const provider = { id: "provider-1", type: "mock", apiFormat: "openai_chat" };
    const model = { id: "model-1", providerId: "provider-1", role: "reasoning", supportsStreaming: false, supportsMultimodalInput: false };
    const bridge = new BrowserRecordingChatBridge({
      db: db as never,
      getConfig: () => ({ defaultProvider: "provider-1", defaultModel: "model-1", providers: [provider], models: [model] } as never),
      providerFactory: { create: vi.fn(() => adapter) } as never,
      emit: async () => undefined,
      isThreadBusy: () => false
    });
    const handle = await bridge.begin({ threadId: "thread-1", recordingId: "recording-1", operation: "playback" });
    const result = await bridge.requestRepairCandidate(handle, {
      actions: [], context: { summary: "失败页面" }, baseRevision: "r1"
    });
    expect(result?.rationale).toEqual(["页面状态已确认"]);
    expect(adapter.runTurn.mock.calls[1][0].transcript).toEqual([expect.objectContaining({ role: "user" })]);
  });

  it("lets the repair model inspect the retained Playwright page before returning a patch", async () => {
    const db = {
      getThread: vi.fn(() => ({ id: "thread-1", providerId: "provider-1", modelId: "model-1" })),
      startTurn: vi.fn(() => ({ id: "turn-1" })), finishTurn: vi.fn(), listRecentMessages: vi.fn(() => []),
      createMessage: vi.fn((input: Record<string, unknown>) => ({ id: "message-1", createdAt: new Date().toISOString(), ...input }))
    };
    const candidate = { operations: [], rationale: ["菜单已展开"], confidence: 0.8 };
    const adapter = { runTurn: vi.fn()
      .mockResolvedValueOnce({ assistantMessage: "先检查页面", toolCalls: [{ id: "tool-1", name: "playwright.inspect_page", arguments: {} }], endTurn: false, goalCompleted: false, isStructured: true })
      .mockResolvedValueOnce({ assistantMessage: JSON.stringify(candidate), toolCalls: [], endTurn: true, goalCompleted: true, isStructured: true }) };
    const provider = { id: "provider-1", type: "mock", apiFormat: "openai_chat" };
    const model = { id: "model-1", providerId: "provider-1", role: "reasoning", supportsStreaming: false, supportsMultimodalInput: false };
    const bridge = new BrowserRecordingChatBridge({
      db: db as never,
      getConfig: () => ({ defaultProvider: "provider-1", defaultModel: "model-1", providers: [provider], models: [model] } as never),
      providerFactory: { create: vi.fn(() => adapter) } as never,
      emit: async () => undefined,
      isThreadBusy: () => false
    });
    const handle = await bridge.begin({ threadId: "thread-1", recordingId: "recording-1", operation: "playback" });
    const execute = vi.fn(async () => JSON.stringify({ url: "https://example.test/form", text: "菜单内容" }));
    const result = await bridge.requestRepairCandidate(handle, {
      actions: [], context: { summary: "失败页面" }, baseRevision: "r1",
      playwright: { specs: [{ name: "playwright.inspect_page", namespace: "playwright", description: "inspect", inputSchema: { type: "object" }, riskLevel: "low" }], execute }
    });
    expect(result?.rationale).toEqual(["菜单已展开"]);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: "playwright.inspect_page" }));
    expect(adapter.runTurn.mock.calls[0][0].availableTools).toHaveLength(1);
    expect(adapter.runTurn.mock.calls[0][0].transcript[0].content).toContain("禁止调用 mcp.call、browser.*");
    expect(adapter.runTurn.mock.calls[1][0].transcript.at(-1)).toEqual(expect.objectContaining({ role: "tool", toolCallId: "tool-1" }));
  });
});

describe("browser recording plan operations", () => {
  it("applies only referenced constrained operations", () => {
    const actions: BrowserRecordingAction[] = [
      { id: "a1", pageId: "page-1", type: "click", locator: { strategy: "css", value: "#open" }, createdAt: "now" },
      { id: "a2", pageId: "page-1", type: "fill", locator: { strategy: "css", value: "#name" }, valueKey: "name_1", createdAt: "now" }
    ];
    const next = applyCandidateOperations(actions, {
      id: "candidate-1", recordingId: "recording-1", threadId: "thread-1", baseRevision: "r1",
      operations: [{ op: "insertBefore", actionId: "a2", action: { id: "wait-1", pageId: "page-1", type: "waitFor", locator: { strategy: "css", value: "#name" }, state: "visible", createdAt: "now" } }],
      rationale: [], confidence: 0.9, createdAt: "now", source: "replay-failure", failedActionId: "a2"
    });
    expect(next.map((action) => action.id)).toEqual(["a1", "wait-1", "a2"]);
    expect(() => applyCandidateOperations(actions, {
      id: "candidate-2", recordingId: "recording-1", threadId: "thread-1", baseRevision: "r1",
      operations: [{ op: "replace", actionId: "a1", action: { id: "bad", pageId: "page-1", type: "click", locator: { strategy: "css", value: "#open", extra: true } } }],
      rationale: [], confidence: 0.9, createdAt: "now", source: "replay-failure"
    } as never)).toThrow("结构无效");
  });
});
