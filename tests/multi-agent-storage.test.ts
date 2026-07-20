import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const databases: DatabaseService[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("multi-agent thread storage", () => {
  it("persists parent/root/path fields and keeps child threads out of the default list", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-agent-tree-test-"));
    directories.push(directory);
    const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(database);

    const root = database.createThread({
      title: "Root",
      mode: "project",
      workspaceKind: "project",
      cwd: directory,
      modelId: "mock-codexh",
      providerId: "mock"
    });
    const child = database.createThread({
      title: "Research",
      mode: "project",
      workspaceKind: "project",
      cwd: directory,
      modelId: "mock-codexh",
      providerId: "mock",
      parentThreadId: root.id,
      rootThreadId: root.id,
      agentPath: "/root/researcher",
      agentRole: "researcher",
      lastTaskMessage: "Inspect the repository",
      status: "running"
    });

    expect(database.listThreads().map((item) => item.id)).toEqual([root.id]);
    expect(database.listAgentTree(root.id).map((item) => item.agentPath)).toEqual([
      "/root",
      "/root/researcher"
    ]);
    expect(database.getThread(child.id)).toMatchObject({
      parentThreadId: root.id,
      rootThreadId: root.id,
      agentPath: "/root/researcher",
      lastTaskMessage: "Inspect the repository",
      status: "running"
    });
  });
});
