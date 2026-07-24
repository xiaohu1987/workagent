import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { app, BrowserWindow, net, shell, webContents } from "electron";
import type { WebContents } from "electron";
import type {
  AttachmentImportInput,
  AppConfig,
  ArtifactRecord,
  BrowserAssertionCheck,
  BrowserAssertionResult,
  BrowserTabRecord,
  BrowserViewport,
  DatabaseConnectionConfig,
  GitActionResult,
  GitSnapshot,
  GpaStage,
  GpaState,
  KnowledgeBaseRecord,
  KnowledgeChunkRecord,
  KnowledgeBaseSummary,
  KnowledgeDocumentRecord,
  KnowledgeImportSource,
  MessageRecord,
  MessageAttachment,
  McpServerConfig,
  ModelProfile,
  PluginRecord,
  ProviderDefinition,
  ProjectPluginBinding,
  QuickNoteRecord,
  ErrorSolutionRecord,
  RuntimeEvent,
  RuntimeThreadSnapshot,
  SkillLabEvent,
  SkillMetadata,
  SubagentResultEnvelope,
  SubagentWaitResult,
  ThreadRecord,
  ToolCallRecord,
  ToolSpecDefinition,
  UserInputQuestion,
  UserInputPrompt
} from "@shared-types";
import { normalizeRuntimeTimeouts } from "@shared-types";
import { AgentRuntimeService, parseGpaState, toGpaPlanResumePreview } from "@agent-runtime";
import { BrowserRuntime, isBrowserErrorPageUrl, loadPage, type PageSnapshot } from "@browser-runtime";
import { buildOkfBundle, extractDocument, extractDocumentBuffer, extractHtmlReadableText, type ExtractedDocument } from "@knowledge-runtime";
import { McpManager } from "@mcp-runtime";
import { hashDirectory, PluginRuntime, type PluginInstallProgress } from "@plugin-runtime";
import { ProviderFactory } from "@provider-adapters";
import {
  SkillsManager,
  buildUserWorkflowPrompt,
  normalizeUserSkillName,
  parseUserWorkflowDraft,
  renderUserWorkflowSkill
} from "@skills-runtime";
import { ToolRuntime } from "@tool-runtime";
import { DatabaseRuntime } from "@database-runtime";
import { RuntimeLogWriter } from "./runtime-log";
import { McpCredentialStore, McpOAuthService } from "./mcp-oauth";
import { TerminalRuntime } from "./terminal-runtime";
import { GitService } from "./git-service";
import { SkillLabService } from "./skill-lab";
import {
  DatabaseService,
  defaultConfig,
  ensureHomeLayout,
  loadConfig,
  saveConfig,
  type HomeLayout
} from "./storage";

type ResolverMap<T> = Map<string, (value: T) => void>;
const INTERACTION_TIMEOUT_MS = 30_000;
const MAX_APPLICATION_BACKGROUND_BYTES = 40 * 1024 * 1024;
const APPLICATION_BACKGROUND_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

type ApplicationBackgroundPayload = {
  bytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
  settings: unknown;
};

type ApplicationBackgroundMetadata = Omit<ApplicationBackgroundPayload, "bytes"> & {
  version: 1;
};

function redactDatabaseErrorMessage(message: string, password?: string): string {
  let redacted = message;
  if (password) redacted = redacted.split(password).join("[redacted]");
  return redacted
    .replace(/\b(password|passwd|pwd)\s*([=:])\s*[^\s,;]+/gi, "$1$2[redacted]")
    .slice(0, 1_000);
}

async function seedBundledSkills(layout: Pick<HomeLayout, "skillsSystemDir" | "skillsImportedDir" | "skillsInstalledDir">): Promise<number> {
  if (!app.isPackaged) {
    return 0;
  }

  const bundledRoot = path.join(process.resourcesPath, "seed-skills");
  const destinations = {
    system: layout.skillsSystemDir,
    imported: layout.skillsImportedDir,
    installed: layout.skillsInstalledDir
  };
  let copied = 0;
  for (const [scope, destination] of Object.entries(destinations)) {
    const source = path.join(bundledRoot, scope);
    try {
      const entries = await fs.readdir(source, { recursive: true, withFileTypes: true });
      copied += entries.filter((entry) => entry.isFile()).length;
      await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
    } catch {
      // A release without bundled skills remains usable and keeps its local skills unchanged.
    }
  }
  return copied;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPathWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function userWorkflowToolCall(call: ToolCallRecord) {
  return {
    name: call.toolName,
    argumentsJson: call.argumentsJson,
    resultJson: call.resultJson,
    status: call.status
  };
}

async function reserveUserSkillDirectory(root: string, baseName: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const directory = path.join(root, suffix === 1 ? baseName : `${baseName}-${suffix}`);
    try {
      await fs.mkdir(directory);
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法为用户技能分配唯一目录。");
}

async function seedBundledPlugins(layout: Pick<HomeLayout, "pluginsInstalledDir" | "pluginsDisabledDir">): Promise<string[]> {
  if (!app.isPackaged) {
    return [];
  }

  const bundledRoot = path.join(process.resourcesPath, "seed-plugins");
  try {
    const entries = await fs.readdir(bundledRoot, { withFileTypes: true });
    const seeded: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const source = path.join(bundledRoot, entry.name);
      const destination = path.join(layout.pluginsInstalledDir, entry.name);
      const removalMarker = path.join(layout.pluginsDisabledDir, `${entry.name}.removed`);
      if (await pathExists(destination) || await pathExists(removalMarker)) continue;
      await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
      seeded.push(entry.name);
    }
    return seeded;
  } catch {
    // A release without bundled plugins remains usable and never overwrites local plugins.
    return [];
  }
}

export class DesktopBackend {
  readonly #events = new EventEmitter();
  readonly #approvalResolvers: ResolverMap<boolean> = new Map();
  readonly #promptResolvers: ResolverMap<Record<string, string>> = new Map();
  readonly #approvalTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #promptTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #sessionApprovedThreadIds = new Set<string>();
  readonly #skills = new SkillsManager();
  readonly #toolRuntime = new ToolRuntime();
  readonly #providerFactory = new ProviderFactory({
    // Use Chromium networking so media CDN downloads follow the same system proxy as the browser.
    fetch: (input, init) => net.fetch(input as string | GlobalRequest, init)
  });
  // The right-side browser is rendered by Chromium. Use the same engine for tool
  // extraction so sites that block raw HTTP clients do not return a challenge page.
  readonly #browser = new BrowserRuntime((target) => this.loadBrowserPage(target));
  readonly #plugins = new PluginRuntime();
  readonly #terminal = new TerminalRuntime();
  readonly #git = new GitService();
  readonly #openedLocalUrls = new Set<string>();
  readonly #browserContents = new Map<string, WebContents>();
  readonly #browserViewports = new Map<string, BrowserViewport>();
  readonly #browserConsoleErrors = new Map<string, Array<{ message: string; sourceId?: string; line?: number }>>();
  readonly #browserDebuggerOwned = new Set<string>();
  readonly #skillLabEvents = new EventEmitter();

  #layout!: HomeLayout;
  #db!: DatabaseService;
  #config!: AppConfig;
  #runtime!: AgentRuntimeService;
  #skillLab!: SkillLabService;
  readonly #gpaStateCache = new Map<string, GpaState>();
  #mcp!: McpManager;
  #mcpOAuth!: McpOAuthService;
  #databaseCredentials!: McpCredentialStore;
  #databases!: DatabaseRuntime;
  #logs!: RuntimeLogWriter;
  #deferredServices: Promise<void> | null = null;
  #backgroundSkillRefresh: Promise<void> | null = null;

  public async initialize(): Promise<void> {
    this.#layout = await ensureHomeLayout();
    this.#logs = new RuntimeLogWriter(this.#layout.logsDir);
    this.#mcpOAuth = new McpOAuthService(
      new McpCredentialStore(path.join(path.dirname(this.#layout.configFile), "mcp-credentials.json"))
    );
    this.#databaseCredentials = new McpCredentialStore(this.#layout.credentialsFile);
    const bundledSkillFileCount = await seedBundledSkills(this.#layout);
    const bundledPluginIds = await seedBundledPlugins(this.#layout);
    this.#config = await loadConfig(this.#layout.configFile);
    this.#databases = new DatabaseRuntime((connection) => this.#databaseCredentials.read<string>(connection.credentialRef));
    this.#db = new DatabaseService(this.#layout.dbFile);
    this.#db.recoverInterruptedThreads();
    this.removePersistedBrowserErrorTabs();
    this.#mcp = new McpManager([], undefined, {
      resolveBearerToken: (config) => {
        const name = config.auth?.bearerTokenEnvVar?.trim();
        return name ? process.env[name] : undefined;
      },
      createOAuthProvider: (config) => this.#mcpOAuth.createProvider(config)
    });
    this.#mcp.setConfigs(this.#config.mcpServers.map((server) => ({
      ...server,
      source: "config",
      pluginId: undefined
    })));
    this.#skillLab = new SkillLabService({
      config: this.#config,
      providerFactory: this.#providerFactory,
      skills: this.#skills,
      mcp: this.#mcp,
      skillsDraftsDir: this.#layout.skillsDraftsDir,
      refreshSkills: () => this.refreshSkills(),
      listSkills: () => this.#skills.list(),
      emit: (event) => this.#skillLabEvents.emit("skill-lab-event", event)
    });

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
        listQueuedMessages: async (threadId) => this.#db.listQueuedMessages(threadId),
        claimNextQueuedMessage: async (threadId) => this.#db.claimNextQueuedMessage(threadId),
        completeQueuedMessage: async (id) => this.#db.completeQueuedMessage(id),
        createMessage: async (input) => this.#db.createMessage(input),
        startTurn: async (input) => this.#db.startTurn(input),
        finishTurn: async (turnRunId, patch) => this.#db.finishTurn(turnRunId, patch),
        recordToolCall: async (input) => this.#db.recordToolCall(input),
        finishToolCall: async (id, patch) => this.#db.finishToolCall(id, patch),
        listToolCalls: async (threadId) => this.#db.listToolCalls(threadId),
        listThreadArtifacts: async (threadId) => this.#db.listArtifacts(threadId),
        addArtifact: async (input) => this.#db.addArtifact(input),
        addRuntimeEvent: async (event) => this.#db.addRuntimeEvent(event)
      },
      buildKnowledgeContext: async (threadId) => this.buildKnowledgeContext(threadId),
      buildWorkflowPackContext: async (threadId) => this.buildWorkflowPackContext(threadId),
      getEnabledPluginIdsForThread: async (threadId) => this.getEnabledPluginIdsForThread(threadId),
      getAccessibleMcpServerIdsForThread: async (threadId) =>
        this.getAccessibleMcpServerIdsForThread(threadId),
      getAccessibleDatabaseConnectionIdsForThread: async () =>
        this.#config.databaseConnections.filter((connection) => connection.enabled).map((connection) => connection.id),
      listKnowledgeBases: async (threadId) => this.listVisibleKnowledgeBases(threadId),
      searchKnowledge: async (query, ids) => this.#db.searchKnowledgeChunks(query, ids),
      readKnowledgeConcept: async (conceptId) => this.#db.getKnowledgeChunk(conceptId) ?? this.#db.getKnowledgeConcept(conceptId),
      searchErrorSolutions: async (input) => this.#db.searchErrorSolutions(input),
      recordErrorSolution: async (input) => this.#db.upsertErrorSolution(input),
      markErrorSolutionUsed: async (id) => {
        this.#db.markErrorSolutionUsed(id);
      },
      listFiles: async (dir) =>
        (await fs.readdir(dir, { withFileTypes: true })).map((entry) => entry.name),
      readFile: async (filePath) => fs.readFile(filePath, "utf8"),
      writeFile: async (filePath, content) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      },
      runTerminalCommand: async (threadId, cwd, command, input) =>
        this.#terminal.execute(threadId, cwd, command, (data) => {
          void this.emitTerminalOutput(threadId, data);
        }, (url) => {
          void this.openLocalServerUrl(threadId, url);
        }, "default", undefined, input?.onStalled),
      cancelTerminalCommands: async (threadId, reason) => this.#terminal.cancelCommands(threadId, reason),
      requestApproval: async (threadId, turnRunId, input) =>
        this.requestApproval(threadId, turnRunId, input),
      requestUserInput: async (threadId, turnRunId, input) =>
        this.requestUserInput(threadId, turnRunId, input),
      spawnChildAgent: async (parentThreadId, input) => this.spawnChildAgent(parentThreadId, input),
      sendAgentMessage: async (parentThreadId, input) => this.sendAgentMessage(parentThreadId, input),
      followupAgentTask: async (parentThreadId, input) => this.followupAgentTask(parentThreadId, input),
      waitForSubagents: async (parentThreadId, input) => this.waitForSubagents(parentThreadId, input),
      interruptAgent: async (parentThreadId, agent) => this.interruptAgent(parentThreadId, agent),
      listSubagents: async (parentThreadId) => this.listSubagents(parentThreadId),
      hasActiveSubagents: async (parentThreadId) => this.hasActiveSubagents(parentThreadId),
      webSearch: async (threadId, query) => this.webSearch(threadId, query),
      openPage: async (threadId, url) => this.openPage(threadId, url),
      findInPage: async (url, pattern) => this.findInPage(url, pattern),
      listBrowserTabs: async (threadId) => this.#db.listBrowserTabs(threadId),
      openBrowserTab: async (threadId, url) => this.openBrowserTab(threadId, url),
      closeBrowserTabs: async (threadId, tabIds) => this.closeBrowserTabs(threadId, tabIds),
      navigateBrowserTab: async (threadId, tabId, url) => this.navigateBrowserTab(threadId, tabId, url),
      reloadBrowserTab: async (threadId, tabId) => this.reloadBrowserTab(threadId, tabId),
      goBackBrowserTab: async (threadId, tabId) => this.goBackBrowserTab(threadId, tabId),
      goForwardBrowserTab: async (threadId, tabId) => this.goForwardBrowserTab(threadId, tabId),
      focusBrowserTab: async (threadId, tabId) => this.focusBrowserTab(threadId, tabId),
      readBrowserPageText: async (threadId, tabId) => this.readBrowserPageText(threadId, tabId),
      inspectBrowserPage: async (threadId, tabId) => this.inspectBrowserPage(threadId, tabId),
      inspectBrowserTarget: async (threadId, tabId, elementId) => this.inspectBrowserTarget(threadId, tabId, elementId),
      clickBrowserElement: async (threadId, tabId, elementId) => this.clickBrowserElement(threadId, tabId, elementId),
      fillBrowserElement: async (threadId, tabId, elementId, value) => this.fillBrowserElement(threadId, tabId, elementId, value),
      selectBrowserOption: async (threadId, tabId, elementId, value) => this.selectBrowserOption(threadId, tabId, elementId, value),
      scrollBrowserPage: async (threadId, tabId, deltaY) => this.scrollBrowserPage(threadId, tabId, deltaY),
      pressBrowserKey: async (threadId, tabId, key) => this.pressBrowserKey(threadId, tabId, key),
      waitForBrowserPage: async (threadId, tabId, input) => this.waitForBrowserPage(threadId, tabId, input),
      setBrowserViewport: async (threadId, tabId, viewport) => this.setBrowserViewport(threadId, tabId, viewport),
      assertBrowserPage: async (threadId, tabId, checks) => this.assertBrowserPage(threadId, tabId, checks),
      captureBrowserScreenshot: async (threadId, tabId, turnRunId, fullPage) => this.captureBrowserScreenshot(threadId, tabId, turnRunId, fullPage),
      captureBrowserSnapshot: async (threadId, tabId, turnRunId) =>
        this.captureBrowserSnapshot(threadId, tabId, turnRunId),
      getThreadOutputDir: async (threadId) => this.getThreadOutputDir(threadId),
      listMcpResources: async (server) => this.#mcp.listResources(server),
      listMcpResourceTemplates: async (server) => this.#mcp.listResourceTemplates(server),
      listMcpTools: async (server) => this.#mcp.listTools(server ? [server] : undefined),
      readMcpResource: async (server, uri) => this.#mcp.readResource(server, uri),
      listMcpPrompts: async (server) => this.#mcp.listPrompts(server),
      getMcpPrompt: async (server, name, args) => this.#mcp.getPrompt(server, name, args),
      getMcpToolApprovalMode: (server, tool) => this.#mcp.getToolApprovalMode(server, tool),
      callMcpTool: async (server, tool, argumentsJson) =>
        this.#mcp.callTool(server, tool, argumentsJson),
      listDatabaseSources: async (ids) => this.listDatabaseSources(ids),
      describeDatabaseSchema: async (sourceId, schema) => this.describeDatabaseSchema(sourceId, schema),
      queryDatabase: async (sourceId, sql, parameters, maxRows) => this.queryDatabase(sourceId, sql, parameters, maxRows),
      executeDatabase: async (sourceId, sql, parameters, operation) => this.executeDatabase(sourceId, sql, parameters, operation),
      markModelAgentIncompatible: async (threadId, modelId, reason) =>
        this.markModelAgentIncompatible(threadId, modelId, reason),
      emit: async (event) => this.emit(event),
      log: async (kind, threadId, payload) => this.#logs.append(kind, payload, threadId)
    });
    for (const approval of this.#db.listPendingApprovals()) {
      this.#scheduleApprovalTimeout(approval.id);
    }
    for (const threadId of this.#db.listQueuedMessageThreadIds()) {
      this.#runtime.wakeQueuedMessages(threadId);
    }
    await this.#logs.append("backend.initialized", {
      logsDir: this.#layout.logsDir,
      bundledSkillFileCount,
      bundledPluginIds
    });
  }

  public initializeDeferredServices(): Promise<void> {
    if (!this.#deferredServices) {
      this.#deferredServices = this.initializeDeferredServicesInternal().catch(async (error) => {
        await this.#logs.append("backend.deferred_initialization_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return this.#deferredServices;
  }

  public onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#events.on("runtime-event", listener);
    return () => this.#events.off("runtime-event", listener);
  }

  public listThreads(): ThreadRecord[] {
    return this.#db.listThreads();
  }

  public getThreadTokenUsage(threadId: string): {
    turn: import("@shared-types").TokenUsage;
    thread: import("@shared-types").TokenUsage;
    turnRunId: string | null;
  } {
    return this.#db.getThreadTokenUsage(threadId);
  }

  public searchThreads(query: string) {
    return this.#db.searchThreads(query);
  }

  public async setThreadPinned(threadId: string, isPinned: boolean): Promise<ThreadRecord> {
    const updated = this.#db.updateThread(threadId, {
      isPinned,
      pinnedAt: isPinned ? new Date().toISOString() : null
    });
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
    return updated;
  }

  public async renameThread(threadId: string, title: string): Promise<ThreadRecord> {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("任务名称不能为空。");
    }
    const updated = this.#db.updateThread(threadId, { title: nextTitle });
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
    return updated;
  }

  public async listMcpServers() {
    const statusById = new Map(this.#mcp.listStatuses().map((status) => [status.serverId, status]));
    return Promise.all(this.#mcp.listConfigs().map(async (server) => ({
      ...server,
      authStatus: await this.#mcpOAuth.status(server),
      status: statusById.get(server.id) ?? { serverId: server.id, state: server.enabled ? "idle" : "disabled" }
    })));
  }

  public async testMcpServer(config: McpServerConfig) {
    return this.#mcp.testConfig({ ...config, source: "config", pluginId: undefined });
  }

  public listDatabaseSources(ids?: string[]) {
    const allowed = ids ? new Set(ids) : null;
    return this.#config.databaseConnections
      .filter((connection) => connection.enabled && (!allowed || allowed.has(connection.id)))
      .map(({ credentialRef: _credentialRef, ...connection }) => connection);
  }

  public async listDatabaseCredentialConnectionIds(): Promise<string[]> {
    const records = await Promise.all(this.#config.databaseConnections.map(async (connection) => ({
      id: connection.id,
      hasCredential: await this.#databaseCredentials.has(connection.credentialRef)
    })));
    return records.filter((record) => record.hasCredential).map((record) => record.id);
  }

  public async testDatabaseConnection(connection: DatabaseConnectionConfig, password?: string) {
    const testId = randomUUID();
    const startedAt = Date.now();
    const details = {
      testId,
      connectionId: connection.id,
      engine: connection.engine,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      tlsMode: connection.tlsMode,
      credentialSource: password ? "input" : "saved"
    };
    await this.#logs.append("database.connection_test_started", details);
    try {
      const result = await this.#databases.test(connection, password);
      await this.#logs.append("database.connection_test_succeeded", {
        ...details,
        durationMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      const typed = error as NodeJS.ErrnoException & {
        errno?: number;
        sqlState?: string;
        syscall?: string;
        fatal?: boolean;
        databaseStage?: string;
      };
      await this.#logs.append("database.connection_test_failed", {
        ...details,
        durationMs: Date.now() - startedAt,
        errorName: typed.name || "Error",
        errorCode: typed.code ?? null,
        errorNumber: typeof typed.errno === "number" ? typed.errno : null,
        errorSqlState: typeof typed.sqlState === "string" ? typed.sqlState : null,
        errorSystemCall: typeof typed.syscall === "string" ? typed.syscall : null,
        errorFatal: typeof typed.fatal === "boolean" ? typed.fatal : null,
        errorStage: typeof typed.databaseStage === "string" ? typed.databaseStage : "unknown",
        errorMessage: redactDatabaseErrorMessage(typed.message || String(error), password)
      });
      throw error;
    }
  }

  public async saveDatabaseCredential(connectionId: string, password: string): Promise<void> {
    const connection = this.#config.databaseConnections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error(`Unknown database connection: ${connectionId}`);
    if (!password) throw new Error("A password is required.");
    await this.#databaseCredentials.write(connection.credentialRef, password);
  }

  public async deleteDatabaseCredential(connectionId: string): Promise<void> {
    const connection = this.#config.databaseConnections.find((entry) => entry.id === connectionId);
    if (connection) await this.#databaseCredentials.remove(connection.credentialRef);
  }

  private requireDatabaseConnection(sourceId: string): DatabaseConnectionConfig {
    const connection = this.#config.databaseConnections.find((entry) => entry.id === sourceId && entry.enabled);
    if (!connection) throw new Error(`Database source is unavailable: ${sourceId}`);
    return connection;
  }

  private async describeDatabaseSchema(sourceId: string, schema?: string) {
    return this.#databases.describeSchema(this.requireDatabaseConnection(sourceId), schema);
  }

  private async queryDatabase(sourceId: string, sql: string, parameters: unknown[], maxRows?: number) {
    return this.#databases.query(this.requireDatabaseConnection(sourceId), sql, parameters, maxRows);
  }

  private async executeDatabase(sourceId: string, sql: string, parameters: unknown[], operation: "insert" | "update" | "delete") {
    return this.#databases.execute(this.requireDatabaseConnection(sourceId), sql, parameters, operation);
  }

  public async refreshMcpTools(serverId?: string) {
    const tools = await this.#mcp.refreshToolDirectory(serverId ? [serverId] : undefined);
    await this.#logs.append("mcp.tools_refreshed", { serverId: serverId ?? "all", toolCount: tools.length });
    return tools;
  }

  public async loginMcpServer(serverId: string): Promise<void> {
    const config = this.#mcp.listConfigs().find((server) => server.id === serverId);
    if (!config) throw new Error(`Unknown MCP server: ${serverId}`);
    await this.#mcpOAuth.login(config);
    await this.#mcp.refresh([serverId]);
    await this.#logs.append("mcp.oauth_login", { serverId, outcome: "success" });
  }

  public async logoutMcpServer(serverId: string): Promise<void> {
    await this.#mcpOAuth.logout(serverId);
    await this.#mcp.refresh([serverId]);
    await this.#logs.append("mcp.oauth_logout", { serverId, outcome: "success" });
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
      providerId: selection.providerId,
      multiAgentMode: this.#config.multiAgent?.defaultMode === "proactive" ? "proactive" : "disabled"
    });
    this.refreshSkillsInBackground(thread.cwd);
    this.#runtime.ensureThread(thread.id);
    return thread;
  }

  public async deleteThread(threadId: string): Promise<void> {
    const thread = this.#db.getThread(threadId);
    const descendants = this.#db.listAgentTree(thread.rootThreadId)
      .filter((item) => item.id !== thread.id && item.agentPath.startsWith(`${thread.agentPath}/`))
      .sort((left, right) => right.agentPath.length - left.agentPath.length);
    if (thread.status === "running" || thread.status === "waiting" || descendants.some((item) => item.status === "running" || item.status === "waiting")) {
      await this.interruptThread(threadId);
      return this.deleteThread(threadId);
    }
    for (const child of descendants) {
      await this.#terminal.close(child.id);
      await this.removeThreadOutputDir(child);
      this.#browser.clearThread(child.id);
      await this.#runtime.forgetThread(child.id);
      this.#db.deleteThread(child.id);
    }
    if ((thread.status as ThreadRecord["status"]) === "running" || (thread.status as ThreadRecord["status"]) === "waiting") {
      throw new Error("任务正在执行，暂时不能删除。");
    }

    await this.#terminal.close(threadId);
    await this.removeThreadOutputDir(thread);
    this.#db.deleteThread(threadId);
    this.#browser.clearThread(threadId);
    await this.#runtime.forgetThread(threadId);
  }

  public async clearThreadConversation(threadId: string): Promise<ThreadRecord> {
    const thread = this.#db.getThread(threadId);
    const descendants = this.#db.listAgentTree(thread.rootThreadId)
      .filter((item) => item.id !== thread.id && item.agentPath.startsWith(`${thread.agentPath}/`));
    if (thread.status === "running" || thread.status === "waiting" || descendants.some((item) => item.status === "running" || item.status === "waiting")) {
      await this.interruptThread(threadId);
      return this.clearThreadConversation(threadId);
    }
    for (const child of descendants) {
      await this.#terminal.close(child.id);
      this.#browser.clearThread(child.id);
      await this.#runtime.forgetThread(child.id);
      this.#db.clearThreadConversation(child.id);
    }
    if ((thread.status as ThreadRecord["status"]) === "running" || (thread.status as ThreadRecord["status"]) === "waiting") {
      throw new Error("任务正在执行，请先停止任务再清空聊天记录。");
    }

    await this.#runtime.abandonGpaPlanFile(threadId);
    await this.#runtime.forgetThread(threadId);
    await this.#terminal.close(threadId);
    for (const tab of this.#db.listBrowserTabs(threadId)) {
      this.releaseBrowserTabContents(threadId, tab.id);
    }
    this.#browser.clearThread(threadId);
    const updated = this.#db.clearThreadConversation(threadId);
    this.#gpaStateCache.delete(threadId);
    this.#runtime.ensureThread(threadId);
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
    return updated;
  }

  public async openTerminal(threadId: string, sessionId = "default") {
    const thread = this.#db.getThread(threadId);
    const cwd = thread.cwd ?? await this.getThreadOutputDir(threadId);
    return this.#terminal.open(
      threadId,
      cwd,
      (data) => {
        void this.emitTerminalOutput(threadId, data, sessionId);
      },
      sessionId
    );
  }

  public async writeTerminal(threadId: string, input: string, sessionId = "default"): Promise<void> {
    const thread = this.#db.getThread(threadId);
    const cwd = thread.cwd ?? await this.getThreadOutputDir(threadId);
    this.#terminal.write(
      threadId,
      cwd,
      input,
      (data) => {
        void this.emitTerminalOutput(threadId, data, sessionId);
      },
      sessionId
    );
  }

  public async closeTerminal(threadId: string, sessionId?: string): Promise<void> {
    await this.#terminal.close(threadId, sessionId);
  }

  public async listProjectFiles(threadId: string): Promise<Array<{ path: string; kind: "file" | "directory"; size?: number }>> {
    const root = this.getProjectDirectory(threadId);
    const files: Array<{ path: string; kind: "file" | "directory"; size?: number }> = [];
    const ignored = new Set([".git", "node_modules", ".next", "dist", "build"]);

    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (ignored.has(entry.name) || entry.isSymbolicLink() || files.length >= 2_000) {
          continue;
        }
        // The renderer stores tree paths with forward slashes on every platform.
        // Returning the same canonical form prevents a refresh from losing selection on Windows.
        const relativePath = (relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name)
          .split(path.sep)
          .join("/");
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          files.push({ path: relativePath, kind: "directory" });
          await visit(absolutePath, relativePath);
          continue;
        }
        if (entry.isFile()) {
          const stats = await fs.stat(absolutePath);
          files.push({ path: relativePath, kind: "file", size: stats.size });
        }
      }
    };

    await visit(root, "");
    return files;
  }

  public async readProjectFile(threadId: string, relativePath: string): Promise<{ path: string; content: string; truncated: boolean; binary: boolean }> {
    const root = this.getProjectDirectory(threadId);
    const target = resolveProjectFilePath(root, relativePath);
    const stats = await fs.stat(target);
    if (!stats.isFile()) {
      throw new Error("The selected project entry is not a file.");
    }

    const buffer = await fs.readFile(target);
    const limit = 512_000;
    const visible = buffer.subarray(0, limit);
    const decoded = decodeProjectText(visible);
    return {
      path: relativePath,
      content: decoded?.content ?? "Binary file preview is not available.",
      truncated: buffer.length > limit,
      binary: !decoded
    };
  }

  public async writeProjectFile(threadId: string, relativePath: string, content: string): Promise<{ path: string }> {
    if (typeof content !== "string") {
      throw new Error("Project file content must be text.");
    }

    const root = this.getProjectDirectory(threadId);
    const target = resolveProjectFilePath(root, relativePath);
    const stats = await fs.stat(target);
    if (!stats.isFile()) {
      throw new Error("The selected project entry is not a file.");
    }

    const existing = await fs.readFile(target);
    const decoded = decodeProjectText(existing);
    if (!decoded) {
      throw new Error("Binary project files cannot be edited here.");
    }

    await fs.writeFile(target, encodeProjectText(content, decoded.encoding));
    return { path: relativePath };
  }

  public getThreadSnapshot(threadId: string, messageLimit = 160): RuntimeThreadSnapshot {
    const thread = this.#db.getThread(threadId);
    const subagents = this.getCurrentRequestSubagents(thread);
    const childApprovals = thread.parentThreadId
      ? []
      : subagents.flatMap((child) => this.#db.listApprovals(child.id).filter((approval) => approval.status === "pending"));
    const childPrompts = thread.parentThreadId
      ? []
      : subagents.flatMap((child) => this.#db.listUserPrompts(child.id).filter((prompt) => prompt.status === "pending"));
    const browserTabs = this.removePersistedBrowserErrorTabs(threadId);
    this.#browser.syncPersistedTabs(threadId, browserTabs);
    const cappedMessageLimit = Number.isFinite(messageLimit)
      ? Math.min(2_000, Math.max(1, Math.floor(messageLimit)))
      : 160;
    const messageCount = this.#db.countMessages(threadId);
    const messages = this.#db.listRecentMessages(threadId, cappedMessageLimit);
    return {
      thread,
      messages,
      messageCount,
      hasMoreMessages: messageCount > messages.length,
      queuedMessages: this.#db.listQueuedMessages(threadId).filter((message) => message.status === "queued"),
      approvals: [...this.#db.listApprovals(threadId), ...childApprovals],
      prompts: [...this.#db.listUserPrompts(threadId), ...childPrompts],
      artifacts: this.#db.listArtifacts(threadId),
      knowledgeBases: this.listVisibleKnowledgeBasesForThread(thread),
      browserTabs,
      projectPlugins: this.listProjectPluginsForThread(thread),
      toolCalls: messages.length > 0 ? this.#db.listToolCalls(threadId, messages[0].createdAt) : [],
      contextCompaction: this.#db.getLatestContextCompaction(threadId),
      gpa: this.getGpaState(threadId),
      subagents
    };
  }

  public getGpaState(threadId: string): GpaState {
    const thread = this.#db.getThread(threadId);
    const state = parseGpaState(thread.gpaStateJson, this.#gpaStateCache.get(threadId));
    this.#gpaStateCache.set(threadId, state);
    return state;
  }

  public onSkillLabEvent(listener: (event: SkillLabEvent) => void): () => void {
    this.#skillLabEvents.on("skill-lab-event", listener);
    return () => this.#skillLabEvents.off("skill-lab-event", listener);
  }

  public async startSkillLab(prompt: string, requestedName?: string, iterations?: number, targetSkillId?: string): Promise<string> {
    await this.initializeDeferredServices();
    return this.#skillLab.start(prompt, requestedName, iterations, targetSkillId);
  }

  public cancelSkillLab(jobId: string): void {
    this.#skillLab.cancel(jobId);
  }

  public resolveSkillLabApproval(jobId: string, approvalId: string, approved: boolean): void {
    this.#skillLab.resolveApproval(jobId, approvalId, approved);
  }

  public resolveSkillLabClarification(jobId: string, clarificationId: string, answers: Record<string, string>): void {
    this.#skillLab.resolveClarification(jobId, clarificationId, answers);
  }

  public async setGpaStage(threadId: string, stage: GpaStage): Promise<void> {
    await this.#runtime.setGpaStage(threadId, stage);
  }

  public getGitSnapshot(threadId: string): Promise<GitSnapshot> {
    const thread = this.#db.getThread(threadId);
    return this.#git.snapshot(thread.cwd ? path.resolve(thread.cwd) : null);
  }

  public stageGitFile(threadId: string, path: string): Promise<GitActionResult> {
    return this.#git.stageFile(this.getProjectDirectory(threadId), path);
  }

  public stageAllGitChanges(threadId: string): Promise<GitActionResult> {
    return this.#git.stageAll(this.getProjectDirectory(threadId));
  }

  public unstageGitFile(threadId: string, path: string): Promise<GitActionResult> {
    return this.#git.unstageFile(this.getProjectDirectory(threadId), path);
  }

  public revertGitFile(threadId: string, path: string, untracked?: boolean): Promise<GitActionResult> {
    return this.#git.revertFile(this.getProjectDirectory(threadId), path, untracked === true);
  }

  public applyGitHunk(
    threadId: string,
    payload: { path: string; hunkId: string; source: "staged" | "unstaged"; action: "stage" | "unstage" | "revert" }
  ): Promise<GitActionResult> {
    return this.#git.applyHunk(this.getProjectDirectory(threadId), payload.path, payload.hunkId, payload.source, payload.action);
  }

  public commitGitChanges(threadId: string, message: string): Promise<GitActionResult> {
    return this.#git.commit(this.getProjectDirectory(threadId), message);
  }

  public pushGitChanges(threadId: string): Promise<GitActionResult> {
    return this.#git.push(this.getProjectDirectory(threadId));
  }

  public pullGitChanges(threadId: string): Promise<GitActionResult> {
    return this.#git.pull(this.getProjectDirectory(threadId));
  }

  public async createGitPullRequest(threadId: string): Promise<GitActionResult> {
    const result = await this.#git.createPullRequest(this.getProjectDirectory(threadId));
    if (result.ok && result.pullRequestUrl) {
      await shell.openExternal(result.pullRequestUrl);
    }
    return result;
  }

  public async resetGpaConfirmationTimeout(threadId: string): Promise<void> {
    await this.#runtime.resetGpaConfirmationTimeout(threadId);
  }

  public async getProjectGpaPlan(threadId: string) {
    const thread = this.#db.getThread(threadId);
    if (thread.mode !== "project" || !thread.cwd) {
      return null;
    }
    const doc = await this.#runtime.peekGpaPlanFile(threadId);
    if (!doc) {
      return null;
    }
    return toGpaPlanResumePreview(doc, threadId);
  }

  public async restoreProjectGpaPlan(threadId: string) {
    const restored = await this.#runtime.restoreGpaPlanFromFile(threadId);
    return restored ?? this.getGpaState(threadId);
  }

  public async abandonProjectGpaPlan(threadId: string): Promise<boolean> {
    return this.#runtime.abandonGpaPlanFile(threadId);
  }

  public async setGpaFullAccess(threadId: string, fullAccess: boolean): Promise<void> {
    await this.#runtime.setGpaFullAccess(threadId, fullAccess);
  }

  public async setKnowledgeEnabled(threadId: string, knowledgeEnabled: boolean): Promise<void> {
    await this.#runtime.setKnowledgeEnabled(threadId, knowledgeEnabled);
  }

  public async sendMessage(
    threadId: string,
    content: string,
    attachments: MessageAttachment[] = [],
    displayContent?: string,
    dispatch = true
  ): Promise<void> {
    await this.initializeDeferredServices();
    const thread = this.#db.getThread(threadId);
    const isFirstThreadMessage = this.#db.listMessages(threadId).length === 0 && this.#db.listQueuedMessages(threadId).length === 0;
    if (isFirstThreadMessage) {
      const updated = this.#db.updateThread(threadId, {
        title: buildThreadTitleFromFirstMessage(displayContent || content)
      });
      await this.emit({
        type: "thread.updated",
        threadId,
        payload: { thread: updated },
        createdAt: new Date().toISOString()
      });
    }

    const queued = this.#db.enqueueQueuedMessage({
      threadId,
      content,
      displayContent: displayContent || content,
      attachments
    });
    await this.emit({
      type: "queue.updated",
      threadId,
      payload: { queueItemId: queued.id, action: "queued" },
      createdAt: new Date().toISOString()
    });
    if (dispatch) {
      this.#runtime.wakeQueuedMessages(threadId);
    }
    // Skill discovery walks user, project, and plugin directories. It must not
    // hold up a message that can run using the current catalog.
    this.refreshSkillsInBackground(thread.cwd);
  }

  public async setThreadMultiAgentMode(threadId: string, mode: ThreadRecord["multiAgentMode"]): Promise<ThreadRecord> {
    const nextMode = mode === "disabled" ? "disabled" : "proactive";
    const updated = this.#db.updateThread(threadId, { multiAgentMode: nextMode });
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
    return updated;
  }

  public async replaceMessage(threadId: string, messageId: string, content: string): Promise<void> {
    const thread = this.#db.getThread(threadId);
    if (thread.status === "running" || thread.status === "waiting") {
      throw new Error("Stop the active task before editing a message.");
    }
    this.#db.truncateConversationFromMessage(threadId, messageId);
    await this.sendMessage(threadId, content);
  }

  public async deleteQueuedMessage(threadId: string, id: string): Promise<void> {
    if (!this.#db.deleteQueuedMessage(threadId, id)) {
      throw new Error("The queued message is no longer available.");
    }
    await this.emit({
      type: "queue.updated",
      threadId,
      payload: { queueItemId: id, action: "deleted" },
      createdAt: new Date().toISOString()
    });
  }

  public async importAttachments(threadId: string, inputs: AttachmentImportInput[]): Promise<MessageAttachment[]> {
    const targetDir = path.join(this.#layout.attachmentsDir, threadId);
    await fs.mkdir(targetDir, { recursive: true });
    if (inputs.length > 16) throw new Error("一次最多添加 16 个附件。");
    const attachments: MessageAttachment[] = [];
    for (const input of inputs) {
      const name = path.basename(input.name || input.path || "attachment");
      const inputData = input.data ? Buffer.from(input.data) : input.path ? await fs.readFile(input.path) : null;
      if (!inputData) throw new Error(`附件 ${name} 没有可读取内容。`);
      const mimeType = normalizeAttachmentMimeType(input.mimeType, name);
      const isImage = mimeType.startsWith("image/");
      const isVideo = mimeType.startsWith("video/");
      const maxBytes = isVideo ? 100 * 1024 * 1024 : isImage ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
      if (inputData.byteLength > maxBytes) {
        throw new Error(`${isVideo ? "视频" : isImage ? "图片" : "附件"} ${name} 超过 ${Math.round(maxBytes / (1024 * 1024))} MB 限制。`);
      }
      const digest = createHash("sha256").update(inputData).digest("hex");
      const extension = path.extname(name) || extensionForMimeType(mimeType);
      const absolutePath = path.join(targetDir, `${digest.slice(0, 24)}${extension.toLowerCase()}`);
      try { await fs.access(absolutePath); } catch { await fs.writeFile(absolutePath, inputData); }
      attachments.push({
        id: randomUUID(),
        kind: isImage ? "image" : isVideo ? "video" : "file",
        name,
        mimeType,
        absolutePath,
        sizeBytes: inputData.byteLength,
        source: "user"
      });
    }
    return attachments;
  }

  public async getAttachmentDataUrl(threadId: string, absolutePath: string): Promise<string> {
    const allowed = await this.isThreadAttachmentPath(threadId, absolutePath);
    if (!allowed) throw new Error("该附件不属于当前对话。");
    const mimeType = normalizeAttachmentMimeType(undefined, absolutePath);
    if (!mimeType.startsWith("image/")) throw new Error("该附件不是可预览图片。");
    const data = await fs.readFile(absolutePath);
    if (data.byteLength > 20 * 1024 * 1024) throw new Error("图片过大，无法预览。");
    return `data:${mimeType};base64,${data.toString("base64")}`;
  }

  public async getAttachmentMediaUrl(threadId: string, absolutePath: string): Promise<{
    url: string;
    mimeType: string;
    kind: "image" | "video" | "file";
  }> {
    const resolved = path.resolve(absolutePath);
    const allowed = await this.isThreadAttachmentPath(threadId, resolved);
    if (!allowed) throw new Error("该附件不属于当前对话。");
    const mimeType = normalizeAttachmentMimeType(undefined, resolved);
    if (mimeType.startsWith("image/")) {
      const data = await fs.readFile(resolved);
      if (data.byteLength > 20 * 1024 * 1024) throw new Error("图片过大，无法预览。");
      return {
        url: `data:${mimeType};base64,${data.toString("base64")}`,
        mimeType,
        kind: "image"
      };
    }
    if (mimeType.startsWith("video/")) {
      await fs.access(resolved);
      return {
        url: buildCodexhMediaUrl(threadId, resolved),
        mimeType,
        kind: "video"
      };
    }
    throw new Error("该附件不支持内嵌预览。");
  }

  public async assertThreadMediaPath(threadId: string, absolutePath: string): Promise<string> {
    const resolved = path.resolve(absolutePath);
    const allowed = await this.isThreadAttachmentPath(threadId, resolved);
    if (!allowed) throw new Error("该媒体文件不属于当前对话。");
    await fs.access(resolved);
    return resolved;
  }

  public async getLocalImagePreview(absolutePath: string): Promise<string> {
    const mimeType = normalizeAttachmentMimeType(undefined, absolutePath);
    if (!mimeType.startsWith("image/")) throw new Error("该文件不是图片。");
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("图片无法预览。");
    const data = await fs.readFile(absolutePath);
    return `data:${mimeType};base64,${data.toString("base64")}`;
  }

  public async rejectUnsupportedMultimodalInput(threadId: string, content: string): Promise<void> {
    if (this.#db.listMessages(threadId).length === 0) {
      const updated = this.#db.updateThread(threadId, {
        title: buildThreadTitleFromFirstMessage(content)
      });
      await this.emit({
        type: "thread.updated",
        threadId,
        payload: { thread: updated },
        createdAt: new Date().toISOString()
      });
    }

    const userMessage = this.#db.createMessage({
      threadId,
      turnRunId: null,
      role: "user",
      content,
      metadataJson: null
    });
    const assistantMessage = this.#db.createMessage({
      threadId,
      turnRunId: null,
      role: "assistant",
      content: "此模型不支持多模态输入，无法处理本次文件、文件夹或图片附件。请切换到支持多模态的模型，或在设置 → 多模态中配置默认多模态识别模型后重试。",
      metadataJson: JSON.stringify({ reason: "multimodal_not_supported" })
    });
    for (const message of [userMessage, assistantMessage]) {
      await this.emit({
        type: "message.created",
        threadId,
        payload: { message },
        createdAt: new Date().toISOString()
      });
    }
  }

  public async interruptThread(threadId: string): Promise<void> {
    const thread = this.#db.getThread(threadId);
    const descendants = this.#db.listAgentTree(thread.rootThreadId)
      .filter((item) => item.id !== thread.id && item.agentPath.startsWith(`${thread.agentPath}/`))
      .sort((left, right) => right.agentPath.length - left.agentPath.length);
    const threadIds = [...descendants.map((child) => child.id), thread.id];
    const cancelledQueueItemIds = new Map<string, string[]>();

    await this.#logs.append("thread.interrupt_requested", {
      targetThreadId: threadId,
      interruptedThreadIds: threadIds
    }, threadId);

    for (const id of threadIds) {
      this.#runtime.interrupt(id);
      this.#terminal.cancelCommands(id, "Task interrupted.");
      cancelledQueueItemIds.set(id, this.#db.cancelQueuedMessages(id));
    }

    await Promise.all(threadIds.map((id) => this.finishInterruptThread(id, cancelledQueueItemIds.get(id) ?? [])));

    await this.#logs.append("thread.interrupted", {
      targetThreadId: threadId,
      interruptedThreadIds: threadIds,
      cancelledQueueItemCount: [...cancelledQueueItemIds.values()].reduce((count, ids) => count + ids.length, 0)
    }, threadId);
  }

  private async finishInterruptThread(threadId: string, cancelledQueueItemIds: string[]): Promise<void> {
    // Let the aborted turn finish its persistence/finally cleanup before a
    // caller deletes or clears this thread and its descendants.
    await this.#runtime.waitForIdle(threadId, 5000);
    // Always force the persisted execution state idle. The turn may still be in
    // "preparing" (DB still idle/completed) when the user hits Stop; skipping
    // cleanup here leaves the UI and queue believing work is still running.
    for (const [promptId] of [...this.#promptResolvers.entries()]) {
      const record = this.#db.getUserPrompt(promptId);
      if (record?.threadId === threadId) {
        this.#clearPromptTimeout(promptId);
        this.#promptResolvers.delete(promptId);
      }
    }
    for (const [approvalId] of [...this.#approvalTimeouts.entries()]) {
      if (this.#db.getApproval(approvalId)?.threadId === threadId) {
        this.#clearApprovalTimeout(approvalId);
        this.#approvalResolvers.get(approvalId)?.(false);
        this.#approvalResolvers.delete(approvalId);
      }
    }
    const updated = this.#db.interruptThreadExecution(threadId);
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
    for (const queueItemId of cancelledQueueItemIds) {
      await this.emit({
        type: "queue.updated",
        threadId,
        payload: { queueItemId, action: "deleted" },
        createdAt: new Date().toISOString()
      });
    }
  }

  public listSkills(): ReturnType<SkillsManager["list"]> {
    return this.#skills.list();
  }

  public getSkillUsageStats() {
    return this.#db.aggregateSkillUsageStats();
  }

  public async reloadSkills(cwd?: string | null): Promise<void> {
    await this.refreshSkills(cwd);
  }

  public listUserSkills(): SkillMetadata[] {
    return this.#skills.list().filter((skill) =>
      !skill.pluginId &&
      skill.scope === "user" &&
      isPathWithinDirectory(this.#layout.skillsDraftsDir, path.dirname(skill.skillPath))
    );
  }

  public async generateUserSkill(threadId: string, requestedName?: string): Promise<SkillMetadata> {
    await this.initializeDeferredServices();
    const thread = this.#db.getThread(threadId);
    if (thread.parentThreadId) throw new Error("只能从主聊天生成用户技能。");
    const messages = this.#db.listMessages(threadId)
      .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
      .map((message) => ({ role: message.role, content: message.content }));
    const toolCalls = this.#db.listToolCalls(threadId).map(userWorkflowToolCall);
    if (messages.length === 0 && toolCalls.length === 0) throw new Error("所选聊天没有可提炼的内容。");

    const selection = resolveThreadModelSelection(this.#config, thread.providerId, thread.modelId);
    const provider = this.#config.providers.find((entry) => entry.id === selection.providerId);
    const model = this.#config.models.find((entry) => entry.id === selection.modelId && entry.providerId === selection.providerId);
    if (!provider || !model || model.role !== "reasoning") throw new Error("所选聊天没有可用的推理模型。");
    const prompt = buildUserWorkflowPrompt({ title: thread.title, messages, toolCalls });
    const timeout = new AbortController();
    const timeoutId = this.#config.timeouts.modelDecisionMs > 0
      ? setTimeout(() => timeout.abort(), this.#config.timeouts.modelDecisionMs)
      : null;

    try {
      const decision = await this.#providerFactory.create(provider).runTurn({
        systemPrompt: "You create concise reusable Codex skills from completed conversations. Return exactly the requested JSON object and never call tools.",
        transcript: [{ role: "user", content: prompt }],
        availableTools: [],
        model: { ...model, supportsStreaming: false },
        provider,
        stream: false,
        abortSignal: timeout.signal
      });
      const generatedDraft = parseUserWorkflowDraft(decision.assistantMessage ?? "", thread.title);
      const draft = requestedName?.trim()
        ? { ...generatedDraft, name: normalizeUserSkillName(requestedName) }
        : generatedDraft;
      const skillDirectory = await reserveUserSkillDirectory(this.#layout.skillsDraftsDir, draft.name);
      const skillPath = path.join(skillDirectory, "SKILL.md");
      try {
        await fs.writeFile(skillPath, renderUserWorkflowSkill({ ...draft, name: path.basename(skillDirectory) }), "utf8");
        await this.refreshSkills();
        const skill = this.#skills.list().find((entry) => path.resolve(entry.skillPath) === path.resolve(skillPath));
        if (!skill) throw new Error("用户技能已生成，但未能载入 Skill 索引。");
        return skill;
      } catch (error) {
        await fs.rm(skillDirectory, { recursive: true, force: true });
        await this.refreshSkills().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (timeout.signal.aborted) throw new Error("生成用户技能超时，请检查模型连接后重试。");
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  public async fetchProviderModels(input: {
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    type?: ProviderDefinition["type"];
    id?: string;
  }): Promise<{ id: string; displayName?: string; contextWindow?: number }[]> {
    const baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
    const apiKey = resolveFetchedApiKey(input);
    if (!baseUrl) {
      throw new Error("缺少调用地址");
    }
    if (!apiKey) {
      throw new Error("缺少 API Key");
    }
    const endpoint = `${baseUrl}/models`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...this.#config.providers.find((provider) => provider.id === input.id)?.headers
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`获取模型失败 (${response.status}): ${text.slice(0, 200)}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ id: string; display_name?: string; name?: string; owned_by?: string; context_window?: number; contextWindow?: number; context_length?: number; max_context_length?: number; max_input_tokens?: number }>;
      models?: Array<{ id: string; display_name?: string; name?: string; context_window?: number; contextWindow?: number; context_length?: number; max_context_length?: number; max_input_tokens?: number }>;
    };
    const list = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];
    if (list.length === 0) {
      throw new Error("接口未返回任何模型");
    }
    return list.map((entry) => {
      const rawContextWindow = entry.context_window ?? entry.contextWindow ?? entry.context_length ?? entry.max_context_length ?? entry.max_input_tokens;
      const numericContextWindow = Number(rawContextWindow);
      const contextWindow = Number.isFinite(numericContextWindow) && numericContextWindow > 0
        ? Math.floor(numericContextWindow)
        : undefined;
      return {
        id: entry.id,
        displayName: entry.display_name ?? entry.name ?? entry.id,
        ...(contextWindow ? { contextWindow } : {})
      };
    });
  }

  public async testProviderModel(input: {
    provider: ProviderDefinition;
    model: ModelProfile;
  }): Promise<{
    latencyMs: number;
    outputTokens: number;
    tokensPerSecond: number;
    contextWindow?: number;
    agentCapability: "verified" | "unsupported";
    agentCapabilityReason?: string;
  }> {
    const startedAt = performance.now();
    const adapter = this.#providerFactory.create(input.provider);
    const detectedContextWindow = this.fetchProviderModels({
      baseUrl: input.provider.baseUrl,
      apiKey: input.provider.apiKey,
      apiKeyEnv: input.provider.apiKeyEnv,
      type: input.provider.type,
      id: input.provider.id
    })
      .then((models) => models.find((model) => model.id === input.model.id)?.contextWindow)
      .catch(() => undefined);
    const timeout = new AbortController();
    const timeoutId = this.#config.timeouts.modelTestMs > 0
      ? setTimeout(() => timeout.abort(), this.#config.timeouts.modelTestMs)
      : null;

    try {
      if (input.model.supportsImageGeneration) {
        if (!adapter.generateImage) {
          throw new Error("当前供应商不支持 OpenAI 兼容图片生成接口。请使用 OpenAI Chat Completions 或 Gateway，并确认中转提供 /images/generations。");
        }
        const image = await adapter.generateImage({
          model: input.model,
          prompt: "A small blue square on a white background.",
          abortSignal: timeout.signal
        });
        if (image.data.byteLength === 0) throw new Error("图片生成接口未返回有效图片数据。");
        const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
        return {
          latencyMs,
          outputTokens: 0,
          tokensPerSecond: 0,
          contextWindow: await detectedContextWindow,
          agentCapability: "unsupported",
          agentCapabilityReason: "Image-generation models do not run Agent tools."
        };
      }
      const decision = await adapter.runTurn({
        systemPrompt:
          "You are testing a model connection. Return one compact JSON object with no tool calls.",
        transcript: [{ role: "user", content: "Return a short connection-test JSON response." }],
        availableTools: [],
        model: { ...input.model, supportsStreaming: false },
        provider: input.provider,
        stream: false,
        abortSignal: timeout.signal
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
      const outputTokens = Math.max(
        1,
        decision.outputTokens ?? estimateTokenCount(decision.assistantMessage ?? "")
      );

      let agentCapability: "verified" | "unsupported" = "unsupported";
      let agentCapabilityReason: string | undefined;
      if (!input.model.supportsToolCalling) {
        agentCapabilityReason = "Tool calling is disabled for this model.";
      } else {
        const probeTool: ToolSpecDefinition = {
          name: "fs.read_directory",
          description: "List the selected workspace directory. Call this exact tool now.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
          },
          riskLevel: "low"
        };
        try {
          const toolDecision = await adapter.runTurn({
            systemPrompt: "Call the provided fs.read_directory tool exactly once with {\"path\":\".\"}. Do not answer in text.",
            transcript: [{ role: "user", content: "Run the Agent protocol test now." }],
            availableTools: [probeTool],
            model: { ...input.model, supportsStreaming: false },
            provider: input.provider,
            stream: false,
            abortSignal: timeout.signal
          });
          const call = toolDecision.toolCalls.find((entry) => entry.name === probeTool.name);
          if (call?.arguments.path === ".") {
            const followUpDecision = await adapter.runTurn({
              systemPrompt:
                "The requested tool has completed. Read its result and return a concise final answer. Do not call another tool.",
              transcript: [
                { role: "user", content: "Inspect the selected workspace." },
                { role: "assistant", content: "", toolCalls: [call] },
                {
                  role: "tool",
                  toolCallId: call.id,
                  content: "fs.read_directory\nDirectory listing completed successfully."
                }
              ],
              availableTools: [probeTool],
              model: { ...input.model, supportsStreaming: false },
              provider: input.provider,
              stream: false,
              abortSignal: timeout.signal
            });
            if (
              followUpDecision.isStructured &&
              followUpDecision.endTurn &&
              followUpDecision.assistantMessage?.trim()
            ) {
              agentCapability = "verified";
            } else {
              agentCapabilityReason =
                "The model called the tool but did not complete the native tool-result follow-up.";
            }
          } else {
            agentCapabilityReason = "The provider did not return the required native fs.read_directory tool call.";
          }
        } catch (error) {
          agentCapabilityReason = error instanceof Error ? error.message : String(error);
        }
      }

      return {
        latencyMs,
        outputTokens,
        tokensPerSecond: Number((outputTokens / (latencyMs / 1_000)).toFixed(2)),
        contextWindow: await detectedContextWindow,
        agentCapability,
        agentCapabilityReason
      };
    } catch (error) {
      if (timeout.signal.aborted) {
        throw new Error("模型测试超时（30 秒）。请检查服务地址和网络连接。");
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  public getConfig(): AppConfig {
    return this.#config;
  }

  public async getApplicationBackground(): Promise<ApplicationBackgroundPayload | null> {
    const appearanceDir = path.join(this.#layout.root, "appearance");
    try {
      const [bytes, rawMetadata] = await Promise.all([
        fs.readFile(path.join(appearanceDir, "background-image")),
        fs.readFile(path.join(appearanceDir, "background.json"), "utf8")
      ]);
      const metadata = JSON.parse(rawMetadata) as Partial<ApplicationBackgroundMetadata>;
      if (!APPLICATION_BACKGROUND_MIME_TYPES.has(metadata.mimeType ?? "")) return null;
      return {
        bytes: Uint8Array.from(bytes).buffer,
        mimeType: metadata.mimeType!,
        fileName: typeof metadata.fileName === "string" ? metadata.fileName : "background",
        settings: metadata.settings
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  public async saveApplicationBackground(payload: ApplicationBackgroundPayload): Promise<void> {
    const bytes = new Uint8Array(payload.bytes);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_APPLICATION_BACKGROUND_BYTES) {
      throw new Error("背景图片必须小于 40 MB。");
    }
    if (!APPLICATION_BACKGROUND_MIME_TYPES.has(payload.mimeType)) {
      throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片。");
    }

    const appearanceDir = path.join(this.#layout.root, "appearance");
    const metadata: ApplicationBackgroundMetadata = {
      version: 1,
      mimeType: payload.mimeType,
      fileName: path.basename(payload.fileName || "background").slice(0, 255),
      settings: payload.settings
    };
    const serializedMetadata = JSON.stringify(metadata, null, 2);
    if (Buffer.byteLength(serializedMetadata, "utf8") > 64 * 1024) {
      throw new Error("背景图片设置无效。");
    }

    await fs.mkdir(appearanceDir, { recursive: true });
    await fs.writeFile(
      path.join(appearanceDir, "background-image"),
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    );
    await fs.writeFile(path.join(appearanceDir, "background.json"), serializedMetadata, "utf8");
  }

  public async saveApplicationBackgroundSettings(settings: unknown): Promise<void> {
    const appearanceDir = path.join(this.#layout.root, "appearance");
    const metadataPath = path.join(appearanceDir, "background.json");
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as ApplicationBackgroundMetadata;
      metadata.settings = settings;
      const serializedMetadata = JSON.stringify(metadata, null, 2);
      if (Buffer.byteLength(serializedMetadata, "utf8") > 64 * 1024) {
        throw new Error("背景图片设置无效。");
      }
      await fs.writeFile(metadataPath, serializedMetadata, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  public async clearApplicationBackground(): Promise<void> {
    const appearanceDir = path.join(this.#layout.root, "appearance");
    await Promise.all([
      fs.rm(path.join(appearanceDir, "background-image"), { force: true }),
      fs.rm(path.join(appearanceDir, "background.json"), { force: true })
    ]);
  }

  public getUpdatePaths(): Pick<HomeLayout, "cacheDir" | "logsDir"> {
    return { cacheDir: this.#layout.cacheDir, logsDir: this.#layout.logsDir };
  }

  public appendRuntimeLog(kind: string, payload: Record<string, unknown>): Promise<void> {
    return this.#logs.append(kind, payload);
  }

  public async saveModelAgentCapability(input: {
    providerId: string;
    modelId: string;
    agentCapability: "verified" | "unsupported";
    agentCapabilityReason?: string;
    contextWindow?: number;
  }): Promise<ModelProfile> {
    const model = this.#config.models.find(
      (entry) => entry.id === input.modelId && entry.providerId === input.providerId
    );
    if (!model) {
      throw new Error("该模型尚未保存。请先保存模型配置后再验证。");
    }

    model.agentCapability = input.agentCapability;
    model.agentCapabilityCheckedAt = new Date().toISOString();
    model.agentCapabilityReason = input.agentCapabilityReason;
    if (Number.isFinite(input.contextWindow) && (input.contextWindow ?? 0) >= 1_024) {
      model.contextWindow = Math.floor(input.contextWindow!);
    }
    await saveConfig(this.#layout.configFile, this.#config);
    await this.#logs.append("model.agent_capability_saved", {
      modelId: model.id,
      providerId: model.providerId,
      agentCapability: model.agentCapability,
      agentCapabilityReason: model.agentCapabilityReason,
      contextWindow: input.contextWindow
    });
    return { ...model };
  }

  private async markModelAgentIncompatible(
    threadId: string,
    modelId: string,
    reason: string
  ): Promise<void> {
    const thread = this.#db.getThread(threadId);
    const model = this.#config.models.find(
      (entry) => entry.id === modelId && entry.providerId === thread.providerId
    );
    if (!model) {
      return;
    }

    model.agentCapability = "unsupported";
    model.agentCapabilityCheckedAt = new Date().toISOString();
    model.agentCapabilityReason = `Runtime Agent protocol failure: ${reason}`;
    await saveConfig(this.#layout.configFile, this.#config);
    await this.#logs.append("model.agent_capability_downgraded", {
      modelId: model.id,
      providerId: model.providerId,
      reason
    });
    await this.emit({
      type: "model.capability.updated",
      threadId,
      payload: {
        modelId: model.id,
        providerId: model.providerId,
        agentCapability: model.agentCapability,
        agentCapabilityCheckedAt: model.agentCapabilityCheckedAt,
        agentCapabilityReason: model.agentCapabilityReason
      },
      createdAt: new Date().toISOString()
    });
  }

  public async saveConfig(nextConfig: AppConfig): Promise<void> {
    const normalized = normalizeAppConfig(nextConfig);

    this.#config.defaultModel = normalized.defaultModel;
    this.#config.defaultProvider = normalized.defaultProvider;
    this.#config.providers = [...normalized.providers];
    this.#config.models = [...normalized.models];
    this.#config.routing = { ...normalized.routing };
    this.#config.multimodal = {
      image: { ...normalized.multimodal.image },
      video: { ...normalized.multimodal.video }
    };
    this.#config.desktop = { ...normalized.desktop };
    this.#config.timeouts = { ...normalized.timeouts };
    this.#config.mcpServers = normalized.mcpServers.map((server) => ({
      ...server,
      source: "config",
      pluginId: undefined
    }));
    const previousDatabaseConnections = this.#config.databaseConnections;
    this.#config.databaseConnections = normalized.databaseConnections;
    const nextCredentialRefs = new Set(normalized.databaseConnections.map((connection) => connection.credentialRef));
    await Promise.all(previousDatabaseConnections
      .filter((connection) => !nextCredentialRefs.has(connection.credentialRef))
      .map((connection) => this.#databaseCredentials.remove(connection.credentialRef)));

    await saveConfig(this.#layout.configFile, this.#config);
    await this.#logs.append("config.timeouts_updated", {
      modelDecisionMs: this.#config.timeouts.modelDecisionMs,
      recoveryModelDecisionMs: this.#config.timeouts.recoveryModelDecisionMs,
      modelTimeoutRetries: this.#config.timeouts.modelTimeoutRetries,
      effective: "immediate"
    });
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
    await this.#mcp.refresh();
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

  public async addThreadSkill(threadId: string, skillId: string): Promise<ThreadRecord> {
    const thread = this.#db.getThread(threadId);
    if (thread.selectedSkillIds.includes(skillId)) {
      return thread;
    }
    const updated = this.#db.updateThread(threadId, {
      selectedSkillIds: [...thread.selectedSkillIds, skillId],
      updatedAt: new Date().toISOString()
    });
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
    return updated;
  }

  public async removeThreadSkill(threadId: string, skillId: string): Promise<ThreadRecord> {
    const thread = this.#db.getThread(threadId);
    if (!thread.selectedSkillIds.includes(skillId)) {
      return thread;
    }
    const updated = this.#db.updateThread(threadId, {
      selectedSkillIds: thread.selectedSkillIds.filter((id) => id !== skillId),
      updatedAt: new Date().toISOString()
    });
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

  public async installPlugin(source: string, onProgress?: (progress: PluginInstallProgress) => void): Promise<PluginRecord> {
    const plugin = await this.#plugins.installFromSource(source, this.#layout.pluginsInstalledDir, onProgress);
    onProgress?.({ percent: 86, stage: "正在登记插件" });
    await fs.rm(path.join(this.#layout.pluginsDisabledDir, `${plugin.id}.removed`), { force: true });
    const sourceHash = await hashDirectory(plugin.installPath);
    this.#db.upsertPlugin(plugin, sourceHash);
    onProgress?.({ percent: 93, stage: "正在加载插件能力" });
    await this.refreshMcpConfiguration();
    await this.refreshSkills();
    onProgress?.({ percent: 100, stage: "插件安装完成" });
    return plugin;
  }

  public async removePlugin(pluginId: string): Promise<void> {
    const plugin = this.#db.listPlugins().find((item) => item.id === pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} is not installed.`);
    }
    if (!isPathWithinDirectory(this.#layout.pluginsInstalledDir, plugin.installPath)) {
      throw new Error("Refusing to remove a plugin outside the managed plugin directory.");
    }

    await fs.rm(plugin.installPath, { recursive: true, force: false });
    await fs.writeFile(path.join(this.#layout.pluginsDisabledDir, `${plugin.id}.removed`), "", "utf8");
    this.#db.deletePlugin(plugin.id);
    for (const thread of this.#db.listThreads(true)) {
      if (thread.selectedPluginIds.includes(plugin.id)) {
        this.#db.updateThread(thread.id, {
          selectedPluginIds: thread.selectedPluginIds.filter((id) => id !== plugin.id)
        });
      }
    }
    await this.refreshMcpConfiguration();
    await this.refreshSkills();
  }

  public async removeSkill(skillId: string): Promise<void> {
    const skill = this.#skills.list().find((item) => item.id === skillId);
    if (!skill) {
      throw new Error("Skill is no longer available.");
    }
    if (skill.pluginId || skill.scope !== "user") {
      throw new Error("Only independently installed or imported skills can be removed here.");
    }
    const skillDirectory = path.dirname(skill.skillPath);
    const allowedRoots = [this.#layout.skillsImportedDir, this.#layout.skillsInstalledDir, this.#layout.skillsDraftsDir];
    if (!allowedRoots.some((root) => isPathWithinDirectory(root, skillDirectory))) {
      throw new Error("Refusing to remove a skill outside the managed user skill directories.");
    }

    await fs.rm(skillDirectory, { recursive: true, force: false });
    for (const thread of this.#db.listThreads(true)) {
      if (thread.selectedSkillIds.includes(skill.id)) {
        this.#db.updateThread(thread.id, {
          selectedSkillIds: thread.selectedSkillIds.filter((id) => id !== skill.id)
        });
      }
    }
    await this.refreshSkills();
  }

  public async setThreadPluginEnabled(threadId: string, pluginId: string, enabled: boolean): Promise<ThreadRecord> {
    const thread = this.#db.getThread(threadId);
    if (!this.#db.listPlugins().some((plugin) => plugin.id === pluginId)) {
      throw new Error(`Plugin ${pluginId} is not installed.`);
    }
    const updated = thread.mode === "project" && thread.projectId
      ? thread
      : this.#db.updateThread(threadId, {
          selectedPluginIds: enabled
            ? [...new Set([...thread.selectedPluginIds, pluginId])]
            : thread.selectedPluginIds.filter((id) => id !== pluginId)
        });
    if (thread.mode === "project" && thread.projectId) {
      this.#db.setProjectPluginBinding(thread.projectId, pluginId, enabled);
    }
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated, pluginChanged: { pluginId, enabled } },
      createdAt: new Date().toISOString()
    });
    return updated;
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
    // Wait for the renderer webview to attach so follow-up automation tools can run.
    await this.requireBrowserContents(threadId, opened.tab.id, 20_000).catch(async (error) => {
      await this.#logs.append("browser.webview_attach_timeout", {
        threadId,
        tabId: opened.tab.id,
        url: opened.tab.url,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return opened;
  }

  public async navigateBrowserTab(threadId: string, tabId: string, url: string) {
    const contents = this.#browserContents.get(this.browserContentsKey(threadId, tabId));
    if (contents && !contents.isDestroyed()) {
      await contents.loadURL(url);
      const page = await this.readVisibleBrowserPage(contents, false);
      const tab = await this.syncBrowserTabFromPage(threadId, tabId, page);
      await this.emit({ type: "browser.updated", threadId, payload: { action: "navigate", tab }, createdAt: new Date().toISOString() });
      return { tab, page };
    }
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
    const contents = this.#browserContents.get(this.browserContentsKey(threadId, tabId));
    if (contents && !contents.isDestroyed()) {
      const loaded = this.waitForBrowserLoad(contents);
      contents.reload();
      await loaded;
      const page = await this.readVisibleBrowserPage(contents, false);
      const tab = await this.syncBrowserTabFromPage(threadId, tabId, page);
      await this.emit({ type: "browser.updated", threadId, payload: { action: "reload", tab }, createdAt: new Date().toISOString() });
      return { tab, page };
    }
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
    const contents = this.#browserContents.get(this.browserContentsKey(threadId, tabId));
    if (contents && !contents.isDestroyed()) {
      if (!contents.canGoBack()) throw new Error("Already at the oldest history entry.");
      const loaded = this.waitForBrowserLoad(contents);
      contents.goBack();
      await loaded;
      const page = await this.readVisibleBrowserPage(contents, false);
      const tab = await this.syncBrowserTabFromPage(threadId, tabId, page);
      await this.emit({ type: "browser.updated", threadId, payload: { action: "back", tab }, createdAt: new Date().toISOString() });
      return { tab, page };
    }
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
    const contents = this.#browserContents.get(this.browserContentsKey(threadId, tabId));
    if (contents && !contents.isDestroyed()) {
      if (!contents.canGoForward()) throw new Error("Already at the latest history entry.");
      const loaded = this.waitForBrowserLoad(contents);
      contents.goForward();
      await loaded;
      const page = await this.readVisibleBrowserPage(contents, false);
      const tab = await this.syncBrowserTabFromPage(threadId, tabId, page);
      await this.emit({ type: "browser.updated", threadId, payload: { action: "forward", tab }, createdAt: new Date().toISOString() });
      return { tab, page };
    }
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

  public async closeBrowserTab(threadId: string, tabId: string) {
    this.releaseBrowserTabContents(threadId, tabId);
    const tabs = this.#browser.closeTab(threadId, tabId);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { tabs },
      createdAt: new Date().toISOString()
    });
    return tabs;
  }

  public async closeBrowserTabs(threadId: string, tabIds: string[]): Promise<void> {
    const existingIds = new Set(this.#browser.listTabs(threadId).map((tab) => tab.id));
    const closedTabIds: string[] = [];
    for (const tabId of new Set(tabIds)) {
      if (!existingIds.has(tabId)) continue;
      this.releaseBrowserTabContents(threadId, tabId);
      this.#browser.closeTab(threadId, tabId);
      existingIds.delete(tabId);
      closedTabIds.push(tabId);
    }
    if (closedTabIds.length === 0) return;

    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "task-cleanup", closedTabIds, tabs: this.#browser.listTabs(threadId) },
      createdAt: new Date().toISOString()
    });
  }

  public async readBrowserPageText(threadId: string, tabId: string) {
    const contents = this.#browserContents.get(this.browserContentsKey(threadId, tabId));
    if (contents && !contents.isDestroyed()) {
      const page = await this.readVisibleBrowserPage(contents, false);
      const tab = await this.syncBrowserTabFromPage(threadId, tabId, page);
      return { tab, text: page.text, title: page.title, url: page.url };
    }
    return this.#browser.readPageText(threadId, tabId);
  }

  public registerBrowserWebContents(threadId: string, tabId: string, webContentsId: number): void {
    if (!this.#db.listBrowserTabs(threadId).some((tab) => tab.id === tabId)) {
      throw new Error("Browser tab does not belong to this thread.");
    }
    const contents = webContents.fromId(webContentsId);
    if (!contents || contents.isDestroyed() || !isBrowserAutomationGuest(contents)) {
      const type = contents && !contents.isDestroyed() ? contents.getType() : "missing";
      throw new Error(`Browser page is not available for automation (type=${type}, id=${webContentsId}).`);
    }
    const key = this.browserContentsKey(threadId, tabId);
    const previous = this.#browserContents.get(key);
    if (previous === contents) return;
    this.#browserContents.set(key, contents);
    this.#browserConsoleErrors.set(key, []);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("console-message", (...args: unknown[]) => {
      const details = typeof args[1] === "object" && args[1] !== null
        ? args[1] as { level?: string; message?: string; sourceId?: string; lineNumber?: number }
        : null;
      const numericLevel = typeof args[1] === "number" ? args[1] : 0;
      const level = details?.level ?? (numericLevel >= 3 ? "error" : "info");
      if (level !== "error") return;
      const errors = this.#browserConsoleErrors.get(key) ?? [];
      errors.push({
        message: details?.message ?? String(args[2] ?? "Unknown console error"),
        sourceId: details?.sourceId ?? (typeof args[4] === "string" ? args[4] : undefined),
        line: details?.lineNumber ?? (typeof args[3] === "number" ? args[3] : undefined)
      });
      this.#browserConsoleErrors.set(key, errors.slice(-100));
    });
    contents.on("did-start-navigation", () => this.#browserConsoleErrors.set(key, []));
    contents.once("destroyed", () => {
      if (this.#browserContents.get(key) === contents) {
        this.#browserContents.delete(key);
        this.#browserViewports.delete(key);
        this.#browserConsoleErrors.delete(key);
        this.#browserDebuggerOwned.delete(key);
      }
    });
    void this.#logs.append("browser.webview_registered", {
      threadId,
      tabId,
      webContentsId,
      type: contents.getType()
    });
  }

  public async setBrowserViewport(threadId: string, tabId: string, viewport: BrowserViewport | null) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const key = this.browserContentsKey(threadId, tabId);
    if (viewport === null) {
      if (contents.debugger.isAttached()) {
        await contents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      }
      this.#browserViewports.delete(key);
      if (this.#browserDebuggerOwned.delete(key) && contents.debugger.isAttached()) contents.debugger.detach();
      await this.emit({
        type: "browser.verification_completed",
        threadId,
        payload: { tabId, viewportRestored: true },
        createdAt: new Date().toISOString()
      });
      return { tabId, viewport: this.defaultBrowserViewport(contents), restored: true };
    }

    const normalized = normalizeBrowserViewport(viewport);
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
      this.#browserDebuggerOwned.add(key);
    }
    await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: normalized.width,
      height: normalized.height,
      deviceScaleFactor: normalized.deviceScaleFactor ?? 1,
      mobile: normalized.mobile ?? normalized.width <= 500
    });
    this.#browserViewports.set(key, normalized);
    return { tabId, viewport: normalized, restored: false };
  }

  public async assertBrowserPage(threadId: string, tabId: string, checks: BrowserAssertionCheck[]) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const key = this.browserContentsKey(threadId, tabId);
    const safeChecks = normalizeBrowserAssertionChecks(checks);
    const pageResults = await contents.executeJavaScript(`
      (() => {
        const checks = ${JSON.stringify(safeChecks)};
        const matchValue = (actual, expected, mode = 'includes') => {
          if (mode === 'equals') return actual === expected;
          if (mode === 'regex') {
            try { return new RegExp(expected).test(actual); } catch { return false; }
          }
          return actual.includes(expected);
        };
        const visible = (element) => {
          if (!element) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        return checks.filter((check) => check.type !== 'no_severe_console_errors').map((check) => {
          try {
            if (check.type === 'url' || check.type === 'title' || check.type === 'text') {
              const actual = check.type === 'url' ? location.href : check.type === 'title' ? document.title : (document.body?.innerText || '');
              const passed = matchValue(actual, check.value, check.match);
              return { check, passed, message: passed ? check.type + ' matched' : check.type + ' did not match', actual: actual.slice(0, 1000) };
            }
            if (check.type === 'element') {
              const element = document.querySelector(check.selector);
              const state = check.state || 'visible';
              const passed = state === 'exists' ? Boolean(element)
                : state === 'visible' ? visible(element)
                : state === 'enabled' ? Boolean(element && visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
                : Boolean(element && (element.checked || element.selected || element.getAttribute('aria-selected') === 'true'));
              return { check, passed, message: passed ? 'element ' + state : 'element is not ' + state, actual: element ? element.tagName.toLowerCase() : null };
            }
            if (check.type === 'images_loaded') {
              const images = [...document.images];
              const broken = images.filter((image) => !image.complete || image.naturalWidth <= 0).map((image) => image.currentSrc || image.src).slice(0, 20);
              return { check, passed: broken.length === 0, message: broken.length === 0 ? 'all images loaded' : broken.length + ' image(s) failed to load', actual: { total: images.length, broken } };
            }
            if (check.type === 'no_horizontal_overflow') {
              const actual = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
              const passed = actual.scrollWidth <= actual.clientWidth + 1;
              return { check, passed, message: passed ? 'no horizontal overflow' : 'page has horizontal overflow', actual };
            }
            if (check.type === 'canvas_nonblank') {
              const canvases = check.selector ? [...document.querySelectorAll(check.selector)] : [...document.querySelectorAll('canvas')];
              let opaquePixels = 0;
              const colors = new Set();
              for (const canvas of canvases) {
                const context = canvas.getContext('2d', { willReadFrequently: true });
                if (canvas.width <= 0 || canvas.height <= 0) continue;
                const sampleWidth = Math.min(canvas.width, 256);
                const sampleHeight = Math.min(canvas.height, 256);
                let data;
                if (context) {
                  data = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
                } else {
                  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
                  if (!gl) continue;
                  data = new Uint8Array(sampleWidth * sampleHeight * 4);
                  gl.readPixels(0, 0, sampleWidth, sampleHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
                }
                const step = Math.max(4, Math.floor(data.length / (16000 * 4)) * 4);
                for (let index = 0; index < data.length; index += step) {
                  if (data[index + 3] > 8) opaquePixels += 1;
                  colors.add(data[index] + ',' + data[index + 1] + ',' + data[index + 2] + ',' + data[index + 3]);
                }
              }
              const passed = canvases.length > 0 && opaquePixels >= (check.minOpaquePixels || 24) && colors.size >= (check.minColors || 2);
              return { check, passed, message: passed ? 'canvas contains rendered pixels' : 'canvas is blank, transparent, or unavailable', actual: { canvases: canvases.length, opaquePixels, colors: colors.size } };
            }
            return { check, passed: false, message: 'unsupported assertion check' };
          } catch (error) {
            return { check, passed: false, message: error instanceof Error ? error.message : String(error) };
          }
        });
      })()
    `, true) as BrowserAssertionResult[];
    const results = [...pageResults];
    for (const check of safeChecks.filter((item) => item.type === "no_severe_console_errors")) {
      const errors = this.#browserConsoleErrors.get(key) ?? [];
      results.push({
        check,
        passed: errors.length === 0,
        message: errors.length === 0 ? "no severe console errors" : `${errors.length} severe console error(s)`,
        actual: errors
      });
    }
    const title = contents.getTitle() || contents.getURL();
    const url = contents.getURL();
    return {
      title,
      url,
      viewport: this.#browserViewports.get(key) ?? this.defaultBrowserViewport(contents),
      passed: results.length > 0 && results.every((result) => result.passed),
      results
    };
  }

  public async syncBrowserWebContents(input: { threadId: string; tabId: string }): Promise<BrowserTabRecord> {
    const contents = await this.requireBrowserContents(input.threadId, input.tabId);
    const page = await this.readVisibleBrowserPage(contents, false);
    const existing = this.#browser.listTabs(input.threadId).find((tab) => tab.id === input.tabId);
    if (isBrowserErrorPageUrl(page.url) && existing) {
      return existing;
    }
    if (existing && existing.url === page.url && existing.title === page.title) {
      return existing;
    }
    const tab = this.#browser.syncTab(input.threadId, input.tabId, page);
    this.persistBrowserTabs(input.threadId);
    await this.emit({
      type: "browser.updated",
      threadId: input.threadId,
      payload: { action: "sync", tab },
      createdAt: new Date().toISOString()
    });
    return tab;
  }

  public async inspectBrowserPage(threadId: string, tabId: string) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const inspection = await contents.executeJavaScript(`
      (() => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const label = (element) => {
          const labelledBy = element.getAttribute('aria-labelledby');
          const labelled = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') : '';
          return (element.getAttribute('aria-label') || labelled || element.innerText || element.value || element.getAttribute('placeholder') || element.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 180);
        };
        let index = 0;
        const elements = [...document.querySelectorAll('a[href], button, input, textarea, select, [contenteditable="true"], [role="button"], [role="link"], [role="textbox"]')]
          .filter(visible)
          .slice(0, 120)
          .map((element) => {
            const id = 'xh-' + (++index);
            element.setAttribute('data-codexh-agent-id', id);
            return {
              id,
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute('role') || element.getAttribute('type') || element.tagName.toLowerCase(),
              name: label(element),
              disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
            };
          });
        return {
          title: document.title || location.href,
          url: location.href,
          text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000),
          elements
        };
      })()
    `, true) as {
      title: string;
      url: string;
      text: string;
      elements: Array<{ id: string; tag: string; role: string; name: string; disabled: boolean }>;
    };
    await this.syncBrowserTabFromPage(threadId, tabId, inspection);
    return inspection;
  }

  public async inspectBrowserTarget(threadId: string, tabId: string, elementId: string) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    return contents.executeJavaScript(`
      (() => {
        const element = document.querySelector('[data-codexh-agent-id="' + CSS.escape(${JSON.stringify(elementId)}) + '"]');
        if (!element) throw new Error('Element is no longer available. Inspect the page again.');
        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute('type') || '').toLowerCase();
        const href = element.getAttribute('href') || '';
        const form = element.closest('form');
        const requiresApproval = type === 'submit' || tag === 'form' || Boolean(form) || /^(mailto:|tel:|intent:)/i.test(href) || element.hasAttribute('download');
        const name = (element.getAttribute('aria-label') || element.innerText || element.value || href || tag).trim().slice(0, 180);
        return { name, requiresApproval, description: tag + (type ? '[' + type + ']' : '') + ': ' + name };
      })()
    `, true) as Promise<{ name: string; requiresApproval: boolean; description: string }>;
  }

  public async clickBrowserElement(threadId: string, tabId: string, elementId: string) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const result = await contents.executeJavaScript(`
      (() => {
        const element = document.querySelector('[data-codexh-agent-id="' + CSS.escape(${JSON.stringify(elementId)}) + '"]');
        if (!element) throw new Error('Element is no longer available. Inspect the page again.');
        element.scrollIntoView({ block: 'center', inline: 'center' });
        element.click();
        return { title: document.title || location.href, url: location.href };
      })()
    `, true) as { title: string; url: string };
    await this.syncBrowserTabFromPage(threadId, tabId, { ...result, text: "", html: "" });
    return result;
  }

  public async fillBrowserElement(threadId: string, tabId: string, elementId: string, value: string) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    return contents.executeJavaScript(`
      (() => {
        const element = document.querySelector('[data-codexh-agent-id="' + CSS.escape(${JSON.stringify(elementId)}) + '"]');
        if (!element) throw new Error('Element is no longer available. Inspect the page again.');
        if (element instanceof HTMLInputElement && element.type === 'file') throw new Error('File upload requires user action.');
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
          setter ? setter.call(element, ${JSON.stringify(value)}) : element.value = ${JSON.stringify(value)};
        } else if (element.isContentEditable) {
          element.textContent = ${JSON.stringify(value)};
        } else {
          throw new Error('Target is not editable.');
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { title: document.title || location.href, url: location.href };
      })()
    `, true) as Promise<{ title: string; url: string }>;
  }

  public async selectBrowserOption(threadId: string, tabId: string, elementId: string, value: string) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    return contents.executeJavaScript(`
      (() => {
        const element = document.querySelector('[data-codexh-agent-id="' + CSS.escape(${JSON.stringify(elementId)}) + '"]');
        if (!(element instanceof HTMLSelectElement)) throw new Error('Target is not a select element.');
        const option = [...element.options].find((item) => item.value === ${JSON.stringify(value)} || item.text.trim() === ${JSON.stringify(value)});
        if (!option) throw new Error('Option was not found.');
        element.value = option.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { title: document.title || location.href, url: location.href };
      })()
    `, true) as Promise<{ title: string; url: string }>;
  }

  public async scrollBrowserPage(threadId: string, tabId: string, deltaY: number) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    return contents.executeJavaScript(`window.scrollBy({ top: ${Math.max(-4000, Math.min(4000, deltaY))}, behavior: 'instant' }); ({ title: document.title || location.href, url: location.href, scrollY: window.scrollY })`, true);
  }

  public async pressBrowserKey(threadId: string, tabId: string, key: string) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const keyCode = key.length === 1 ? key.toUpperCase() : key;
    contents.sendInputEvent({ type: "keyDown", keyCode });
    contents.sendInputEvent({ type: "keyUp", keyCode });
    return { title: contents.getTitle(), url: contents.getURL(), key };
  }

  public async waitForBrowserPage(threadId: string, tabId: string, input: { text?: string; elementId?: string; timeoutMs?: number }) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const timeoutMs = Math.max(250, Math.min(input.timeoutMs ?? 5_000, 15_000));
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const matched = await contents.executeJavaScript(`
        (() => {
          const elementId = ${JSON.stringify(input.elementId ?? "")};
          const text = ${JSON.stringify(input.text ?? "")};
          return (elementId && !!document.querySelector('[data-codexh-agent-id="' + CSS.escape(elementId) + '"]')) ||
            (text && (document.body?.innerText || '').includes(text));
        })()
      `, true) as boolean;
      if (matched) return { matched: true, waitedMs: Date.now() - startedAt };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("Timed out waiting for the requested page state.");
  }

  private browserContentsKey(threadId: string, tabId: string) {
    return `${threadId}:${tabId}`;
  }

  private releaseBrowserTabContents(threadId: string, tabId: string): void {
    const key = this.browserContentsKey(threadId, tabId);
    const contents = this.#browserContents.get(key);
    this.#browserContents.delete(key);
    this.#browserViewports.delete(key);
    this.#browserConsoleErrors.delete(key);
    this.#browserDebuggerOwned.delete(key);
    if (contents && !contents.isDestroyed()) contents.close();
  }

  private defaultBrowserViewport(contents: WebContents): BrowserViewport {
    const size = BrowserWindow.fromWebContents(contents)?.getContentBounds();
    return { width: Math.max(1, size?.width ?? 1440), height: Math.max(1, size?.height ?? 900), deviceScaleFactor: 1, mobile: false };
  }

  private async requireBrowserContents(threadId: string, tabId: string, timeoutMs = 20_000): Promise<WebContents> {
    const key = this.browserContentsKey(threadId, tabId);
    const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const contents = this.#browserContents.get(key);
      if (contents && !contents.isDestroyed()) return contents;
      // Ask the renderer to re-bind once mid-wait; UI may already show the page.
      if (attempt === Math.min(20, Math.floor(attempts / 3))) {
        this.emitBrowserReregisterRequest(threadId, tabId);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const tabExists = this.#db.listBrowserTabs(threadId).some((tab) => tab.id === tabId);
    const registeredForThread = [...this.#browserContents.keys()].filter((item) => item.startsWith(`${threadId}:`));
    await this.#logs.append("browser.webview_missing", {
      threadId,
      tabId,
      tabExists,
      registeredKeys: registeredForThread,
      timeoutMs
    });
    // Tab metadata already exists: the workspace is open, only automation binding failed.
    if (tabExists) {
      throw new Error(
        `Browser tab webview is not attached yet for tab ${tabId}. Wait for the page to finish loading and retry.`
      );
    }
    throw new Error("Browser tab is not ready. Open the Browser workspace and retry.");
  }

  private emitBrowserReregisterRequest(threadId: string, tabId: string): void {
    const window = BrowserWindow.getAllWindows().find((entry) => !entry.isDestroyed());
    window?.webContents.send("browser:request-reregister", { threadId, tabId });
  }

  private waitForBrowserLoad(contents: WebContents, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Browser page load timed out."));
      }, timeoutMs);
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onFailed = (_event: unknown, errorCode: number, errorDescription: string) => {
        if (errorCode === -3) return;
        cleanup();
        reject(new Error(`Browser page load failed: ${errorDescription}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        contents.removeListener("did-finish-load", onLoaded);
        contents.removeListener("did-fail-load", onFailed);
      };
      contents.once("did-finish-load", onLoaded);
      contents.once("did-fail-load", onFailed);
    });
  }

  private async readVisibleBrowserPage(contents: WebContents, includeHtml: boolean) {
    return contents.executeJavaScript(`
      ({
        title: document.title || location.href,
        url: location.href,
        text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim(),
        html: ${includeHtml ? "document.documentElement?.outerHTML || ''" : "''"}
      })
    `, true) as Promise<{ title: string; url: string; text: string; html: string }>;
  }

  private async syncBrowserTabFromPage(threadId: string, tabId: string, page: { title: string; url: string; text: string; html?: string }) {
    if (isBrowserErrorPageUrl(page.url)) {
      const existing = this.#browser.listTabs(threadId).find((tab) => tab.id === tabId);
      if (existing) return existing;
    }
    const tab = this.#browser.syncTab(threadId, tabId, { ...page, html: page.html ?? "" });
    this.persistBrowserTabs(threadId);
    return tab;
  }

  private removePersistedBrowserErrorTabs(threadId?: string): BrowserTabRecord[] {
    const threadIds = threadId ? [threadId] : this.#db.listThreads().map((thread) => thread.id);
    let requestedTabs: BrowserTabRecord[] = [];
    for (const id of threadIds) {
      const tabs = this.#db.listBrowserTabs(id);
      const filtered = tabs.filter((tab) => !isBrowserErrorPageUrl(tab.url));
      if (filtered.length !== tabs.length) {
        this.#db.replaceBrowserTabs(id, filtered);
      }
      if (id === threadId) {
        requestedTabs = filtered;
      }
    }
    return requestedTabs;
  }

  public async openFileLocation(threadId: string, filePath: string): Promise<string> {
    const thread = this.#db.getThread(threadId);
    const workspaceRoot = thread.cwd ?? await this.getThreadOutputDir(threadId);
    const resolvedRoot = path.resolve(workspaceRoot);
    const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(resolvedRoot, filePath);
    return shell.openPath(path.dirname(absolutePath));
  }

  public async captureBrowserSnapshot(threadId: string, tabId: string, turnRunId: string) {
    const outputDir = await this.getThreadOutputDir(threadId);
    const contents = this.#browserContents.get(this.browserContentsKey(threadId, tabId));
    if (contents && !contents.isDestroyed()) {
      const page = await this.readVisibleBrowserPage(contents, true);
      await this.syncBrowserTabFromPage(threadId, tabId, page);
    }
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

  public async captureBrowserScreenshot(threadId: string, tabId: string, turnRunId: string, fullPage = false) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const key = this.browserContentsKey(threadId, tabId);
    const outputDir = await this.getThreadOutputDir(threadId);
    const browserDir = path.join(outputDir, "browser");
    await fs.mkdir(browserDir, { recursive: true });
    const title = contents.getTitle() || "browser-page";
    const fileName = `${title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page"}-${Date.now()}.png`;
    const filePath = path.join(browserDir, fileName);
    let png: Buffer;
    if (fullPage) {
      let attachedHere = false;
      if (!contents.debugger.isAttached()) {
        contents.debugger.attach("1.3");
        attachedHere = true;
      }
      try {
        const metrics = await contents.debugger.sendCommand("Page.getLayoutMetrics") as { cssContentSize?: { width: number; height: number } };
        const contentSize = metrics.cssContentSize ?? { width: 1440, height: 900 };
        const captured = await contents.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          fromSurface: true,
          clip: {
            x: 0,
            y: 0,
            width: Math.min(16384, Math.max(1, contentSize.width)),
            height: Math.min(16384, Math.max(1, contentSize.height)),
            scale: 1
          }
        }) as { data: string };
        png = Buffer.from(captured.data, "base64");
      } finally {
        if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
      }
    } else {
      png = (await contents.capturePage()).toPNG();
    }
    await fs.writeFile(filePath, png);
    const stats = await fs.stat(filePath);
    const artifact = this.#db.addArtifact({
      threadId,
      turnRunId,
      messageId: null,
      toolCallId: null,
      artifactKind: "browser-screenshot",
      displayName: fileName,
      absolutePath: filePath,
      relativePath: path.relative(outputDir, filePath),
      mimeType: "image/png",
      sizeBytes: stats.size,
      sha256: await fileSha256(filePath),
      sourceKind: "browser",
      isUserVisible: true,
      status: "ready"
    });
    const dimensions = readPngDimensions(png);
    const capturedAt = new Date().toISOString();
    const attachment: MessageAttachment = {
      id: randomUUID(),
      kind: "image",
      name: fileName,
      mimeType: "image/png",
      absolutePath: filePath,
      sizeBytes: stats.size,
      width: dimensions.width,
      height: dimensions.height,
      source: "generated"
    };
    return {
      title,
      url: contents.getURL(),
      filePath,
      width: dimensions.width,
      height: dimensions.height,
      viewport: this.#browserViewports.get(key) ?? this.defaultBrowserViewport(contents),
      fullPage,
      capturedAt,
      attachment,
      artifact
    };
  }

  public async importKnowledge(input: {
    displayName: string;
    scope: "global" | "project" | "imported";
    sourcePaths?: string[];
    sources?: KnowledgeImportSource[];
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

    const sources = normalizeKnowledgeImportSources(input.sources, input.sourcePaths);
    if (sources.length === 0) throw new Error("Please add at least one local document or URL.");

    const knowledgeBase = this.#db.createKnowledgeBase({
      scope: input.scope,
      projectId,
      displayName: input.displayName,
      bundleRoot,
      okfVersion: "0.1",
      status: "importing"
    });
    try {
      // Keep the original sources so refresh can re-fetch URLs and discover local folder changes.
      const importRunId = this.#db.createKnowledgeImportRun(knowledgeBase.id, sources);
      const documents = await this.extractKnowledgeSourceDocuments(sources);
      const displayName = resolveKnowledgeImportDisplayName(input.displayName, sources, documents);
      if (displayName !== knowledgeBase.displayName) {
        this.#db.updateKnowledgeBase(knowledgeBase.id, { displayName });
      }
      const built = await buildOkfBundle({
        bundleRoot: knowledgeBase.bundleRoot,
        knowledgeBaseId: knowledgeBase.id,
        importRunId,
        documents
      });

      for (const concept of built.concepts) this.#db.insertKnowledgeConcept(concept);
      for (const document of documents) this.storeKnowledgeDocument(knowledgeBase.id, document);
      this.#db.updateKnowledgeBase(knowledgeBase.id, { status: "ready" });

      if (thread) this.bindKnowledgeBaseToThread(thread.id, knowledgeBase.id);

      const indexStats = await fs.stat(built.indexPath);
      this.#db.addArtifact({
        threadId: input.threadId ?? "knowledge",
        turnRunId: null,
        messageId: null,
        toolCallId: null,
        artifactKind: "knowledge-index",
        displayName: `${displayName} index.md`,
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
        payload: { knowledgeBaseId: knowledgeBase.id, conceptCount: built.concepts.length },
        createdAt: new Date().toISOString()
      });
      return { knowledgeBaseId: knowledgeBase.id, conceptCount: built.concepts.length, bundleRoot: built.bundleRoot };
    } catch (error) {
      this.#db.updateKnowledgeBase(knowledgeBase.id, { status: "failed" });
      throw error;
    }
  }

  public listKnowledgeBaseSummaries(): KnowledgeBaseSummary[] {
    const threads = this.#db.listThreads();
    return this.#db.listKnowledgeBaseSummaries().map((knowledgeBase) => {
      if (knowledgeBase.scope === "global") {
        return { ...knowledgeBase, scopeTargetLabel: "所有聊天" };
      }
      if (knowledgeBase.scope === "project") {
        const projectThread = threads.find((thread) => thread.projectId === knowledgeBase.projectId);
        return {
          ...knowledgeBase,
          scopeTargetLabel: projectThread?.cwd ? `项目：${projectThread.cwd}` : "原项目已删除"
        };
      }
      const owners = threads.filter((thread) => thread.knowledgeBaseIds.includes(knowledgeBase.id));
      return {
        ...knowledgeBase,
        scopeTargetLabel: owners.length > 0
          ? `对话：${owners.slice(0, 2).map((thread) => thread.title).join("、")}${owners.length > 2 ? ` 等 ${owners.length} 个` : ""}`
          : "原对话已删除"
      };
    });
  }

  public listQuickNotes(): QuickNoteRecord[] {
    return this.#db.listQuickNotes();
  }

  public saveQuickNote(input: { id?: string; title?: string; content: string }): QuickNoteRecord {
    const content = input.content.trim();
    if (!content) throw new Error("笔记内容不能为空。");
    const existing = input.id ? this.#db.getQuickNote(input.id) : null;
    const title = input.title?.trim() || existing?.title || buildThreadTitleFromFirstMessage(content);
    const knowledgeBase = existing ? this.#db.getKnowledgeBase(existing.knowledgeBaseId) : this.#db.findKnowledgeBase("global", "随手记");
    const base = knowledgeBase ?? this.#db.createKnowledgeBase({
      scope: "global",
      projectId: null,
      displayName: "随手记",
      bundleRoot: path.join(this.#layout.globalBundlesDir, "quick-notes"),
      okfVersion: "0.1",
      status: "ready"
    });
    const id = existing?.id ?? input.id ?? randomUUID();
    const sourcePath = existing?.knowledgeSourcePath ?? `quick-notes/${id}.md`;
    this.storeKnowledgeDocument(base.id, {
      title,
      body: content,
      sourcePath,
      sourceHash: createHash("sha256").update(`${title}\n${content}`).digest("hex"),
      mimeHint: "text/markdown"
    });
    const note = this.#db.upsertQuickNote({ id, title, content, knowledgeBaseId: base.id, knowledgeSourcePath: sourcePath });
    this.#db.updateKnowledgeBase(base.id, { status: "ready" });
    return note;
  }

  public deleteQuickNote(id: string): void {
    const note = this.#db.getQuickNote(id);
    if (!note) return;
    this.#db.deleteKnowledgeDocumentBySourcePath(note.knowledgeBaseId, note.knowledgeSourcePath);
    this.#db.deleteQuickNote(id);
    this.#db.updateKnowledgeBase(note.knowledgeBaseId, { status: "ready" });
  }

  public async createQuickNoteWithAi(prompt: string, context: string): Promise<string> {
    const provider = this.#config.providers.find((item) => item.id === this.#config.defaultProvider);
    const model = this.#config.models.find((item) => item.providerId === this.#config.defaultProvider && item.id === this.#config.defaultModel);
    if (!provider || !model) throw new Error("请先在设置中配置默认文本模型。");
    const decision = await this.#providerFactory.create(provider).runTurn({
      systemPrompt: "你是笔记写作助手。仅返回可直接插入 Markdown 笔记的正文，不要解释。",
      transcript: [{ role: "user", content: `创作要求：${prompt}\n\n当前笔记：\n${context.slice(0, 12_000)}` }],
      availableTools: [], model, provider
    });
    if (!decision.assistantMessage?.trim()) throw new Error("模型没有返回可插入内容。");
    return decision.assistantMessage.trim();
  }

  public listKnowledgeBaseDocuments(knowledgeBaseId: string): KnowledgeDocumentRecord[] {
    return this.#db.listKnowledgeDocuments(knowledgeBaseId);
  }

  public async refreshKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBaseSummary> {
    const knowledgeBase = this.#db.getKnowledgeBase(knowledgeBaseId);
    if (!knowledgeBase) throw new Error("Knowledge base not found.");
    this.#db.updateKnowledgeBase(knowledgeBaseId, { status: "importing" });
    try {
      const selectedSources = this.#db.listLatestKnowledgeImportSources(knowledgeBaseId);
      const documents = await this.extractKnowledgeSourceDocuments(selectedSources, { allowEmptyLocal: true });
      const currentPaths = new Set(documents.map((document) => document.sourcePath));
      const existing = new Map(this.#db.listKnowledgeDocuments(knowledgeBaseId).map((document) => [document.sourcePath, document]));
      for (const document of existing.values()) {
        if (!currentPaths.has(document.sourcePath)) this.#db.markKnowledgeDocumentMissing(document.id);
      }
      for (const document of documents) {
        const previous = existing.get(document.sourcePath);
        if (!previous || previous.sourceHash !== document.sourceHash || previous.status !== "ready") {
          this.storeKnowledgeDocument(knowledgeBaseId, document);
        }
      }
      this.#db.updateKnowledgeBase(knowledgeBaseId, { status: "ready" });
    } catch (error) {
      this.#db.updateKnowledgeBase(knowledgeBaseId, { status: "failed" });
      throw error;
    }
    const summary = this.#db.listKnowledgeBaseSummaries().find((item) => item.id === knowledgeBaseId);
    if (!summary) throw new Error("Knowledge base disappeared during refresh.");
    return summary;
  }

  public async deleteKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    const knowledgeBase = this.#db.getKnowledgeBase(knowledgeBaseId);
    if (!knowledgeBase) return;
    await fs.rm(knowledgeBase.bundleRoot, { recursive: true, force: true });
    this.#db.deleteKnowledgeBase(knowledgeBaseId);
  }

  public listErrorSolutions(input: { limit?: number; modelId?: string | null } = {}): ErrorSolutionRecord[] {
    return this.#db.listErrorSolutions(input);
  }

  public deleteErrorSolution(id: string): void {
    this.#db.deleteErrorSolution(id);
  }

  public clearErrorSolutions(modelId?: string | null): number {
    return this.#db.clearErrorSolutions(modelId);
  }

  private async extractKnowledgeSourceDocuments(
    sources: KnowledgeImportSource[],
    options: { allowEmptyLocal?: boolean } = {}
  ): Promise<ExtractedDocument[]> {
    const documents: ExtractedDocument[] = [];
    for (const source of sources) {
      if (source.kind === "file" || source.kind === "folder") {
        const paths = await expandKnowledgeSources([source.path], { allowEmpty: options.allowEmptyLocal });
        for (const sourcePath of paths) documents.push(await extractDocument(sourcePath));
        continue;
      }
      if (source.kind === "url") {
        documents.push(await this.extractRemoteKnowledgeDocument(source.url));
        continue;
      }
      documents.push(await this.extractBrowserKnowledgeDocument(source));
    }
    if (documents.length === 0) throw new Error("No readable knowledge documents were found.");
    return documents;
  }

  private async extractRemoteKnowledgeDocument(rawUrl: string): Promise<ExtractedDocument> {
    const url = normalizeKnowledgeUrl(rawUrl);
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: "text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,*/*;q=0.5" }
    });
    if (!response.ok) throw new Error(`Unable to fetch ${url} (${response.status}).`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 20 * 1024 * 1024) throw new Error("Remote document exceeds the 20 MB import limit.");
    const finalUrl = response.url || url;
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || /\.(?:html?|aspx?|php)(?:$|[?#])/i.test(finalUrl)) {
      await response.body?.cancel();
      const page = await this.loadBrowserPage(finalUrl);
      const body = extractHtmlReadableText(page.html) || page.text.trim();
      if (!body) throw new Error("The page did not contain readable text. Sign in through the Browser workspace and import the current page instead.");
      if (body.length > 2_000_000) throw new Error("Rendered page text exceeds the 2 MB import limit.");
      return {
        title: page.title,
        body,
        sourcePath: page.url,
        sourceHash: createHash("sha256").update(body).digest("hex"),
        mimeHint: "text/html"
      };
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > 20 * 1024 * 1024) throw new Error("Remote document exceeds the 20 MB import limit.");
    const document = await extractDocumentBuffer(data, finalUrl, {
      mimeHint: contentType || undefined,
      extension: knowledgeExtensionForMimeType(contentType)
    });
    if (!document.body) throw new Error("The remote document did not contain readable text.");
    return document;
  }

  private async extractBrowserKnowledgeDocument(source: Extract<KnowledgeImportSource, { kind: "browser" }>): Promise<ExtractedDocument> {
    const contents = await this.requireBrowserContents(source.threadId, source.tabId).catch(() => {
      throw new Error("Open this source in the Browser workspace, sign in if needed, then retry the import.");
    });
    const page = await this.readVisibleBrowserPage(contents, true);
    const body = extractHtmlReadableText(page.html) || page.text.trim();
    if (!body) throw new Error("The current browser page did not contain readable text. Complete login and wait for the document to load.");
    if (body.length > 2_000_000) throw new Error("Rendered page text exceeds the 2 MB import limit.");
    return {
      title: page.title,
      body,
      sourcePath: page.url || source.url,
      sourceHash: createHash("sha256").update(body).digest("hex"),
      mimeHint: "text/html"
    };
  }

  private storeKnowledgeDocument(
    knowledgeBaseId: string,
    document: { title: string; body: string; sourcePath: string; sourceHash: string; mimeHint: string }
  ): void {
    const documentId = randomUUID();
    const now = new Date().toISOString();
    const chunks = splitKnowledgeDocument(document.body).map((content, chunkIndex) => ({
      id: randomUUID(),
      knowledgeBaseId,
      documentId,
      chunkIndex,
      title: document.title,
      content,
      sourcePath: document.sourcePath,
      locator: getChunkLocator(content, chunkIndex),
      createdAt: now
    } satisfies KnowledgeChunkRecord));
    this.#db.replaceKnowledgeDocument({
      id: documentId,
      knowledgeBaseId,
      sourcePath: document.sourcePath,
      sourceHash: document.sourceHash,
      title: document.title,
      mimeHint: document.mimeHint,
      status: "ready",
      updatedAt: now
    }, chunks);
  }

  public resolveApproval(
    id: string,
    resolution: {
      decision: "approved" | "denied";
      mode?: "once" | "session" | "remember";
      source?: "user" | "timeout";
    }
  ): void {
    const approval = this.#db.getApproval(id);
    if (!approval) {
      return;
    }

    const approved = resolution.decision === "approved";
    const resolutionMode = approved ? (resolution.mode ?? "once") : null;
    const source = resolution.source ?? "user";
    this.#clearApprovalTimeout(id);
    this.#db.resolveApproval(id, { approved, resolutionMode, resolutionSource: source });

    if (approved) {
      if (resolutionMode === "session") {
        this.#sessionApprovedThreadIds.add(approval.threadId);
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
        mode: resolutionMode,
        source
      },
      createdAt: new Date().toISOString()
    });

    this.#approvalResolvers.get(id)?.(approved);
    this.#approvalResolvers.delete(id);
  }

  public async answerUserPrompt(
    id: string,
    answers: Record<string, string>,
    source: "user" | "timeout" = "user"
  ): Promise<void> {
    const prompt = this.#db.getUserPrompt(id);
    const resolve = this.#promptResolvers.get(id);
    const thread = prompt ? this.#db.getThread(prompt.threadId) : null;
    if (!prompt || prompt.status !== "pending" || !resolve || !thread || thread.status !== "waiting") {
      throw new Error("此问题所属的任务已中断，请重新开始后再决定。");
    }

    this.#clearPromptTimeout(id);
    this.#db.resolveUserPrompt(id, answers, source);
    this.#db.finishTurn(prompt.turnRunId, { status: "running" });
    const updatedThread = this.#db.updateThread(prompt.threadId, { status: "running" });
    const answeredPrompt = this.#db.getUserPrompt(id);
    await this.emit({
      type: "user-input.resolved",
      threadId: prompt.threadId,
      payload: { prompt: answeredPrompt },
      createdAt: new Date().toISOString()
    });
    await this.emit({
      type: "thread.updated",
      threadId: prompt.threadId,
      payload: { thread: updatedThread },
      createdAt: new Date().toISOString()
    });
    resolve(answers);
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
    if (this.getGpaState(threadId).fullAccess) {
      return true;
    }
    const approvalKey = hashApprovalPayload({
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      payload: getApprovalScopePayload(input.payload)
    });
    if (this.#config.desktop.approvals === "auto" && input.riskLevel === "low") {
      return true;
    }

    // A session approval intentionally covers later operations in this chat,
    // including commands whose arguments differ from the first request.
    if (this.#sessionApprovedThreadIds.has(threadId)) {
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
      status: "pending",
      expiresAt: new Date(Date.now() + INTERACTION_TIMEOUT_MS).toISOString()
    });

    await this.emit({
      type: "approval.requested",
      threadId,
      payload: { approval: record },
      createdAt: new Date().toISOString()
    });

    const response = new Promise<boolean>((resolve) => {
      this.#approvalResolvers.set(record.id, resolve);
    });
    this.#scheduleApprovalTimeout(record.id);
    return response;
  }

  private async requestUserInput(
    threadId: string,
    turnRunId: string,
    input: {
      title: string;
      kind: "generic" | "gpa_plan_clarification";
      allowSkip: boolean;
      questions: UserInputQuestion[];
      timeoutMs?: number;
      defaultAnswers?: Record<string, string>;
    }
  ): Promise<Record<string, string>> {
    const defaultAnswers = input.defaultAnswers ??
      (input.kind === "generic" ? buildPromptDefaultAnswers(input.questions) : null);
    const timeoutMs = input.timeoutMs ?? (defaultAnswers ? INTERACTION_TIMEOUT_MS : undefined);
    const prompt = this.#db.createUserPrompt({
      threadId,
      turnRunId,
      title: input.title,
      kind: input.kind,
      allowSkip: input.allowSkip,
      questions: input.questions,
      status: "pending",
      expiresAt: timeoutMs ? new Date(Date.now() + timeoutMs).toISOString() : null,
      defaultAnswers
    });

    this.#db.finishTurn(turnRunId, { status: "waiting_user_input" });
    const waitingThread = this.#db.updateThread(threadId, { status: "waiting" });
    const response = new Promise<Record<string, string>>((resolve) => {
      this.#promptResolvers.set(prompt.id, resolve);
    });
    if (prompt.expiresAt && prompt.defaultAnswers) {
      this.#schedulePromptTimeout(prompt.id);
    }

    await this.emit({
      type: "user-input.requested",
      threadId,
      payload: { prompt },
      createdAt: new Date().toISOString()
    });
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: waitingThread },
      createdAt: new Date().toISOString()
    });

    return response;
  }

  #scheduleApprovalTimeout(id: string): void {
    this.#clearApprovalTimeout(id);
    const approval = this.#db.getApproval(id);
    if (!approval?.expiresAt || approval.status !== "pending") return;
    const delay = Math.max(0, Date.parse(approval.expiresAt) - Date.now());
    this.#approvalTimeouts.set(id, setTimeout(() => {
      void this.resolveApproval(id, { decision: "denied", source: "timeout" });
    }, delay));
  }

  #clearApprovalTimeout(id: string): void {
    const timer = this.#approvalTimeouts.get(id);
    if (timer) clearTimeout(timer);
    this.#approvalTimeouts.delete(id);
  }

  #schedulePromptTimeout(id: string): void {
    this.#clearPromptTimeout(id);
    const prompt = this.#db.getUserPrompt(id);
    if (!prompt?.expiresAt || !prompt.defaultAnswers || prompt.status !== "pending") return;
    const delay = Math.max(0, Date.parse(prompt.expiresAt) - Date.now());
    this.#promptTimeouts.set(id, setTimeout(() => {
      void this.answerUserPrompt(id, prompt.defaultAnswers ?? {}, "timeout").catch(() => undefined);
    }, delay));
  }

  #clearPromptTimeout(id: string): void {
    const timer = this.#promptTimeouts.get(id);
    if (timer) clearTimeout(timer);
    this.#promptTimeouts.delete(id);
  }

  private async spawnChildAgent(
    parentThreadId: string,
    input: { prompt: string; role: string; modelId?: string; systemOverride?: boolean }
  ): Promise<{ threadId: string; agentPath: string; status: ThreadRecord["status"] }> {
    const parent = this.#db.getThread(parentThreadId);
    if (parent.multiAgentMode === "disabled" && !input.systemOverride) {
      throw new Error("Multi-agent delegation is disabled for this task.");
    }
    const tree = this.#db.listAgentTree(parent.rootThreadId);
    const root = this.#db.getThread(parent.rootThreadId);
    const delegatedForCurrentRequest = this.getCurrentRequestSubagents(root, tree);
    const depth = Math.max(0, parent.agentPath.split("/").filter(Boolean).length - 1);
    if (depth >= this.#config.multiAgent.maxDepth) {
      throw new Error(`Maximum child-agent depth (${this.#config.multiAgent.maxDepth}) reached.`);
    }
    if (delegatedForCurrentRequest.length >= this.#config.multiAgent.maxSubagentsPerRoot) {
      throw new Error(`Maximum child-agent count (${this.#config.multiAgent.maxSubagentsPerRoot}) reached for this user request.`);
    }
    const duplicate = delegatedForCurrentRequest.find((item) => isOverlappingSubagentAssignment(input, item));
    if (duplicate) {
      throw new Error(
        `An overlapping child-agent task already exists for this user request (${duplicate.agentPath}). ` +
        "Use multi_agents.wait or multi_agents.followup_task instead of spawning a duplicate."
      );
    }

    const activeCount = tree.filter((item) =>
      item.id !== parent.rootThreadId && this.isSubagentActive(item)
    ).length;
    if (activeCount >= this.#config.multiAgent.maxConcurrentSubagents) {
      throw new Error(`All ${this.#config.multiAgent.maxConcurrentSubagents} child-agent slots are busy. Wait for a child to finish first.`);
    }

    await this.refreshSkills(parent.cwd);
    const role = normalizeAgentSegment(input.role);
    const siblingPaths = new Set(this.#db.listChildThreads(parent.id).map((item) => item.agentPath));
    let suffix = 1;
    let agentPath = `${parent.agentPath}/${role}`;
    while (siblingPaths.has(agentPath)) {
      suffix += 1;
      agentPath = `${parent.agentPath}/${role}-${suffix}`;
    }
    const thread = this.#db.createThread({
      title: `${input.role}: ${input.prompt.slice(0, 40)}`,
      mode: parent.mode,
      workspaceKind: parent.workspaceKind,
      cwd: parent.cwd,
      modelId: input.modelId ?? parent.modelId,
      providerId: parent.providerId,
      parentThreadId: parent.id,
      rootThreadId: parent.rootThreadId,
      agentPath,
      agentRole: input.role,
      lastTaskMessage: input.prompt,
      multiAgentMode: parent.multiAgentMode,
      status: "running"
    });
    this.#db.updateThread(thread.id, {
      selectedSkillIds: parent.selectedSkillIds,
      selectedPluginIds: parent.selectedPluginIds,
      knowledgeBaseIds: parent.knowledgeBaseIds
    });
    await this.sendMessage(thread.id, buildChildAgentPrompt(parent, thread, input.prompt));
    await this.emitAgentTreeUpdated(parent.rootThreadId);
    return { threadId: thread.id, agentPath: thread.agentPath, status: "running" };
  }

  private resolveAgent(parentThreadId: string, agent: string): ThreadRecord {
    const parent = this.#db.getThread(parentThreadId);
    const tree = this.#db.listAgentTree(parent.rootThreadId);
    const normalized = agent.trim();
    const result = tree.find((item) => item.id === normalized || item.agentPath === normalized);
    if (!result || result.id === parentThreadId || !result.agentPath.startsWith(`${parent.agentPath}/`)) {
      throw new Error(`Unknown child agent: ${agent}`);
    }
    return result;
  }

  private buildSubagentEnvelope(thread: ThreadRecord): SubagentResultEnvelope {
    const messages = this.#db.listMessages(thread.id);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const summary = lastAssistant?.content?.trim() || thread.lastTaskMessage || "No final result was returned.";
    const latestTurn = this.#db.getLatestTurnRun(thread.id);
    const hasQueuedMessage = this.#db.listQueuedMessages(thread.id)
      .some((message) => message.status === "queued" || message.status === "dispatching");
    const status = thread.status === "running" || thread.status === "waiting"
      ? thread.status
      : hasQueuedMessage
        ? "queued"
        : latestTurn?.status === "interrupted"
        ? "interrupted"
        : thread.status === "idle"
          ? "queued"
          : thread.status;
    const errors = [
      ...(latestTurn?.errorMessage ? [latestTurn.errorMessage] : []),
      ...(thread.status === "failed" && !latestTurn?.errorMessage ? [summary] : [])
    ];
    return {
      status: status as SubagentResultEnvelope["status"],
      summary,
      evidence: messages.filter((message) => message.role === "tool").slice(-8).map((message) => message.content.slice(0, 500)),
      errors,
      agentPath: thread.agentPath,
      threadId: thread.id
    };
  }

  private async sendAgentMessage(parentThreadId: string, input: { agent: string; message: string }): Promise<SubagentResultEnvelope> {
    const child = this.resolveAgent(parentThreadId, input.agent);
    await this.sendMessage(child.id, input.message, [], undefined, false);
    await this.emitAgentTreeUpdated(child.rootThreadId);
    return this.buildSubagentEnvelope(child);
  }

  private async followupAgentTask(parentThreadId: string, input: { agent: string; prompt: string }): Promise<SubagentResultEnvelope> {
    const child = this.resolveAgent(parentThreadId, input.agent);
    await this.sendMessage(child.id, input.prompt);
    return { ...this.buildSubagentEnvelope(this.#db.getThread(child.id)), status: "running" };
  }

  public async listSubagents(parentThreadId: string): Promise<ThreadRecord[]> {
    const parent = this.#db.getThread(parentThreadId);
    return this.getCurrentRequestSubagents(parent);
  }

  private async hasActiveSubagents(parentThreadId: string): Promise<boolean> {
    return (await this.listSubagents(parentThreadId)).some((item) => this.isSubagentActive(item));
  }

  private async waitForSubagents(
    parentThreadId: string,
    input: { agents?: string[]; timeoutMs?: number; abortSignal?: AbortSignal }
  ): Promise<SubagentWaitResult> {
    const parent = this.#db.getThread(parentThreadId);
    const timeoutMs = Math.min(30_000, Math.max(250, Math.round(input.timeoutMs ?? 30_000)));
    const targetIds = input.agents?.length
      ? input.agents.map((agent) => this.resolveAgent(parentThreadId, agent).id)
      : (await this.listSubagents(parentThreadId)).map((item) => item.id);
    if (targetIds.length === 0) return { agents: [], timedOut: false };
    const getTargets = () => targetIds.map((id) => this.#db.getThread(id));
    const allFinished = (agents: ThreadRecord[]) => agents.every((agent) => !this.isSubagentActive(agent));
    const initial = getTargets();
    if (allFinished(initial)) return { agents: initial.map((item) => this.buildSubagentEnvelope(item)), timedOut: false };

    return new Promise<SubagentWaitResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish({ agents: [], timedOut: false });
      const finish = (value: SubagentWaitResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        if (timeout) clearTimeout(timeout);
        input.abortSignal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const poll = () => {
        const agents = getTargets();
        if (allFinished(agents)) finish({ agents: agents.map((item) => this.buildSubagentEnvelope(item)), timedOut: false });
      };
      timer = setInterval(poll, 250);
      timeout = setTimeout(() => {
        const agents = getTargets();
        finish({ agents: agents.map((item) => this.buildSubagentEnvelope(item)), timedOut: true });
      }, timeoutMs);
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private isSubagentActive(thread: ThreadRecord): boolean {
    return thread.status === "running"
      || thread.status === "waiting"
      || this.#db.listQueuedMessages(thread.id).some((message) => message.status === "queued" || message.status === "dispatching");
  }

  private getCurrentRequestSubagents(parent: ThreadRecord, tree = this.#db.listAgentTree(parent.rootThreadId)): ThreadRecord[] {
    const latestRootUserMessage = this.#db.getLatestMessage(parent.rootThreadId, "user");
    const requestStartedAt = latestRootUserMessage ? Date.parse(latestRootUserMessage.createdAt) : Number.NEGATIVE_INFINITY;

    return tree.filter((item) =>
      item.id !== parent.id
      && item.agentPath.startsWith(`${parent.agentPath}/`)
      && Date.parse(item.createdAt) >= requestStartedAt
    );
  }

  public async interruptAgent(parentThreadId: string, agent: string): Promise<SubagentResultEnvelope> {
    const child = this.resolveAgent(parentThreadId, agent);
    await this.interruptThread(child.id);
    return this.buildSubagentEnvelope(this.#db.getThread(child.id));
  }

  private async emitAgentTreeUpdated(rootThreadId: string): Promise<void> {
    const root = this.#db.getThread(rootThreadId);
    await this.emit({
      type: "thread.updated",
      threadId: root.id,
      payload: { thread: root },
      createdAt: new Date().toISOString()
    });
  }

  private async buildKnowledgeContext(threadId: string): Promise<string | null> {
    const bundles = this.listVisibleKnowledgeBases(threadId).map(
      (item) => `- ${item.displayName} (${item.scope})`
    );
    if (bundles.length === 0) {
      return null;
    }
    return [
      "Available local knowledge bases:",
      ...bundles,
      "Use knowledge.search to retrieve their contents. Bundle paths are intentionally not exposed as workspace files."
    ].join("\n");
  }

  private async buildWorkflowPackContext(threadId: string): Promise<string | null> {
    const thread = this.#db.getThread(threadId);
    const enabledPluginIds = new Set(await this.getEnabledPluginIdsForThread(threadId));
    const enabledPlugins = this.#db.listPlugins().filter((plugin) => enabledPluginIds.has(plugin.id));
    if (enabledPlugins.length === 0) {
      return null;
    }

    const blocks: string[] = ["Active workflow packs:"];
    for (const plugin of enabledPlugins) {
      const startup = await this.#plugins.collectStartupContext(plugin);
      const sessionStartHooks =
        startup.manifest?.hooks.filter((hook) => hook.eventName.toLowerCase() === "sessionstart") ?? [];
      const hookName = sessionStartHooks.length > 0 ? "SessionStart" : "startup_context";
      const hookMessage = startup.content
        ? `Loaded ${startup.source} startup context.`
        : sessionStartHooks.length > 0
          ? "Plugin declares SessionStart hooks but no native startup context was produced."
          : "Plugin has no startup context.";
      this.#db.recordPluginHookRun(
        thread.projectId ?? thread.id,
        plugin.id,
        hookName,
        startup.content ? "success" : "skipped",
        hookMessage
      );
      blocks.push(`## ${plugin.name}`);
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

  private async webSearch(threadId: string, query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const providers = [
      {
        name: "bing",
        url: `https://www.bing.com/search?count=8&setlang=zh-Hans&q=${encodeURIComponent(normalizedQuery)}`,
        selector: "li.b_algo h2 a"
      },
      {
        name: "360",
        url: `https://www.so.com/s?q=${encodeURIComponent(normalizedQuery)}`,
        selector: "h3.res-title a"
      },
      {
        name: "baidu",
        url: `https://www.baidu.com/s?rn=8&wd=${encodeURIComponent(normalizedQuery)}`,
        selector: "h3 a"
      }
    ];

    for (const provider of providers) {
      try {
        // A search is visible in the workspace as well as being parsed for the agent.
        const page = threadId
          ? (await this.openBrowserTab(threadId, provider.url)).page
          : await this.loadBrowserPage(provider.url);
        const $ = cheerio.load(page.html);
        const results = $(provider.selector)
          .toArray()
          .slice(0, 8)
          .map((element) => {
            const anchor = $(element);
            const href = anchor.attr("data-mdurl") ?? anchor.attr("href") ?? "";
            const container = anchor.closest(".result, .c-container, .b_algo, article, div");
            return {
              title: anchor.text().replace(/\s+/g, " ").trim(),
              url: resolveSearchResultUrl(page.url, href),
              snippet: container.text().replace(/\s+/g, " ").trim().slice(0, 600)
            };
          })
          .filter((item) => item.title && /^https?:\/\//i.test(item.url));
        const relevantResults = filterRelevantSearchResults(normalizedQuery, results);
        if (relevantResults.length > 0) {
          return relevantResults;
        }
        await this.#logs.append("web.search_provider_irrelevant", {
          provider: provider.name,
          query: normalizedQuery,
          pageUrl: page.url,
          resultCount: results.length
        });
      } catch (error) {
        await this.#logs.append("web.search_provider_failed", {
          provider: provider.name,
          query: normalizedQuery,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // A search outage is a valid result state, not an executable-tool failure.
    // This lets the agent complete with a clear limitation instead of retrying it.
    return [];
  }

  private async openPage(threadId: string, url: string): Promise<{ title: string; url: string; text: string }> {
    if (threadId) {
      const opened = await this.openBrowserTab(threadId, url);
      return opened.page;
    }

    const page = await this.loadBrowserPage(url);
    return { title: page.title, url: page.url, text: page.text };
  }

  private async loadBrowserPage(target: string): Promise<PageSnapshot> {
    if (!/^https?:\/\//i.test(target)) {
      return loadPage(target);
    }

    let extractor: BrowserWindow | null = null;
    try {
      extractor = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      await extractor.loadURL(target);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const rendered = await extractor.webContents.executeJavaScript(`
        (() => {
          const ignored = document.querySelectorAll("script, style, noscript, template");
          for (const node of ignored) node.remove();
          const text = (document.body?.innerText || document.documentElement?.innerText || "")
            .replace(/\\s+/g, " ")
            .trim();
          return {
            title: document.title || location.href,
            url: location.href,
            text,
            html: document.documentElement?.outerHTML || ""
          };
        })();
      `);
      if (!rendered.text) {
        throw new Error("The rendered page did not contain readable text.");
      }
      return { ...rendered, fetchedAt: new Date().toISOString() };
    } catch (error) {
      await this.#logs.append("browser.rendered_extraction_fallback", {
        url: target,
        error: error instanceof Error ? error.message : String(error)
      });
      return loadPage(target);
    } finally {
      if (extractor && !extractor.isDestroyed()) {
        extractor.destroy();
      }
    }
  }

  private async findInPage(url: string, pattern: string): Promise<string[]> {
    const page = await this.openPage("", url);
    const lines = page.text.split(/(?<=[.!?。！？])\s+/);
    return lines.filter((line) => line.toLowerCase().includes(pattern.toLowerCase())).slice(0, 20);
  }

  private async emit(event: RuntimeEvent): Promise<void> {
    let subject: ThreadRecord | null = null;
    if (event.threadId) {
      try {
        subject = this.#db.getThread(event.threadId);
      } catch {
        subject = null;
      }
    }
    const routedEvent: RuntimeEvent = subject?.parentThreadId
      ? {
          ...event,
          notificationThreadId: subject.rootThreadId,
          notificationChildThreadId: subject.id
        }
      : event;

    this.#db.addRuntimeEvent(routedEvent);
    this.#events.emit("runtime-event", routedEvent);
    if (routedEvent.type === "thread.updated") {
      if (subject?.parentThreadId) {
        const root = this.#db.getThread(subject.rootThreadId);
        this.#events.emit("runtime-event", {
          type: "thread.updated",
          threadId: root.id,
          payload: { thread: root, childThread: subject },
          createdAt: new Date().toISOString()
        } satisfies RuntimeEvent);
      }
    }
    if (routedEvent.type !== "assistant.delta") {
      await this.#logs.append("runtime.event", { event: sanitizeRuntimeEventForLog(routedEvent) }, routedEvent.threadId);
    }
  }

  private async syncInstalledPlugins(): Promise<void> {
    const plugins = await this.#plugins.discoverInstalledPlugins(this.#layout.pluginsInstalledDir);
    for (const plugin of plugins) {
      this.#db.upsertPlugin(plugin, await hashDirectory(plugin.installPath));
    }
  }

  private async initializeDeferredServicesInternal(): Promise<void> {
    await this.#logs.prune();
    await this.syncInstalledPlugins();
    await this.refreshMcpConfiguration(false);
    await this.refreshSkills();
    void this.#mcp.refresh().catch(async (error) => {
      await this.#logs.append("mcp.background_refresh_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    await this.#logs.append("backend.deferred_initialization_completed", {
      pluginCount: this.#db.listPlugins().length,
      skillCount: this.#skills.list().length,
      mcpStatuses: this.#mcp.listStatuses()
    });
  }

  private async refreshSkills(cwd?: string | null): Promise<void> {
    const pluginRoots = await this.#plugins.collectPluginSkillRoots(this.#db.listPlugins());
    await this.#skills.refresh(this.#layout.root, cwd, pluginRoots);
  }

  private refreshSkillsInBackground(cwd?: string | null): void {
    if (this.#backgroundSkillRefresh) {
      return;
    }
    const refresh = this.refreshSkills(cwd);
    this.#backgroundSkillRefresh = refresh;
    void refresh.catch(async (error) => {
      await this.#logs.append("skills.background_refresh_failed", {
        cwd: cwd ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => {
      if (this.#backgroundSkillRefresh === refresh) {
        this.#backgroundSkillRefresh = null;
      }
    });
  }

  private async refreshMcpConfiguration(connect = true): Promise<void> {
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
      const localOverride = this.#config.mcpServers.find((configured) => configured.id === server.id);
      effectiveServers.set(server.id, localOverride ? {
        ...server,
        // Endpoint and process details stay owned by the plugin. Local config can
        // only attach credentials and policy for the user's installation.
        auth: localOverride.auth,
        defaultToolsApprovalMode: localOverride.defaultToolsApprovalMode,
        tools: localOverride.tools,
        enabled: localOverride.enabled
      } : server);
    }

    this.#mcp.setConfigs([...effectiveServers.values()]);
    if (connect) {
      await this.#mcp.refresh();
    }
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
    const configuredIds = thread.mode === "project" && thread.projectId
      ? this.#db.listProjectPluginBindings(thread.projectId).filter((binding) => binding.enabled).map((binding) => binding.pluginId)
      : thread.selectedPluginIds;
    const installedIds = new Set(this.#db.listPlugins().map((plugin) => plugin.id));
    return [...new Set(configuredIds)].filter((pluginId) => installedIds.has(pluginId));
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
          knowledgeBase.scope === "global" || explicit.has(knowledgeBase.id) ||
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

  private async isThreadAttachmentPath(threadId: string, absolutePath: string): Promise<boolean> {
    const candidate = path.resolve(absolutePath);
    const attachmentsRoot = path.resolve(this.#layout.attachmentsDir, threadId);
    const outputRoot = path.resolve(await this.getThreadOutputDir(threadId));
    const isWithin = (root: string) => {
      const relative = path.relative(root, candidate);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    if (isWithin(attachmentsRoot) || isWithin(outputRoot)) return true;
    const messages = this.#db.listMessages(threadId);
    return messages.some((message) => {
      try {
        const attachments = JSON.parse(message.metadataJson ?? "{}").attachments;
        return Array.isArray(attachments) && attachments.some((item) => item?.absolutePath === candidate);
      } catch {
        return false;
      }
    });
  }

  private async emitTerminalOutput(threadId: string, data: string, sessionId = "default"): Promise<void> {
    await this.emit({
      type: "terminal.output",
      threadId,
      payload: { data, sessionId },
      createdAt: new Date().toISOString()
    });
  }

  private getProjectDirectory(threadId: string): string {
    const thread = this.#db.getThread(threadId);
    if (!thread.cwd) {
      throw new Error("This task does not have a project folder.");
    }
    return path.resolve(thread.cwd);
  }

  private async openLocalServerUrl(threadId: string, url: string): Promise<void> {
    const key = `${threadId}:${url}`;
    if (this.#openedLocalUrls.has(key)) {
      return;
    }
    this.#openedLocalUrls.add(key);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
        if (response.ok) {
          if (!this.#db.listBrowserTabs(threadId).some((tab) => tab.url === url)) {
            await this.openBrowserTab(threadId, url);
          }
          await shell.openExternal(url);
          return;
        }
      } catch {
        // The server may still be binding its port after a background launch.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }

    this.#openedLocalUrls.delete(key);
  }
}

function sanitizeRuntimeEventForLog(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "assistant.execution_output" || typeof event.payload?.content !== "string") {
    return event;
  }
  const { content, ...payload } = event.payload;
  return {
    ...event,
    payload: {
      ...payload,
      content: `[internal execution output omitted; ${content.length} characters]`
    }
  };
}

function normalizeAppConfig(config: AppConfig): AppConfig {
  const fallback = defaultConfig();
  const providers = config.providers.length ? [...config.providers] : fallback.providers;
  const models = config.models.filter((model) =>
    providers.some((provider) => provider.id === model.providerId)
  );
  const nextModels = (models.length ? models : fallback.models).map((model) => ({
    ...model,
    role:
      model.role === "image" || model.role === "video" || model.role === "reasoning"
        ? model.role
        : undefined,
    supportsImageGeneration:
      model.role === "image" ? true : model.supportsImageGeneration === true,
    supportsVideoGeneration:
      model.role === "video" ? true : model.supportsVideoGeneration === true
  }));

  const firstModel = nextModels[0];
  if (!firstModel) {
    return fallback;
  }

  const reasoningModels = nextModels.filter((model) => model.role === "reasoning");
  const firstProviderWithModel =
    providers.find((provider) => reasoningModels.some((model) => model.providerId === provider.id)) ??
    providers.find((provider) => nextModels.some((model) => model.providerId === provider.id)) ??
    providers.find((provider) => provider.id === firstModel.providerId) ??
    fallback.providers[0];
  const defaultProvider = reasoningModels.some(
    (model) => model.providerId === config.defaultProvider
  )
    ? config.defaultProvider
    : firstProviderWithModel.id;
  const providerModels = reasoningModels.filter((model) => model.providerId === defaultProvider);
  const defaultModel = providerModels.some((model) => model.id === config.defaultModel)
    ? config.defaultModel
    : providerModels[0]?.id ?? reasoningModels[0]?.id ?? firstModel.id;

  return {
    ...config,
    defaultProvider,
    defaultModel,
    providers,
    models: nextModels,
    multimodal: {
      image: normalizeMultimodalDefaults(config.multimodal?.image, nextModels, "image"),
      video: normalizeMultimodalDefaults(config.multimodal?.video, nextModels, "video"),
      input: normalizeMultimodalInputDefaults(config.multimodal?.input, nextModels)
    },
    projectExecutionPolicies: config.projectExecutionPolicies ?? {},
    timeouts: normalizeRuntimeTimeouts(config.timeouts),
    multiAgent: {
      defaultMode: "disabled",
      maxConcurrentSubagents: Math.min(3, Math.max(1, Math.round(config.multiAgent?.maxConcurrentSubagents ?? fallback.multiAgent.maxConcurrentSubagents))),
      maxSubagentsPerRoot: Math.min(8, Math.max(1, Math.round(config.multiAgent?.maxSubagentsPerRoot ?? fallback.multiAgent.maxSubagentsPerRoot))),
      maxDepth: Math.min(3, Math.max(1, Math.round(config.multiAgent?.maxDepth ?? fallback.multiAgent.maxDepth))),
      childWritePolicy: "read-only"
    },
    databaseConnections: Array.isArray(config.databaseConnections) ? config.databaseConnections : []
  };
}

function normalizeAgentSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "agent";
}

function isOverlappingSubagentAssignment(
  input: { prompt: string; role: string },
  existing: Pick<ThreadRecord, "agentRole" | "lastTaskMessage">
): boolean {
  const requestedRole = normalizeDelegationRole(input.role);
  const existingRole = normalizeDelegationRole(existing.agentRole ?? "");
  if (requestedRole && requestedRole === existingRole) {
    return true;
  }

  const requestedFiles = extractDelegatedFileScopes(input.prompt);
  const existingFiles = extractDelegatedFileScopes(existing.lastTaskMessage ?? "");
  let sharedFiles = 0;
  for (const file of requestedFiles) {
    if (existingFiles.has(file)) sharedFiles += 1;
  }
  return sharedFiles >= 2;
}

function normalizeDelegationRole(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\W_]+/g, "");
}

function extractDelegatedFileScopes(prompt: string): Set<string> {
  const scopes = new Set<string>();
  const normalized = prompt.toLowerCase().replace(/\\/g, "/");
  for (const match of normalized.matchAll(/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:[a-z0-9]{1,8})/g)) {
    scopes.add(match[0]);
  }
  return scopes;
}

function buildChildAgentPrompt(parent: ThreadRecord, child: ThreadRecord, prompt: string): string {
  return [
    `[Internal child-agent task ${child.agentPath}]`,
    `Parent agent: ${parent.agentPath}`,
    "You are a bounded child agent. Work independently on the assigned task and return a concise structured result.",
    "This task is read-only: do not edit files, run mutating shell commands, commit, push, or change external state.",
    "Include summary, concrete evidence (paths, symbols, or commands inspected), and errors or uncertainty.",
    "Assigned task:",
    prompt
  ].join("\n\n");
}

function normalizeMultimodalDefaults(
  value: AppConfig["multimodal"]["image"] | undefined,
  models: AppConfig["models"],
  role: "image" | "video"
): AppConfig["multimodal"]["image"] {
  const roleModels = models.filter((model) => model.role === role);
  let defaultProviderId = value?.defaultProviderId?.trim();
  let defaultModelId = value?.defaultModelId?.trim();
  const ok = roleModels.some(
    (model) => model.id === defaultModelId && model.providerId === defaultProviderId
  );
  if (!ok) {
    const first = roleModels[0];
    defaultProviderId = first?.providerId;
    defaultModelId = first?.id;
  }
  return {
    enabled: value?.enabled !== false,
    defaultProviderId,
    defaultModelId
  };
}

function normalizeMultimodalInputDefaults(
  value: AppConfig["multimodal"]["input"] | undefined,
  models: AppConfig["models"]
): AppConfig["multimodal"]["input"] {
  const candidates = models.filter((model) => model.supportsMultimodalInput);
  let defaultProviderId = value?.defaultProviderId?.trim();
  let defaultModelId = value?.defaultModelId?.trim();
  const ok = candidates.some(
    (model) => model.id === defaultModelId && model.providerId === defaultProviderId
  );
  if (!ok) {
    const first = candidates[0];
    defaultProviderId = first?.providerId;
    defaultModelId = first?.id;
  }
  return {
    enabled: value?.enabled !== false,
    defaultProviderId,
    defaultModelId
  };
}

function resolveThreadModelSelection(
  config: AppConfig,
  providerId?: string | null,
  modelId?: string | null
): Pick<ThreadRecord, "providerId" | "modelId"> {
  const normalized = normalizeAppConfig(config);
  const reasoningModels = normalized.models.filter(
    (model) => model.role === "reasoning"
  );
  const providerModels = providerId
    ? reasoningModels.filter((model) => model.providerId === providerId)
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

function resolveFetchedApiKey(input: { apiKey?: string; apiKeyEnv?: string }): string {
  if (input.apiKey) {
    return input.apiKey;
  }
  if (input.apiKeyEnv) {
    const value = process.env[input.apiKeyEnv];
    if (value) {
      return value;
    }
  }
  return "";
}

function normalizeAttachmentMimeType(value: string | undefined, fileName: string): string {
  if (value && value !== "application/octet-stream") return value.toLowerCase();
  switch (path.extname(fileName).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

function buildCodexhMediaUrl(threadId: string, absolutePath: string): string {
  const url = new URL("codexh-media://local/play");
  url.searchParams.set("threadId", threadId);
  url.searchParams.set("path", absolutePath);
  return url.toString();
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  if (mimeType === "video/x-matroska") return ".mkv";
  return "";
}

async function fileSha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeBrowserViewport(viewport: BrowserViewport): BrowserViewport {
  const width = Math.min(3840, Math.max(320, Math.round(Number(viewport.width) || 1440)));
  const height = Math.min(2160, Math.max(320, Math.round(Number(viewport.height) || 900)));
  return {
    width,
    height,
    deviceScaleFactor: Math.min(3, Math.max(1, Number(viewport.deviceScaleFactor) || 1)),
    mobile: viewport.mobile ?? width <= 500
  };
}

function normalizeBrowserAssertionChecks(checks: BrowserAssertionCheck[]): BrowserAssertionCheck[] {
  const normalized: BrowserAssertionCheck[] = [];
  for (const check of checks.slice(0, 40)) {
    if (!check || typeof check !== "object" || typeof check.type !== "string") continue;
    if (check.type === "url" || check.type === "title" || check.type === "text") {
      if (typeof check.value !== "string" || check.value.length === 0 || check.value.length > 500) continue;
      normalized.push({ ...check, match: check.match ?? "includes" });
      continue;
    }
    if (check.type === "element") {
      if (typeof check.selector !== "string" || check.selector.length === 0 || check.selector.length > 500) continue;
      normalized.push({ ...check, state: check.state ?? "visible" });
      continue;
    }
    if (
      check.type === "images_loaded" ||
      check.type === "no_horizontal_overflow" ||
      check.type === "canvas_nonblank" ||
      check.type === "no_severe_console_errors"
    ) normalized.push(check);
  }
  return normalized;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Browser screenshot is not a valid PNG image.");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
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

function buildPromptDefaultAnswers(questions: UserInputQuestion[]): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const option = question.options?.find((entry) => entry.recommended) ?? question.options?.[0];
    if (!option) return null;
    answers[question.id] = option.id;
  }
  return Object.keys(answers).length > 0 ? answers : null;
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

function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 1;
  }
  return Math.max(1, Math.ceil(Array.from(normalized).length / 4));
}

function splitKnowledgeDocument(body: string, maximumCharacters = 2_400): string[] {
  const paragraphs = body.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maximumCharacters) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length > maximumCharacters) {
      for (let offset = 0; offset < paragraph.length; offset += maximumCharacters) chunks.push(paragraph.slice(offset, offset + maximumCharacters));
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [body.trim()];
}

function getChunkLocator(content: string, chunkIndex: number): string {
  const heading = content.match(/^\s*#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading ? `${heading} · Chunk ${chunkIndex + 1}` : `Chunk ${chunkIndex + 1}`;
}

function normalizeKnowledgeImportSources(
  sources: KnowledgeImportSource[] | undefined,
  legacyPaths: string[] | undefined
): KnowledgeImportSource[] {
  const normalized = sources?.length
    ? sources
    : (legacyPaths ?? []).map((path) => ({ kind: "file" as const, path }));
  const seen = new Set<string>();
  return normalized.flatMap((source): KnowledgeImportSource[] => {
    if (source.kind === "url") {
      const url = normalizeKnowledgeUrl(source.url);
      const key = `url:${url}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ kind: "url", url }];
    }
    if (source.kind === "browser") {
      const url = normalizeKnowledgeUrl(source.url);
      const key = `browser:${source.threadId}:${source.tabId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...source, url }];
    }
    const pathKey = `${source.kind}:${path.resolve(source.path).toLowerCase()}`;
    if (seen.has(pathKey)) return [];
    seen.add(pathKey);
    return [{ ...source, path: source.path }];
  });
}

function resolveKnowledgeImportDisplayName(
  requestedName: string,
  sources: KnowledgeImportSource[],
  documents: ExtractedDocument[]
): string {
  const trimmed = requestedName.trim();
  const webSources = sources.filter((source) => source.kind === "url" || source.kind === "browser");
  if (webSources.length !== 1 || documents.length !== 1) {
    return trimmed || "Imported Knowledge";
  }
  const defaultNames = new Set(["", "Imported Knowledge"]);
  try {
    defaultNames.add(new URL(webSources[0].url).hostname);
  } catch {
    // URL validation runs before this point; retain the supplied name as a fallback.
  }
  const pageTitle = documents[0].title.trim();
  return defaultNames.has(trimmed) && pageTitle ? pageTitle : trimmed || "Imported Knowledge";
}

function normalizeKnowledgeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Knowledge URLs must be valid http or https addresses.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Knowledge URLs only support http and https.");
  }
  return url.toString();
}

function knowledgeExtensionForMimeType(mimeType: string): string | undefined {
  switch (mimeType) {
    case "application/pdf": return ".pdf";
    case "application/json": return ".json";
    case "text/plain": return ".txt";
    case "text/csv": return ".csv";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return ".docx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation": return ".pptx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return ".xlsx";
    case "application/vnd.ms-excel": return ".xls";
    default: return undefined;
  }
}

async function expandKnowledgeSources(
  sourcePaths: string[],
  options: { allowEmpty?: boolean } = {}
): Promise<string[]> {
  const supported = new Set([".md", ".txt", ".json", ".html", ".htm", ".csv", ".xlsx", ".xls", ".docx", ".pdf", ".pptx"]);
  const files = new Set<string>();
  const visit = async (target: string): Promise<void> => {
    let stat;
    try {
      stat = await fs.stat(target);
    } catch (error: any) {
      if (options.allowEmpty && error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isFile()) {
      if (supported.has(path.extname(target).toLowerCase())) files.add(path.resolve(target));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      await visit(path.join(target, entry.name));
    }
  };
  for (const sourcePath of sourcePaths) await visit(sourcePath);
  if (files.size === 0 && !options.allowEmpty) throw new Error("No supported documents were found.");
  return [...files];
}

function resolveSearchResultUrl(pageUrl: string, href: string): string {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
}

function filterRelevantSearchResults<T extends { title: string; snippet: string }>(
  query: string,
  results: T[]
): T[] {
  const terms = [
    ...Array.from(query.matchAll(/[\u4e00-\u9fff]{2,}/g), (match) => match[0]),
    ...Array.from(query.matchAll(/[a-z0-9][a-z0-9._-]{1,}/gi), (match) => match[0])
  ];
  if (terms.length === 0) {
    return results;
  }
  return results.filter((result) => {
    const text = `${result.title} ${result.snippet}`.toLowerCase();
    return terms.some((term) => text.includes(term.toLowerCase()));
  });
}

type ProjectTextEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "gb18030";

function decodeProjectText(buffer: Buffer): { content: string; encoding: ProjectTextEncoding } | null {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { content: buffer.subarray(3).toString("utf8"), encoding: "utf8-bom" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { content: buffer.subarray(2).toString("utf16le"), encoding: "utf16le" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { content: decodeUtf16Be(buffer.subarray(2)), encoding: "utf16be" };
  }
  if (buffer.includes(0)) {
    return null;
  }
  if (isValidUtf8(buffer)) {
    return { content: buffer.toString("utf8"), encoding: "utf8" };
  }
  if (!looksLikeText(buffer)) {
    return null;
  }
  return { content: iconv.decode(buffer, "gb18030"), encoding: "gb18030" };
}

function encodeProjectText(content: string, encoding: ProjectTextEncoding): Buffer {
  switch (encoding) {
    case "utf8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
    case "utf16be":
      return Buffer.concat([Buffer.from([0xfe, 0xff]), encodeUtf16Be(content)]);
    case "gb18030":
      return iconv.encode(content, "gb18030");
    default:
      return Buffer.from(content, "utf8");
  }
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function looksLikeText(buffer: Buffer): boolean {
  let controlCharacters = 0;
  for (const byte of buffer) {
    if ((byte < 0x09) || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      controlCharacters += 1;
    }
  }
  return controlCharacters <= Math.max(2, Math.floor(buffer.length / 20));
}

function decodeUtf16Be(buffer: Buffer): string {
  const length = buffer.length - (buffer.length % 2);
  const littleEndian = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 2) {
    littleEndian[index] = buffer[index + 1]!;
    littleEndian[index + 1] = buffer[index]!;
  }
  return littleEndian.toString("utf16le");
}

function encodeUtf16Be(content: string): Buffer {
  const littleEndian = Buffer.from(content, "utf16le");
  const bigEndian = Buffer.allocUnsafe(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1]!;
    bigEndian[index + 1] = littleEndian[index]!;
  }
  return bigEndian;
}

function resolveProjectFilePath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Project file paths must be relative to the project folder.");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Project file path is outside the project folder.");
  }
  return resolved;
}

function getApprovalScopePayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.patchPreview === "string") {
    return { operation: "apply_patch" };
  }
  return payload;
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

function isBrowserAutomationGuest(contents: WebContents): boolean {
  const type = contents.getType();
  if (type === "webview") {
    return true;
  }
  // Electron 43+ GuestView MPArch may report embedded guests as "page".
  const host = (contents as WebContents & { hostWebContents?: WebContents | null }).hostWebContents;
  return Boolean(host && !host.isDestroyed());
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
