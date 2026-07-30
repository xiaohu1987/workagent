import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService, defaultConfig, loadConfig, saveConfig } from "../apps/desktop/src/main/storage";

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

  it("aggregates usage by provider-scoped model and time bucket", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-usage-analytics-test-"));
    directories.push(directory);
    const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(database);
    const thread = database.createThread({
      title: "Usage source",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "grok-4.5",
      providerId: "provider-5"
    });

    for (const [providerId, inputTokens, outputTokens] of [["provider-5", 100, 25], ["provider-3", 40, 10]] as const) {
      database.startTurn({
        threadId: thread.id,
        kind: "chat",
        status: "completed",
        providerId,
        modelId: "grok-4.5",
        resolvedModelSnapshotJson: "{}",
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        usageJson: JSON.stringify({ inputTokens, outputTokens }),
        errorMessage: null
      });
    }

    const summary = database.getUsageAnalytics({ rangeDays: 7, granularity: "day" });

    expect(summary.totalRequests).toBe(2);
    expect(summary.totalUsage.totalTokens).toBe(175);
    expect(summary.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: "provider-5", modelId: "grok-4.5", requestCount: 1 }),
      expect.objectContaining({ providerId: "provider-3", modelId: "grok-4.5", requestCount: 1 })
    ]));
    expect(summary.trend).toHaveLength(1);
  });

  it("includes all descendant agent usage in the root task token total", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-agent-usage-test-"));
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
      title: "Researcher",
      mode: "project",
      workspaceKind: "project",
      cwd: directory,
      modelId: "mock-codexh",
      providerId: "mock",
      parentThreadId: root.id,
      rootThreadId: root.id,
      agentPath: "/root/researcher"
    });
    const grandchild = database.createThread({
      title: "Reviewer",
      mode: "project",
      workspaceKind: "project",
      cwd: directory,
      modelId: "mock-codexh",
      providerId: "mock",
      parentThreadId: child.id,
      rootThreadId: root.id,
      agentPath: "/root/researcher/reviewer"
    });
    const unrelated = database.createThread({
      title: "Unrelated",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock-codexh",
      providerId: "mock"
    });

    for (const [threadId, inputTokens, outputTokens] of [
      [root.id, 100, 20],
      [child.id, 50, 10],
      [grandchild.id, 25, 5],
      [unrelated.id, 1_000, 500]
    ] as const) {
      database.startTurn({
        threadId,
        kind: "regular",
        status: "completed",
        providerId: "mock",
        modelId: "mock-codexh",
        resolvedModelSnapshotJson: "{}",
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        usageJson: JSON.stringify({ inputTokens, outputTokens }),
        errorMessage: null
      });
    }

    expect(database.getThreadTokenUsage(root.id).thread).toMatchObject({
      inputTokens: 175,
      outputTokens: 35,
      totalTokens: 210
    });
    expect(database.getThreadTokenUsage(child.id).thread.totalTokens).toBe(210);
  });

  it("persists queued child-agent dispatches independently from normal message queues", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-agent-dispatch-test-"));
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
      title: "Queued reviewer",
      mode: "project",
      workspaceKind: "project",
      cwd: directory,
      modelId: "mock-codexh",
      providerId: "mock",
      parentThreadId: root.id,
      rootThreadId: root.id,
      agentPath: "/root/reviewer"
    });

    database.enqueueQueuedMessage({ threadId: child.id, content: "Review the patch", displayContent: "Review the patch", attachments: [] });
    database.markSubagentPendingDispatch(child.id, root.id);

    expect(database.isSubagentPendingDispatch(child.id)).toBe(true);
    expect(database.listQueuedSubagentMessageThreadIds()).toEqual([
      { threadId: child.id, rootThreadId: root.id }
    ]);
    expect(database.listSubagentPendingDispatchRoots()).toEqual([root.id]);
    expect(database.listSubagentPendingDispatches(root.id)).toEqual([
      expect.objectContaining({ threadId: child.id, rootThreadId: root.id })
    ]);

    database.clearSubagentPendingDispatch(child.id);
    expect(database.isSubagentPendingDispatch(child.id)).toBe(false);
    expect(database.listQueuedMessages(child.id)).toHaveLength(1);
  });

  it("persists an explicit full-access default for a newly created task", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-default-access-test-"));
    directories.push(directory);
    const database = new DatabaseService(path.join(directory, "codexh.sqlite"));
    databases.push(database);

    const thread = database.createThread({
      title: "Default access",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      modelId: "mock-codexh",
      providerId: "mock",
      gpaStateJson: JSON.stringify({ fullAccess: true }),
      multiAgentMode: "proactive"
    });

    expect(database.getThread(thread.id)).toMatchObject({
      gpaStateJson: JSON.stringify({ fullAccess: true }),
      multiAgentMode: "proactive"
    });
  });

  it("keeps saved multi-agent settings instead of reverting to defaults", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-multi-agent-config-test-"));
    directories.push(directory);
    const configFile = path.join(directory, "config.toml");
    const config = defaultConfig();
    config.multiAgent = {
      defaultMode: "disabled",
      maxConcurrentSubagents: 6,
      maxSubagentsPerRoot: 3,
      maxDepth: 2,
      childWritePolicy: "read-only",
      defaultContextFork: "recent",
      defaultModelId: "mock-codexh",
      defaultProviderId: "mock",
      defaultReasoningEffort: "high"
    };

    await saveConfig(configFile, config);
    const loaded = await loadConfig(configFile);

    expect(loaded.multiAgent).toEqual(config.multiAgent);
  });
});
