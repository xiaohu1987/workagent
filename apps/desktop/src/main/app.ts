import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import type {
  AppConfig,
  ArtifactRecord,
  BrowserTabRecord,
  KnowledgeBaseRecord,
  MessageRecord,
  McpServerConfig,
  PluginRecord,
  ProjectPluginBinding,
  RuntimeEvent,
  RuntimeThreadSnapshot,
  ThreadRecord,
  UserInputPrompt
} from "@shared-types";
import { AgentRuntimeService } from "@agent-runtime";
import { BrowserRuntime } from "@browser-runtime";
import { buildOkfBundle, extractDocument } from "@knowledge-runtime";
import { McpManager } from "@mcp-runtime";
import { hashDirectory, PluginRuntime } from "@plugin-runtime";
import { ProviderFactory } from "@provider-adapters";
import { SkillsManager } from "@skills-runtime";
import { ToolRuntime } from "@tool-runtime";
import {
  DatabaseService,
  defaultConfig,
  ensureHomeLayout,
  loadConfig,
  saveConfig,
  type HomeLayout
} from "./storage";

type ResolverMap<T> = Map<string, (value: T) => void>;

export class DesktopBackend {
  readonly #events = new EventEmitter();
  readonly #approvalResolvers: ResolverMap<boolean> = new Map();
  readonly #promptResolvers: ResolverMap<Record<string, string>> = new Map();
  readonly #sessionApprovalKeys = new Set<string>();
  readonly #skills = new SkillsManager();
  readonly #toolRuntime = new ToolRuntime();
  readonly #providerFactory = new ProviderFactory();
  readonly #browser = new BrowserRuntime();
  readonly #plugins = new PluginRuntime();

  #layout!: HomeLayout;
  #db!: DatabaseService;
  #config!: AppConfig;
  #runtime!: AgentRuntimeService;
  #mcp!: McpManager;

  public async initialize(): Promise<void> {
    this.#layout = await ensureHomeLayout();
    this.#config = await loadConfig(this.#layout.configFile);
    this.#db = new DatabaseService(this.#layout.dbFile);
    this.#mcp = new McpManager();
    await this.syncInstalledPlugins();
    await this.refreshMcpConfiguration();
    await this.refreshSkills();

    this.#runtime = new AgentRuntimeService({
      config: this.#config,
      skills: this.#skills,
      toolRuntime: this.#toolRuntime,
      providerFactory: this.#providerFactory,
      mcp: this.#mcp,
      persistence: {
        getThread: async (threadId) => this.#db.getThread(threadId),
        updateThread: async (threadId, patch) => this.#db.updateThread(threadId, patch),
        listMessages: async (threadId) => this.#db.listMessages(threadId),
        createMessage: async (input) => this.#db.createMessage(input),
        startTurn: async (input) => this.#db.startTurn(input),
        finishTurn: async (turnRunId, patch) => this.#db.finishTurn(turnRunId, patch),
        recordToolCall: async (input) => this.#db.recordToolCall(input),
        finishToolCall: async (id, patch) => this.#db.finishToolCall(id, patch),
        listThreadArtifacts: async (threadId) => this.#db.listArtifacts(threadId),
        addArtifact: async (input) => this.#db.addArtifact(input),
        addRuntimeEvent: async (event) => this.#db.addRuntimeEvent(event)
      },
      buildKnowledgeContext: async (threadId) => this.buildKnowledgeContext(threadId),
      buildWorkflowPackContext: async (threadId) => this.buildWorkflowPackContext(threadId),
      getEnabledPluginIdsForThread: async (threadId) => this.getEnabledPluginIdsForThread(threadId),
      getAccessibleMcpServerIdsForThread: async (threadId) =>
        this.getAccessibleMcpServerIdsForThread(threadId),
      listKnowledgeBases: async (threadId) => this.listVisibleKnowledgeBases(threadId),
      searchKnowledge: async (query, ids) => this.#db.searchKnowledge(query, ids),
      readKnowledgeConcept: async (conceptId) => this.#db.getKnowledgeConcept(conceptId),
      listFiles: async (dir) =>
        (await fs.readdir(dir, { withFileTypes: true })).map((entry) => entry.name),
      readFile: async (filePath) => fs.readFile(filePath, "utf8"),
      writeFile: async (filePath, content) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      },
      requestApproval: async (threadId, turnRunId, input) =>
        this.requestApproval(threadId, turnRunId, input),
      requestUserInput: async (threadId, turnRunId, input) =>
        this.requestUserInput(threadId, turnRunId, input),
      spawnChildAgent: async (parentThreadId, input) => this.spawnChildAgent(parentThreadId, input),
      webSearch: async (query) => this.webSearch(query),
      openPage: async (threadId, url) => this.openPage(threadId, url),
      findInPage: async (url, pattern) => this.findInPage(url, pattern),
      listBrowserTabs: async (threadId) => this.#db.listBrowserTabs(threadId),
      openBrowserTab: async (threadId, url) => this.openBrowserTab(threadId, url),
      navigateBrowserTab: async (threadId, tabId, url) => this.navigateBrowserTab(threadId, tabId, url),
      reloadBrowserTab: async (threadId, tabId) => this.reloadBrowserTab(threadId, tabId),
      goBackBrowserTab: async (threadId, tabId) => this.goBackBrowserTab(threadId, tabId),
      goForwardBrowserTab: async (threadId, tabId) => this.goForwardBrowserTab(threadId, tabId),
      focusBrowserTab: async (threadId, tabId) => this.focusBrowserTab(threadId, tabId),
      readBrowserPageText: async (threadId, tabId) => this.readBrowserPageText(threadId, tabId),
      captureBrowserSnapshot: async (threadId, tabId, turnRunId) =>
        this.captureBrowserSnapshot(threadId, tabId, turnRunId),
      getThreadOutputDir: async (threadId) => this.getThreadOutputDir(threadId),
      listMcpResources: async (server) => this.#mcp.listResources(server),
      listMcpResourceTemplates: async (server) => this.#mcp.listResourceTemplates(server),
      readMcpResource: async (server, uri) => this.#mcp.readResource(server, uri),
      callMcpTool: async (server, tool, argumentsJson) =>
        this.#mcp.callTool(server, tool, argumentsJson),
      emit: async (event) => this.emit(event)
    });
  }

  public onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#events.on("runtime-event", listener);
    return () => this.#events.off("runtime-event", listener);
  }

  public listThreads(): ThreadRecord[] {
    return this.#db.listThreads();
  }

  public createThread(input: {
    title: string;
    mode: ThreadRecord["mode"];
    cwd?: string | null;
    providerId?: string | null;
    modelId?: string | null;
  }): ThreadRecord {
    const selection = resolveThreadModelSelection(this.#config, input.providerId, input.modelId);
    const thread = this.#db.createThread({
      title: input.title,
      mode: input.mode,
      workspaceKind: input.cwd ? "project" : "projectless",
      cwd: input.cwd,
      modelId: selection.modelId,
      providerId: selection.providerId
    });
    void this.refreshSkills(thread.cwd);
    this.#runtime.ensureThread(thread.id);
    return thread;
  }

  public async deleteThread(threadId: string): Promise<void> {
    const thread = this.#db.getThread(threadId);
    if (thread.status === "running" || thread.status === "waiting") {
      throw new Error("任务正在执行，暂时不能删除。");
    }

    await this.removeThreadOutputDir(thread);
    this.#db.deleteThread(threadId);
    this.#browser.clearThread(threadId);
    this.#runtime.forgetThread(threadId);
  }

  public getThreadSnapshot(threadId: string): RuntimeThreadSnapshot {
    const thread = this.#db.getThread(threadId);
    this.#browser.syncPersistedTabs(threadId, this.#db.listBrowserTabs(threadId));
    return {
      thread,
      messages: this.#db.listMessages(threadId),
      approvals: this.#db.listApprovals(threadId),
      prompts: this.#db.listUserPrompts(threadId),
      artifacts: this.#db.listArtifacts(threadId),
      knowledgeBases: this.listVisibleKnowledgeBasesForThread(thread),
      browserTabs: this.#db.listBrowserTabs(threadId),
      projectPlugins: this.listProjectPluginsForThread(thread)
    };
  }

  public sendMessage(threadId: string, content: string): void {
    const thread = this.#db.getThread(threadId);
    if (this.#db.listMessages(threadId).length === 0) {
      const updated = this.#db.updateThread(threadId, {
        title: buildThreadTitleFromFirstMessage(content)
      });
      void this.emit({
        type: "thread.updated",
        threadId,
        payload: { thread: updated },
        createdAt: new Date().toISOString()
      });
    }

    void this.refreshSkills(thread.cwd);
    this.#runtime.submitUserInput(threadId, content);
  }

  public interruptThread(threadId: string): void {
    this.#runtime.interrupt(threadId);
  }

  public listSkills(): ReturnType<SkillsManager["list"]> {
    return this.#skills.list();
  }

  public async reloadSkills(cwd?: string | null): Promise<void> {
    await this.refreshSkills(cwd);
  }

  public getConfig(): AppConfig {
    return this.#config;
  }

  public async saveConfig(nextConfig: AppConfig): Promise<void> {
    const normalized = normalizeAppConfig(nextConfig);

    this.#config.defaultModel = normalized.defaultModel;
    this.#config.defaultProvider = normalized.defaultProvider;
    this.#config.providers = [...normalized.providers];
    this.#config.models = [...normalized.models];
    this.#config.routing = { ...normalized.routing };
    this.#config.desktop = { ...normalized.desktop };
    this.#config.mcpServers = normalized.mcpServers.map((server) => ({
      ...server,
      source: "config",
      pluginId: undefined
    }));

    await saveConfig(this.#layout.configFile, this.#config);
    for (const thread of this.#db.listThreads()) {
      const selection = resolveThreadModelSelection(this.#config, thread.providerId, thread.modelId);
      if (selection.providerId === thread.providerId && selection.modelId === thread.modelId) {
        continue;
      }

      const updated = this.#db.updateThread(thread.id, selection);
      await this.emit({
        type: "thread.updated",
        threadId: thread.id,
        payload: { thread: updated },
        createdAt: new Date().toISOString()
      });
    }
    await this.refreshMcpConfiguration();
  }

  public async updateThreadModelSelection(
    threadId: string,
    providerId: string,
    modelId: string
  ): Promise<ThreadRecord> {
    const selection = resolveThreadModelSelection(this.#config, providerId, modelId);
    const updated = this.#db.updateThread(threadId, selection);
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
    return updated;
  }

  public listPlugins(): PluginRecord[] {
    return this.#db.listPlugins();
  }

  public async installPlugin(source: string): Promise<PluginRecord> {
    const plugin = await this.#plugins.installFromSource(source, this.#layout.pluginsInstalledDir);
    const sourceHash = await hashDirectory(plugin.installPath);
    this.#db.upsertPlugin(plugin, sourceHash);
    await this.refreshMcpConfiguration();
    await this.refreshSkills();
    return plugin;
  }

  public setProjectPluginEnabled(threadId: string, pluginId: string, enabled: boolean): ProjectPluginBinding {
    const thread = this.#db.getThread(threadId);
    if (thread.mode !== "project" || !thread.projectId) {
      throw new Error("Workflow packs can only be enabled for project-mode threads.");
    }
    const binding = this.#db.setProjectPluginBinding(thread.projectId, pluginId, enabled);
    void this.emit({
      type: "thread.updated",
      threadId,
      payload: { projectPluginBinding: binding },
      createdAt: new Date().toISOString()
    });
    return binding;
  }

  public async openBrowserTab(threadId: string, url: string) {
    const opened = await this.#browser.openTab(threadId, url);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "open", tab: opened.tab },
      createdAt: new Date().toISOString()
    });
    return opened;
  }

  public async navigateBrowserTab(threadId: string, tabId: string, url: string) {
    const result = await this.#browser.navigate(threadId, tabId, url);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "navigate", tab: result.tab },
      createdAt: new Date().toISOString()
    });
    return result;
  }

  public async reloadBrowserTab(threadId: string, tabId: string) {
    const result = await this.#browser.reload(threadId, tabId);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "reload", tab: result.tab },
      createdAt: new Date().toISOString()
    });
    return result;
  }

  public async goBackBrowserTab(threadId: string, tabId: string) {
    const result = this.#browser.goBack(threadId, tabId);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "back", tab: result.tab },
      createdAt: new Date().toISOString()
    });
    return result;
  }

  public async goForwardBrowserTab(threadId: string, tabId: string) {
    const result = this.#browser.goForward(threadId, tabId);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "forward", tab: result.tab },
      createdAt: new Date().toISOString()
    });
    return result;
  }

  public async focusBrowserTab(threadId: string, tabId: string) {
    const tab = this.#browser.focusTab(threadId, tabId);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "focus", tab },
      createdAt: new Date().toISOString()
    });
    return tab;
  }

  public readBrowserPageText(threadId: string, tabId: string) {
    return this.#browser.readPageText(threadId, tabId);
  }

  public async captureBrowserSnapshot(threadId: string, tabId: string, turnRunId: string) {
    const outputDir = await this.getThreadOutputDir(threadId);
    const snapshot = await this.#browser.captureSnapshot(threadId, tabId, outputDir);
    const stats = await fs.stat(snapshot.filePath);
    const artifact = this.#db.addArtifact({
      threadId,
      turnRunId,
      messageId: null,
      toolCallId: null,
      artifactKind: "browser-snapshot",
      displayName: `${snapshot.title}.html`,
      absolutePath: snapshot.filePath,
      relativePath: path.relative(outputDir, snapshot.filePath),
      mimeType: "text/html",
      sizeBytes: stats.size,
      sha256: await fileSha256(snapshot.filePath),
      sourceKind: "browser",
      isUserVisible: true,
      status: "ready"
    });
    return { ...snapshot, artifact };
  }

  public async importKnowledge(input: {
    displayName: string;
    scope: "global" | "project" | "imported";
    sourcePaths: string[];
    threadId?: string;
  }): Promise<KnowledgeImportSummary> {
    const thread = input.threadId ? this.#db.getThread(input.threadId) : null;
    const projectId = input.scope === "project" ? thread?.projectId ?? null : null;
    const bundleRoot = input.scope === "project"
      ? resolveProjectKnowledgeBundleRoot(thread, input.displayName)
      : path.join(this.#layout.globalBundlesDir, randomUUID());

    if (input.scope === "project" && (!thread?.cwd || !thread.projectId)) {
      throw new Error("Project-scoped knowledge imports require a project thread.");
    }

    const knowledgeBase = this.#db.createKnowledgeBase({
      scope: input.scope,
      projectId,
      displayName: input.displayName,
      bundleRoot,
      okfVersion: "0.1",
      status: "importing"
    });
    const importRunId = this.#db.createKnowledgeImportRun(knowledgeBase.id, input.sourcePaths);
    const documents = await Promise.all(input.sourcePaths.map((sourcePath) => extractDocument(sourcePath)));
    const built = await buildOkfBundle({
      bundleRoot: knowledgeBase.bundleRoot,
      knowledgeBaseId: knowledgeBase.id,
      importRunId,
      documents
    });

    for (const concept of built.concepts) {
      this.#db.insertKnowledgeConcept(concept);
    }
    this.#db.updateKnowledgeBase(knowledgeBase.id, { status: "ready" });

    if (thread) {
      this.bindKnowledgeBaseToThread(thread.id, knowledgeBase.id);
    }

    const indexStats = await fs.stat(built.indexPath);
    this.#db.addArtifact({
      threadId: input.threadId ?? "knowledge",
      turnRunId: null,
      messageId: null,
      toolCallId: null,
      artifactKind: "knowledge-index",
      displayName: `${input.displayName} index.md`,
      absolutePath: built.indexPath,
      relativePath: "index.md",
      mimeType: "text/markdown",
      sizeBytes: indexStats.size,
      sha256: await fileSha256(built.indexPath),
      sourceKind: "knowledge-import",
      isUserVisible: true,
      status: "ready"
    });

    await this.emit({
      type: "knowledge.imported",
      threadId: input.threadId,
      payload: {
        knowledgeBaseId: knowledgeBase.id,
        conceptCount: built.concepts.length
      },
      createdAt: new Date().toISOString()
    });

    return {
      knowledgeBaseId: knowledgeBase.id,
      conceptCount: built.concepts.length,
      bundleRoot: built.bundleRoot
    };
  }

  public resolveApproval(
    id: string,
    resolution: {
      decision: "approved" | "denied";
      mode?: "once" | "session" | "remember";
    }
  ): void {
    const approval = this.#db.getApproval(id);
    if (!approval) {
      return;
    }

    const approved = resolution.decision === "approved";
    const resolutionMode = approved ? (resolution.mode ?? "once") : null;
    this.#db.resolveApproval(id, { approved, resolutionMode });

    if (approved) {
      const scopeKey = buildApprovalScopeKey(approval.projectId, approval.approvalKey);
      if (resolutionMode === "session") {
        this.#sessionApprovalKeys.add(scopeKey);
      }
      if (resolutionMode === "remember") {
        this.#db.upsertRememberedApproval({
          projectId: approval.projectId,
          approvalKey: approval.approvalKey,
          title: approval.title,
          description: approval.description,
          riskLevel: approval.riskLevel,
          payloadJson: approval.payloadJson
        });
      }
    }

    void this.emit({
      type: "approval.resolved",
      threadId: approval.threadId,
      payload: {
        approvalId: approval.id,
        approved,
        mode: resolutionMode
      },
      createdAt: new Date().toISOString()
    });

    this.#approvalResolvers.get(id)?.(approved);
    this.#approvalResolvers.delete(id);
  }

  public answerUserPrompt(id: string, answers: Record<string, string>): void {
    this.#db.resolveUserPrompt(id);
    this.#promptResolvers.get(id)?.(answers);
    this.#promptResolvers.delete(id);
  }

  private async requestApproval(
    threadId: string,
    turnRunId: string,
    input: {
      title: string;
      description: string;
      riskLevel: "low" | "medium" | "high";
      payload: Record<string, unknown>;
    }
  ): Promise<boolean> {
    const thread = this.#db.getThread(threadId);
    const approvalKey = hashApprovalPayload({
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      payload: input.payload
    });
    const scopeKey = buildApprovalScopeKey(thread.projectId, approvalKey);

    if (this.#config.desktop.approvals === "auto" && input.riskLevel === "low") {
      return true;
    }

    if (this.#sessionApprovalKeys.has(scopeKey)) {
      return true;
    }

    if (this.#db.findRememberedApproval(thread.projectId, approvalKey)) {
      return true;
    }

    const record = this.#db.createApproval({
      threadId,
      turnRunId,
      toolCallId: null,
      projectId: thread.projectId,
      title: input.title,
      description: input.description,
      scope: this.#config.desktop.approvals,
      riskLevel: input.riskLevel,
      approvalKey,
      payloadJson: JSON.stringify(input.payload),
      status: "pending"
    });

    await this.emit({
      type: "approval.requested",
      threadId,
      payload: { approval: record },
      createdAt: new Date().toISOString()
    });

    return new Promise<boolean>((resolve) => {
      this.#approvalResolvers.set(record.id, resolve);
    });
  }

  private async requestUserInput(
    threadId: string,
    turnRunId: string,
    input: {
      title: string;
      questions: Array<{ id: string; label: string; prompt: string; options?: string[] }>;
    }
  ): Promise<Record<string, string>> {
    const prompt = this.#db.createUserPrompt({
      threadId,
      turnRunId,
      title: input.title,
      questions: input.questions,
      status: "pending"
    });

    await this.emit({
      type: "user-input.requested",
      threadId,
      payload: { prompt },
      createdAt: new Date().toISOString()
    });

    return new Promise((resolve) => {
      this.#promptResolvers.set(prompt.id, resolve);
    });
  }

  private async spawnChildAgent(
    parentThreadId: string,
    input: { prompt: string; role: string; modelId?: string }
  ): Promise<string> {
    const parent = this.#db.getThread(parentThreadId);
    await this.refreshSkills(parent.cwd);
    const thread = this.#db.createThread({
      title: `${input.role}: ${input.prompt.slice(0, 40)}`,
      mode: parent.mode,
      workspaceKind: parent.workspaceKind,
      cwd: parent.cwd,
      modelId: input.modelId ?? parent.modelId,
      providerId: parent.providerId
    });
    this.#runtime.submitUserInput(thread.id, input.prompt);
    return thread.id;
  }

  private async buildKnowledgeContext(threadId: string): Promise<string | null> {
    const bundles = this.listVisibleKnowledgeBases(threadId).map(
      (item) => `- ${item.displayName}: ${path.join(item.bundleRoot, "index.md")}`
    );
    if (bundles.length === 0) {
      return null;
    }
    return bundles.length > 0 ? ["Available knowledge bases:", ...bundles].join("\n") : null;
  }

  private async buildWorkflowPackContext(threadId: string): Promise<string | null> {
    const thread = this.#db.getThread(threadId);
    if (thread.mode !== "project" || !thread.projectId) {
      return null;
    }

    const enabledPlugins = this.listProjectPluginsForThread(thread).filter((item) => item.binding?.enabled);
    if (enabledPlugins.length === 0) {
      return null;
    }

    const blocks: string[] = ["Active workflow packs:"];
    for (const item of enabledPlugins) {
      const startup = await this.#plugins.collectStartupContext(item.plugin);
      const sessionStartHooks =
        startup.manifest?.hooks.filter((hook) => hook.eventName.toLowerCase() === "sessionstart") ?? [];
      const hookName = sessionStartHooks.length > 0 ? "SessionStart" : "startup_context";
      const hookMessage = startup.content
        ? `Loaded ${startup.source} startup context.`
        : sessionStartHooks.length > 0
          ? "Plugin declares SessionStart hooks but no native startup context was produced."
          : "Plugin has no startup context.";
      this.#db.recordPluginHookRun(
        thread.projectId,
        item.plugin.id,
        hookName,
        startup.content ? "success" : "skipped",
        hookMessage
      );
      blocks.push(`## ${item.plugin.name}`);
      if (startup.content) {
        blocks.push(startup.content.slice(0, 4_000));
      }
      if (startup.manifest?.mcpServers.length) {
        blocks.push(
          `MCP servers: ${startup.manifest.mcpServers.map((server) => server.name).join(", ")}`
        );
      }
    }
    return blocks.join("\n\n");
  }

  private async webSearch(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": "codexh/0.1.0"
      }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    return $(".result")
      .toArray()
      .slice(0, 8)
      .map((element) => {
        const anchor = $(element).find(".result__a").first();
        const snippet = $(element).find(".result__snippet").text().trim();
        return {
          title: anchor.text().trim(),
          url: anchor.attr("href") ?? "",
          snippet
        };
      })
      .filter((item) => item.title && item.url);
  }

  private async openPage(threadId: string, url: string): Promise<{ title: string; url: string; text: string }> {
    if (threadId) {
      const opened = await this.openBrowserTab(threadId, url);
      return opened.page;
    }

    const response = await fetch(url, {
      headers: {
        "user-agent": "codexh/0.1.0"
      }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    return {
      title: $("title").text().trim() || url,
      url: response.url || url,
      text: $.text().replace(/\s+/g, " ").trim()
    };
  }

  private async findInPage(url: string, pattern: string): Promise<string[]> {
    const page = await this.openPage("", url);
    const lines = page.text.split(/(?<=[.!?。！？])\s+/);
    return lines.filter((line) => line.toLowerCase().includes(pattern.toLowerCase())).slice(0, 20);
  }

  private async emit(event: RuntimeEvent): Promise<void> {
    this.#db.addRuntimeEvent(event);
    this.#events.emit("runtime-event", event);
  }

  private async syncInstalledPlugins(): Promise<void> {
    const plugins = await this.#plugins.discoverInstalledPlugins(this.#layout.pluginsInstalledDir);
    for (const plugin of plugins) {
      this.#db.upsertPlugin(plugin, await hashDirectory(plugin.installPath));
    }
  }

  private async refreshSkills(cwd?: string | null): Promise<void> {
    const pluginRoots = await this.#plugins.collectPluginSkillRoots(this.#db.listPlugins());
    await this.#skills.refresh(this.#layout.root, cwd, pluginRoots);
  }

  private async refreshMcpConfiguration(): Promise<void> {
    const pluginServers = await this.#plugins.collectPluginMcpServers(this.#db.listPlugins());
    const effectiveServers = new Map<string, McpServerConfig>();

    for (const server of this.#config.mcpServers) {
      effectiveServers.set(server.id, {
        ...server,
        source: "config",
        pluginId: undefined
      });
    }

    for (const server of pluginServers) {
      effectiveServers.set(server.id, server);
    }

    this.#mcp.setConfigs([...effectiveServers.values()]);
  }

  private listProjectPluginsForThread(thread: ThreadRecord): Array<{
    plugin: PluginRecord;
    binding: ProjectPluginBinding | null;
  }> {
    const plugins = this.#db.listPlugins();
    const bindings = thread.projectId ? this.#db.listProjectPluginBindings(thread.projectId) : [];
    return plugins.map((plugin) => ({
      plugin,
      binding: bindings.find((binding) => binding.pluginId === plugin.id) ?? null
    }));
  }

  private async getEnabledPluginIdsForThread(threadId: string): Promise<string[]> {
    const thread = this.#db.getThread(threadId);
    if (!thread.projectId) {
      return [];
    }
    return this.#db
      .listProjectPluginBindings(thread.projectId)
      .filter((binding) => binding.enabled)
      .map((binding) => binding.pluginId);
  }

  private async getAccessibleMcpServerIdsForThread(threadId: string): Promise<string[]> {
    const enabledPlugins = new Set(await this.getEnabledPluginIdsForThread(threadId));
    return this.#mcp
      .listConfigs()
      .filter(
        (server) =>
          server.enabled &&
          (server.source !== "plugin" || (!!server.pluginId && enabledPlugins.has(server.pluginId)))
      )
      .map((server) => server.id);
  }

  private listVisibleKnowledgeBases(threadId: string): KnowledgeBaseRecord[] {
    return this.listVisibleKnowledgeBasesForThread(this.#db.getThread(threadId));
  }

  private listVisibleKnowledgeBasesForThread(thread: ThreadRecord): KnowledgeBaseRecord[] {
    const explicit = new Set(thread.knowledgeBaseIds);
    return this.#db
      .listKnowledgeBases()
      .filter(
        (knowledgeBase) =>
          explicit.has(knowledgeBase.id) ||
          (thread.projectId &&
            knowledgeBase.scope === "project" &&
            knowledgeBase.projectId === thread.projectId)
      );
  }

  private bindKnowledgeBaseToThread(threadId: string, knowledgeBaseId: string): void {
    const thread = this.#db.getThread(threadId);
    if (thread.knowledgeBaseIds.includes(knowledgeBaseId)) {
      return;
    }
    this.#db.updateThread(threadId, {
      knowledgeBaseIds: [...thread.knowledgeBaseIds, knowledgeBaseId]
    });
  }

  private persistBrowserTabs(threadId: string): void {
    this.#db.replaceBrowserTabs(threadId, this.#browser.listTabs(threadId));
  }

  private resolveThreadOutputPaths(thread: Pick<ThreadRecord, "id" | "cwd">): {
    baseDir: string;
    outputDir: string;
  } {
    const baseDir = thread.cwd ? path.join(thread.cwd, ".codexh", "outputs") : this.#layout.outputsDir;
    return {
      baseDir,
      outputDir: path.join(baseDir, thread.id)
    };
  }

  private async removeThreadOutputDir(thread: Pick<ThreadRecord, "id" | "cwd">): Promise<void> {
    const { baseDir, outputDir } = this.resolveThreadOutputPaths(thread);
    const resolvedBaseDir = path.resolve(baseDir);
    const resolvedOutputDir = path.resolve(outputDir);
    const relative = path.relative(resolvedBaseDir, resolvedOutputDir);

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("线程输出目录路径异常，已阻止删除。");
    }

    await fs.rm(resolvedOutputDir, { recursive: true, force: true });
  }

  private async getThreadOutputDir(threadId: string): Promise<string> {
    const thread = this.#db.getThread(threadId);
    const { outputDir } = this.resolveThreadOutputPaths(thread);
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
  }
}

function normalizeAppConfig(config: AppConfig): AppConfig {
  const fallback = defaultConfig();
  const providers = config.providers.length ? [...config.providers] : fallback.providers;
  const models = config.models.filter((model) =>
    providers.some((provider) => provider.id === model.providerId)
  );
  const nextModels = models.length ? models : fallback.models;

  const firstModel = nextModels[0];
  if (!firstModel) {
    return fallback;
  }

  const firstProviderWithModel =
    providers.find((provider) => nextModels.some((model) => model.providerId === provider.id)) ??
    providers.find((provider) => provider.id === firstModel.providerId) ??
    fallback.providers[0];
  const defaultProvider = nextModels.some(
    (model) => model.providerId === config.defaultProvider
  )
    ? config.defaultProvider
    : firstProviderWithModel.id;
  const providerModels = nextModels.filter((model) => model.providerId === defaultProvider);
  const defaultModel = providerModels.some((model) => model.id === config.defaultModel)
    ? config.defaultModel
    : providerModels[0]?.id ?? firstModel.id;

  return {
    ...config,
    defaultProvider,
    defaultModel,
    providers,
    models: nextModels
  };
}

function resolveThreadModelSelection(
  config: AppConfig,
  providerId?: string | null,
  modelId?: string | null
): Pick<ThreadRecord, "providerId" | "modelId"> {
  const normalized = normalizeAppConfig(config);
  const providerModels = providerId
    ? normalized.models.filter((model) => model.providerId === providerId)
    : [];

  if (providerId && providerModels.length > 0) {
    const selectedModel = providerModels.find((model) => model.id === modelId) ?? providerModels[0];
    return {
      providerId,
      modelId: selectedModel.id
    };
  }

  return {
    providerId: normalized.defaultProvider,
    modelId: normalized.defaultModel
  };
}

export interface KnowledgeImportSummary {
  knowledgeBaseId: string;
  conceptCount: number;
  bundleRoot: string;
}

async function fileSha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function resolveProjectKnowledgeBundleRoot(
  thread: ThreadRecord | null,
  displayName: string
): string {
  if (!thread?.cwd) {
    throw new Error("Project-scoped knowledge imports require a project cwd.");
  }

  return path.join(
    thread.cwd,
    ".codexh",
    "knowledge",
    "bundles",
    `${slugify(displayName)}-${randomUUID()}`
  );
}

function buildThreadTitleFromFirstMessage(content: string): string {
  const normalized = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "新建任务";
  }

  const sentenceBoundary = normalized.search(/[。！？!?；;]/u);
  const firstSentence =
    sentenceBoundary === -1 ? normalized : normalized.slice(0, sentenceBoundary + 1).trim();
  const codePoints = Array.from(firstSentence);
  if (codePoints.length <= 24) {
    return firstSentence;
  }

  return `${codePoints.slice(0, 24).join("").trimEnd()}...`;
}

function hashApprovalPayload(input: {
  title: string;
  description: string;
  riskLevel: string;
  payload: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(stableStringify(input))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)])
    );
  }
  return value;
}

function buildApprovalScopeKey(projectId: string | null, approvalKey: string): string {
  return `${projectId ?? "__global__"}:${approvalKey}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
