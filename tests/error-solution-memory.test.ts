import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const tempDirs: string[] = [];
const databases: DatabaseService[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-error-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("error solution memory persistence", () => {
  it("migrates legacy model-scoped rows without deleting them", async () => {
    const tempDir = await makeTempDir();
    const dbPath = path.join(tempDir, "codexh.sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE error_solutions (
      scope_key TEXT PRIMARY KEY, id TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', project_id TEXT,
      tool_name TEXT NOT NULL, task_key_pattern TEXT NOT NULL, error_signature TEXT NOT NULL,
      error_summary TEXT NOT NULL, solution_summary TEXT NOT NULL, strategy_json TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 1, source_thread_id TEXT, last_used_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const observedAt = "2026-07-01T00:00:00.000Z";
    legacy.prepare(`INSERT INTO error_solutions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-scope", "legacy-id", "legacy-model", "project-1", "apply_patch", "apply_patch:src/app.ts",
        "apply_patch:context mismatch", "context mismatch", "read then patch", "{}", 2, "thread-1",
        observedAt, observedAt, observedAt);
    legacy.close();

    const db = new DatabaseService(dbPath);
    databases.push(db);
    const [memory] = db.listErrorSolutions({ modelId: "legacy-model" });
    expect(memory).toMatchObject({
      id: "legacy-id",
      memoryKind: "recovered",
      scopeMode: "model",
      targetKeyPattern: "apply_patch:src/app.ts",
      successCount: 2,
      failureCount: 0,
      recallCount: 0,
      lastRecalledAt: null,
      lastRecallOutcome: null
    });
    expect(memory?.lastObservedAt).toBe(observedAt);
  });

  it("stores recovered solutions and retrieves similar failures for the same model", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    const first = db.upsertErrorSolution({
      modelId: "gpt-test",
      projectId: "project-1",
      toolName: "apply_patch",
      taskKeyPattern: "apply_patch:src/app.ts",
      errorSignature: "apply_patch:patch context did not match",
      errorSummary: "Patch context did not match current file content",
      solutionSummary: "Read src/app.ts first, then apply a minimal patch with exact context.",
      strategyJson: JSON.stringify({ successTool: "apply_patch", guidance: "read then rewrite" }),
      sourceThreadId: "thread-1"
    });

    expect(first.successCount).toBe(1);
    expect(first.modelId).toBe("gpt-test");

    const second = db.upsertErrorSolution({
      modelId: "gpt-test",
      projectId: "project-1",
      toolName: "apply_patch",
      taskKeyPattern: "apply_patch:src/app.ts",
      errorSignature: "apply_patch:patch context did not match",
      errorSummary: "Patch context did not match current file content",
      solutionSummary: "Read src/app.ts first, then apply a minimal patch with exact context.",
      strategyJson: JSON.stringify({ successTool: "apply_patch", guidance: "read then rewrite" }),
      sourceThreadId: "thread-2"
    });

    expect(second.id).toBe(first.id);
    expect(second.successCount).toBe(2);

    db.recordErrorSolutionRecall(first.id);
    db.setErrorSolutionRecallOutcome(first.id, "prerequisite");
    let listed = db.listErrorSolutions({ modelId: "gpt-test" });
    expect(listed[0]).toMatchObject({
      successCount: 2,
      recallCount: 1,
      lastRecallOutcome: "prerequisite"
    });
    expect(listed[0]?.lastRecalledAt).toBeTruthy();

    db.markErrorSolutionUsed(first.id);
    listed = db.listErrorSolutions({ modelId: "gpt-test" });
    expect(listed[0]?.lastRecallOutcome).toBe("recovered");

    const matches = db.searchErrorSolutions({
      modelId: "gpt-test",
      projectId: "project-1",
      toolName: "apply_patch",
      query: "patch context did not match",
      limit: 3
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.solutionSummary).toContain("Read src/app.ts first");
  });

  it("keeps memories isolated between different models", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    db.upsertErrorSolution({
      modelId: "model-a",
      projectId: null,
      toolName: "shell.exec",
      taskKeyPattern: "shell.exec:npm test",
      errorSignature: "shell.exec:exit code N",
      errorSummary: "command failed with exit code 1",
      solutionSummary: "Inspect package.json then run a narrower test script.",
      strategyJson: "{}",
      sourceThreadId: null,
      successCount: 3
    });

    db.upsertErrorSolution({
      modelId: "model-b",
      projectId: null,
      toolName: "shell.exec",
      taskKeyPattern: "shell.exec:npm test",
      errorSignature: "shell.exec:exit code N",
      errorSummary: "command failed with exit code 1",
      solutionSummary: "Retry with --silent and inspect stderr only.",
      strategyJson: "{}",
      sourceThreadId: null,
      successCount: 1
    });

    const forA = db.searchErrorSolutions({
      modelId: "model-a",
      toolName: "shell.exec",
      query: "exit code",
      limit: 3
    });
    const forB = db.searchErrorSolutions({
      modelId: "model-b",
      toolName: "shell.exec",
      query: "exit code",
      limit: 3
    });

    expect(forA).toHaveLength(1);
    expect(forA[0]?.solutionSummary).toContain("package.json");
    expect(forB).toHaveLength(1);
    expect(forB[0]?.solutionSummary).toContain("--silent");
    expect(db.listErrorSolutions({ modelId: "model-a" })).toHaveLength(1);
    expect(db.listErrorSolutions()).toHaveLength(2);
  });

  it("keeps project self-improvement experience isolated while retaining global experience", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    db.upsertSelfImprovementMemory({
      scope: "project", projectId: "project-a", kind: "experience", title: "Project A", content: "Use the A deployment command.", sourceThreadId: "thread-a"
    });
    db.upsertSelfImprovementMemory({
      scope: "global", projectId: null, kind: "preference", title: "Global", content: "Keep responses concise.", sourceThreadId: "thread-global"
    });

    const projectA = db.searchSelfImprovementMemories({ query: "deployment concise", projectId: "project-a" });
    const projectB = db.searchSelfImprovementMemories({ query: "deployment concise", projectId: "project-b" });
    expect(projectA.map((entry) => entry.title)).toEqual(expect.arrayContaining(["Project A", "Global"]));
    expect(projectB.map((entry) => entry.title)).toEqual(["Global"]);
  });

  it("lists error solutions from newest update to oldest", async () => {
    vi.useFakeTimers();
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    vi.setSystemTime("2026-07-25T01:00:00.000Z");
    const first = db.upsertErrorSolution({
      modelId: "model-a", projectId: null, toolName: "shell.exec",
      taskKeyPattern: "shell.exec:first", errorSignature: "first failure",
      errorSummary: "first failure", solutionSummary: "first solution",
      strategyJson: "{}", sourceThreadId: null
    });
    vi.setSystemTime("2026-07-25T02:00:00.000Z");
    const second = db.upsertErrorSolution({
      modelId: "model-a", projectId: null, toolName: "shell.exec",
      taskKeyPattern: "shell.exec:second", errorSignature: "second failure",
      errorSummary: "second failure", solutionSummary: "second solution",
      strategyJson: "{}", sourceThreadId: null
    });
    vi.setSystemTime("2026-07-25T03:00:00.000Z");
    db.recordErrorSolutionRecall(first.id);

    expect(db.listErrorSolutions({ modelId: "model-a" }).map((entry) => entry.id))
      .toEqual([first.id, second.id]);
  });

  it("lists self-improvement memories from newest update to oldest", async () => {
    vi.useFakeTimers();
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    vi.setSystemTime("2026-07-25T01:00:00.000Z");
    const first = db.upsertSelfImprovementMemory({
      scope: "global", projectId: null, kind: "experience", title: "First",
      content: "First memory", sourceThreadId: "thread-first"
    });
    vi.setSystemTime("2026-07-25T02:00:00.000Z");
    const second = db.upsertSelfImprovementMemory({
      scope: "global", projectId: null, kind: "experience", title: "Second",
      content: "Second memory", sourceThreadId: "thread-second"
    });
    vi.setSystemTime("2026-07-25T03:00:00.000Z");
    db.markSelfImprovementMemoryUsed(first.id);

    expect(db.listSelfImprovementMemories({ all: true }).map((entry) => entry.id))
      .toEqual([first.id, second.id]);
  });

  it("shares project recovery facts across models while keeping model strategies separate", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    const shared = db.upsertErrorSolution({
      modelId: "*",
      projectId: "project-1",
      toolName: "apply_patch",
      memoryKind: "recovered",
      scopeMode: "shared",
      taskKeyPattern: "apply_patch:src/app.ts",
      targetKeyPattern: "file:c:/repo/src/app.ts",
      strategyFingerprint: "failed-patch",
      errorSignature: "apply_patch:context mismatch",
      errorSummary: "Patch context did not match",
      solutionSummary: "Read the current file before applying a smaller patch.",
      strategyJson: "{}",
      sourceThreadId: "thread-a"
    });
    db.upsertErrorSolution({
      modelId: "model-a",
      projectId: "project-1",
      toolName: "apply_patch",
      memoryKind: "recovered",
      scopeMode: "model",
      taskKeyPattern: "apply_patch:src/app.ts",
      targetKeyPattern: "file:c:/repo/src/app.ts",
      strategyFingerprint: "failed-patch",
      errorSignature: "apply_patch:context mismatch",
      errorSummary: "Patch context did not match",
      solutionSummary: "Model A should use a minimal exact-context patch.",
      strategyJson: "{}",
      sourceThreadId: "thread-a"
    });

    const forModelB = db.searchErrorSolutions({
      modelId: "model-b",
      projectId: "project-1",
      toolName: "apply_patch",
      phase: "preflight",
      targetKey: "file:c:/repo/src/app.ts",
      strategyFingerprint: "failed-patch",
      query: "",
      limit: 5
    });
    expect(forModelB.map((entry) => entry.id)).toEqual([shared.id]);
    expect(forModelB[0]?.scopeMode).toBe("shared");
    expect(forModelB[0]?.matchKind).toBe("exact_strategy");

    const otherProject = db.searchErrorSolutions({
      modelId: "model-b",
      projectId: "project-2",
      toolName: "apply_patch",
      phase: "preflight",
      targetKey: "file:c:/repo/src/app.ts",
      strategyFingerprint: "failed-patch",
      query: "",
      limit: 5
    });
    expect(otherProject).toEqual([]);
  });

  it("stores blocked strategies with decayed confidence and no false success count", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);
    const observedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();

    const memory = db.upsertErrorSolution({
      modelId: "*",
      projectId: "project-1",
      toolName: "apply_patch",
      memoryKind: "blocked_strategy",
      scopeMode: "shared",
      taskKeyPattern: "apply_patch:src/app.ts",
      targetKeyPattern: "file:c:/repo/src/app.ts",
      strategyFingerprint: "known-bad",
      errorSignature: "apply_patch:context mismatch",
      errorSummary: "Patch context did not match",
      solutionSummary: "Do not repeat this patch.",
      strategyJson: "{}",
      sourceThreadId: "thread-a",
      failureCount: 2,
      lastObservedAt: observedAt
    });
    expect(memory.successCount).toBe(0);
    expect(memory.failureCount).toBe(2);

    const matches = db.searchErrorSolutions({
      modelId: "model-b",
      projectId: "project-1",
      toolName: "apply_patch",
      phase: "preflight",
      targetKey: "file:c:/repo/src/app.ts",
      strategyFingerprint: "known-bad",
      query: "",
      limit: 3
    });
    expect(matches[0]?.effectiveConfidence).toBeCloseTo(0.5, 1);
  });

  it("deletes one memory and can clear remaining records by model", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    const first = db.upsertErrorSolution({
      modelId: "model-a",
      projectId: null,
      toolName: "apply_patch",
      taskKeyPattern: "apply_patch:a.ts",
      errorSignature: "apply_patch:context mismatch a",
      errorSummary: "context mismatch a",
      solutionSummary: "read then rewrite a",
      strategyJson: "{}",
      sourceThreadId: null
    });
    db.upsertErrorSolution({
      modelId: "model-a",
      projectId: null,
      toolName: "shell.exec",
      taskKeyPattern: "shell.exec:pnpm test",
      errorSignature: "shell.exec:exit N",
      errorSummary: "exit 1",
      solutionSummary: "narrower command",
      strategyJson: "{}",
      sourceThreadId: null
    });
    db.upsertErrorSolution({
      modelId: "model-b",
      projectId: null,
      toolName: "fs.read_file",
      taskKeyPattern: "fs.read_file:missing.ts",
      errorSignature: "fs.read_file:enoent",
      errorSummary: "ENOENT",
      solutionSummary: "list directory first",
      strategyJson: "{}",
      sourceThreadId: null
    });

    db.deleteErrorSolution(first.id);
    expect(db.listErrorSolutions({ modelId: "model-a" }).map((entry) => entry.id)).not.toContain(first.id);
    expect(db.clearErrorSolutions("model-a")).toBe(1);
    expect(db.listErrorSolutions({ modelId: "model-a" })).toEqual([]);
    expect(db.listErrorSolutions({ modelId: "model-b" })).toHaveLength(1);
    expect(db.clearErrorSolutions()).toBe(1);
    expect(db.listErrorSolutions()).toEqual([]);
  });
});
