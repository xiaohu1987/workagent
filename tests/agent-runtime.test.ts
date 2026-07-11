import { describe, expect, it } from "vitest";
import {
  createToolCallFingerprint,
  buildExecutionRecoveryInstruction,
  buildStrategySwitchInstruction,
  buildRepeatedTaskRecoveryMessage,
  buildRuntimeFailureRecoveryMessage,
  compactTranscriptForContext,
  CONTEXT_COMPACTION_THRESHOLD,
  shouldFinishGpaAnalysisTurn,
  getAddedPatchFiles,
  getToolCallTaskKey,
  MAX_REPEATED_TASK_FAILURES,
  parseGpaState
} from "@agent-runtime";

describe("createToolCallFingerprint", () => {
  it("stops only after five consecutive failures of the same tool task", () => {
    expect(MAX_REPEATED_TASK_FAILURES).toBe(5);
  });

  it("treats equivalent tool arguments as the same call", () => {
    expect(createToolCallFingerprint("read", { path: ".", depth: 1 })).toBe(
      createToolCallFingerprint("read", { depth: 1, path: "." })
    );
  });

  it("keeps different tools and arguments distinct", () => {
    const fingerprint = createToolCallFingerprint("read", { path: "." });

    expect(fingerprint).not.toBe(createToolCallFingerprint("read", { path: "src" }));
    expect(fingerprint).not.toBe(createToolCallFingerprint("read_file", { path: "." }));
  });

  it("groups patch retries by their target file instead of patch text", () => {
    const firstAttempt = "*** Begin Patch\n*** Add File: css/style.css\nbody {}\n*** End Patch";
    const retry = "*** Begin Patch\n*** Add File: css/style.css\n+body {}\n*** End Patch";

    expect(getToolCallTaskKey("apply_patch", { patch: firstAttempt })).toBe(
      getToolCallTaskKey("apply_patch", { patch: retry })
    );
  });

  it("identifies files created by an Add File patch", () => {
    expect(
      getAddedPatchFiles({
        patch: "*** Begin Patch\n*** Add File: js/renderer.js\n+export {}\n*** Add File: css/game.css\n+.game {}\n*** End Patch"
      })
    ).toEqual(["js/renderer.js", "css/game.css"]);
  });
});

describe("ACT execution recovery", () => {
  it("forces the next model turn to make a real tool call without reporting a task failure", () => {
    const instruction = buildExecutionRecoveryInstruction({
      attempt: 2,
      reason: "The decision did not execute a tool.",
      bootstrapWorkspace: true
    });

    expect(instruction).toContain("fs.read_directory");
    expect(instruction).toContain("call apply_patch");
    expect(instruction).toContain("Do not write progress prose");
    expect(instruction).not.toContain("failed");
  });
});

describe("context compaction", () => {
  it("compresses the transcript before it reaches the model context limit", () => {
    const transcript = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message ${index} ${"x".repeat(500)}`
    }));
    const result = compactTranscriptForContext(transcript, 2_000, "system instructions");

    expect(CONTEXT_COMPACTION_THRESHOLD).toBe(0.8);
    expect(result.compacted).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.transcript.length).toBeLessThan(transcript.length);
    expect(result.transcript[0]?.content).toContain("内部上下文压缩摘要");
  });

  it("leaves a small transcript unchanged", () => {
    const transcript = [{ role: "user" as const, content: "short request" }];
    const result = compactTranscriptForContext(transcript, 128_000, "system instructions");

    expect(result.compacted).toBe(false);
    expect(result.transcript).toBe(transcript);
  });
});

describe("GPA analysis turn completion", () => {
  it("ends a structured GOAL or PLAN reply even when the provider leaves end_turn false", () => {
    const decision = { isStructured: true, toolCalls: [] };

    expect(shouldFinishGpaAnalysisTurn("goal", decision)).toBe(true);
    expect(shouldFinishGpaAnalysisTurn("plan", decision)).toBe(true);
    expect(shouldFinishGpaAnalysisTurn("act", decision)).toBe(false);
  });

  it("does not complete an analysis stage when a tool call still needs blocking", () => {
    expect(
      shouldFinishGpaAnalysisTurn("plan", {
        isStructured: true,
        toolCalls: [{ id: "call-1", name: "fs.read_directory", arguments: { path: "." } }]
      })
    ).toBe(false);
  });
});

describe("strategy switching", () => {
  it("blocks the same failed patch and directs the model to inspect before a different patch", () => {
    const instruction = buildStrategySwitchInstruction({
      toolName: "apply_patch",
      taskKey: "apply_patch:src/app.ts",
      attempts: 2,
      lastError: "Patch context did not match"
    });

    expect(instruction).toContain("will not execute");
    expect(instruction).toContain("Inspect the target file");
    expect(instruction).toContain("materially different");
  });

  it("uses a different diagnostic route after a failed file read", () => {
    const instruction = buildStrategySwitchInstruction({
      toolName: "fs.read_file",
      taskKey: "fs.read_file:missing.ts",
      attempts: 2,
      lastError: "ENOENT"
    });

    expect(instruction).toContain("fs.read_directory");
    expect(instruction).toContain("corrected path");
  });
});

describe("failure recovery messages", () => {
  it("gives a concrete recovery path for repeated executable failures", () => {
    const message = buildRepeatedTaskRecoveryMessage({
      taskKey: "apply_patch:src/app.ts",
      attempts: 5,
      lastError: "Permission denied"
    });

    expect(message).toContain("建议");
    expect(message).toContain("权限");
    expect(message).toContain("重新发送任务");
  });

  it("gives an actionable recovery path for runtime errors", () => {
    const message = buildRuntimeFailureRecoveryMessage(new Error("Invalid workspace path"));

    expect(message).toContain("项目路径");
    expect(message).toContain("重新提交");
  });
});

describe("GPA access state", () => {
  it("persists full access independently from the GPA stage", () => {
    expect(
      parseGpaState(
        JSON.stringify({
          stage: "off",
          fullAccess: true,
          awaitingConfirmation: null,
          planTasks: [],
          updatedAt: "2026-01-01T00:00:00.000Z"
        })
      )
    ).toMatchObject({ stage: "off", fullAccess: true });
  });

  it("defaults full access to disabled for existing tasks", () => {
    expect(parseGpaState(null).fullAccess).toBe(false);
  });
});
