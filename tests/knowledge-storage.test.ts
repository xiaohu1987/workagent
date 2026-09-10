import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const temporaryDirectories: string[] = [];
const databases: DatabaseService[] = [];

async function createDatabase(): Promise<DatabaseService> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-knowledge-storage-"));
  temporaryDirectories.push(directory);
  const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
  databases.push(database);
  return database;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("DatabaseService knowledge categories", () => {
  it("stores, updates, and lists knowledge base categories", async () => {
    const database = await createDatabase();
    const created = database.createKnowledgeBase({
      scope: "global",
      projectId: null,
      displayName: "产品手册",
      category: " 产品文档 ",
      bundleRoot: path.join(os.tmpdir(), "kb-product"),
      okfVersion: "0.1",
      status: "ready"
    });

    expect(created.category).toBe("产品文档");
    expect(database.getKnowledgeBase(created.id)?.category).toBe("产品文档");
    expect(database.listKnowledgeBases()[0]?.category).toBe("产品文档");

    database.updateKnowledgeBase(created.id, { category: "技术规范" });
    expect(database.getKnowledgeBase(created.id)).toMatchObject({
      displayName: "产品手册",
      category: "技术规范"
    });
    expect(database.listKnowledgeBaseSummaries()[0]?.category).toBe("技术规范");
  });
});
