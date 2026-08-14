import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const temporaryDirectories: string[] = [];
const databases: DatabaseService[] = [];

async function createDatabase(): Promise<DatabaseService> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-storage-test-"));
  temporaryDirectories.push(directory);
  const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
  databases.push(database);
  return database;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("DatabaseService.aggregateSkillUsageStats", () => {
  it("keeps usage cumulative when a skill's content hash changes", async () => {
    const database = await createDatabase();
    const result = JSON.stringify({ ok: true, json: { skill: "plugin:release-notes" } });

    database.recordToolCall({
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "skills.load",
      argumentsJson: JSON.stringify({ skill_id: "old-content-hash" }),
      resultJson: result,
      status: "completed",
      riskLevel: "low",
      approvalMode: "auto"
    });
    database.recordToolCall({
      threadId: "thread-2",
      turnRunId: "turn-2",
      toolName: "skills.load",
      argumentsJson: JSON.stringify({ skill_id: "new-content-hash" }),
      resultJson: result,
      status: "completed",
      riskLevel: "low",
      approvalMode: "auto"
    });

    expect(database.aggregateSkillUsageStats()).toEqual([
      expect.objectContaining({ skillId: "plugin:release-notes", callCount: 2, successCount: 2, successRate: 1 })
    ]);
  });
});

describe("DatabaseService.recordToolCall", () => {
  it("preserves a runtime-assigned id for message-to-tool correlation", async () => {
    const database = await createDatabase();
    const record = database.recordToolCall({
      id: "runtime-tool-id",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "fs.read_file",
      argumentsJson: JSON.stringify({ path: "src/App.tsx" }),
      resultJson: null,
      status: "running",
      riskLevel: "low",
      approvalMode: "auto"
    });

    expect(record.id).toBe("runtime-tool-id");
    expect(database.listToolCalls("thread-1")[0]?.id).toBe("runtime-tool-id");
  });

  it("keeps large results out of history summaries and loads them on demand", async () => {
    const database = await createDatabase();
    const largeResult = JSON.stringify({ ok: true, content: "x".repeat(8_000) });
    const record = database.recordToolCall({
      id: "large-tool-result",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "shell.exec",
      argumentsJson: JSON.stringify({ command: "build" }),
      resultJson: largeResult,
      status: "completed",
      riskLevel: "low",
      approvalMode: "auto"
    });

    expect(database.listToolCallSummaries("thread-1")).toEqual([
      expect.objectContaining({
        id: record.id,
        resultJson: null,
        resultSize: Buffer.byteLength(largeResult, "utf8"),
        hasFullResult: false
      })
    ]);
    expect(database.getToolCallDetails("thread-1", [record.id])).toEqual([{
      toolCallId: record.id,
      resultJson: largeResult,
      resultSize: Buffer.byteLength(largeResult, "utf8"),
      available: true
    }]);
    expect(database.getToolCallDetails("another-thread", [record.id])[0]).toEqual(
      expect.objectContaining({ toolCallId: record.id, resultJson: null, available: false })
    );
  });

  it("reuses small complete results without a detail request", async () => {
    const database = await createDatabase();
    const smallResult = JSON.stringify({ ok: true, content: "done" });
    database.recordToolCall({
      id: "small-tool-result",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "shell.exec",
      argumentsJson: JSON.stringify({ command: "test" }),
      resultJson: smallResult,
      status: "completed",
      riskLevel: "low",
      approvalMode: "auto"
    });

    expect(database.listToolCallSummaries("thread-1")[0]).toEqual(
      expect.objectContaining({ resultJson: smallResult, hasFullResult: true })
    );
  });
});
