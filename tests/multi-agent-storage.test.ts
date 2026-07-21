import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const databases: DatabaseService[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("multi-agent thread storage", () => {
  it("removes plugin records together with project bindings", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-plugin-removal-test-"));
    directories.push(directory);
    const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(database);
    const thread = database.createThread({
      title: "Project",
      mode: "project",
      workspaceKind: "project",
      cwd: directory,
      modelId: "mock-codexh",
      providerId: "mock"
    });
    const plugin = {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      manifestPath: path.join(directory, "plugin.json"),
      installPath: path.join(directory, "test-plugin"),
      enabled: true,
      source: "local"
    };

    database.upsertPlugin(plugin);
    database.setProjectPluginBinding(thread.projectId!, plugin.id, true);
    database.deletePlugin(plugin.id);

    expect(database.listPlugins()).toEqual([]);
    expect(database.listProjectPluginBindings(thread.projectId!)).toEqual([]);
  });

  it("defaults ordinary chats to no plugins and persists their selected plugins", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-plugin-thread-test-"));
    directories.push(directory);
    const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(database);

    const thread = database.createThread({
      title: "Chat",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock-codexh",
      providerId: "mock"
    });
    expect(thread.selectedPluginIds).toEqual([]);

    database.updateThread(thread.id, { selectedPluginIds: ["superpowers"] });
    expect(database.getThread(thread.id).selectedPluginIds).toEqual(["superpowers"]);

    database.close();
    databases.splice(databases.indexOf(database), 1);
    const persisted = new DatabaseService(path.join(directory, "codexh.sqlite"));
    expect(persisted.getThread(thread.id).selectedPluginIds).toEqual(["superpowers"]);
    persisted.close();
    const legacy = new DatabaseSync(path.join(directory, "codexh.sqlite"));
    legacy.exec("ALTER TABLE threads DROP COLUMN selected_plugin_ids_json");
    legacy.close();
    const reopened = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(reopened);
    expect(reopened.getThread(thread.id).selectedPluginIds).toEqual([]);
  });

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
