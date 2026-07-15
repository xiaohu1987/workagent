import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const temporaryDirectories: string[] = [];
const databases: DatabaseService[] = [];

async function createDatabase(): Promise<DatabaseService> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-clear-chat-test-"));
  temporaryDirectories.push(directory);
  const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
  databases.push(database);
  return database;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe("DatabaseService.clearThreadConversation", () => {
  it("removes conversation records while preserving the thread", async () => {
    const database = await createDatabase();
    const thread = database.createThread({
      title: "保留的任务",
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
      content: "需要清空的消息",
      metadataJson: null
    });
    database.enqueueQueuedMessage({
      threadId: thread.id,
      content: "queued",
      displayContent: "queued",
      attachments: []
    });
    database.recordToolCall({
      threadId: thread.id,
      turnRunId: "turn-1",
      toolName: "fs.read_file",
      argumentsJson: "{}",
      resultJson: "{}",
      status: "completed",
      riskLevel: "low",
      approvalMode: "auto"
    });
    database.updateThread(thread.id, {
      status: "completed",
      gpaStateJson: JSON.stringify({ stage: "act" })
    });

    const cleared = database.clearThreadConversation(thread.id);

    expect(cleared).toMatchObject({
      id: thread.id,
      title: "保留的任务",
      status: "idle",
      gpaStateJson: null
    });
    expect(database.listMessages(thread.id)).toEqual([]);
    expect(database.listQueuedMessages(thread.id)).toEqual([]);
    expect(database.listToolCalls(thread.id)).toEqual([]);
    expect(database.listThreads().some((item) => item.id === thread.id)).toBe(true);
  });

  it("rejects clearing an active thread", async () => {
    const database = await createDatabase();
    const thread = database.createThread({
      title: "执行中的任务",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock",
      providerId: "mock"
    });
    database.updateThread(thread.id, { status: "running" });

    expect(() => database.clearThreadConversation(thread.id)).toThrow("暂时不能清空");
  });
});
