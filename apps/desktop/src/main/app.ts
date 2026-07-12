import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as cheerio from "cheerio";
import { BrowserWindow, shell, webContents } from "electron";
import type { WebContents } from "electron";
import type {
  AttachmentImportInput,
  AppConfig,
  ArtifactRecord,
  BrowserTabRecord,
  GpaStage,
  GpaState,
  KnowledgeBaseRecord,
  KnowledgeChunkRecord,
  KnowledgeBaseSummary,
  KnowledgeDocumentRecord,
  MessageRecord,
  MessageAttachment,
  McpServerConfig,
  ModelProfile,
  PluginRecord,
  ProviderDefinition,
  ProjectPluginBinding,
  RuntimeEvent,
  RuntimeThreadSnapshot,
  ThreadRecord,
  UserInputPrompt
} from "@shared-types";
import { AgentRuntimeService, parseGpaState } from "@agent-runtime";
import { BrowserRuntime, loadPage, type PageSnapshot } from "@browser-runtime";
import { buildOkfBundle, extractDocument } from "@knowledge-runtime";
import { McpManager } from "@mcp-runtime";
import { hashDirectory, PluginRuntime } from "@plugin-runtime";
import { ProviderFactory } from "@provider-adapters";
import { SkillsManager } from "@skills-runtime";
import { ToolRuntime } from "@tool-runtime";
import { RuntimeLogWriter } from "./runtime-log";
import { TerminalRuntime } from "./terminal-runtime";
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
  // The right-side browser is rendered by Chromium. Use the same engine for tool
  // extraction so sites that block raw HTTP clients do not return a challenge page.
  readonly #browser = new BrowserRuntime((target) => this.loadBrowserPage(target));
  readonly #plugins = new PluginRuntime();
  readonly #terminal = new TerminalRuntime();
  readonly #openedLocalUrls = new Set<string>();
  readonly #browserContents = new Map<string, WebContents>();

  #layout!: HomeLayout;
  #db!: DatabaseService;
  #config!: AppConfig;
  #runtime!: AgentRuntimeService;
  #mcp!: McpManager;
  #logs!: RuntimeLogWriter;

  public async initialize(): Promise<void> {
    this.#layout = await ensureHomeLayout();
    this.#logs = new RuntimeLogWriter(this.#layout.logsDir);
    this.#config = await loadConfig(this.#layout.configFile);
    this.#db = new DatabaseService(this.#layout.dbFile);
    this.#db.recoverInterruptedThreads();
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
      listKnowledgeBases: async (threadId) => this.listVisibleKnowledgeBases(threadId),
      searchKnowledge: async (query, ids) => this.#db.searchKnowledgeChunks(query, ids),
      readKnowledgeConcept: async (conceptId) => this.#db.getKnowledgeChunk(conceptId) ?? this.#db.getKnowledgeConcept(conceptId),
      listFiles: async (dir) =>
        (await fs.readdir(dir, { withFileTypes: true })).map((entry) => entry.name),
      readFile: async (filePath) => fs.readFile(filePath, "utf8"),
      writeFile: async (filePath, content) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      },
      runTerminalCommand: async (threadId, cwd, command) =>
        this.#terminal.execute(threadId, cwd, command, (data) => {
          void this.emitTerminalOutput(threadId, data);
        }, (url) => {
          void this.openLocalServerUrl(threadId, url);
        }),
      requestApproval: async (threadId, turnRunId, input) =>
        this.requestApproval(threadId, turnRunId, input),
      requestUserInput: async (threadId, turnRunId, input) =>
        this.requestUserInput(threadId, turnRunId, input),
      spawnChildAgent: async (parentThreadId, input) => this.spawnChildAgent(parentThreadId, input),
      webSearch: async (threadId, query) => this.webSearch(threadId, query),
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
      inspectBrowserPage: async (threadId, tabId) => this.inspectBrowserPage(threadId, tabId),
      inspectBrowserTarget: async (threadId, tabId, elementId) => this.inspectBrowserTarget(threadId, tabId, elementId),
      clickBrowserElement: async (threadId, tabId, elementId) => this.clickBrowserElement(threadId, tabId, elementId),
      fillBrowserElement: async (threadId, tabId, elementId, value) => this.fillBrowserElement(threadId, tabId, elementId, value),
      selectBrowserOption: async (threadId, tabId, elementId, value) => this.selectBrowserOption(threadId, tabId, elementId, value),
      scrollBrowserPage: async (threadId, tabId, deltaY) => this.scrollBrowserPage(threadId, tabId, deltaY),
      pressBrowserKey: async (threadId, tabId, key) => this.pressBrowserKey(threadId, tabId, key),
      waitForBrowserPage: async (threadId, tabId, input) => this.waitForBrowserPage(threadId, tabId, input),
      captureBrowserScreenshot: async (threadId, tabId, turnRunId) => this.captureBrowserScreenshot(threadId, tabId, turnRunId),
      captureBrowserSnapshot: async (threadId, tabId, turnRunId) =>
        this.captureBrowserSnapshot(threadId, tabId, turnRunId),
      getThreadOutputDir: async (threadId) => this.getThreadOutputDir(threadId),
      listMcpResources: async (server) => this.#mcp.listResources(server),
      listMcpResourceTemplates: async (server) => this.#mcp.listResourceTemplates(server),
      listMcpTools: async (server) => this.#mcp.listTools(server ? [server] : undefined),
      readMcpResource: async (server, uri) => this.#mcp.readResource(server, uri),
      callMcpTool: async (server, tool, argumentsJson) =>
        this.#mcp.callTool(server, tool, argumentsJson),
      emit: async (event) => this.emit(event),
      log: async (kind, threadId, payload) => this.#logs.append(kind, payload, threadId)
    });
    await this.#logs.append("backend.initialized", { logsDir: this.#layout.logsDir });
  }

  public onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#events.on("runtime-event", listener);
    return () => this.#events.off("runtime-event", listener);
  }

  public listThreads(): ThreadRecord[] {
    return this.#db.listThreads();
  }

  public searchThreads(query: string) {
    return this.#db.searchThreads(query);
  }

  public listMcpServers() {
    const statusById = new Map(this.#mcp.listStatuses().map((status) => [status.serverId, status]));
    return this.#mcp.listConfigs().map((server) => ({
      ...server,
      status: statusById.get(server.id) ?? { serverId: server.id, state: server.enabled ? "idle" : "disabled" }
    }));
  }

  public async testMcpServer(config: McpServerConfig) {
    return this.#mcp.testConfig({ ...config, source: "config", pluginId: undefined });
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
    this.#terminal.close(threadId);
    this.#runtime.forgetThread(threadId);
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

  public closeTerminal(threadId: string, sessionId?: string): void {
    this.#terminal.close(threadId, sessionId);
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
        const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
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

  public async readProjectFile(threadId: string, relativePath: string): Promise<{ path: string; content: string; truncated: boolean }> {
    const root = this.getProjectDirectory(threadId);
    const target = resolveProjectFilePath(root, relativePath);
    const stats = await fs.stat(target);
    if (!stats.isFile()) {
      throw new Error("The selected project entry is not a file.");
    }

    const buffer = await fs.readFile(target);
    const limit = 512_000;
    const visible = buffer.subarray(0, limit);
    const isBinary = visible.includes(0);
    return {
      path: relativePath,
      content: isBinary ? "Binary file preview is not available." : visible.toString("utf8"),
      truncated: buffer.length > limit
    };
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
      projectPlugins: this.listProjectPluginsForThread(thread),
      toolCalls: this.#db.listToolCalls(threadId),
      gpa: this.getGpaState(threadId)
    };
  }

  public getGpaState(threadId: string): GpaState {
    const thread = this.#db.getThread(threadId);
    return parseGpaState(thread.gpaStateJson);
  }

  public async setGpaStage(threadId: string, stage: GpaStage): Promise<void> {
    await this.#runtime.setGpaStage(threadId, stage);
  }

  public async setGpaFullAccess(threadId: string, fullAccess: boolean): Promise<void> {
    await this.#runtime.setGpaFullAccess(threadId, fullAccess);
  }

  public async setKnowledgeEnabled(threadId: string, knowledgeEnabled: boolean): Promise<void> {
    await this.#runtime.setKnowledgeEnabled(threadId, knowledgeEnabled);
  }

  public async sendMessage(threadId: string, content: string, attachments: MessageAttachment[] = [], displayContent?: string): Promise<void> {
    const thread = this.#db.getThread(threadId);
    if (this.#db.listMessages(threadId).length === 0) {
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

    await this.refreshSkills(thread.cwd);
    this.#runtime.submitUserInput(threadId, content, attachments, displayContent);
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
      if (inputData.byteLength > 20 * 1024 * 1024) throw new Error(`附件 ${name} 超过 20 MB 限制。`);
      const mimeType = normalizeAttachmentMimeType(input.mimeType, name);
      const isImage = mimeType.startsWith("image/");
      if (isImage && inputData.byteLength > 10 * 1024 * 1024) throw new Error(`图片 ${name} 超过 10 MB 限制。`);
      const digest = createHash("sha256").update(inputData).digest("hex");
      const extension = path.extname(name) || extensionForMimeType(mimeType);
      const absolutePath = path.join(targetDir, `${digest.slice(0, 24)}${extension.toLowerCase()}`);
      try { await fs.access(absolutePath); } catch { await fs.writeFile(absolutePath, inputData); }
      attachments.push({
        id: randomUUID(), kind: isImage ? "image" : "file", name, mimeType, absolutePath,
        sizeBytes: inputData.byteLength, source: "user"
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
      content: "此模型不支持多模态输入，无法处理本次文件、文件夹或图片附件。请切换到支持多模态的模型后重试。",
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
    this.#runtime.interrupt(threadId);
    const thread = this.#db.getThread(threadId);
    if (thread.status !== "running" && thread.status !== "waiting") {
      return;
    }
    const updated = this.#db.interruptThreadExecution(threadId);
    await this.emit({
      type: "thread.updated",
      threadId,
      payload: { thread: updated },
      createdAt: new Date().toISOString()
    });
  }

  public listSkills(): ReturnType<SkillsManager["list"]> {
    return this.#skills.list();
  }

  public async reloadSkills(cwd?: string | null): Promise<void> {
    await this.refreshSkills(cwd);
  }

  public async fetchProviderModels(input: {
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    type?: ProviderDefinition["type"];
    id?: string;
  }): Promise<{ id: string; displayName?: string }[]> {
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
      data?: Array<{ id: string; display_name?: string; name?: string; owned_by?: string }>;
      models?: Array<{ id: string; display_name?: string; name?: string }>;
    };
    const list = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];
    if (list.length === 0) {
      throw new Error("接口未返回任何模型");
    }
    return list.map((entry) => ({
      id: entry.id,
      displayName: entry.display_name ?? entry.name ?? entry.id
    }));
  }

  public async testProviderModel(input: {
    provider: ProviderDefinition;
    model: ModelProfile;
  }): Promise<{ latencyMs: number; outputTokens: number; tokensPerSecond: number }> {
    const startedAt = performance.now();
    const adapter = this.#providerFactory.create(input.provider);
    const timeout = new AbortController();
    const timeoutId = setTimeout(() => timeout.abort(), 30_000);

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
        return { latencyMs, outputTokens: 0, tokensPerSecond: 0 };
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

      return {
        latencyMs,
        outputTokens,
        tokensPerSecond: Number((outputTokens / (latencyMs / 1_000)).toFixed(2))
      };
    } catch (error) {
      if (timeout.signal.aborted) {
        throw new Error("模型测试超时（30 秒）。请检查服务地址和网络连接。");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
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
    if (!contents || contents.isDestroyed() || contents.getType() !== "webview") {
      throw new Error("Browser page is not available for automation.");
    }
    const key = this.browserContentsKey(threadId, tabId);
    this.#browserContents.set(key, contents);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.once("destroyed", () => {
      if (this.#browserContents.get(key) === contents) this.#browserContents.delete(key);
    });
  }

  public async syncBrowserWebContents(input: { threadId: string; tabId: string }): Promise<BrowserTabRecord> {
    const contents = await this.requireBrowserContents(input.threadId, input.tabId);
    const page = await this.readVisibleBrowserPage(contents, false);
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

  private async requireBrowserContents(threadId: string, tabId: string): Promise<WebContents> {
    const key = this.browserContentsKey(threadId, tabId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const contents = this.#browserContents.get(key);
      if (contents && !contents.isDestroyed()) return contents;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Browser tab is not ready. Open the Browser workspace and retry.");
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
    const tab = this.#browser.syncTab(threadId, tabId, { ...page, html: page.html ?? "" });
    this.persistBrowserTabs(threadId);
    return tab;
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

  public async captureBrowserScreenshot(threadId: string, tabId: string, turnRunId: string) {
    const contents = await this.requireBrowserContents(threadId, tabId);
    const outputDir = await this.getThreadOutputDir(threadId);
    const browserDir = path.join(outputDir, "browser");
    await fs.mkdir(browserDir, { recursive: true });
    const title = contents.getTitle() || "browser-page";
    const fileName = `${title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "page"}-${Date.now()}.png`;
    const filePath = path.join(browserDir, fileName);
    const image = await contents.capturePage();
    await fs.writeFile(filePath, image.toPNG());
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
    return { title, url: contents.getURL(), filePath, artifact };
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
    try {
      const sourcePaths = await expandKnowledgeSources(input.sourcePaths);
      // Keep the user's original folders so manual refresh can discover added files.
      const importRunId = this.#db.createKnowledgeImportRun(knowledgeBase.id, input.sourcePaths);
      const documents = await Promise.all(sourcePaths.map((sourcePath) => extractDocument(sourcePath)));
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

  public listKnowledgeBaseDocuments(knowledgeBaseId: string): KnowledgeDocumentRecord[] {
    return this.#db.listKnowledgeDocuments(knowledgeBaseId);
  }

  public async refreshKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBaseSummary> {
    const knowledgeBase = this.#db.getKnowledgeBase(knowledgeBaseId);
    if (!knowledgeBase) throw new Error("Knowledge base not found.");
    this.#db.updateKnowledgeBase(knowledgeBaseId, { status: "importing" });
    try {
      const selectedSources = this.#db.listLatestKnowledgeImportSources(knowledgeBaseId);
      const sourcePaths = await expandKnowledgeSources(selectedSources, { allowEmpty: true });
      const currentPaths = new Set(sourcePaths);
      const existing = new Map(this.#db.listKnowledgeDocuments(knowledgeBaseId).map((document) => [document.sourcePath, document]));
      for (const document of existing.values()) {
        if (!currentPaths.has(document.sourcePath)) this.#db.markKnowledgeDocumentMissing(document.id);
      }
      for (const sourcePath of sourcePaths) {
        const document = await extractDocument(sourcePath);
        const previous = existing.get(sourcePath);
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
    if (parseGpaState(thread.gpaStateJson).fullAccess) {
      return true;
    }
    const approvalKey = hashApprovalPayload({
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      payload: getApprovalScopePayload(input.payload)
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
    this.#db.addRuntimeEvent(event);
    this.#events.emit("runtime-event", event);
    if (event.type !== "assistant.delta") {
      await this.#logs.append("runtime.event", { event }, event.threadId);
    }
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
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return "";
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

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
