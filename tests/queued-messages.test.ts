import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const tempDirs: string[] = [];
const databases: DatabaseService[] = [];

async function createDatabase() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-queue-test-"));
  tempDirs.push(dir);
  const db = new DatabaseService(path.join(dir, "codexh.sqlite"));
  databases.push(db);
  return db;
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("queued messages", () => {
  it("keeps queued messages in FIFO order and restores a claimed message after recovery", async () => {
    const db = await createDatabase();
    const first = db.enqueueQueuedMessage({ threadId: "thread-1", content: "first", displayContent: "first", attachments: [] });
    const second = db.enqueueQueuedMessage({ threadId: "thread-1", content: "second", displayContent: "second", attachments: [] });

    expect(db.listQueuedMessages("thread-1").map((item) => item.id)).toEqual([first.id, second.id]);
    expect(db.claimNextQueuedMessage("thread-1")?.id).toBe(first.id);
    expect(db.listQueuedMessages("thread-1")[0]?.status).toBe("dispatching");

    db.recoverInterruptedThreads();
    expect(db.listQueuedMessages("thread-1")[0]?.status).toBe("queued");
    expect(db.deleteQueuedMessage("thread-1", second.id)).toBe(true);
    expect(db.listQueuedMessages("thread-1").map((item) => item.id)).toEqual([first.id]);
  });

  it("reuses the persisted user message when an in-flight queue item is recovered", async () => {
    const db = await createDatabase();
    const thread = db.createThread({
      title: "restart recovery",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock",
      providerId: "mock"
    });
    const queued = db.enqueueQueuedMessage({
      threadId: thread.id,
      content: "same submission",
      displayContent: "same submission",
      attachments: []
    });
    expect(db.claimNextQueuedMessage(thread.id)?.id).toBe(queued.id);

    const first = db.createQueuedUserMessage(queued.id, {
      threadId: thread.id,
      turnRunId: null,
      role: "user",
      content: queued.content,
      metadataJson: null
    });
    expect(first.created).toBe(true);

    db.recoverInterruptedThreads();
    expect(db.claimNextQueuedMessage(thread.id)?.id).toBe(queued.id);
    const recovered = db.createQueuedUserMessage(queued.id, {
      threadId: thread.id,
      turnRunId: null,
      role: "user",
      content: queued.content,
      metadataJson: null
    });

    expect(recovered.created).toBe(false);
    expect(recovered.message.id).toBe(first.message.id);
    expect(db.listMessages(thread.id).filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("backfills legacy in-flight queue items without conflating separate identical submissions", async () => {
    const db = await createDatabase();
    const thread = db.createThread({
      title: "legacy restart recovery",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock",
      providerId: "mock"
    });
    const firstQueue = db.enqueueQueuedMessage({
      threadId: thread.id,
      content: "repeatable text",
      displayContent: "repeatable text",
      attachments: []
    });
    db.claimNextQueuedMessage(thread.id);
    const legacyMessage = db.createMessage({
      threadId: thread.id,
      turnRunId: null,
      role: "user",
      content: firstQueue.content,
      metadataJson: null
    });
    db.createMessage({
      threadId: thread.id,
      turnRunId: null,
      role: "user",
      content: firstQueue.content,
      metadataJson: null
    });

    db.recoverInterruptedThreads();
    expect(db.listQueuedMessages(thread.id)[0]?.userMessageId).toBe(legacyMessage.id);
    expect(db.listMessages(thread.id).filter((message) => message.role === "user")).toEqual([legacyMessage]);
    db.completeQueuedMessage(firstQueue.id);

    const secondQueue = db.enqueueQueuedMessage({
      threadId: thread.id,
      content: "repeatable text",
      displayContent: "repeatable text",
      attachments: []
    });
    db.claimNextQueuedMessage(thread.id);
    const second = db.createQueuedUserMessage(secondQueue.id, {
      threadId: thread.id,
      turnRunId: null,
      role: "user",
      content: secondQueue.content,
      metadataJson: null
    });

    expect(second.created).toBe(true);
    expect(second.message.id).not.toBe(legacyMessage.id);
    expect(db.listMessages(thread.id).filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("keeps a newly enqueued message claimable after an interrupted dispatch", async () => {
    const db = await createDatabase();
    const thread = db.createThread({
      title: "queue interrupt",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock",
      providerId: "mock"
    });
    db.updateThread(thread.id, { status: "running" });
    const interrupted = db.enqueueQueuedMessage({
      threadId: thread.id,
      content: "running turn",
      displayContent: "running turn",
      attachments: []
    });
    expect(db.claimNextQueuedMessage(thread.id)?.id).toBe(interrupted.id);

    db.interruptThreadExecution(thread.id);
    db.completeQueuedMessage(interrupted.id);

    const next = db.enqueueQueuedMessage({
      threadId: thread.id,
      content: "after stop",
      displayContent: "after stop",
      attachments: []
    });
    expect(db.getThread(thread.id).status).toBe("idle");
    expect(db.claimNextQueuedMessage(thread.id)?.id).toBe(next.id);
  });

  it("cancels queued messages without touching a dispatch already in progress", async () => {
    const db = await createDatabase();
    const active = db.enqueueQueuedMessage({ threadId: "thread-1", content: "active", displayContent: "active", attachments: [] });
    const queued = db.enqueueQueuedMessage({ threadId: "thread-1", content: "queued", displayContent: "queued", attachments: [] });

    expect(db.claimNextQueuedMessage("thread-1")?.id).toBe(active.id);
    expect(db.cancelQueuedMessages("thread-1")).toEqual([queued.id]);
    expect(db.listQueuedMessages("thread-1").map((item) => item.id)).toEqual([active.id]);
  });
});
