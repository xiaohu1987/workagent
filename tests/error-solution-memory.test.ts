import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const tempDirs: string[] = [];
const databases: DatabaseService[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-error-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("error solution memory persistence", () => {
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

    db.markErrorSolutionUsed(first.id);
    const listed = db.listErrorSolutions({ modelId: "gpt-test" });
    expect(listed[0]?.successCount).toBe(3);

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
