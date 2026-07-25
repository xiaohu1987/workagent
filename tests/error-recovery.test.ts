import { describe, expect, it } from "vitest";
import type { ErrorSolutionRecord } from "../packages/shared-types/src";
import {
  MAX_PREMATURE_COMPLETION_ATTEMPTS,
  MAX_TARGET_FAILURE_ATTEMPTS,
  appendRecoveryEpisodeStep,
  calculateErrorSolutionConfidence,
  createRecoveryEpisode,
  createRecoveryPrerequisiteToolCall,
  createRecoveryStrategyFingerprint,
  getToolCallRecoveryTargetKey,
  shouldBlockPreviouslyFailedRecoveredStrategy,
  shouldHardBlockRememberedStrategy,
  updateRecoveryEpisodeFailure
} from "../packages/agent-runtime/src/error-recovery";

describe("recovery episodes", () => {
  it("keeps completion and target failure limits independent", () => {
    expect(MAX_TARGET_FAILURE_ATTEMPTS).toBe(2);
    expect(MAX_PREMATURE_COMPLETION_ATTEMPTS).toBe(5);
  });

  it("does not treat a successful read as recovery, but resolves on same-target delivery", () => {
    const targetKey = getToolCallRecoveryTargetKey("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"
    }, "C:/repo");
    const episode = createRecoveryEpisode({
      targetKey,
      toolName: "apply_patch",
      taskKey: "apply_patch:src/app.ts",
      errorSignature: "apply_patch:context mismatch",
      errorSummary: "context mismatch",
      strategyFingerprint: "bad-patch",
      failedApproach: "large stale patch"
    });

    expect(appendRecoveryEpisodeStep(episode, {
      toolName: "fs.read_file",
      targetKey: getToolCallRecoveryTargetKey("fs.read_file", { path: "src/app.ts" }, "C:/repo"),
      approach: "read current file",
      evidenceKinds: ["observation"]
    })).toBe(false);
    expect(episode.resolvedAt).toBeNull();

    expect(appendRecoveryEpisodeStep(episode, {
      toolName: "fs.write_file",
      targetKey: getToolCallRecoveryTargetKey("fs.write_file", { path: "src/app.ts" }, "C:/repo"),
      approach: "write verified current content",
      evidenceKinds: ["delivery"]
    })).toBe(true);
    expect(episode.resolvedAt).not.toBeNull();
  });

  it("retains every materially different failed strategy in one target episode", () => {
    const episode = createRecoveryEpisode({
      targetKey: "file:c:/repo/src/app.ts",
      toolName: "apply_patch",
      taskKey: "apply_patch:src/app.ts",
      errorSignature: "apply_patch:context mismatch",
      errorSummary: "first mismatch",
      strategyFingerprint: "strategy-1",
      failedApproach: "large patch"
    });
    updateRecoveryEpisodeFailure(episode, {
      toolName: "fs.write_file",
      taskKey: "fs.write_file:src/app.ts",
      errorSignature: "fs.write_file:version conflict",
      errorSummary: "second conflict",
      strategyFingerprint: "strategy-2",
      failedApproach: "stale full rewrite"
    });

    expect(episode.failureCount).toBe(2);
    expect(episode.failures.map((failure) => failure.strategyFingerprint)).toEqual(["strategy-1", "strategy-2"]);
  });

  it("uses stable strategy hashes and creates deterministic write prerequisites", () => {
    const left = createRecoveryStrategyFingerprint("apply_patch", { patch: "x", mode: "safe" });
    const right = createRecoveryStrategyFingerprint("apply_patch", { mode: "safe", patch: "x" });
    expect(left).toBe(right);

    const prerequisite = createRecoveryPrerequisiteToolCall({
      name: "apply_patch",
      arguments: { patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch" }
    }, "C:/repo", "call-1");
    expect(prerequisite).toEqual({
      id: "call-1",
      name: "fs.read_file",
      arguments: { path: expect.stringMatching(/src[\\/]app\.ts$/) }
    });
  });

  it("hard-blocks exact negative strategies for 90 days, then degrades to advice", () => {
    const makeMemory = (ageDays: number): ErrorSolutionRecord => {
      const observedAt = new Date(Date.UTC(2026, 6, 25) - ageDays * 86_400_000).toISOString();
      return {
        id: "memory-1",
        modelId: "*",
        projectId: "project-1",
        toolName: "apply_patch",
        memoryKind: "blocked_strategy",
        scopeMode: "shared",
        taskKeyPattern: "apply_patch:src/app.ts",
        targetKeyPattern: "file:c:/repo/src/app.ts",
        strategyFingerprint: "bad-patch",
        errorSignature: "apply_patch:context mismatch",
        errorSummary: "context mismatch",
        solutionSummary: "do not repeat",
        strategyJson: "{}",
        successCount: 0,
        failureCount: 2,
        confidence: 1,
        sourceThreadId: "thread-1",
        lastUsedAt: observedAt,
        lastObservedAt: observedAt,
        expiresAt: null,
        createdAt: observedAt,
        updatedAt: observedAt,
        matchKind: "exact_strategy"
      };
    };
    const now = new Date(Date.UTC(2026, 6, 25));
    expect(calculateErrorSolutionConfidence(makeMemory(30), now)).toBeCloseTo(0.5);
    expect(shouldHardBlockRememberedStrategy(makeMemory(89), now)).toBe(true);
    expect(shouldHardBlockRememberedStrategy(makeMemory(91), now)).toBe(false);
    const recovered = { ...makeMemory(1), memoryKind: "recovered" as const, successCount: 1, failureCount: 0 };
    expect(shouldBlockPreviouslyFailedRecoveredStrategy(recovered)).toBe(true);
    expect(shouldBlockPreviouslyFailedRecoveredStrategy({ ...recovered, matchKind: "exact_target" })).toBe(false);
  });
});
