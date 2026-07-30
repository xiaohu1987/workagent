import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const temporaryDirectories: string[] = [];
const databases: DatabaseService[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("DatabaseService storage maintenance", () => {
  it("preserves application data when truncating the SQLite WAL", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-storage-maintenance-"));
    temporaryDirectories.push(directory);
    const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(database);
    const thread = database.createThread({
      title: "保留的数据",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock",
      providerId: "mock"
    });
    database.createMessage({
      threadId: thread.id,
      turnRunId: null,
      role: "user",
      content: "清理日志后仍然存在",
      metadataJson: null
    });

    database.checkpointWriteAheadLog();

    expect(database.getThread(thread.id).title).toBe("保留的数据");
    expect(database.listMessages(thread.id)).toEqual([
      expect.objectContaining({ role: "user", content: "清理日志后仍然存在" })
    ]);
  });

  it("clears task memories without removing error memories", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-memory-maintenance-"));
    temporaryDirectories.push(directory);
    const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(database);
    database.upsertSelfImprovementMemory({
      scope: "global",
      projectId: null,
      kind: "experience",
      title: "任务经验",
      content: "保留的任务处理方式",
      sourceThreadId: null
    });
    database.upsertErrorSolution({
      modelId: "model-a",
      projectId: null,
      toolName: "apply_patch",
      taskKeyPattern: "apply_patch:file.ts",
      errorSignature: "apply_patch:context mismatch",
      errorSummary: "context mismatch",
      solutionSummary: "read then patch",
      strategyJson: "{}",
      sourceThreadId: null
    });

    expect(database.clearSelfImprovementMemories()).toBe(1);
    expect(database.listSelfImprovementMemories({ all: true })).toEqual([]);
    expect(database.listErrorSolutions({ modelId: "model-a" })).toHaveLength(1);

    expect(database.clearErrorSolutions()).toBe(1);
    expect(database.listErrorSolutions()).toEqual([]);
  });
});
