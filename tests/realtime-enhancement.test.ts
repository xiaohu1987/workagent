import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@shared-types";
import {
  RealtimeEnhancementController,
  realtimeTextReactionPolicy
} from "../apps/desktop/src/renderer/realtime-enhancement";

function event(
  type: RuntimeEvent["type"],
  payload: Record<string, unknown>,
  threadId = "thread-1"
): RuntimeEvent {
  return {
    type,
    threadId,
    payload,
    createdAt: new Date().toISOString()
  };
}

describe("realtime enhancement controller", () => {
  it("tracks streamed text, tool execution, and completion", async () => {
    const controller = new RealtimeEnhancementController({ enabled: true, threadId: "thread-1" });
    await controller.submitText("inspect the project");

    controller.handleRuntimeEvent(event("assistant.draft.updated", {
      turnRunId: "turn-1",
      draftId: "draft-1",
      content: "I am checking the project."
    }));
    expect(controller.getState()).toMatchObject({
      phase: "generating",
      turnRunId: "turn-1",
      assistantText: "I am checking the project."
    });

    controller.handleRuntimeEvent(event("tool.started", {
      turnRunId: "turn-1",
      toolName: "fs.read_directory"
    }));
    expect(controller.getState()).toMatchObject({ phase: "executing", activeTool: "fs.read_directory" });

    controller.handleRuntimeEvent(event("tool.completed", {
      turnRunId: "turn-1",
      toolName: "fs.read_directory"
    }));
    expect(controller.getState()).toMatchObject({ phase: "generating", activeTool: null });

    controller.handleRuntimeEvent(event("assistant.completed", {
      turnRunId: "turn-1",
      draftId: "draft-1",
      messageId: "message-1"
    }));
    expect(controller.getState()).toMatchObject({ phase: "generating", turnRunId: "turn-1" });

    controller.handleRuntimeEvent(event("thread.updated", {
      thread: { status: "completed" }
    }));
    expect(controller.getState()).toMatchObject({ phase: "completed", turnRunId: "turn-1" });

    controller.returnToIdle("turn-1");
    expect(controller.getState()).toMatchObject({ phase: "idle", turnRunId: null, assistantText: "" });
  });

  it("seals an interrupted turn so late events cannot revive it", async () => {
    let interruptCount = 0;
    const controller = new RealtimeEnhancementController(
      { enabled: true, threadId: "thread-1" },
      { interrupt: () => { interruptCount += 1; } }
    );

    await controller.submitText("first request");
    controller.handleRuntimeEvent(event("assistant.draft.updated", {
      turnRunId: "turn-old",
      content: "old response"
    }));

    await controller.submitText("second request");
    expect(interruptCount).toBe(1);
    expect(controller.getState()).toMatchObject({ phase: "thinking", userText: "second request", assistantText: "" });

    controller.handleRuntimeEvent(event("assistant.draft.updated", {
      turnRunId: "turn-old",
      content: "late old response"
    }));
    expect(controller.getState()).toMatchObject({ phase: "thinking", userText: "second request", assistantText: "" });

    controller.handleRuntimeEvent(event("assistant.draft.updated", {
      turnRunId: "turn-new",
      content: "new response"
    }));
    expect(controller.getState()).toMatchObject({ phase: "generating", turnRunId: "turn-new", assistantText: "new response" });
  });

  it("keeps a turn open when an assistant output is followed by a tool call", async () => {
    const controller = new RealtimeEnhancementController({ enabled: true, threadId: "thread-1" });
    await controller.submitText("search the web");

    controller.handleRuntimeEvent(event("assistant.completed", {
      turnRunId: "turn-1",
      draftId: "draft-1",
      messageId: "message-1"
    }));
    controller.handleRuntimeEvent(event("tool.started", {
      turnRunId: "turn-1",
      toolName: "web_search.search_query"
    }));

    expect(controller.getState()).toMatchObject({
      phase: "executing",
      turnRunId: "turn-1",
      activeTool: "web_search.search_query"
    });
  });

  it("ignores events from another thread and marks discarded output interrupted", async () => {
    const controller = new RealtimeEnhancementController({ enabled: true, threadId: "thread-1" });
    await controller.submitText("cancel this");
    controller.handleRuntimeEvent(event("assistant.draft.updated", {
      turnRunId: "turn-1",
      content: "partial"
    }));
    controller.handleRuntimeEvent(event("assistant.draft.updated", {
      turnRunId: "turn-other",
      content: "wrong thread"
    }, "thread-2"));
    expect(controller.getState().assistantText).toBe("partial");

    controller.handleRuntimeEvent(event("assistant.completed", {
      turnRunId: "turn-1",
      discarded: true
    }));
    expect(controller.getState()).toMatchObject({ phase: "interrupted", assistantText: "partial" });
  });

  it("reacts to text and runtime phase without making another model request", () => {
    expect(realtimeTextReactionPolicy({
      phase: "thinking",
      userText: "please fix this error",
      assistantText: "",
      activeTool: null
    })).toMatchObject({ mood: "warning", pulse: true });
    expect(realtimeTextReactionPolicy({
      phase: "completed",
      userText: "done",
      assistantText: "success",
      activeTool: null
    })).toMatchObject({ mood: "success", pulse: false });
  });
});
