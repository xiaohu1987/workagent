import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const tempDirs: string[] = [];
const databases: DatabaseService[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("thread workspace roots", () => {
  it("round-trips ordered workspace roots while preserving cwd as primary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-workspace-roots-"));
    tempDirs.push(dir);
    const db = new DatabaseService(path.join(dir, "state.sqlite"));
    databases.push(db);
    const primary = path.join(dir, "primary");
    const secondary = path.join(dir, "secondary");
    await fs.mkdir(primary);
    await fs.mkdir(secondary);
    const thread = db.createThread({
      title: "协作",
      mode: "project",
      workspaceKind: "project",
      cwd: primary,
      workspaceRoots: [primary, secondary],
      modelId: "model",
      providerId: "provider"
    });
    expect(db.getThread(thread.id).workspaceRoots).toEqual([primary, secondary]);
    expect(db.getThread(thread.id).cwd).toBe(primary);
    expect(db.setThreadWorkspaceRoots(thread.id, [primary, secondary])).toMatchObject({ workspaceRoots: [primary, secondary] });
    expect(() => db.setThreadWorkspaceRoots(thread.id, [secondary, primary])).toThrow("primary workspace");
  });

  it("backfills the legacy cwd into workspace roots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-workspace-roots-legacy-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "state.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL, workspace_kind TEXT NOT NULL,
        cwd TEXT, project_id TEXT, workspace_id TEXT, model_id TEXT NOT NULL, provider_id TEXT NOT NULL, status TEXT NOT NULL,
        selected_skill_ids_json TEXT NOT NULL, knowledge_base_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO threads VALUES ('legacy', 'Legacy', 'project', 'project', '${dir.replace(/'/g, "''")}', NULL, NULL, 'model', 'provider', 'idle', '[]', '[]', '2026-01-01', '2026-01-01');
    `);
    legacy.close();
    const db = new DatabaseService(dbPath);
    databases.push(db);
    expect(db.getThread("legacy").workspaceRoots).toEqual([dir]);
  });
});
