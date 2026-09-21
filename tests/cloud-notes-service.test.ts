import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudNotesService } from "../apps/desktop/src/main/cloud-notes-service";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const SERVER_TIME = "2026-01-01T00:00:00.000Z";
const databases: DatabaseService[] = [];
const directories: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<{ db: DatabaseService; service: CloudNotesService }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-cloud-notes-"));
  directories.push(directory);
  const db = new DatabaseService(path.join(directory, "codexh.sqlite"));
  databases.push(db);
  return { db, service: new CloudNotesService(db) };
}

function seedAccount(db: DatabaseService, serverUrl: string): void {
  db.saveCloudNotesAccount({
    serverUrl,
    userId: "user-test",
    email: "codex@example.com",
    displayName: "Codex",
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    cursor: 0,
    lastSyncedAt: null,
    deviceId: "device-test"
  });
}

type SyncRequest = { since: number; deviceId: string; changes: Array<Record<string, unknown>> };

async function startSyncServer(reply: (request: SyncRequest, index: number) => Record<string, unknown>) {
  const received: SyncRequest[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/notes/sync") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as SyncRequest;
        received.push(parsed);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(reply(parsed, received.length - 1)));
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { serverUrl: `http://127.0.0.1:${port}`, received };
}

describe("cloud notes local state machine", () => {
  it("saves a local note and marks it pending", async () => {
    const { service } = await createService();
    const note = service.save({ content: "云笔记第一条内容" });

    expect(note.id).toBeTruthy();
    expect(note.title.length).toBeGreaterThan(0);
    expect(note.dirty).toBe(true);
    expect(service.list()).toHaveLength(1);

    const status = service.getStatus();
    expect(status.localCount).toBe(1);
    expect(status.pendingCount).toBe(1);
    expect(status.loggedIn).toBe(false);
  });

  it("rejects empty content and trims stored text", async () => {
    const { service } = await createService();
    expect(() => service.save({ content: "   " })).toThrow();

    const note = service.save({ content: "  带空格的正文  " });
    expect(note.content).toBe("带空格的正文");
  });

  it("deletes never-synced notes and tombstones synced ones", async () => {
    const { db, service } = await createService();
    const fresh = service.save({ content: "本地未同步" });
    service.remove(fresh.id);
    expect(db.getCloudNote(fresh.id)).toBeNull();

    db.upsertCloudNote({
      id: "synced-note",
      title: "已同步",
      content: "来自服务端",
      version: 3,
      seq: 5,
      dirty: false,
      serverUpdatedAt: SERVER_TIME
    });
    service.remove("synced-note");

    const tombstone = db.getCloudNote("synced-note");
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.dirty).toBe(true);
    expect(service.list().map((note) => note.id)).not.toContain("synced-note");
  });
});

describe("cloud notes sync", () => {
  it("pushes local changes and records the server cursor", async () => {
    const { serverUrl, received } = await startSyncServer(() => ({
      applied: [{ id: "placeholder", status: "updated", version: 1 }],
      conflicts: [],
      notes: [],
      cursor: 42,
      serverTime: SERVER_TIME
    }));
    const { db, service } = await createService();
    seedAccount(db, serverUrl);
    const note = service.save({ content: "待推送的笔记" });

    const outcome = await service.sync();
    const applied = received[0]?.changes?.[0] as Record<string, unknown> | undefined;
    expect(applied?.id).toBe(note.id);
    expect(applied?.deviceId).toBe("device-test");

    expect(outcome.pushed).toBe(0);
    expect(outcome.cursor).toBe(42);
    expect(outcome.pendingCount).toBe(1);

    const recorded = db.getCloudNotesAccount();
    expect(recorded?.cursor).toBe(42);
    expect(recorded?.lastSyncedAt).toBe(SERVER_TIME);
  });

  it("clears the dirty flag when the server accepts local changes", async () => {
    const { db, service } = await createService();
    const note = service.save({ content: "本地新建" });
    const { serverUrl } = await startSyncServer(() => ({
      applied: [{ id: note.id, status: "created", version: 1 }],
      conflicts: [],
      notes: [],
      cursor: 7,
      serverTime: SERVER_TIME
    }));
    seedAccount(db, serverUrl);

    const outcome = await service.sync();
    expect(outcome.pushed).toBe(1);
    expect(outcome.pendingCount).toBe(0);

    const stored = db.getCloudNote(note.id);
    expect(stored?.version).toBe(1);
    expect(stored?.dirty).toBe(false);
    expect(stored?.seq).toBe(7);
  });

  it("keeps a local draft and accepts the server copy on conflict", async () => {
    const { db, service } = await createService();
    const note = service.save({ content: "本地修改过的正文", title: "本地标题" });
    const { serverUrl } = await startSyncServer(() => ({
      applied: [{ id: note.id, status: "conflict", version: 4 }],
      conflicts: [
        {
          id: note.id,
          title: "服务端标题",
          content: "服务端正文",
          version: 4,
          seq: 11,
          deleted: false,
          serverUpdatedAt: SERVER_TIME
        }
      ],
      notes: [],
      cursor: 11,
      serverTime: SERVER_TIME
    }));
    seedAccount(db, serverUrl);

    const outcome = await service.sync();
    expect(outcome.conflicts).toBe(1);
    expect(outcome.conflictDrafts).toHaveLength(1);
    expect(outcome.pendingCount).toBe(1);

    const authoritative = db.getCloudNote(note.id);
    expect(authoritative?.content).toBe("服务端正文");
    expect(authoritative?.version).toBe(4);
    expect(authoritative?.dirty).toBe(false);

    const draftId = outcome.conflictDrafts[0]!.draftId;
    const draft = db.getCloudNote(draftId);
    expect(draft?.content).toBe("本地修改过的正文");
    expect(draft?.dirty).toBe(true);
    expect(draft?.title).toContain("冲突副本");
  });

  it("pulls new server notes and removes deleted ones", async () => {
    const { db, service } = await createService();
    db.upsertCloudNote({
      id: "note-to-delete",
      title: "远端已删除",
      content: "old",
      version: 2,
      seq: 4,
      dirty: false,
      serverUpdatedAt: SERVER_TIME
    });
    const { serverUrl } = await startSyncServer(() => ({
      applied: [],
      conflicts: [],
      notes: [
        {
          id: "server-note",
          title: "服务端新建",
          content: "服务端正文",
          version: 1,
          seq: 12,
          deleted: false,
          serverUpdatedAt: SERVER_TIME
        },
        {
          id: "note-to-delete",
          title: "远端已删除",
          content: "",
          version: 3,
          seq: 13,
          deleted: true,
          serverUpdatedAt: SERVER_TIME
        }
      ],
      cursor: 13,
      serverTime: SERVER_TIME
    }));
    seedAccount(db, serverUrl);

    const outcome = await service.sync();
    expect(outcome.pulled).toBe(2);
    expect(db.getCloudNote("server-note")?.content).toBe("服务端正文");
    expect(db.getCloudNote("note-to-delete")).toBeNull();
    expect(outcome.localCount).toBe(1);
  });

  it("refuses to sync without an account", async () => {
    const { service } = await createService();
    await expect(service.sync()).rejects.toThrow();
  });
});
