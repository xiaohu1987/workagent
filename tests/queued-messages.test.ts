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
});
