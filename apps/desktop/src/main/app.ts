import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { app, BrowserWindow, desktopCapturer, net, screen, shell, webContents } from "electron";
import type { WebContents } from "electron";
import type {
  AttachmentImportInput,
  AppConfig,
  ArtifactRecord,
  ApprovalRequest,
  BrowserAssertionCheck,
  BrowserAssertionResult,
  BrowserOpenMode,
  BrowserTabRecord,
  BrowserViewport,
  DatabaseConnectionConfig,
  GitActionResult,
  GitSnapshot,
  GpaStage,
  GpaState,
  GptReasoningEffort,
  KnowledgeBaseRecord,
  KnowledgeChunkRecord,
  KnowledgeBaseSummary,
  KnowledgeDocumentRecord,
  KnowledgeImportSource,
  MessageRecord,
  MessageAttachment,
  QueuedMessageRecord,
  McpServerConfig,
  ModelProfile,
  OpenAiApiFormat,
  PendingResumeThread,
  ReasoningEffort,
  PluginRecord,
  ProviderDefinition,
  ProjectPluginBinding,
  QuickNoteRecord,
  ErrorSolutionRecord,
  RuntimeEvent,
  RuntimeLogEntry,
  RuntimeLogPage,
  RuntimeThreadSnapshotCursor,
  RuntimeThreadSnapshot,
  SkillLabEvent,
  SkillMetadata,
  SubagentResultEnvelope,
  SubagentWaitResult,
  SubagentWatchdogDiagnostic,
  ThreadRecord,
  ToolCallDetail,
  ToolCallRecord,
  ToolSpecDefinition,
  UserInputQuestion,
  UserInputPrompt
} from "@shared-types";
import { isExplicitMcpProhibition, isOverlappingSubagentAssignment, normalizeSubagentMcpPolicy } from "./subagent-assignment";
import { isGptReasoningEffort, normalizeResponseTone, withGptReasoningCapabilities } from "@shared-types";
import {
  AgentRuntimeService,
  isUnitTestCommand,
  parseGpaState,
  resolveSubagentWatchdogDecision,
  toGpaPlanResumePreview
} from "@agent-runtime";
import { BrowserRuntime, isBrowserErrorPageUrl, loadPage, resolveBrowserOpenPreferences, type PageSnapshot } from "@browser-runtime";
import { buildOkfBundle, extractDocument, extractDocumentBuffer, extractHtmlReadableText, type ExtractedDocument } from "@knowledge-runtime";
import { McpManager } from "@mcp-runtime";
import { hashDirectory, PluginRuntime, type PluginInstallProgress } from "@plugin-runtime";
import { classifyResponsesFallback, defaultOpenAiApiFormatsForModel, ProviderFactory } from "@provider-adapters";
import {
  SkillsManager,
  buildUserWorkflowPrompt,
  normalizeUserSkillName,
  parseUserWorkflowDraft,
  renderUserWorkflowSkill
} from "@skills-runtime";
import { listProjectDirectoryEntries, type ProjectFileEntry } from "./project-files";
import { ToolRuntime } from "@tool-runtime";
import { DatabaseRuntime } from "@database-runtime";
import { redactRuntimeLogPayload, RuntimeLogWriter } from "./runtime-log";
import { McpCredentialStore, McpOAuthService } from "./mcp-oauth";
import { TerminalRuntime, type TerminalOutputHeartbeat } from "./terminal-runtime";
import { GitService } from "./git-service";
import { SkillLabService } from "./skill-lab";
import { parseEditableMessageMetadata } from "./message-metadata";
import { isProjectAttachmentPath } from "./attachment-path";
import {
  DatabaseService,
  defaultConfig,
  ensureHomeLayout,
  loadConfig,
  saveConfig,
  type HomeLayout
} from "./storage";

type ResolverMap<T> = Map<string, (value: T) => void>;
type SubagentProgress = {
  lastProgressAt: string;
  lastToolEventAt: string | null;
  currentTool: string | null;
  isShellOrTest: boolean;
  phase: "starting" | "awaiting_model" | "executing_shell_test" | "retrying";
  interruptionReason?: string;
};
const INTERACTION_TIMEOUT_MS = 30_000;
const RUNTIME_TOOL_RESULT_LIMIT_BYTES = 4_096;
const MAX_APPLICATION_BACKGROUND_BYTES = 40 * 1024 * 1024;
const APPLICATION_BACKGROUND_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

type ApplicationBackgroundItemPayload = {
  id: string;
  bytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
};

type ApplicationBackgroundCollectionPayload = {
  items: ApplicationBackgroundItemPayload[];
  settings: unknown;
};

type ApplicationBackgroundItemMetadata = Omit<ApplicationBackgroundItemPayload, "bytes">;

type ApplicationBackgroundMetadata = {
  version: 2;
  items: ApplicationBackgroundItemMetadata[];
  settings: unknown;
};

async function getFileSize(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return stats?.size ?? 0;
}

function compactTerminalInput(input: string | undefined): string | undefined {
  const normalized = input?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 96 ? `${normalized.slice(0, 95)}…` : normalized;
}

function compactRuntimeToolResult(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "tool.completed" || typeof event.payload.resultJson !== "string") return event;
  const resultSize = Buffer.byteLength(event.payload.resultJson, "utf8");
  if (resultSize <= RUNTIME_TOOL_RESULT_LIMIT_BYTES) {
    return { ...event, payload: { ...event.payload, resultSize, hasFullResult: true } };
  }
  return {
    ...event,
    payload: { ...event.payload, resultJson: null, resultSize, hasFullResult: false }
  };
}

type LegacyApplicationBackgroundMetadata = {
  version: 1;
  mimeType: string;
  fileName: string;
  settings: unknown;
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
    fetch: (input, init) => net.fetch(input as string | GlobalRequest, init),
    onApiFormatResolved: async (providerId, model) => {
      const stored = this.#config?.models.find((entry) => entry.providerId === providerId && entry.id === model.id);
      if (!stored || stored !== model || !this.#layout?.configFile) return;
      await saveConfig(this.#layout.configFile, this.#config);
    }
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
  readonly #subagentDispatches = new Map<string, Promise<void>>();
  readonly #subagentProgress = new Map<string, SubagentProgress>();

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
    // Capture threads that were still running when the previous process died
    // (crash / kill) before recovery flips them to interrupted, so the UI can
    // offer to resume them just like the graceful-shutdown path does.
    const staleRunningRootThreadIds = new Set(
      this.#db
        .listThreads(true)
        .filter((thread) => thread.status === "running" || thread.status === "waiting")
        .map((thread) => thread.rootThreadId)
    );
    this.#db.recoverInterruptedThreads();
    if (staleRunningRootThreadIds.size > 0) {
      await this.addPendingResumeMarkers([...staleRunningRootThreadIds]);
    }
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
      emit: (event) => this.#skillLabEvents.emit("skill-lab-event", event),
      log: (kind, payload) => this.#logs.append(kind, payload)
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
        enqueueQueuedMessage: async (input) => this.#db.enqueueQueuedMessage(input),
        claimNextQueuedMessage: async (threadId) => this.#db.claimNextQueuedMessage(threadId),
        completeQueuedMessage: async (id) => this.#db.completeQueuedMessage(id),
        createMessage: async (input) => this.#db.createMessage(input),
        createQueuedUserMessage: async (queueItemId, input) => this.#db.createQueuedUserMessage(queueItemId, input),
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
      addKnowledgeNote: async (input) => this.addAgentKnowledgeNote(input),
      readThreadTodos: async (threadId) => this.readThreadTodos(threadId),
      writeThreadTodos: async (threadId, items) => this.writeThreadTodos(threadId, items),
      openExternalUrl: async (url) => {
        await shell.openExternal(url);
      },
      searchErrorSolutions: async (input) => this.#db.searchErrorSolutions(input),
      recordErrorSolution: async (input) => this.#db.upsertErrorSolution(input),
      markErrorSolutionUsed: async (id) => {
        this.#db.markErrorSolutionUsed(id);
      },
      recordErrorSolutionRecall: async (id) => {
        this.#db.recordErrorSolutionRecall(id);
      },
      setErrorSolutionRecallOutcome: async (id, outcome) => {
        this.#db.setErrorSolutionRecallOutcome(id, outcome);
      },
      searchSelfImprovementMemories: async (input) => this.#db.searchSelfImprovementMemories(input),
      addSelfImprovementMemory: async (input) => this.#db.upsertSelfImprovementMemory(input),
      markSelfImprovementMemoryUsed: async (id) => this.#db.markSelfImprovementMemoryUsed(id),
      listFiles: async (dir) =>
        (await fs.readdir(dir, { withFileTypes: true })).map((entry) => entry.name),
      readFile: async (filePath) => fs.readFile(filePath, "utf8"),
      writeFile: async (filePath, content) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      },
      runTerminalCommand: async (threadId, cwd, command, input) =>
        this.#terminal.execute(threadId, cwd, command, (data, heartbeat) => {
          void this.emitTerminalOutput(threadId, data, "default", heartbeat, command);
        }, (url) => {
          void this.openLocalServerUrl(threadId, url);
        }, "default", input?.onIdle),
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
      installSkillForThread: async (threadId, input) => this.installSkillForThread(threadId, input),
      installPluginForThread: async (threadId, source) => this.installPluginForThread(threadId, source),
      installMcpServerFromChat: async (input) => this.installMcpServerFromChat(input),
      webSearch: async (threadId, query) => this.webSearch(threadId, query),
      openPage: async (threadId, url) => this.openPage(threadId, url),
      findInPage: async (url, pattern) => this.findInPage(url, pattern),
      listBrowserTabs: async (threadId) => this.#db.listBrowserTabs(threadId),
      openBrowserTab: async (threadId, url, openMode) => this.openBrowserTab(threadId, url, openMode),
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
      captureDesktopScreenshot: async (threadId, turnRunId, display) => this.captureDesktopScreenshot(threadId, turnRunId, display),
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
      log: async (kind, threadId, payload) => {
        await this.#logs.append(kind, payload, threadId);
        this.emitLiveRuntimeLog({
          timestamp: new Date().toISOString(),
          kind,
          threadId,
          payload: redactRuntimeLogPayload(payload)
        });
      }
    });
    for (const approval of this.#db.listPendingApprovals()) {
      this.#scheduleApprovalTimeout(approval.id);
    }
    void this.processSelfImprovementMemories();
    // Recovery turns interrupted work back into queued messages. Reapply the
    // child-agent limit before waking them so a restart cannot burst past it.
    const childCapacity = Math.max(1, this.#config.multiAgent.maxConcurrentSubagents - 1);
    const recoveredChildrenByRoot = new Map<string, number>();
    for (const child of this.#db.listQueuedSubagentMessageThreadIds()) {
      if (this.#db.isSubagentPendingDispatch(child.threadId)) continue;
      const restoredCount = recoveredChildrenByRoot.get(child.rootThreadId) ?? 0;
      if (restoredCount >= childCapacity) {
        this.#db.markSubagentPendingDispatch(child.threadId, child.rootThreadId);
      } else {
        recoveredChildrenByRoot.set(child.rootThreadId, restoredCount + 1);
      }
    }
    for (const threadId of this.#db.listQueuedMessageThreadIds()) {
      if (!this.#db.isSubagentPendingDispatch(threadId)) {
        this.#runtime.wakeQueuedMessages(threadId);
      }
    }
    for (const rootThreadId of this.#db.listSubagentPendingDispatchRoots()) {
      this.schedulePendingSubagentDispatch(rootThreadId);
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

  public getUsageAnalytics(input?: { rangeDays?: number | null; granularity?: "day" | "week" | "month" }) {
    return this.#db.getUsageAnalytics(input);
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

  public async createThread(input: {
    title: string;
    mode: ThreadRecord["mode"];
    cwd?: string | null;
    workspaceRoots?: string[];
    providerId?: string | null;
    modelId?: string | null;
  }): Promise<ThreadRecord> {
    const workspaceRoots = input.mode === "project"
      ? await validateWorkspaceRoots(input.workspaceRoots?.length ? input.workspaceRoots : input.cwd ? [input.cwd] : [])
      : [];
    const cwd = workspaceRoots[0] ?? null;
    const selection = resolveThreadModelSelection(this.#config, input.providerId, input.modelId);
    const thread = this.#db.createThread({
      title: input.title,
      mode: input.mode,
      workspaceKind: cwd ? "project" : "projectless",
      cwd,
      workspaceRoots,
      modelId: selection.modelId,
      providerId: selection.providerId,
      // Ordinary conversations start with least privilege. Project tasks keep
      // their existing explicit default; a user may still change either mode.
      gpaStateJson: JSON.stringify({ fullAccess: input.mode === "project" }),
      multiAgentMode: "proactive"
    });
    this.refreshSkillsInBackground(thread.cwd);
    this.#runtime.ensureThread(thread.id);
    return thread;
  }

  public async addThreadWorkspaceRoot(threadId: string, rootPath: string): Promise<ThreadRecord> {
    const thread = this.#db.getThread(threadId);
    this.assertWorkspaceRootsMutable(thread);
    const workspaceRoots = await validateWorkspaceRoots([...(thread.workspaceRoots ?? (thread.cwd ? [thread.cwd] : [])), rootPath]);
    const updated = this.#db.setThreadWorkspaceRoots(threadId, workspaceRoots);
    await this.emitThreadUpdated(updated);
    return updated;
  }

  public async removeThreadWorkspaceRoot(threadId: string, rootPath: string): Promise<ThreadRecord> {
    const thread = this.#db.getThread(threadId);
    this.assertWorkspaceRootsMutable(thread);
    const target = normalizeWorkspaceRoot(rootPath);
    if (sameWorkspacePath(target, thread.cwd)) throw new Error("主目录不能移除。");
    const currentRoots = thread.workspaceRoots ?? (thread.cwd ? [thread.cwd] : []);
    const workspaceRoots = currentRoots.filter((root) => !sameWorkspacePath(root, target));
    if (workspaceRoots.length === currentRoots.length) throw new Error("协作目录不存在。");
    const updated = this.#db.setThreadWorkspaceRoots(threadId, workspaceRoots);
    await this.emitThreadUpdated(updated);
    return updated;
  }

  private assertWorkspaceRootsMutable(thread: ThreadRecord): void {
    if (thread.mode !== "project" || !thread.cwd) throw new Error("只有项目任务可以管理协作目录。");
    if (thread.status === "running" || thread.status === "waiting") throw new Error("任务执行期间不能修改协作目录。");
  }

  private async emitThreadUpdated(thread: ThreadRecord): Promise<void> {
    await this.emit({ type: "thread.updated", threadId: thread.id, payload: { thread }, createdAt: new Date().toISOString() });
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

  public async openTerminal(threadId: string, sessionId = "default", rootPath?: string) {
    const thread = this.#db.getThread(threadId);
    const cwd = thread.cwd ? this.getProjectDirectory(threadId, rootPath) : await this.getThreadOutputDir(threadId);
    return this.#terminal.open(
      threadId,
      cwd,
      (data, heartbeat) => {
        void this.emitTerminalOutput(threadId, data, sessionId, heartbeat);
      },
      sessionId
    );
  }

  public async writeTerminal(threadId: string, input: string, sessionId = "default", rootPath?: string): Promise<void> {
    const thread = this.#db.getThread(threadId);
    const cwd = thread.cwd ? this.getProjectDirectory(threadId, rootPath) : await this.getThreadOutputDir(threadId);
    this.#terminal.write(
      threadId,
      cwd,
      input,
      (data, heartbeat) => {
        void this.emitTerminalOutput(threadId, data, sessionId, heartbeat);
      },
      sessionId
    );
  }

  public async closeTerminal(threadId: string, sessionId?: string): Promise<void> {
    await this.#terminal.close(threadId, sessionId);
  }

  public async listProjectFiles(threadId: string, rootPath?: string, relativeDirectory = ""): Promise<ProjectFileEntry[]> {
    const root = this.getProjectDirectory(threadId, rootPath);
    return listProjectDirectoryEntries(root, relativeDirectory);
  }

  public async readProjectFile(threadId: string, rootPath: string | undefined, relativePath: string): Promise<{ path: string; content: string; truncated: boolean; binary: boolean }> {
    const root = this.getProjectDirectory(threadId, rootPath);
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

  public async writeProjectFile(threadId: string, rootPath: string | undefined, relativePath: string, content: string): Promise<{ path: string }> {
    if (typeof content !== "string") {
      throw new Error("Project file content must be text.");
    }

    const root = this.getProjectDirectory(threadId, rootPath);
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

  public getThreadSnapshot(threadId: string, cursor?: RuntimeThreadSnapshotCursor): RuntimeThreadSnapshot {
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
    const messageCount = this.#db.countMessages(threadId);
    const toolCallCount = this.#db.countToolCalls(threadId);
    const artifactCount = this.#db.countArtifacts(threadId);
    const canUseDelta = Boolean(
      cursor &&
      cursor.messageCount <= messageCount &&
      cursor.toolCallCount <= toolCallCount &&
      cursor.artifactCount <= artifactCount &&
      cursor.observedAt
    );
    const messages = canUseDelta && cursor
      ? this.#db.listMessagesCreatedSince(threadId, cursor.observedAt)
      : this.#db.listRecentMessages(threadId, Math.max(1, messageCount));
    const toolCalls = canUseDelta && cursor
      ? this.#db.listToolCallSummariesChangedSince(threadId, cursor.observedAt)
      : this.#db.listToolCallSummaries(threadId);
    const artifacts = canUseDelta && cursor
      ? this.#db.listArtifactsCreatedSince(threadId, cursor.observedAt)
      : this.#db.listArtifacts(threadId);
    const observedAt = new Date().toISOString();
    return {
      snapshotMode: canUseDelta ? "delta" : "full",
      snapshotCursor: { observedAt, messageCount, toolCallCount, artifactCount },
      thread,
      messages,
      messageCount,
      queuedMessages: this.#db.listQueuedMessages(threadId).filter((message) => message.status === "queued"),
      approvals: [...this.#db.listApprovals(threadId), ...childApprovals],
      prompts: [...this.#db.listUserPrompts(threadId), ...childPrompts],
      artifacts,
      knowledgeBases: this.listVisibleKnowledgeBasesForThread(thread),
      browserTabs,
      projectPlugins: this.listProjectPluginsForThread(thread),
      toolCalls,
      contextCompaction: this.#db.getLatestContextCompaction(threadId),
      contextMeasurement: this.#db.getLatestContextMeasurement(threadId),
      gpa: this.getGpaState(threadId),
      subagents,
      subagentResults: subagents.map((child) => this.buildSubagentEnvelope(child)),
      queuedSubagentIds: subagents
        .filter((child) => this.#db.isSubagentPendingDispatch(child.id))
        .map((child) => child.id)
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

  public async startSkillLab(
    prompt: string,
    requestedName?: string,
    iterations?: number,
    targetSkillId?: string,
    providerId?: string,
    modelId?: string
  ): Promise<string> {
    await this.initializeDeferredServices();
    return this.#skillLab.start(prompt, requestedName, iterations, targetSkillId, providerId, modelId);
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

  public getGitSnapshot(threadId: string, rootPath?: string): Promise<GitSnapshot> {
    return this.#git.snapshot(this.getProjectDirectory(threadId, rootPath));
  }

  public stageGitFile(threadId: string, filePath: string, rootPath?: string): Promise<GitActionResult> {
    return this.#git.stageFile(this.getProjectDirectory(threadId, rootPath), filePath);
  }

  public stageAllGitChanges(threadId: string, rootPath?: string): Promise<GitActionResult> {
    return this.#git.stageAll(this.getProjectDirectory(threadId, rootPath));
  }

  public unstageGitFile(threadId: string, filePath: string, rootPath?: string): Promise<GitActionResult> {
    return this.#git.unstageFile(this.getProjectDirectory(threadId, rootPath), filePath);
  }

  public revertGitFile(threadId: string, filePath: string, untracked?: boolean, rootPath?: string): Promise<GitActionResult> {
    return this.#git.revertFile(this.getProjectDirectory(threadId, rootPath), filePath, untracked === true);
  }

  public applyGitHunk(
    threadId: string,
    payload: { path: string; hunkId: string; source: "staged" | "unstaged"; action: "stage" | "unstage" | "revert"; rootPath?: string }
  ): Promise<GitActionResult> {
    return this.#git.applyHunk(this.getProjectDirectory(threadId, payload.rootPath), payload.path, payload.hunkId, payload.source, payload.action);
  }

  public commitGitChanges(threadId: string, message: string, rootPath?: string): Promise<GitActionResult> {
    return this.#git.commit(this.getProjectDirectory(threadId, rootPath), message);
  }

  public pushGitChanges(threadId: string, rootPath?: string): Promise<GitActionResult> {
    return this.#git.push(this.getProjectDirectory(threadId, rootPath));
  }

  public pullGitChanges(threadId: string, rootPath?: string): Promise<GitActionResult> {
    return this.#git.pull(this.getProjectDirectory(threadId, rootPath));
  }

  public switchGitBranch(threadId: string, branch: string, rootPath?: string): Promise<GitActionResult> {
    return this.#git.switchBranch(this.getProjectDirectory(threadId, rootPath), branch);
  }

  public async createGitPullRequest(threadId: string, rootPath?: string): Promise<GitActionResult> {
    const result = await this.#git.createPullRequest(this.getProjectDirectory(threadId, rootPath));
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
    dispatch = true,
    mediaIntent?: "image" | "video" | null
  ): Promise<{ queued: QueuedMessageRecord; queuedBehindActiveTask: boolean }> {
    // Queue first so cold-start maintenance (plugin discovery, skill indexing,
    // MCP refresh) never delays visible message submission.
    void this.initializeDeferredServices();
    const thread = this.#db.getThread(threadId);
    const queuedBehindActiveTask = this.#runtime.isProcessingTurn(threadId)
      || thread.status === "running"
      || thread.status === "waiting";
    // Use COUNT instead of loading every message row just to test emptiness —
    // listMessages materializes hundreds of large content/metadata rows
    // synchronously on the main process for long conversations.
    const isFirstThreadMessage = this.#db.countMessages(threadId) === 0 && this.#db.listQueuedMessages(threadId).length === 0;
    if (isFirstThreadMessage) {
      const updated = this.#db.updateThread(threadId, {
        title: buildThreadTitleFromFirstMessage(displayContent || content)
      });
      void this.emit({
        type: "thread.updated",
        threadId,
        payload: { thread: updated },
        createdAt: new Date().toISOString()
      }).catch(() => undefined);
    }

    const queued = this.#db.enqueueQueuedMessage({
      threadId,
      content,
      displayContent: displayContent || content,
      attachments,
      mediaIntent: mediaIntent ?? null
    });
    // Emit synchronously before the first await inside emit, but do not make
    // queue dispatch wait for the event-log append that follows it.
    void this.emit({
      type: "queue.updated",
      threadId,
      payload: { queueItemId: queued.id, action: "queued" },
      createdAt: new Date().toISOString()
    }).catch(() => undefined);
    if (dispatch) {
      this.#runtime.wakeQueuedMessages(threadId);
    }
    // Skill discovery walks user, project, and plugin directories. It must not
    // hold up a message that can run using the current catalog.
    this.refreshSkillsInBackground(thread.cwd);
    return { queued, queuedBehindActiveTask };
  }

  public async guideActiveThread(threadId: string, content: string): Promise<{ accepted: boolean }> {
    const guidance = content.trim();
    if (!guidance) {
      throw new Error("Guidance cannot be empty.");
    }
    const activeTurnRunId = this.#runtime.guideActiveTurn(threadId, guidance);
    if (activeTurnRunId) {
      const message = this.#db.createMessage({
        threadId,
        turnRunId: activeTurnRunId,
        role: "user",
        content: guidance,
        metadataJson: JSON.stringify({ displayKind: "guidance" })
      });
      await this.emit({
        type: "message.created",
        threadId,
        payload: { message },
        createdAt: new Date().toISOString()
      });
      return { accepted: true };
    }
    // A completed turn has no remaining model decision to guide. Preserve the
    // request by routing it through the established FIFO message path.
    await this.sendMessage(threadId, guidance);
    return { accepted: false };
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
    const originalMessage = this.#db.getMessage(threadId, messageId);
    if (!originalMessage || originalMessage.role !== "user") {
      throw new Error("The message to edit is no longer available.");
    }
    const { attachments, displayContent } = parseEditableMessageMetadata(originalMessage.metadataJson);
    this.#db.truncateConversationFromMessage(threadId, messageId);
    await this.sendMessage(threadId, content, attachments, displayContent);
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
    if (inputs.length > 16) throw new Error("一次最多添加 16 个附件。");
    const projectRoot = this.#db.getThread(threadId).cwd;
    const attachments: MessageAttachment[] = [];
    for (const input of inputs) {
      const name = path.basename(input.name || input.path || "attachment");
      const linkedProjectPath = isProjectAttachmentPath(projectRoot, input.path)
        ? path.resolve(input.path)
        : null;
      const inputData = input.data ? Buffer.from(input.data) : linkedProjectPath ? null : input.path ? await fs.readFile(input.path) : null;
      if (!inputData && !linkedProjectPath) throw new Error(`附件 ${name} 没有可读取内容。`);
      const mimeType = normalizeAttachmentMimeType(input.mimeType, name);
      const isImage = mimeType.startsWith("image/");
      const isVideo = mimeType.startsWith("video/");
      const maxBytes = isVideo ? 100 * 1024 * 1024 : isImage ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
      const sizeBytes = linkedProjectPath
        ? (await fs.stat(linkedProjectPath)).size
        : inputData!.byteLength;
      if (sizeBytes > maxBytes) {
        throw new Error(`${isVideo ? "视频" : isImage ? "图片" : "附件"} ${name} 超过 ${Math.round(maxBytes / (1024 * 1024))} MB 限制。`);
      }
      const absolutePath = linkedProjectPath ?? await this.copyAttachment(targetDir, name, mimeType, inputData!);
      attachments.push({
        id: randomUUID(),
        kind: isImage ? "image" : isVideo ? "video" : "file",
        name,
        mimeType,
        absolutePath,
        sizeBytes,
        source: "user"
      });
    }
    return attachments;
  }

  private async copyAttachment(targetDir: string, name: string, mimeType: string, data: Buffer): Promise<string> {
    await fs.mkdir(targetDir, { recursive: true });
    const digest = createHash("sha256").update(data).digest("hex");
    const extension = path.extname(name) || extensionForMimeType(mimeType);
    const absolutePath = path.join(targetDir, `${digest.slice(0, 24)}${extension.toLowerCase()}`);
    try { await fs.access(absolutePath); } catch { await fs.writeFile(absolutePath, data); }
    return absolutePath;
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

  #apiCardFavoritesFile(): string {
    return path.join(path.dirname(this.#layout.configFile), "api-card-favorites.json");
  }

  public async loadApiCardFavorites(): Promise<unknown[]> {
    try {
      const raw = await fs.readFile(this.#apiCardFavoritesFile(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public async saveApiCardFavorites(favorites: unknown[]): Promise<void> {
    const file = this.#apiCardFavoritesFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(favorites, null, 2), "utf8");
  }

  public hasActiveThreads(): boolean {
    if (!this.#db) return false;
    return this.#db
      .listThreads(true)
      .some((thread) => thread.status === "running" || thread.status === "waiting");
  }

  public async interruptActiveThreads(): Promise<void> {
    if (!this.#db) return;
    const rootThreadIds = new Set(
      this.#db
        .listThreads(true)
        .filter((thread) => thread.status === "running" || thread.status === "waiting")
        .map((thread) => thread.rootThreadId)
    );
    await this.#logs.append("app.shutdown_interrupt", {
      activeRootThreadIds: [...rootThreadIds]
    });
    // Record before interrupting: if the quit fallback timeout kills the
    // process mid-shutdown, next launch can still offer to resume.
    await this.addPendingResumeMarkers([...rootThreadIds]);
    await Promise.allSettled([...rootThreadIds].map((rootThreadId) => this.interruptThread(rootThreadId)));
  }

  #pendingResumeFile(): string {
    return path.join(path.dirname(this.#layout.configFile), "pending-resume.json");
  }

  private async readPendingResumeMarkers(): Promise<Array<{ threadId: string; interruptedAt: string }>> {
    try {
      const raw = await fs.readFile(this.#pendingResumeFile(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is { threadId: string; interruptedAt: string } =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as { threadId?: unknown }).threadId === "string" &&
          typeof (entry as { interruptedAt?: unknown }).interruptedAt === "string"
      );
    } catch {
      return [];
    }
  }

  private async writePendingResumeMarkers(markers: Array<{ threadId: string; interruptedAt: string }>): Promise<void> {
    const file = this.#pendingResumeFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(markers, null, 2), "utf8");
  }

  private async addPendingResumeMarkers(threadIds: string[]): Promise<void> {
    const uniqueIds = [...new Set(threadIds)];
    if (uniqueIds.length === 0) return;
    const existing = await this.readPendingResumeMarkers();
    const interruptedAt = new Date().toISOString();
    const next = [
      ...existing.filter((marker) => !uniqueIds.includes(marker.threadId)),
      ...uniqueIds.map((threadId) => ({ threadId, interruptedAt }))
    ];
    await this.writePendingResumeMarkers(next);
  }

  public async listPendingResume(): Promise<PendingResumeThread[]> {
    if (!this.#db) return [];
    const markers = await this.readPendingResumeMarkers();
    if (markers.length === 0) return [];
    const threadsById = new Map(this.#db.listThreads().map((thread) => [thread.id, thread]));
    const kept: typeof markers = [];
    const result: PendingResumeThread[] = [];
    for (const marker of markers) {
      const thread = threadsById.get(marker.threadId);
      const lastUserMessage = thread ? this.#db.getLastUserMessage(marker.threadId) : null;
      // Prune entries that can no longer be resumed: thread deleted, already
      // running again, or nothing left to continue with.
      if (!thread || thread.status === "running" || thread.status === "waiting" || !lastUserMessage?.content.trim()) {
        continue;
      }
      kept.push(marker);
      result.push({
        threadId: thread.id,
        title: thread.title,
        interruptedAt: marker.interruptedAt,
        lastUserMessage: lastUserMessage.content
      });
    }
    if (kept.length !== markers.length) {
      await this.writePendingResumeMarkers(kept);
    }
    return result;
  }

  public async dismissPendingResume(threadId: string): Promise<void> {
    const markers = await this.readPendingResumeMarkers();
    await this.writePendingResumeMarkers(markers.filter((marker) => marker.threadId !== threadId));
  }

  public async resumePendingResume(threadId: string): Promise<void> {
    if (!this.#db) return;
    const markers = await this.readPendingResumeMarkers();
    if (!markers.some((marker) => marker.threadId === threadId)) return;
    await this.dismissPendingResume(threadId);
    const thread = this.#db.getThread(threadId);
    if (thread.status === "running" || thread.status === "waiting") return;
    const lastUserMessage = this.#db.getLastUserMessage(threadId);
    if (!lastUserMessage?.content.trim()) return;
    const { attachments, displayContent } = parseEditableMessageMetadata(lastUserMessage.metadataJson);
    // Re-dispatch the interrupted message itself instead of sending a copy.
    // Pre-linking user_message_id makes dispatch reuse the persisted message
    // (no duplicate bubble, no duplicated prompt in the model context).
    // A hard process exit can leave the original dispatching queue item in
    // storage. Startup recovery makes it claimable again, so reuse it instead
    // of enqueueing the same user message a second time.
    const queued = this.#db
      .listQueuedMessages(threadId)
      .find((item) => item.userMessageId === lastUserMessage.id) ??
      this.#db.enqueueQueuedMessage({
        threadId,
        content: lastUserMessage.content,
        displayContent: displayContent ?? lastUserMessage.content,
        attachments,
        userMessageId: lastUserMessage.id
      });
    void this.emit({
      type: "queue.updated",
      threadId,
      payload: { queueItemId: queued.id, action: "queued" },
      createdAt: new Date().toISOString()
    }).catch(() => undefined);
    this.#runtime.wakeQueuedMessages(threadId);
  }

  public async interruptThread(threadId: string): Promise<void> {
    const thread = this.#db.getThread(threadId);
    const descendants = this.#db.listAgentTree(thread.rootThreadId)
      .filter((item) => item.id !== thread.id && item.agentPath.startsWith(`${thread.agentPath}/`))
      .sort((left, right) => right.agentPath.length - left.agentPath.length);
    const threadIds = [...descendants.map((child) => child.id), thread.id];
    const cancelledQueueItemIds = new Map<string, string[]>();
    const queuedAtInterrupt = new Map<string, string[]>();

    for (const id of threadIds) {
      this.#runtime.interrupt(id);
      this.#terminal.cancelCommands(id, "Task interrupted.");
      this.#db.clearSubagentPendingDispatch(id);
      // Capture the queue boundary before the first await. Messages submitted
      // after Stop must survive the cleanup of the interrupted turn.
      queuedAtInterrupt.set(
        id,
        this.#db.listQueuedMessages(id)
          .filter((item) => item.status === "queued")
          .map((item) => item.id)
      );
    }

    await this.#logs.append("thread.interrupt_requested", {
      targetThreadId: threadId,
      interruptedThreadIds: threadIds
    }, threadId);

    for (const id of threadIds) {
      cancelledQueueItemIds.set(id, this.#db.cancelQueuedMessages(id, queuedAtInterrupt.get(id) ?? []));
    }

    await Promise.all(threadIds.map((id) => this.finishInterruptThread(id, cancelledQueueItemIds.get(id) ?? [])));

    await this.#logs.append("thread.interrupted", {
      targetThreadId: threadId,
      interruptedThreadIds: threadIds,
      cancelledQueueItemCount: [...cancelledQueueItemIds.values()].reduce((count, ids) => count + ids.length, 0)
    }, threadId);
  }

  private async finishInterruptThread(threadId: string, cancelledQueueItemIds: string[]): Promise<void> {
    try {
      // Explicit authorizations have no timeout. Resolve every pending approval
      // before waiting so a stopped task can release its suspended tool call.
      for (const approvalId of [...this.#approvalResolvers.keys()]) {
        const approval = this.#db.getApproval(approvalId);
        if (approval?.threadId === threadId && approval.status === "pending") {
          this.resolveApproval(approvalId, { decision: "denied", source: "interrupted" });
        }
      }
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
    } finally {
      this.#runtime.resumeAfterInterrupt(threadId);
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
      // Tool messages repeat the full tool result. Tool calls below keep the
      // actionable name, arguments, status, and a bounded result instead.
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));
    const toolCalls = this.#db.listToolCalls(threadId).map(userWorkflowToolCall);
    if (messages.length === 0 && toolCalls.length === 0) throw new Error("所选聊天没有可提炼的内容。");

    const selection = resolveThreadModelSelection(this.#config, thread.providerId, thread.modelId);
    const provider = this.#config.providers.find((entry) => entry.id === selection.providerId);
    const model = this.#config.models.find((entry) => entry.id === selection.modelId && entry.providerId === selection.providerId);
    if (!provider || !model || model.role !== "reasoning") throw new Error("所选聊天没有可用的推理模型。");
    const prompt = buildUserWorkflowPrompt({ title: thread.title, messages, toolCalls });
    const timeout = new AbortController();
    let failureStage: "provider_request" | "parse_response" | "save_skill" = "provider_request";

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
      failureStage = "parse_response";
      const generatedDraft = parseUserWorkflowDraft(decision.assistantMessage ?? "", thread.title);
      const draft = requestedName?.trim()
        ? { ...generatedDraft, name: normalizeUserSkillName(requestedName) }
        : generatedDraft;
      failureStage = "save_skill";
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
      const message = error instanceof Error ? error.message : String(error);
      await this.#logs.append("user_skill.generation_failed", {
        modelId: model.id,
        providerId: provider.id,
        messageCount: messages.length,
        toolCallCount: toolCalls.length,
        promptChars: prompt.length,
        responseFormat: "json_object",
        stage: failureStage,
        error: message.slice(0, 2_000)
      }, threadId);
      if (failureStage === "provider_request") {
        throw new Error(`提炼技能的模型请求失败：${message}`);
      }
      if (failureStage === "parse_response") {
        throw new Error(`提炼技能时模型没有返回可用的 JSON 内容：${message}`);
      }
      throw error;
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
    const configuredProvider = this.#config.providers.find((provider) => provider.id === input.id);
    const headers = input.type === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...configuredProvider?.headers
        }
      : {
          Authorization: `Bearer ${apiKey}`,
          ...configuredProvider?.headers
        };
    const response = await fetch(endpoint, {
      method: "GET",
      headers
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
    agentCapability: "verified" | "unsupported";
    agentCapabilityReason?: string;
    verifiedApiFormats?: OpenAiApiFormat[];
    preferredApiFormat?: OpenAiApiFormat;
    apiFormatCheckedAt?: string;
  }> {
    if (input.provider.type !== "mock" && !input.provider.baseUrl?.trim()) {
      throw new Error("请先填写调用 URL，模型测试不会使用隐式默认地址。");
    }
    const timeout = new AbortController();
    if (input.model.supportsImageGeneration) {
      const startedAt = performance.now();
      const adapter = this.#providerFactory.create(input.provider);
      try {
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
          agentCapability: "unsupported",
          agentCapabilityReason: "Image-generation models do not run Agent tools."
        };
      } catch (error) {
        throw error;
      }
    }

    const formats: Array<OpenAiApiFormat | "anthropic" | "gemini"> = input.provider.apiFormat === "auto"
      ? defaultOpenAiApiFormatsForModel(input.model)
      : input.provider.apiFormat === "openai_responses" || input.provider.apiFormat === "openai_chat"
        ? [input.provider.apiFormat]
        : input.provider.apiFormat === "anthropic" || input.provider.apiFormat === "gemini"
          ? [input.provider.apiFormat]
          : input.provider.type === "anthropic" ? ["anthropic"]
            : input.provider.type === "gemini" ? ["gemini"]
              : ["openai_chat"];
    const successes: Array<{
      format: OpenAiApiFormat | "anthropic" | "gemini";
      latencyMs: number;
      outputTokens: number;
      agentCapability: "verified" | "unsupported";
      agentCapabilityReason?: string;
    }> = [];
    const failures: string[] = [];
    let responsesTemporarilyUnavailable = false;

    for (const format of formats) {
      const provider = { ...input.provider, apiFormat: format };
      const adapter = this.#providerFactory.create(provider);
      const startedAt = performance.now();
      try {
      const decision = await adapter.runTurn({
        systemPrompt:
          "You are testing a model connection. Return one compact JSON object with no tool calls.",
        transcript: [{ role: "user", content: "Return a short connection-test JSON response." }],
        availableTools: [],
        model: { ...input.model, supportsStreaming: false },
        provider,
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
            provider,
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
              provider,
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

        successes.push({ format, latencyMs, outputTokens, agentCapability, agentCapabilityReason });
      } catch (error) {
        const label = format === "openai_responses" ? "Responses" : format === "openai_chat" ? "Chat Completions" : format;
        if (format === "openai_responses" && classifyResponsesFallback(error) === "temporary") {
          responsesTemporarilyUnavailable = true;
        }
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (successes.length === 0) {
      throw new Error(`所有可用的上游格式均检测失败。技术详情：${failures.join("；")}`);
    }
    const verifiedApiFormats = successes
      .filter((entry): entry is typeof entry & { format: OpenAiApiFormat } =>
        entry.agentCapability === "verified" && (entry.format === "openai_responses" || entry.format === "openai_chat"))
      .map((entry) => entry.format);
    const preferred = successes.find((entry) => entry.agentCapability === "verified" && entry.format === "openai_responses")
      ?? successes.find((entry) => entry.agentCapability === "verified" && entry.format === "openai_chat")
      ?? successes.find((entry) => entry.format === "openai_responses")
      ?? successes[0]!;
    const preferredApiFormat = !responsesTemporarilyUnavailable && (preferred.format === "openai_responses" || preferred.format === "openai_chat")
      ? preferred.format
      : undefined;
    const apiFormatCheckedAt = preferredApiFormat ? new Date().toISOString() : undefined;
    return {
      latencyMs: preferred.latencyMs,
      outputTokens: preferred.outputTokens,
      tokensPerSecond: Number((preferred.outputTokens / (preferred.latencyMs / 1_000)).toFixed(2)),
      agentCapability: verifiedApiFormats.length > 0 ? "verified" : "unsupported",
      agentCapabilityReason: verifiedApiFormats.length > 0 ? undefined : preferred.agentCapabilityReason,
      verifiedApiFormats,
      preferredApiFormat,
      apiFormatCheckedAt
    };
  }

  public getConfig(): AppConfig {
    return this.#config;
  }

  public async setGlobalReasoningEffort(reasoningEffort: GptReasoningEffort): Promise<GptReasoningEffort> {
    if (!isGptReasoningEffort(reasoningEffort)) {
      throw new Error("不支持的 GPT 推理强度。");
    }
    const previous = this.#config.reasoningEffort;
    this.#config.reasoningEffort = reasoningEffort;
    try {
      await saveConfig(this.#layout.configFile, this.#config);
    } catch (error) {
      this.#config.reasoningEffort = previous;
      throw error;
    }
    await this.#logs.append("config.reasoning_effort_updated", { reasoningEffort });
    return reasoningEffort;
  }

  public async setLiveEditPreviewEnabled(enabled: boolean): Promise<boolean> {
    const previous = this.#config.desktop.liveEditPreview;
    this.#config.desktop.liveEditPreview = enabled;
    try {
      await saveConfig(this.#layout.configFile, this.#config);
    } catch (error) {
      this.#config.desktop.liveEditPreview = previous;
      throw error;
    }
    await this.#logs.append("config.live_edit_preview_updated", { enabled });
    return enabled;
  }

  public async setLlmLogViewerEnabled(enabled: boolean): Promise<boolean> {
    const previous = this.#config.desktop.llmLogViewer;
    const previousLiveEditPreview = this.#config.desktop.liveEditPreview;
    this.#config.desktop.llmLogViewer = enabled;
    if (enabled) this.#config.desktop.liveEditPreview = false;
    try {
      await saveConfig(this.#layout.configFile, this.#config);
    } catch (error) {
      this.#config.desktop.llmLogViewer = previous;
      this.#config.desktop.liveEditPreview = previousLiveEditPreview;
      throw error;
    }
    await this.#logs.append("config.llm_log_viewer_updated", { enabled });
    return enabled;
  }

  public async getApplicationBackgrounds(): Promise<ApplicationBackgroundCollectionPayload | null> {
    const appearanceDir = path.join(this.#layout.root, "appearance");
    try {
      const rawMetadata = await fs.readFile(path.join(appearanceDir, "background.json"), "utf8");
      const metadata = JSON.parse(rawMetadata) as Partial<ApplicationBackgroundMetadata> | Partial<LegacyApplicationBackgroundMetadata>;
      if (metadata.version === 2 && "items" in metadata && Array.isArray(metadata.items)) {
        const items = await Promise.all(metadata.items.map(async (item) => {
          if (
            !item ||
            typeof item.id !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
            !APPLICATION_BACKGROUND_MIME_TYPES.has(item.mimeType ?? "")
          ) {
            return null;
          }
          try {
            const bytes = await fs.readFile(path.join(appearanceDir, "backgrounds", item.id));
            return {
              id: item.id,
              bytes: Uint8Array.from(bytes).buffer,
              mimeType: item.mimeType,
              fileName: typeof item.fileName === "string" ? item.fileName : "background"
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        }));
        const availableItems = items.filter((item): item is ApplicationBackgroundItemPayload => item !== null);
        return availableItems.length > 0 ? { items: availableItems, settings: metadata.settings } : null;
      }

      const legacyMetadata = metadata as Partial<LegacyApplicationBackgroundMetadata>;
      if (!APPLICATION_BACKGROUND_MIME_TYPES.has(legacyMetadata.mimeType ?? "")) return null;
      const bytes = await fs.readFile(path.join(appearanceDir, "background-image"));
      return {
        items: [{
          id: "legacy-background",
          bytes: Uint8Array.from(bytes).buffer,
          mimeType: legacyMetadata.mimeType!,
          fileName: typeof legacyMetadata.fileName === "string" ? legacyMetadata.fileName : "background"
        }],
        settings: legacyMetadata.settings
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  public async saveApplicationBackgrounds(payload: ApplicationBackgroundCollectionPayload): Promise<void> {
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error("请至少保留一张背景图片。");
    }
    if (payload.items.length > 50) {
      throw new Error("背景图片最多支持 50 张。");
    }

    const seenIds = new Set<string>();
    const items = payload.items.map((item) => {
      const bytes = new Uint8Array(item.bytes);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) || seenIds.has(item.id)) {
        throw new Error("背景图片标识无效。");
      }
      seenIds.add(item.id);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_APPLICATION_BACKGROUND_BYTES) {
        throw new Error("背景图片必须小于 40 MB。");
      }
      if (!APPLICATION_BACKGROUND_MIME_TYPES.has(item.mimeType)) {
        throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片。");
      }
      return {
        id: item.id,
        bytes,
        mimeType: item.mimeType,
        fileName: path.basename(item.fileName || "background").slice(0, 255)
      };
    });

    const appearanceDir = path.join(this.#layout.root, "appearance");
    const metadata: ApplicationBackgroundMetadata = {
      version: 2,
      items: items.map(({ id, mimeType, fileName }) => ({ id, mimeType, fileName })),
      settings: payload.settings
    };
    const serializedMetadata = JSON.stringify(metadata, null, 2);
    if (Buffer.byteLength(serializedMetadata, "utf8") > 64 * 1024) {
      throw new Error("背景图片设置无效。");
    }

    await fs.mkdir(appearanceDir, { recursive: true });
    const backgroundsDir = path.join(appearanceDir, "backgrounds");
    await fs.rm(backgroundsDir, { recursive: true, force: true });
    await fs.mkdir(backgroundsDir, { recursive: true });
    await Promise.all(items.map((item) => fs.writeFile(
      path.join(backgroundsDir, item.id),
      Buffer.from(item.bytes.buffer, item.bytes.byteOffset, item.bytes.byteLength)
    )));
    await fs.rm(path.join(appearanceDir, "background-image"), { force: true });
    await fs.writeFile(path.join(appearanceDir, "background.json"), serializedMetadata, "utf8");
  }

  public async saveApplicationBackgroundSettings(settings: unknown): Promise<void> {
    const appearanceDir = path.join(this.#layout.root, "appearance");
    const metadataPath = path.join(appearanceDir, "background.json");
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as ApplicationBackgroundMetadata | LegacyApplicationBackgroundMetadata;
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

  public async clearApplicationBackgrounds(): Promise<void> {
    const appearanceDir = path.join(this.#layout.root, "appearance");
    await Promise.all([
      fs.rm(path.join(appearanceDir, "background-image"), { force: true }),
      fs.rm(path.join(appearanceDir, "backgrounds"), { recursive: true, force: true }),
      fs.rm(path.join(appearanceDir, "background.json"), { force: true })
    ]);
  }

  public getUpdatePaths(): Pick<HomeLayout, "cacheDir" | "logsDir"> {
    return { cacheDir: this.#layout.cacheDir, logsDir: this.#layout.logsDir };
  }

  public async getRuntimeLogStats() {
    const runtime = await this.#logs.getStats();
    const sqliteWalBytes = await getFileSize(`${this.#layout.dbFile}-wal`);
    return {
      bytes: runtime.bytes + sqliteWalBytes,
      fileCount: runtime.fileCount + (sqliteWalBytes > 0 ? 1 : 0)
    };
  }

  public async clearRuntimeLogs() {
    const sqliteWalFile = `${this.#layout.dbFile}-wal`;
    const sqliteWalBytesBefore = await getFileSize(sqliteWalFile);
    const runtime = await this.#logs.clear();
    this.#db.checkpointWriteAheadLog();
    const sqliteWalBytesAfter = await getFileSize(sqliteWalFile);
    const sqliteWalBytesCleared = Math.max(0, sqliteWalBytesBefore - sqliteWalBytesAfter);
    return {
      bytes: runtime.bytes + sqliteWalBytesCleared,
      fileCount: runtime.fileCount + (sqliteWalBytesCleared > 0 ? 1 : 0)
    };
  }

  public async getThreadRuntimeLogs(threadId: string, limit = 300): Promise<RuntimeLogPage> {
    this.#db.getThread(threadId);
    return this.#logs.readSessionPage(threadId, limit);
  }

  public appendRuntimeLog(kind: string, payload: Record<string, unknown>): Promise<void> {
    return this.#logs.append(kind, payload);
  }

  public flushRuntimeLogs(): Promise<void> {
    return this.#logs ? this.#logs.flush() : Promise.resolve();
  }

  public async saveModelAgentCapability(input: {
    providerId: string;
    modelId: string;
    agentCapability: "verified" | "unsupported";
    agentCapabilityReason?: string;
    contextWindow?: number;
    verifiedApiFormats?: OpenAiApiFormat[];
    preferredApiFormat?: OpenAiApiFormat;
    apiFormatCheckedAt?: string;
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
    model.verifiedApiFormats = input.verifiedApiFormats;
    model.preferredApiFormat = input.preferredApiFormat;
    model.apiFormatCheckedAt = input.apiFormatCheckedAt;
    if (Number.isFinite(input.contextWindow) && (input.contextWindow ?? 0) >= 1_024) {
      model.contextWindow = Math.floor(input.contextWindow!);
    }
    await saveConfig(this.#layout.configFile, this.#config);
    await this.#logs.append("model.agent_capability_saved", {
      modelId: model.id,
      providerId: model.providerId,
      agentCapability: model.agentCapability,
      agentCapabilityReason: model.agentCapabilityReason,
      verifiedApiFormats: model.verifiedApiFormats,
      preferredApiFormat: model.preferredApiFormat,
      apiFormatCheckedAt: model.apiFormatCheckedAt,
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
    this.#config.responseTone = normalized.responseTone;
    this.#config.reasoningEffort = normalized.reasoningEffort;
    this.#config.providers = [...normalized.providers];
    this.#config.models = [...normalized.models];
    this.#config.routing = { ...normalized.routing };
    this.#config.multimodal = {
      image: { ...normalized.multimodal.image },
      video: { ...normalized.multimodal.video },
      input: { ...normalized.multimodal.input }
    };
    this.#config.desktop = { ...normalized.desktop };
    this.#config.multiAgent = { ...normalized.multiAgent };
    this.#config.selfImprovement = { ...normalized.selfImprovement };
    this.#config.projectExecutionPolicies = normalized.projectExecutionPolicies;
    const previousMcpServers = this.#config.mcpServers;
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
    const selectionCache = new Map<string, Pick<ThreadRecord, "providerId" | "modelId">>();
    for (const thread of this.#db.listThreads()) {
      const cacheKey = `${thread.providerId ?? ""}::${thread.modelId ?? ""}`;
      let selection = selectionCache.get(cacheKey);
      if (!selection) {
        selection = resolveThreadModelSelection(this.#config, thread.providerId, thread.modelId);
        selectionCache.set(cacheKey, selection);
      }
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
    // Only rebuild MCP state when server definitions actually changed. Saving
    // Unrelated settings (tone, multi-agent, ...) must not respawn MCP.
    // child processes — that blocked the IPC handler for seconds on Windows.
    if (!areMcpServerConfigsEqual(previousMcpServers, this.#config.mcpServers)) {
      await this.refreshMcpConfiguration(
        mcpConnectionSettingsChanged(previousMcpServers, this.#config.mcpServers)
      );
    }
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

  public async installSkillForThread(
    threadId: string,
    input: { source: string; subdirectory?: string }
  ): Promise<{ id: string; name: string; qualifiedName: string; skillPath: string }> {
    const installed = await this.#plugins.installSkillFromSource(
      input.source,
      this.#layout.skillsInstalledDir,
      input.subdirectory
    );
    await this.refreshSkills();
    const skill = this.#skills.list().find((entry) => path.resolve(entry.skillPath) === path.resolve(installed.skillPath));
    if (!skill) {
      throw new Error("The installed SKILL.md is missing valid name and description metadata.");
    }
    await this.addThreadSkill(threadId, skill.id);
    await this.#logs.append("skill.installed_from_chat", {
      threadId,
      source: installed.source,
      qualifiedName: skill.qualifiedName
    }, threadId);
    return {
      id: skill.id,
      name: skill.name,
      qualifiedName: skill.qualifiedName,
      skillPath: skill.skillPath
    };
  }

  public async installPluginForThread(threadId: string, source: string): Promise<PluginRecord> {
    const plugin = await this.installPlugin(source);
    await this.setThreadPluginEnabled(threadId, plugin.id, true);
    await this.#logs.append("plugin.installed_from_chat", {
      threadId,
      pluginId: plugin.id,
      source: plugin.source
    }, threadId);
    return plugin;
  }

  public async installMcpServerFromChat(input: {
    id?: string;
    name: string;
    description?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    transport?: string;
  }): Promise<{ server: McpServerConfig; connectionError?: string }> {
    const name = input.name.trim();
    const command = input.command?.trim();
    const url = input.url?.trim();
    if (!name) throw new Error("MCP server name is required.");
    if (!command && !url) throw new Error("Provide either an MCP command or a service URL.");
    if (command && /[\r\n\0]/.test(command)) throw new Error("MCP command must be a single command name.");
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("MCP service URL must be a valid http or https URL.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("MCP service URL must use http or https.");
      }
    }
    const baseId = slugify(input.id?.trim() || name) || "mcp-server";
    const id = baseId;
    const server: McpServerConfig = {
      id,
      name,
      description: input.description?.trim() || undefined,
      command: command || undefined,
      args: input.args?.map((value) => String(value)).filter(Boolean),
      cwd: input.cwd?.trim() || undefined,
      url: url || undefined,
      transport: input.transport?.trim() || (url ? "streamable-http" : "stdio"),
      enabled: true,
      source: "config"
    };
    const existingIndex = this.#config.mcpServers.findIndex((entry) => entry.id === id);
    if (existingIndex >= 0) {
      this.#config.mcpServers.splice(existingIndex, 1, server);
    } else {
      this.#config.mcpServers.push(server);
    }
    await saveConfig(this.#layout.configFile, this.#config);
    let connectionError: string | undefined;
    try {
      await this.refreshMcpConfiguration();
    } catch (error) {
      connectionError = error instanceof Error ? error.message : String(error);
      await this.#logs.append("mcp.installed_from_chat_connection_failed", { id, connectionError });
    }
    await this.#logs.append("mcp.installed_from_chat", {
      id,
      transport: server.transport,
      sourceKind: command ? "command" : "url",
      connected: !connectionError
    });
    return { server, connectionError };
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

  public async openBrowserTab(threadId: string, url: string, requestedOpenMode?: BrowserOpenMode) {
    const { browserOpenMode, silentBrowserOpen } = resolveBrowserOpenPreferences(
      this.#config.desktop.browserOpenMode,
      this.#config.desktop.silentBrowserOpen,
      requestedOpenMode
    );
    const opened = await this.#browser.openTab(threadId, url);
    this.persistBrowserTabs(threadId);
    await this.emit({
      type: "browser.updated",
      threadId,
      payload: { action: "open", tab: opened.tab, browserOpenMode, silentBrowserOpen },
      createdAt: new Date().toISOString()
    });
    if (browserOpenMode === "external_default") {
      await shell.openExternal(opened.tab.url);
    }
    // Wait for the renderer webview to attach so follow-up automation tools can run.
    await this.requireBrowserContents(threadId, opened.tab.id, 20_000).catch(async (error) => {
      await this.#logs.append("browser.webview_attach_timeout", {
        threadId,
        tabId: opened.tab.id,
        url: opened.tab.url,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return { ...opened, browserOpenMode, silentBrowserOpen };
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

  public async captureDesktopScreenshot(
    threadId: string,
    turnRunId: string,
    target: "cursor" | "primary" = "cursor"
  ) {
    const displays = screen.getAllDisplays();
    if (displays.length === 0) throw new Error("No desktop display is available for screenshot capture.");

    const targetDisplay = target === "primary"
      ? screen.getPrimaryDisplay()
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const targetIndex = Math.max(0, displays.findIndex((display) => display.id === targetDisplay.id));
    const scaleFactor = Number.isFinite(targetDisplay.scaleFactor) ? Math.max(1, targetDisplay.scaleFactor) : 1;
    const requestedWidth = Math.max(1, Math.round(targetDisplay.size.width * scaleFactor));
    const requestedHeight = Math.max(1, Math.round(targetDisplay.size.height * scaleFactor));
    const captureScale = Math.min(1, 8192 / Math.max(requestedWidth, requestedHeight));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.max(1, Math.round(requestedWidth * captureScale)),
        height: Math.max(1, Math.round(requestedHeight * captureScale))
      },
      fetchWindowIcons: false
    });
    const source = sources.find((candidate) => candidate.display_id === String(targetDisplay.id))
      ?? sources[targetIndex]
      ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error("Desktop screenshot capture returned no image. Check the operating system screen-recording permission and try again.");
    }

    const outputDir = await this.getThreadOutputDir(threadId);
    const screenshotDir = path.join(outputDir, "screenshots");
    await fs.mkdir(screenshotDir, { recursive: true });
    const displayLabel = targetDisplay.label?.trim() || source.name || `Display ${targetDisplay.id}`;
    const fileName = `desktop-${String(targetDisplay.id).replace(/[^a-z0-9_-]+/gi, "-")}-${Date.now()}.png`;
    const filePath = path.join(screenshotDir, fileName);
    const png = source.thumbnail.toPNG();
    await fs.writeFile(filePath, png);
    const stats = await fs.stat(filePath);
    const dimensions = readPngDimensions(png);
    const artifact = this.#db.addArtifact({
      threadId,
      turnRunId,
      messageId: null,
      toolCallId: null,
      artifactKind: "desktop-screenshot",
      displayName: fileName,
      absolutePath: filePath,
      relativePath: path.relative(outputDir, filePath),
      mimeType: "image/png",
      sizeBytes: stats.size,
      sha256: await fileSha256(filePath),
      sourceKind: "desktop",
      isUserVisible: true,
      status: "ready"
    });
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
      title: `Desktop screenshot: ${displayLabel}`,
      filePath,
      width: dimensions.width,
      height: dimensions.height,
      displayId: String(targetDisplay.id),
      displayLabel,
      capturedAt: new Date().toISOString(),
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

  public clearSelfImprovementMemories(): number {
    return this.#db.clearSelfImprovementMemories();
  }

  public listSelfImprovementMemories(input: { projectId?: string | null; limit?: number; all?: boolean } = {}) {
    return this.#db.listSelfImprovementMemories(input);
  }

  public deleteSelfImprovementMemory(id: string): void {
    this.#db.deleteSelfImprovementMemory(id);
  }

  public async refreshSelfImprovementMemories(): Promise<{ processed: number; pruned: number }> {
    return this.processSelfImprovementMemories();
  }

  private async processSelfImprovementMemories(): Promise<{ processed: number; pruned: number }> {
    const settings = this.#config.selfImprovement;
    const pruned = this.#db.pruneSelfImprovementMemories(settings.retentionDays, settings.maxMemories);
    if (!settings.generateMemories) return { processed: 0, pruned };
    const idleBefore = Date.now() - settings.idleMinutes * 60_000;
    let processed = 0;
    for (const thread of this.#db.listThreads()) {
      if (thread.parentThreadId || thread.status === "running" || Date.parse(thread.updatedAt) > idleBefore) continue;
      if (!this.#db.claimSelfImprovementJob(thread.id)) continue;
      try {
        const messages = this.#db.listMessages(thread.id);
        const request = [...messages].reverse().find((message) => message.role === "user")?.content.trim();
        const result = [...messages].reverse().find((message) => message.role === "assistant")?.content.trim();
        if (!request || !result) {
          this.#db.finishSelfImprovementJob(thread.id, "No completed user/assistant exchange.");
          continue;
        }
        this.#db.upsertSelfImprovementMemory({
          scope: thread.projectId ? "project" : "global",
          projectId: thread.projectId,
          kind: "experience",
          title: `任务经验：${thread.title.slice(0, 160)}`,
          content: `任务：${request.slice(0, 900)}\n结果：${result.slice(0, 2_400)}`,
          sourceThreadId: thread.id
        });
        this.#db.finishSelfImprovementJob(thread.id);
        processed += 1;
      } catch (error) {
        this.#db.finishSelfImprovementJob(thread.id, error instanceof Error ? error.message : String(error));
      }
    }
    return { processed, pruned };
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

  public addAgentKnowledgeNote(input: {
    title: string;
    content: string;
    knowledgeBaseId?: string;
    threadId?: string;
  }): { documentId: string; knowledgeBaseId: string; sourcePath: string } {
    const title = input.title.trim();
    const content = input.content.trim();
    if (!title || !content) {
      throw new Error("知识库笔记标题和内容不能为空。");
    }
    const visible = input.threadId ? this.listVisibleKnowledgeBases(input.threadId) : this.#db.listKnowledgeBases();
    const selected = input.knowledgeBaseId
      ? visible.find((base) => base.id === input.knowledgeBaseId) ?? this.#db.getKnowledgeBase(input.knowledgeBaseId)
      : visible[0] ?? this.#db.findKnowledgeBase("global", "随手记");
    const base = selected ?? this.#db.createKnowledgeBase({
      scope: "global",
      projectId: null,
      displayName: "随手记",
      bundleRoot: path.join(this.#layout.globalBundlesDir, "quick-notes"),
      okfVersion: "0.1",
      status: "ready"
    });
    if (input.knowledgeBaseId && !visible.some((item) => item.id === base.id) && input.threadId) {
      throw new Error("指定的知识库对当前对话不可用。");
    }
    const noteId = randomUUID();
    const sourcePath = `agent-notes/${noteId}.md`;
    const documentId = randomUUID();
    const now = new Date().toISOString();
    const chunks = splitKnowledgeDocument(content).map((chunk, chunkIndex) => ({
      id: randomUUID(),
      knowledgeBaseId: base.id,
      documentId,
      chunkIndex,
      title,
      content: chunk,
      sourcePath,
      locator: getChunkLocator(chunk, chunkIndex),
      createdAt: now
    } satisfies KnowledgeChunkRecord));
    this.#db.replaceKnowledgeDocument({
      id: documentId,
      knowledgeBaseId: base.id,
      sourcePath,
      sourceHash: createHash("sha256").update(`${title}\n${content}`).digest("hex"),
      title,
      mimeHint: "text/markdown",
      status: "ready",
      updatedAt: now
    }, chunks);
    this.#db.updateKnowledgeBase(base.id, { status: "ready" });
    return { documentId, knowledgeBaseId: base.id, sourcePath };
  }

  private threadTodosPath(threadId: string): string {
    return path.join(this.#layout.cacheDir, "thread-todos", `${threadId}.json`);
  }

  public async readThreadTodos(
    threadId: string
  ): Promise<Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>> {
    try {
      const raw = await fs.readFile(this.threadTodosPath(threadId), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const row = entry as Record<string, unknown>;
        const statusRaw = String(row.status ?? "pending");
        const status = (["pending", "in_progress", "completed", "cancelled"].includes(statusRaw)
          ? statusRaw
          : "pending") as "pending" | "in_progress" | "completed" | "cancelled";
        return [{
          id: String(row.id ?? randomUUID()),
          content: String(row.content ?? "").trim() || "Task",
          status
        }];
      });
    } catch {
      return [];
    }
  }

  public async writeThreadTodos(
    threadId: string,
    items: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }>
  ): Promise<void> {
    const target = this.threadTodosPath(threadId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(items, null, 2), "utf8");
  }

  public resolveApproval(
    id: string,
    resolution: {
      decision: "approved" | "denied";
      mode?: "once" | "session" | "remember";
      source?: "user" | "timeout" | "interrupted";
    }
  ): void {
    const approval = this.#db.getApproval(id);
    if (!approval) {
      return;
    }

    const approved = resolution.decision === "approved";
    const resolutionMode = approved
      ? (approval.kind === "explicit_authorization" ? "once" : (resolution.mode ?? "once"))
      : null;
    const source = resolution.source ?? "user";
    this.#clearApprovalTimeout(id);
    this.#db.resolveApproval(id, { approved, resolutionMode, resolutionSource: source });

    if (approved && approval.kind === "permission") {
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
        kind: approval.kind,
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
      kind?: ApprovalRequest["kind"];
      title: string;
      description: string;
      riskLevel: "low" | "medium" | "high";
      payload: Record<string, unknown>;
    }
  ): Promise<boolean> {
    const thread = this.#db.getThread(threadId);
    const kind = input.kind ?? "permission";
    const requiresExplicitAuthorization = kind === "explicit_authorization";
    if (!requiresExplicitAuthorization && this.getGpaState(threadId).fullAccess) {
      return true;
    }
    const approvalKey = hashApprovalPayload({
      kind,
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      payload: getApprovalScopePayload(input.payload)
    });
    if (!requiresExplicitAuthorization && this.#config.desktop.approvals === "auto" && input.riskLevel === "low") {
      return true;
    }

    // A session approval intentionally covers later operations in this chat,
    // including commands whose arguments differ from the first request.
    if (!requiresExplicitAuthorization && this.#sessionApprovedThreadIds.has(threadId)) {
      return true;
    }

    if (!requiresExplicitAuthorization && this.#db.findRememberedApproval(thread.projectId, approvalKey)) {
      return true;
    }

    const record = this.#db.createApproval({
      threadId,
      turnRunId,
      toolCallId: null,
      projectId: thread.projectId,
      kind,
      title: input.title,
      description: input.description,
      scope: this.#config.desktop.approvals,
      riskLevel: input.riskLevel,
      approvalKey,
      payloadJson: JSON.stringify(input.payload),
      status: "pending",
      expiresAt: requiresExplicitAuthorization ? null : new Date(Date.now() + INTERACTION_TIMEOUT_MS).toISOString()
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
    input: { prompt: string; role: string; modelId?: string; providerId?: string; contextFork?: "none" | "all" | "recent"; reasoningEffort?: ReasoningEffort; serviceTier?: string; systemOverride?: boolean }
  ): Promise<{ threadId: string; agentPath: string; status: ThreadRecord["status"]; reused?: boolean; queued?: boolean }> {
    const parent = this.#db.getThread(parentThreadId);
    if (parent.multiAgentMode === "disabled" && !input.systemOverride) {
      throw new Error("Multi-agent delegation is disabled for this task.");
    }
    const tree = this.#db.listAgentTree(parent.rootThreadId);
    const root = this.#db.getThread(parent.rootThreadId);
    const latestRootUserMessage = this.#db.getLatestMessage(root.id, "user");
    const assignedPrompt = normalizeSubagentMcpPolicy(input.prompt, {
      projectMode: parent.mode === "project" && Boolean(parent.cwd),
      userExplicitlyForbidsMcp: isExplicitMcpProhibition(latestRootUserMessage?.content ?? "")
    });
    const normalizedInput = assignedPrompt === input.prompt ? input : { ...input, prompt: assignedPrompt };
    const delegatedForCurrentRequest = this.getCurrentRequestSubagents(root, tree);
    const depth = Math.max(0, parent.agentPath.split("/").filter(Boolean).length - 1);
    if (depth >= this.#config.multiAgent.maxDepth) {
      throw new Error(`Maximum child-agent depth (${this.#config.multiAgent.maxDepth}) reached.`);
    }
    if (delegatedForCurrentRequest.length >= this.#config.multiAgent.maxSubagentsPerRoot) {
      throw new Error(`Maximum child-agent count (${this.#config.multiAgent.maxSubagentsPerRoot}) reached for this user request.`);
    }
    const duplicate = delegatedForCurrentRequest.find((item) => isOverlappingSubagentAssignment(normalizedInput, item));
    if (duplicate) {
      return { threadId: duplicate.id, agentPath: duplicate.agentPath, status: duplicate.status, reused: true };
    }

    const activeCount = tree.filter((item) =>
      item.id !== parent.rootThreadId && this.isSubagentActive(item) && !this.#db.isSubagentPendingDispatch(item.id)
    ).length;
    const childCapacity = Math.max(1, this.#config.multiAgent.maxConcurrentSubagents - 1);
    const queued = activeCount >= childCapacity;

    await this.refreshSkills(parent.cwd);
    const role = normalizeAgentSegment(input.role);
    const requestedModelId = input.modelId?.trim();
    const requestedProviderId = input.providerId?.trim();
    const configuredModelId = this.#config.multiAgent.defaultModelId?.trim();
    const configuredProviderId = this.#config.multiAgent.defaultProviderId?.trim();
    const reasoningModels = this.#config.models.filter((model) => model.role === "reasoning");
    const selectModel = (modelId: string | undefined, providerId?: string) => {
      if (!modelId) return undefined;
      const candidates = reasoningModels.filter((model) => model.id === modelId);
      if (providerId) return candidates.find((model) => model.providerId === providerId);
      return candidates.find((model) => model.providerId === parent.providerId) ?? candidates[0];
    };
    // Explicit choice wins. A configured default follows it; without either,
    // child agents inherit the exact model and provider from their parent.
    const selectedModel = selectModel(requestedModelId, requestedProviderId)
      ?? selectModel(configuredModelId, configuredProviderId);
    const siblingPaths = new Set(this.#db.listChildThreads(parent.id).map((item) => item.agentPath));
    let suffix = 1;
    let agentPath = `${parent.agentPath}/${role}`;
    while (siblingPaths.has(agentPath)) {
      suffix += 1;
      agentPath = `${parent.agentPath}/${role}-${suffix}`;
    }
    const thread = this.#db.createThread({
      title: `${input.role}: ${assignedPrompt.slice(0, 40)}`,
      mode: parent.mode,
      workspaceKind: parent.workspaceKind,
      cwd: parent.cwd,
      workspaceRoots: parent.workspaceRoots ?? (parent.cwd ? [parent.cwd] : []),
      modelId: selectedModel?.id ?? parent.modelId,
      providerId: selectedModel?.providerId ?? parent.providerId,
      parentThreadId: parent.id,
      rootThreadId: parent.rootThreadId,
      agentPath,
      agentRole: input.role,
      lastTaskMessage: assignedPrompt,
      gpaStateJson: parent.gpaStateJson ?? JSON.stringify({ fullAccess: true }),
      multiAgentMode: parent.multiAgentMode,
      status: queued ? "idle" : "running"
    });
    this.#db.updateThread(thread.id, {
      selectedSkillIds: parent.selectedSkillIds,
      selectedPluginIds: parent.selectedPluginIds,
      knowledgeBaseIds: parent.knowledgeBaseIds
    });
    const contextFork = input.contextFork ?? this.#config.multiAgent.defaultContextFork ?? "all";
    const parentMessages = contextFork === "none" ? [] : this.#db.listMessages(parent.id).slice(contextFork === "recent" ? -6 : -24);
    if (queued) {
      this.#db.markSubagentPendingDispatch(thread.id, parent.rootThreadId);
    }
    await this.sendMessage(
      thread.id,
      buildChildAgentPrompt(parent, thread, assignedPrompt, parentMessages.map((message) => `${message.role}: ${message.content}`).join("\n").slice(-12_000)),
      [],
      undefined,
      !queued
    );
    await this.emitAgentTreeUpdated(parent.rootThreadId);
    return { threadId: thread.id, agentPath: thread.agentPath, status: thread.status, queued };
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
    const watchdog = this.#subagentProgress.get(thread.id);
    const status = watchdog?.interruptionReason
      ? "interrupted"
      : thread.status === "running" || thread.status === "waiting"
      ? thread.status
      : hasQueuedMessage
        ? "queued"
        : latestTurn?.status === "interrupted"
        ? "interrupted"
        : thread.status === "idle"
          ? "queued"
          : thread.status;
    const errors = [
      ...(watchdog?.interruptionReason ? [watchdog.interruptionReason] : []),
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

  public getToolCallDetails(threadId: string, toolCallIds: string[]): ToolCallDetail[] {
    this.#db.getThread(threadId);
    const normalizedIds = toolCallIds
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .slice(0, 200);
    return this.#db.getToolCallDetails(threadId, normalizedIds);
  }

  private getSubagentBaseState(thread: ThreadRecord, currentTool: string | null, progress?: SubagentProgress): SubagentWatchdogDiagnostic["state"] {
    if (progress?.interruptionReason) return "auto_interrupted";
    if (!this.isSubagentActive(thread)) return "completed";
    if (this.#db.isSubagentPendingDispatch(thread.id)) return "queued";
    if (currentTool && progress?.isShellOrTest) return "executing_shell_test";
    if (progress?.phase === "retrying") return "retrying";
    if (progress?.phase === "awaiting_model") return "awaiting_model";
    return "starting";
  }

  private buildSubagentWatchdogDiagnostic(
    thread: ThreadRecord,
    nowMs = Date.now(),
    allowDatabaseFallback = true
  ): SubagentWatchdogDiagnostic {
    let progress = this.#subagentProgress.get(thread.id);
    const toolCalls = !progress && allowDatabaseFallback ? this.#db.listToolCalls(thread.id) : [];
    const runningTool = [...toolCalls].reverse().find((call) => call.status === "running" || call.status === "pending") ?? null;
    const latestTool = [...toolCalls].reverse().find(Boolean) ?? null;
    const latestToolEventAt = latestTool
      ? (latestTool.completedAt && Date.parse(latestTool.completedAt) > Date.parse(latestTool.startedAt)
        ? latestTool.completedAt
        : latestTool.startedAt)
      : progress?.lastToolEventAt ?? null;
    const currentTool = progress?.currentTool ?? runningTool?.toolName ?? null;
    const command = runningTool ? (() => {
      try {
        const parsed = JSON.parse(runningTool.argumentsJson) as { command?: unknown };
        return typeof parsed.command === "string" ? parsed.command : "";
      } catch {
        return "";
      }
    })() : "";
    const isShellOrTest = progress?.isShellOrTest === true || currentTool === "shell.exec"
      || currentTool === "project.verify"
      || (Boolean(command) && isUnitTestCommand(command));
    if (!progress && allowDatabaseFallback) {
      progress = {
        lastProgressAt: latestToolEventAt ?? thread.createdAt,
        lastToolEventAt: latestToolEventAt,
        currentTool,
        isShellOrTest,
        phase: currentTool
          ? (isShellOrTest ? "executing_shell_test" : "starting")
          : "awaiting_model"
      };
      this.#subagentProgress.set(thread.id, progress);
    }
    const lastProgressAt = progress?.lastProgressAt ?? latestToolEventAt ?? thread.createdAt;
    const baseState = this.getSubagentBaseState(thread, currentTool, progress);
    const decision = progress?.interruptionReason && !this.isSubagentActive(thread)
      ? {
          action: "continue" as const,
          state: "auto_interrupted" as const,
          nextInspectionAt: null,
          automaticInterruptAt: null,
          reason: progress.interruptionReason
        }
      : resolveSubagentWatchdogDecision({
      nowMs,
      startedAt: thread.createdAt,
      lastProgressAt,
      currentTool,
      isShellOrTest,
      active: this.isSubagentActive(thread),
      baseState: baseState === "stalled" || baseState === "auto_interrupted" || baseState === "completed" ? "starting" : baseState
    });
    const startedAtMs = Date.parse(thread.createdAt);
    const progressAtMs = Date.parse(lastProgressAt);
    return {
      threadId: thread.id,
      agentPath: thread.agentPath,
      state: decision.state,
      lastToolEventAt: latestToolEventAt,
      currentTool,
      isShellOrTest,
      lastProgressAt,
      startedAt: thread.createdAt,
      runtimeMs: Math.max(0, nowMs - (Number.isFinite(startedAtMs) ? startedAtMs : nowMs)),
      idleForMs: Math.max(0, nowMs - (Number.isFinite(progressAtMs) ? progressAtMs : nowMs)),
      nextInspectionAt: decision.nextInspectionAt,
      automaticInterruptAt: decision.automaticInterruptAt,
      interruptionReason: progress?.interruptionReason ?? decision.reason
    };
  }

  private async interruptSubagentForWatchdog(thread: ThreadRecord, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const progress = this.#subagentProgress.get(thread.id) ?? {
      lastProgressAt: now,
      lastToolEventAt: null,
      currentTool: null,
      isShellOrTest: false,
      phase: "starting" as const
    };
    this.#subagentProgress.set(thread.id, { ...progress, interruptionReason: reason, lastProgressAt: now });
    await this.emit({
      type: "agent.watchdog",
      threadId: thread.id,
      payload: { state: "auto_interrupted", reason, automatic: true },
      createdAt: now
    });
    await this.#logs.append("subagent.watchdog_interrupted", { threadId: thread.id, agentPath: thread.agentPath, reason }, thread.id);
    await this.interruptThread(thread.id);
  }

  public async sendAgentMessage(parentThreadId: string, input: { agent: string; message: string }): Promise<SubagentResultEnvelope> {
    const child = this.resolveAgent(parentThreadId, input.agent);
    await this.sendMessage(child.id, input.message, [], undefined, false);
    await this.emitAgentTreeUpdated(child.rootThreadId);
    return this.buildSubagentEnvelope(child);
  }

  public async followupAgentTask(parentThreadId: string, input: { agent: string; prompt: string }): Promise<SubagentResultEnvelope> {
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
    const timeoutMs = Math.min(30_000, Math.max(250, Math.round(input.timeoutMs ?? 30_000)));
    const targetIds = input.agents?.length
      ? input.agents.map((agent) => this.resolveAgent(parentThreadId, agent).id)
      : (await this.listSubagents(parentThreadId)).map((item) => item.id);
    const targetIdSet = new Set(targetIds);
    if (targetIds.length === 0) return { agents: [], timedOut: false, diagnostics: [] };
    const getTargets = () => targetIds.map((id) => this.#db.getThread(id));
    const allFinished = (agents: ThreadRecord[]) => agents.every((agent) => !this.isSubagentActive(agent));
    const initial = getTargets();
    if (allFinished(initial)) {
      return {
        agents: initial.map((item) => this.buildSubagentEnvelope(item)),
        timedOut: false,
        diagnostics: initial.map((item) => this.buildSubagentWatchdogDiagnostic(item))
      };
    }

    return new Promise<SubagentWaitResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => finish({ agents: [], timedOut: false, diagnostics: [] });
      const onRuntimeEvent = (event: RuntimeEvent) => {
        if (event.threadId && targetIdSet.has(event.threadId)) void poll();
      };
      const finish = (value: SubagentWaitResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (timeout) clearTimeout(timeout);
        input.abortSignal?.removeEventListener("abort", onAbort);
        this.#events.off("runtime-event", onRuntimeEvent);
        resolve(value);
      };
      let inspecting = false;
      let allowDatabaseFallback = true;
      const snapshot = async (timedOut: boolean, useDatabaseFallback: boolean) => {
        const agents = getTargets();
        const diagnostics = agents.map((agent) => this.buildSubagentWatchdogDiagnostic(
          agent,
          Date.now(),
          useDatabaseFallback
        ));
        return { agents, diagnostics, timedOut };
      };
      const scheduleNextPoll = (diagnostics: SubagentWatchdogDiagnostic[]) => {
        if (settled) return;
        const nextInspectionAt = diagnostics
          .map((diagnostic) => Date.parse(diagnostic.nextInspectionAt ?? ""))
          .filter((value) => Number.isFinite(value))
          .sort((left, right) => left - right)[0];
        const delay = Number.isFinite(nextInspectionAt)
          ? Math.max(250, nextInspectionAt - Date.now())
          : 1_000;
        timer = setTimeout(() => void poll(), delay);
      };
      const poll = async () => {
        if (settled || inspecting) return;
        inspecting = true;
        try {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          const observed = await snapshot(false, allowDatabaseFallback);
          allowDatabaseFallback = false;
          for (const diagnostic of observed.diagnostics) {
            if (diagnostic.state !== "stalled" && diagnostic.state !== "auto_interrupted") continue;
            const child = observed.agents.find((agent) => agent.id === diagnostic.threadId);
            if (child && this.isSubagentActive(child)) {
              await this.interruptSubagentForWatchdog(child, diagnostic.interruptionReason ?? "Subagent watchdog interrupted the task.");
            }
          }
          const final = await snapshot(false, false);
          if (allFinished(final.agents)) {
            finish({
              agents: final.agents.map((item) => this.buildSubagentEnvelope(item)),
              timedOut: false,
              diagnostics: final.diagnostics
            });
          } else {
            scheduleNextPoll(final.diagnostics);
          }
        } finally {
          inspecting = false;
        }
      };
      timeout = setTimeout(() => {
        void snapshot(true, false).then((result) => finish({
          agents: result.agents.map((item) => this.buildSubagentEnvelope(item)),
          timedOut: true,
          diagnostics: result.diagnostics
        }));
      }, timeoutMs);
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.#events.on("runtime-event", onRuntimeEvent);
      void poll();
    });
  }

  private isSubagentActive(thread: ThreadRecord): boolean {
    return thread.status === "running"
      || thread.status === "waiting"
      || this.#db.listQueuedMessages(thread.id).some((message) => message.status === "queued" || message.status === "dispatching");
  }

  private schedulePendingSubagentDispatch(rootThreadId: string): void {
    if (this.#subagentDispatches.has(rootThreadId)) return;
    const dispatch = this.dispatchPendingSubagents(rootThreadId)
      .catch(async (error) => {
        const reason = `Subagent dispatch failed: ${error instanceof Error ? error.message : String(error)}`;
        await this.#logs.append("subagent.pending_dispatch_failed", {
          rootThreadId,
          error: reason
        }, rootThreadId);
        // A failed scheduler must not leave children in a permanently queued
        // or running-looking state. Preserve their prompts and prior evidence,
        // then converge each pending child through the normal interruption path.
        for (const pending of this.#db.listSubagentPendingDispatches(rootThreadId)) {
          try {
            await this.interruptSubagentForWatchdog(this.#db.getThread(pending.threadId), reason);
          } catch (interruptError) {
            await this.#logs.append("subagent.pending_dispatch_interrupt_failed", {
              rootThreadId,
              threadId: pending.threadId,
              error: interruptError instanceof Error ? interruptError.message : String(interruptError)
            }, rootThreadId);
          }
        }
      })
      .finally(() => this.#subagentDispatches.delete(rootThreadId));
    this.#subagentDispatches.set(rootThreadId, dispatch);
  }

  private async dispatchPendingSubagents(rootThreadId: string): Promise<void> {
    const childCapacity = Math.max(1, this.#config.multiAgent.maxConcurrentSubagents - 1);
    const tree = this.#db.listAgentTree(rootThreadId);
    let activeCount = tree.filter((item) =>
      item.id !== rootThreadId && this.isSubagentActive(item) && !this.#db.isSubagentPendingDispatch(item.id)
    ).length;
    for (const pending of this.#db.listSubagentPendingDispatches(rootThreadId)) {
      if (activeCount >= childCapacity) break;
      this.#db.clearSubagentPendingDispatch(pending.threadId);
      this.#runtime.wakeQueuedMessages(pending.threadId);
      activeCount += 1;
      await this.emitAgentTreeUpdated(rootThreadId);
    }
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

  private async webSearch(_threadId: string, query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
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
        // Web search is background retrieval. Only explicit browser.* tools may
        // create a thread tab or depend on the visible Browser workspace.
        const page = await this.loadBrowserPage(provider.url);
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

  private async openPage(_threadId: string, url: string): Promise<{ title: string; url: string; text: string }> {
    // web_search.open_page extracts text without surfacing a Browser tab. This
    // keeps ordinary research silent and avoids a webview-attachment prompt.
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

  private observeSubagentRuntimeEvent(event: RuntimeEvent, subject: ThreadRecord | null): void {
    if (!subject?.parentThreadId) return;
    const now = event.createdAt;
    const previous = this.#subagentProgress.get(subject.id) ?? {
      lastProgressAt: subject.createdAt,
      lastToolEventAt: null,
      currentTool: null,
      isShellOrTest: false,
      phase: "starting" as const
    };
    if (previous.interruptionReason && event.type !== "agent.watchdog") return;

    const next: SubagentProgress = { ...previous };
    const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : null;
    if (event.type === "tool.started" && toolName) {
      let command = "";
      if (typeof event.payload.argumentsJson === "string") {
        try {
          const parsed = JSON.parse(event.payload.argumentsJson) as { command?: unknown };
          command = typeof parsed.command === "string" ? parsed.command : "";
        } catch {
          // Malformed tool arguments are still a real tool event.
        }
      }
      next.lastProgressAt = now;
      next.lastToolEventAt = now;
      next.currentTool = toolName;
      next.isShellOrTest = toolName === "shell.exec" || toolName === "project.verify" || isUnitTestCommand(command);
      next.phase = next.isShellOrTest ? "executing_shell_test" : "starting";
    } else if (event.type === "tool.completed") {
      next.lastProgressAt = now;
      next.lastToolEventAt = now;
      next.currentTool = null;
      next.isShellOrTest = false;
      next.phase = "awaiting_model";
    } else if (event.type === "terminal.output") {
      // Output is deliberately not persisted again here. Its timestamp is
      // enough to prove that a shell/test process made observable progress.
      next.lastProgressAt = now;
    } else if (event.type === "agent.awaiting_model") {
      next.lastProgressAt = now;
      next.currentTool = null;
      next.isShellOrTest = false;
      next.phase = "awaiting_model";
    } else if (event.type === "agent.retrying") {
      next.lastProgressAt = now;
      next.phase = "retrying";
    } else if (event.type === "agent.watchdog") {
      next.lastProgressAt = now;
      next.interruptionReason = typeof event.payload.reason === "string"
        ? event.payload.reason
        : previous.interruptionReason;
    } else {
      return;
    }
    this.#subagentProgress.set(subject.id, next);
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
    this.observeSubagentRuntimeEvent(event, subject);
    const routedEvent: RuntimeEvent = subject?.parentThreadId
      ? {
          ...event,
          notificationThreadId: subject.rootThreadId,
          notificationChildThreadId: subject.id
        }
      : event;

    const boundedEvent = compactRuntimeToolResult(routedEvent);
    this.#db.addRuntimeEvent(boundedEvent);
    this.#events.emit("runtime-event", boundedEvent);
    if (boundedEvent.type === "thread.updated") {
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
    const sanitizedEvent = sanitizeRuntimeEventForLog(boundedEvent);
    const runtimeLogEntry: RuntimeLogEntry = {
      timestamp: boundedEvent.createdAt,
      kind: "runtime.event",
      threadId: boundedEvent.threadId,
      payload: { event: sanitizedEvent }
    };
    if (boundedEvent.type !== "assistant.draft.updated" || this.#config.desktop.llmLogViewer) {
      // Runtime delivery must not wait for disk I/O. RuntimeLogWriter keeps
      // ordering and flushes the batch before readers or shutdown continue.
      void this.#logs.append("runtime.event", runtimeLogEntry.payload, boundedEvent.threadId);
    }
    this.emitLiveRuntimeLog(runtimeLogEntry);
    if (subject?.parentThreadId && (boundedEvent.type === "thread.updated" || boundedEvent.type === "queue.updated")) {
      this.schedulePendingSubagentDispatch(subject.rootThreadId);
    }
  }

  private emitLiveRuntimeLog(entry: RuntimeLogEntry): void {
    if (!this.#config.desktop.llmLogViewer) return;
    this.#events.emit("runtime-event", {
      type: "runtime.log",
      threadId: entry.threadId,
      payload: { entry },
      createdAt: entry.timestamp
    } satisfies RuntimeEvent);
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
    void this.#mcp.warmToolCache().catch(async (error) => {
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

  public async getThreadOutputDir(threadId: string): Promise<string> {
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

  private async emitTerminalOutput(
    threadId: string,
    data: string,
    sessionId = "default",
    heartbeat?: TerminalOutputHeartbeat,
    input?: string
  ): Promise<void> {
    await this.emit({
      type: "terminal.output",
      threadId,
      // This is also a heartbeat for the subagent watchdog. Keep the visible
      // output behavior intact while exposing only compact progress metadata.
      payload: {
        data,
        sessionId,
        progress: true,
        byteLength: heartbeat?.byteLength ?? Buffer.byteLength(data, "utf8"),
        inputPreview: compactTerminalInput(input)
      },
      createdAt: heartbeat?.occurredAt ?? new Date().toISOString()
    });
  }

  private getProjectDirectory(threadId: string, requestedRoot?: string): string {
    const thread = this.#db.getThread(threadId);
    if (!thread.cwd) {
      throw new Error("This task does not have a project folder.");
    }
    if (!requestedRoot) return path.resolve(thread.cwd);
    const resolved = normalizeWorkspaceRoot(requestedRoot);
    const match = (thread.workspaceRoots ?? (thread.cwd ? [thread.cwd] : [])).find((root) => sameWorkspacePath(root, resolved));
    if (!match) throw new Error("The selected folder is not part of this collaboration task.");
    return path.resolve(match);
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
          await this.openBrowserTab(threadId, url);
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

function normalizeWorkspaceRoot(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("协作目录不能为空。");
  if (!path.isAbsolute(value.trim())) throw new Error("协作目录必须使用绝对路径。");
  return path.resolve(value.trim());
}

function workspaceComparisonKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function sameWorkspacePath(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && workspaceComparisonKey(left) === workspaceComparisonKey(right));
}

async function validateWorkspaceRoots(values: string[]): Promise<string[]> {
  const roots = values.map(normalizeWorkspaceRoot);
  for (const [index, root] of roots.entries()) {
    const stats = await fs.stat(root).catch(() => null);
    if (!stats?.isDirectory()) throw new Error(`协作目录不可访问：${root}`);
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = roots[otherIndex];
      if (sameWorkspacePath(root, other)) throw new Error(`协作目录重复：${root}`);
      const relativeToOther = path.relative(other, root);
      const relativeToRoot = path.relative(root, other);
      const nested = (relativeToOther && !relativeToOther.startsWith(`..${path.sep}`) && relativeToOther !== ".." && !path.isAbsolute(relativeToOther))
        || (relativeToRoot && !relativeToRoot.startsWith(`..${path.sep}`) && relativeToRoot !== ".." && !path.isAbsolute(relativeToRoot));
      if (nested) throw new Error(`协作目录不能互相包含：${root}`);
    }
  }
  return roots;
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
  const nextModels = (models.length ? models : fallback.models).map((model) => withGptReasoningCapabilities({
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
    responseTone: normalizeResponseTone(config.responseTone),
    reasoningEffort: isGptReasoningEffort(config.reasoningEffort) ? config.reasoningEffort : "medium",
    providers,
    models: nextModels,
    multimodal: {
      image: normalizeMultimodalDefaults(config.multimodal?.image, nextModels, "image"),
      video: normalizeMultimodalDefaults(config.multimodal?.video, nextModels, "video"),
      input: normalizeMultimodalInputDefaults(config.multimodal?.input, nextModels)
    },
    desktop: {
      ...fallback.desktop,
      ...config.desktop,
      browserOpenMode: config.desktop?.browserOpenMode === "external_default" ? "external_default" : "in_app",
      silentBrowserOpen: config.desktop?.silentBrowserOpen !== false,
      liveEditPreview: config.desktop?.liveEditPreview === true,
      llmLogViewer: config.desktop?.llmLogViewer === true
    },
    projectExecutionPolicies: config.projectExecutionPolicies ?? {},
    multiAgent: {
      defaultMode: config.multiAgent?.defaultMode === "disabled" ? "disabled" : "proactive",
      maxConcurrentSubagents: Math.min(8, Math.max(2, Math.round(config.multiAgent?.maxConcurrentSubagents ?? fallback.multiAgent.maxConcurrentSubagents))),
      maxSubagentsPerRoot: Math.min(16, Math.max(1, Math.round(config.multiAgent?.maxSubagentsPerRoot ?? fallback.multiAgent.maxSubagentsPerRoot))),
      maxDepth: Math.min(6, Math.max(1, Math.round(config.multiAgent?.maxDepth ?? fallback.multiAgent.maxDepth))),
      childWritePolicy: config.multiAgent?.childWritePolicy === "read-only" ? "read-only" : "inherit",
      defaultContextFork: config.multiAgent?.defaultContextFork ?? "all",
      defaultModelId: config.multiAgent?.defaultModelId,
      defaultProviderId: config.multiAgent?.defaultProviderId,
      defaultReasoningEffort: config.multiAgent?.defaultReasoningEffort ?? "medium"
    },
    selfImprovement: config.selfImprovement ?? fallback.selfImprovement,
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

function buildChildAgentPrompt(parent: ThreadRecord, child: ThreadRecord, prompt: string, inheritedContext = ""): string {
  return [
    `[Internal child-agent task ${child.agentPath}]`,
    `Parent agent: ${parent.agentPath}`,
    "You are a bounded child agent. Work independently on the assigned task and return a concise structured result.",
    "You share the parent workspace and inherit its permission policy. Use the normal approval flow for any action that requires approval.",
    "Include summary, concrete evidence (paths, symbols, or commands inspected), and errors or uncertainty.",
    "Assigned task:",
    prompt,
    ...(inheritedContext ? ["Inherited parent context:", inheritedContext] : [])
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
  const hasConfiguredDefault = Boolean(defaultProviderId || defaultModelId);
  const ok = candidates.some(
    (model) => model.id === defaultModelId && model.providerId === defaultProviderId
  );
  if (hasConfiguredDefault && !ok) {
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

/** Fields that affect the MCP manager's stored config (not necessarily the connection). */
function mcpServerConfigShape(server: McpServerConfig): string {
  return JSON.stringify({
    id: server.id,
    name: server.name ?? null,
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? {},
    cwd: server.cwd ?? null,
    url: server.url ?? null,
    transport: server.transport ?? null,
    auth: server.auth ?? null,
    enabled: server.enabled !== false,
    defaultToolsApprovalMode: server.defaultToolsApprovalMode ?? "prompt",
    tools: server.tools ?? {}
  });
}

function areMcpServerConfigsEqual(a: McpServerConfig[], b: McpServerConfig[]): boolean {
  if (a.length !== b.length) return false;
  const shapeOf = (list: McpServerConfig[]) =>
    list.map((server) => ({ id: server.id, shape: mcpServerConfigShape(server) }))
      .sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify(shapeOf(a)) === JSON.stringify(shapeOf(b));
}

/**
 * Mirrors the fields McpManager's connectionFingerprint uses (plus `enabled`).
 * When none of these change, existing connections stay valid and refresh() is a no-op.
 */
function mcpConnectionSettingsChanged(a: McpServerConfig[], b: McpServerConfig[]): boolean {
  const connShape = (server: McpServerConfig) => JSON.stringify({
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? {},
    cwd: server.cwd ?? null,
    url: server.url ?? null,
    transport: server.transport ?? null,
    auth: server.auth ?? null,
    enabled: server.enabled !== false
  });
  const previous = new Map(a.map((server) => [server.id, connShape(server)]));
  if (previous.size !== b.length) return true;
  return b.some((server) => previous.get(server.id) !== connShape(server));
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
  kind?: ApprovalRequest["kind"];
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
