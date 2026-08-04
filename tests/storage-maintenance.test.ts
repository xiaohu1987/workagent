import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  it("rolls back the runtime event migration when rebuilding the index fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-runtime-event-rollback-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "codexh.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE runtime_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        thread_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO runtime_events VALUES
        ('draft', 'assistant.draft.updated', 'thread-1', '{}', '2026-01-01T00:00:00.000Z'),
        ('compact', 'agent.context_compacted', 'thread-1', '{}', '2026-01-01T00:00:01.000Z');
      CREATE TABLE conflicting_index_owner (thread_id TEXT, type TEXT, created_at TEXT);
      CREATE INDEX idx_runtime_events_thread_type_created
        ON conflicting_index_owner(thread_id, type, created_at DESC);
      PRAGMA user_version = 1;
    `);
    legacy.close();

    expect(() => new DatabaseService(databasePath)).toThrow();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const events = inspection.prepare("SELECT id FROM runtime_events ORDER BY created_at").all();
    const temporaryTable = inspection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_events_compacted'")
      .get();
    const version = inspection.prepare("PRAGMA user_version").get() as { user_version: number };
    inspection.close();

    expect(events).toEqual([{ id: "draft" }, { id: "compact" }]);
    expect(temporaryTable).toBeUndefined();
    expect(version.user_version).toBe(1);
  });

  it("migrates legacy runtime events without retaining high-volume transient payloads", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-runtime-event-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "codexh.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE runtime_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        thread_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO runtime_events VALUES
        ('draft', 'assistant.draft.updated', 'thread-1', '{"content":"large transient draft"}', '2026-01-01T00:00:00.000Z'),
        ('delta', 'assistant.delta', 'thread-1', '{"content":"large transient delta"}', '2026-01-01T00:00:01.000Z'),
        ('compact-old', 'agent.context_compacted', 'thread-1', '{"turnRunId":"turn-1","contextWindow":128000,"threshold":80000,"target":40000,"beforeTokens":90000,"afterTokens":40000,"messagesBefore":100,"messagesAfter":60}', '2026-01-01T00:00:02.000Z'),
        ('compact-new', 'agent.context_compacted', 'thread-1', '{"turnRunId":"turn-2","contextWindow":128000,"threshold":80000,"target":40000,"beforeTokens":95000,"afterTokens":42000,"messagesBefore":110,"messagesAfter":64}', '2026-01-01T00:00:03.000Z');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const database = new DatabaseService(databasePath);
    databases.push(database);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const events = inspection.prepare("SELECT type FROM runtime_events ORDER BY created_at").all() as Array<{ type: string }>;
    const plan = inspection
      .prepare("EXPLAIN QUERY PLAN SELECT payload_json, created_at FROM runtime_events WHERE thread_id = ? AND type = 'agent.context_compacted' ORDER BY created_at DESC LIMIT 1")
      .all("thread-1") as Array<{ detail: string }>;
    inspection.close();

    expect(events).toEqual([{ type: "agent.context_compacted" }, { type: "agent.context_compacted" }]);
    expect(plan.some((entry) => entry.detail.includes("idx_runtime_events_thread_type_created"))).toBe(true);
    expect(database.getLatestContextCompaction("thread-1")).toEqual(expect.objectContaining({ turnRunId: "turn-2" }));

    database.addRuntimeEvent({
      type: "assistant.draft.updated",
      threadId: "thread-1",
      payload: { content: "not persisted" },
      createdAt: "2026-01-01T00:00:04.000Z"
    });
    expect(database.getLatestContextCompaction("thread-1")).toEqual(expect.objectContaining({ turnRunId: "turn-2" }));
  });

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
