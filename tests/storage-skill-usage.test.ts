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
