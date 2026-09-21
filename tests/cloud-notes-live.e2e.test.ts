/**
 * 联调测试：驱动桌面端 CloudNotesService 连接已部署的 CloudNotes 服务。
 * 默认跳过，需显式指定目标地址才会执行：
 *   $env:CLOUDNOTES_E2E_URL="http://127.0.0.1:3003"; node .\node_modules\vitest\vitest.mjs run tests/cloud-notes-live.e2e.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudNotesService } from "../apps/desktop/src/main/cloud-notes-service";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const SERVER_URL = process.env.CLOUDNOTES_E2E_URL ?? "";
const LIVE_ENABLED = SERVER_URL.length > 0;
const PASSWORD = "Str0ngPassw0rd!";
const EMAIL = `codexh-live-${Date.now()}@example.com`;

const databases: DatabaseService[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function makeDevice(deviceId: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-cloud-live-"));
  directories.push(directory);
  const db = new DatabaseService(path.join(directory, "codexh.sqlite"));
  databases.push(db);
  const service = new CloudNotesService(db);
  service.configure({ serverUrl: SERVER_URL, email: EMAIL, displayName: "Live Check", deviceId });
  return { db, service };
}

describe.skipIf(!LIVE_ENABLED)("云笔记真实服务联调（需设置 CLOUDNOTES_E2E_URL）", () => {
  it("注册登录并在两个设备之间完成同步、冲突与删除", async () => {
    const a = await makeDevice("device-a");
    const registered = await a.service.login(PASSWORD, true);
    expect(registered.loggedIn).toBe(true);
    expect(registered.serverUrl).toBe(SERVER_URL);

    const created = a.service.save({ title: "Live check", content: "hello from device a" });
    const firstSync = await a.service.sync();
    expect(firstSync.pushed).toBe(1);
    expect(a.service.getStatus().pendingCount).toBe(0);

    const b = await makeDevice("device-b");
    await b.service.login(PASSWORD, false);
    const pulled = await b.service.sync();
    const onB = b.service.list().find((note) => note.id === created.id);
    expect(onB?.content).toBe("hello from device a");

    b.service.save({ id: created.id, content: "written by device b" });
    await b.service.sync();
    const noteOnB = b.service.list().find((note) => note.id === created.id);
    expect(noteOnB?.version).toBe(2);

    a.service.save({ id: created.id, content: "stale write from device a" });
    const conflicted = await a.service.sync();
    expect(conflicted.conflicts).toBe(1);
    expect(conflicted.conflictDrafts.length).toBe(1);

    const conflictDraft = a.service
      .list()
      .find((note) => note.title.includes("冲突副本"));
    expect(conflictDraft?.content).toBe("stale write from device a");
    const authoritative = a.service.list().find((note) => note.id === created.id);
    expect(authoritative?.content).toBe("written by device b");

    const versionAfterConflict = a.service.getStatus();
    expect(versionAfterConflict.pendingCount).toBe(1);

    b.service.remove(created.id);
    await b.service.sync();
    await a.service.sync();
    expect(a.service.list().some((note) => note.id === created.id)).toBe(false);

    console.log(
      JSON.stringify(
        {
          serverUrl: SERVER_URL,
          registered: registered.email,
          deviceAUserId: registered.userId,
          firstSyncPushed: firstSync.pushed,
          deviceBPulled: pulled.pulled,
          conflictCount: conflicted.conflicts,
          conflictDraftKept: conflictDraft?.title ?? null,
          tombstonePropagated: !a.service.list().some((note) => note.id === created.id),
          finalLocalCount: a.service.list().length
        },
        null,
        2
      )
    );
  }, 60_000);
});
