import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService, deriveMemoryFingerprint } from "../apps/desktop/src/main/storage";

const temporaryDirectories: string[] = [];
const databases: DatabaseService[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function createDatabaseDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return path.join(directory, "codexh.sqlite");
}

/**
 * The self-improvement tables exactly as shipped before scoped memories landed:
 * no `fingerprint`, no `source`, no job `content_hash`.
 */
const LEGACY_MEMORY_SCHEMA = `
  CREATE TABLE self_improvement_memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    project_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_thread_id TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE self_improvement_memory_fts USING fts5 (memory_id UNINDEXED, title, content);
  CREATE TABLE self_improvement_jobs (
    thread_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until TEXT,
    last_error TEXT,
    processed_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

describe("self-improvement memory schema migration", () => {
  it("boots an existing install whose memory table predates fingerprint", async () => {
    const databasePath = await createDatabaseDirectory("codexh-memory-schema-");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(LEGACY_MEMORY_SCHEMA);
    legacy.exec(`
      INSERT INTO self_improvement_memories
        (id, scope, project_id, kind, title, content, source_thread_id, usage_count, last_used_at, created_at, updated_at)
      VALUES
        ('m1', 'project', 'project-a', 'experience', '构建命令', '使用 pnpm build。', 'thread-1', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('m2', 'project', 'project-a', 'experience', '构建命令', '重复的同一事实。', 'thread-2', 0, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('m3', 'project', 'project-b', 'experience', '构建命令', '另一个项目。', 'thread-3', 0, NULL, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
        ('m4', 'global', 'project-a', 'preference', '沟通偏好', '先给结论。', 'thread-4', 0, NULL, '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
      INSERT INTO self_improvement_jobs (thread_id, status, attempts, lease_until, last_error, processed_at, updated_at)
        VALUES ('thread-1', 'completed', 1, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const database = new DatabaseService(databasePath);
    databases.push(database);

    const stored = database.listSelfImprovementMemories({ all: true });
    expect(stored.map((memory) => memory.id).sort()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(stored.every((memory) => memory.source === "distilled")).toBe(true);

    const byId = new Map(stored.map((memory) => [memory.id, memory]));
    // Legacy `global` rows that wrongly carried a project id are normalised.
    expect(byId.get("m4")).toMatchObject({ scope: "global", projectId: null });

    // The surviving representative of each identity is discoverable again…
    expect(byId.get("m1")?.fingerprint).toBe(
      deriveMemoryFingerprint({ scope: "project", projectId: "project-a", title: "构建命令" })
    );
    expect(database.findSelfImprovementMemoryByFingerprint({
      scope: "project",
      projectId: "project-a",
      fingerprint: byId.get("m1")!.fingerprint
    })?.id).toBe("m1");
    // …while the colliding duplicate keeps an empty fingerprint, so the partial
    // unique index still builds instead of aborting startup.
    expect(byId.get("m2")?.fingerprint).toBe("");
    expect(byId.get("m3")?.fingerprint).not.toBe(byId.get("m1")?.fingerprint);
    expect(byId.get("m4")?.fingerprint).toBe(
      deriveMemoryFingerprint({ scope: "global", projectId: null, title: "沟通偏好" })
    );
  });

  it("reopens a migrated database without re-running the backfill", async () => {
    const databasePath = await createDatabaseDirectory("codexh-memory-schema-reopen-");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(LEGACY_MEMORY_SCHEMA);
    legacy.exec(`
      INSERT INTO self_improvement_memories
        (id, scope, project_id, kind, title, content, source_thread_id, usage_count, last_used_at, created_at, updated_at)
      VALUES ('legacy', 'global', NULL, 'note', '部署路径', '/srv/app。', NULL, 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const first = new DatabaseService(databasePath);
    const assigned = first.listSelfImprovementMemories({ all: true })[0]!.fingerprint;
    first.close();

    const reopened = new DatabaseService(databasePath);
    databases.push(reopened);
    const second = reopened.listSelfImprovementMemories({ all: true });
    expect(assigned).not.toBe("");
    expect(second).toHaveLength(1);
    expect(second[0]!.fingerprint).toBe(assigned);
    expect(second[0]!.content).toBe("/srv/app。");
  });

  it("reopens a database whose duplicate legacy rows were left unbackfilled", async () => {
    const databasePath = await createDatabaseDirectory("codexh-memory-schema-collision-");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(LEGACY_MEMORY_SCHEMA);
    // Three rows sharing one identity: the first boot gives one of them the
    // fingerprint and leaves the other two blank. A second boot then sees only
    // the blank rows, so deduping against the batch alone would rewrite a
    // fingerprint that is already taken and abort startup.
    legacy.exec(`
      INSERT INTO self_improvement_memories
        (id, scope, project_id, kind, title, content, source_thread_id, usage_count, last_used_at, created_at, updated_at)
      VALUES
        ('dup-1', 'global', NULL, 'experience', '任务经验：你好', '第一次。', NULL, 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('dup-2', 'global', NULL, 'experience', '任务经验：你好', '第二次。', NULL, 0, NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
        ('dup-3', 'global', NULL, 'experience', '任务经验：你好', '第三次。', NULL, 0, NULL, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    `);
    legacy.close();

    const first = new DatabaseService(databasePath);
    const afterFirst = first.listSelfImprovementMemories({ all: true });
    first.close();
    expect(afterFirst).toHaveLength(3);
    expect(afterFirst.filter((memory) => memory.fingerprint !== "")).toHaveLength(1);

    const reopened = new DatabaseService(databasePath);
    databases.push(reopened);
    const afterSecond = reopened.listSelfImprovementMemories({ all: true });
    expect(afterSecond).toHaveLength(3);
    expect(afterSecond.filter((memory) => memory.fingerprint !== "")).toHaveLength(1);
    expect(new Set(afterSecond.map((memory) => memory.fingerprint)).size).toBeLessThanOrEqual(2);
    expect(reopened.findSelfImprovementMemoryByFingerprint({
      scope: "global",
      projectId: null,
      fingerprint: afterSecond.find((memory) => memory.fingerprint !== "")!.fingerprint
    })?.id).toBe("dup-1");
    expect(afterSecond.every((memory) => memory.content.length > 0)).toBe(true);
  });

  it("keeps a fresh install on the current schema and enforces fingerprint uniqueness", async () => {
    const databasePath = await createDatabaseDirectory("codexh-memory-schema-fresh-");
    const database = new DatabaseService(databasePath);
    databases.push(database);

    const first = database.mergeSelfImprovementMemory({
      scope: "project",
      projectId: "project-a",
      kind: "experience",
      title: "测试命令",
      content: "使用 pnpm test。",
      sourceThreadId: "thread-1"
    });
    const second = database.mergeSelfImprovementMemory({
      scope: "project",
      projectId: "project-a",
      kind: "experience",
      title: "测试命令",
      content: "使用 pnpm test --run。",
      sourceThreadId: "thread-2"
    });

    expect(first.action).toBe("created");
    expect(second.action).toBe("updated");
    expect(second.record.id).toBe(first.record.id);
    expect(database.listSelfImprovementMemories({ all: true })).toHaveLength(1);
    expect(database.listSelfImprovementMemories({ all: true })[0]!.content).toBe("使用 pnpm test --run。");
  });
});
