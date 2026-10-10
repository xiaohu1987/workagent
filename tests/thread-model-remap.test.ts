import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";
import { remapThreadModelSelections } from "../apps/desktop/src/main/thread-model-remap";

const temporaryDirectories: string[] = [];
const databases: DatabaseService[] = [];

async function createDatabase(): Promise<DatabaseService> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-model-remap-test-"));
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

describe("remapThreadModelSelections", () => {
  it("rewrites a stale provider/model pair and keeps the original updatedAt", async () => {
    const database = await createDatabase();
    const thread = database.createThread({
      title: "stale model thread",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "deepseek-old",
      providerId: "provider-12"
    });
    const lastActivity = "2026-09-24T09:41:30.494Z";
    database.updateThread(thread.id, { updatedAt: lastActivity });

    const emitted: string[] = [];
    await remapThreadModelSelections({
      database,
      resolveSelection: () => ({ providerId: "provider-12", modelId: "deepseek-flash" }),
      onThreadUpdated: async (updated) => {
        emitted.push(updated.id);
      }
    });

    const stored = database.getThread(thread.id);
    expect(stored.providerId).toBe("provider-12");
    expect(stored.modelId).toBe("deepseek-flash");
    expect(stored.updatedAt).toBe(lastActivity);
    expect(emitted).toEqual([thread.id]);
  });

  it("skips threads that already match and resolves each stored pair once", async () => {
    const database = await createDatabase();
    const keep = database.createThread({
      title: "already current",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "deepseek-flash",
      providerId: "provider-12"
    });
    const staleA = database.createThread({
      title: "stale A",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "deepseek-old",
      providerId: "provider-12"
    });
    const staleB = database.createThread({
      title: "stale B",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "deepseek-old",
      providerId: "provider-12"
    });

    const resolutions: string[] = [];
    const emitted: string[] = [];
    await remapThreadModelSelections({
      database,
      resolveSelection: (thread) => {
        resolutions.push(`${thread.providerId}::${thread.modelId}`);
        return { providerId: "provider-12", modelId: "deepseek-flash" };
      },
      onThreadUpdated: async (updated) => {
        emitted.push(updated.id);
      }
    });

    expect(database.getThread(keep.id).updatedAt).toBe(keep.updatedAt);
    expect(emitted.sort()).toEqual([staleA.id, staleB.id].sort());
    expect(resolutions.length).toBe(2);
    expect(new Set(resolutions)).toEqual(
      new Set(["provider-12::deepseek-flash", "provider-12::deepseek-old"])
    );
  });
});
