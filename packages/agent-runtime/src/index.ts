import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  ArtifactRecord,
  McpServerConfig,
  MessageRecord,
  ModelProfile,
  ProviderTurnInput,
  RuntimeEvent,
  RuntimePromptBundle,
  RuntimeThreadSnapshot,
  SkillMetadata,
  ThreadRecord,
  ToolCallRecord,
  ToolResult,
  TurnRunRecord
} from "@shared-types";
import { buildDecisionSystemPrompt, ProviderFactory } from "@provider-adapters";
import { SkillsManager } from "@skills-runtime";
import { McpManager } from "@mcp-runtime";
import { ToolRuntime } from "@tool-runtime";
import {
  buildGpaSystemDirective,
  DEFAULT_GPA_STATE,
  detectGpaConfirmation,
  gpaStageAllowsTools,
  gpaStageLabel,
  nextStageAfterConfirmation,
  parseGpaState
} from "./gpa";
import type { GpaStage, GpaState } from "@shared-types";

export { parseGpaState } from "./gpa";

type Submission =
  | { type: "user_input"; content: string }
  | { type: "interrupt" }
  | { type: "approval_response"; requestId: string; approved: boolean }
  | { type: "user_input_response"; promptId: string; answers: Record<string, string> }
  | { type: "shutdown" };

interface RuntimePersistence {
  getThread(threadId: string): Promise<ThreadRecord>;
  updateThread(threadId: string, patch: Partial<ThreadRecord>): Promise<ThreadRecord>;
  listMessages(threadId: string): Promise<MessageRecord[]>;
  createMessage(input: Omit<MessageRecord, "id" | "createdAt">): Promise<MessageRecord>;
  startTurn(input: Omit<TurnRunRecord, "id" | "startedAt" | "completedAt">): Promise<TurnRunRecord>;
  finishTurn(turnRunId: string, patch: Partial<TurnRunRecord>): Promise<void>;
  recordToolCall(
    input: Omit<ToolCallRecord, "id" | "startedAt" | "completedAt">
  ): Promise<ToolCallRecord>;
  finishToolCall(id: string, patch: Partial<ToolCallRecord>): Promise<void>;
  listToolCalls(threadId: string): Promise<ToolCallRecord[]>;
  listThreadArtifacts(threadId: string): Promise<ArtifactRecord[]>;
  addArtifact(input: Omit<ArtifactRecord, "id" | "createdAt">): Promise<ArtifactRecord>;
  addRuntimeEvent(event: RuntimeEvent): Promise<void>;
}

interface RuntimeServices {
  config: AppConfig;
  skills: SkillsManager;
  toolRuntime: ToolRuntime;
  providerFactory: ProviderFactory;
  mcp: McpManager;
  persistence: RuntimePersistence;
  buildKnowledgeContext(threadId: string): Promise<string | null>;
  buildWorkflowPackContext(threadId: string): Promise<string | null>;
  getEnabledPluginIdsForThread(threadId: string): Promise<string[]>;
  getAccessibleMcpServerIdsForThread(threadId: string): Promise<string[]>;
  listKnowledgeBases(threadId: string): Promise<any[]>;
  searchKnowledge(query: string, knowledgeBaseIds?: string[]): Promise<any[]>;
  readKnowledgeConcept(conceptId: string): Promise<any | null>;
  listFiles(dir: string): Promise<string[]>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  requestApproval(threadId: string, turnRunId: string, input: {
    title: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    payload: Record<string, unknown>;
  }): Promise<boolean>;
  requestUserInput(threadId: string, turnRunId: string, input: {
    title: string;
    questions: Array<{ id: string; label: string; prompt: string; options?: string[] }>;
  }): Promise<Record<string, string>>;
  spawnChildAgent(parentThreadId: string, input: {
    prompt: string;
    role: string;
    modelId?: string;
  }): Promise<string>;
  webSearch(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
  openPage(threadId: string, url: string): Promise<{ title: string; url: string; text: string }>;
  findInPage(url: string, pattern: string): Promise<string[]>;
  listBrowserTabs(threadId: string): Promise<any[]>;
  openBrowserTab(threadId: string, url: string): Promise<any>;
  navigateBrowserTab(threadId: string, tabId: string, url: string): Promise<any>;
  reloadBrowserTab(threadId: string, tabId: string): Promise<any>;
  goBackBrowserTab(threadId: string, tabId: string): Promise<any>;
  goForwardBrowserTab(threadId: string, tabId: string): Promise<any>;
  focusBrowserTab(threadId: string, tabId: string): Promise<any>;
  readBrowserPageText(threadId: string, tabId: string): Promise<any>;
  captureBrowserSnapshot(threadId: string, tabId: string, turnRunId: string): Promise<any>;
  getThreadOutputDir(threadId: string): Promise<string>;
  listMcpResources(server?: string): Promise<any[]>;
  listMcpResourceTemplates(server?: string): Promise<any[]>;
  readMcpResource(server: string, uri: string): Promise<any>;
  callMcpTool(server: string, tool: string, argumentsJson: Record<string, unknown>): Promise<any>;
  emit(event: RuntimeEvent): Promise<void>;
}

class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #resolvers: Array<(value: T) => void> = [];

  public push(value: T): void {
    const resolver = this.#resolvers.shift();
    if (resolver) {
      resolver(value);
      return;
    }
    this.#values.push(value);
  }

  public async take(): Promise<T> {
    const value = this.#values.shift();
    if (value) {
      return value;
    }
    return new Promise((resolve) => this.#resolvers.push(resolve));
  }
}

class ThreadSessionRuntime {
  readonly #queue = new AsyncQueue<Submission>();
  readonly #abortController = new AbortController();
  #activeTurnRunId: string | null = null;
  #pendingInput: string[] = [];
  #running = false;
  #gpa: GpaState = { ...DEFAULT_GPA_STATE };
  #gpaLoaded = false;

  public constructor(
    private readonly threadId: string,
    private readonly services: RuntimeServices
  ) {}

  public start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    void this.submissionLoop();
  }

  public submit(input: Submission): void {
    this.#queue.push(input);
  }

  public stop(): void {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    this.#queue.push({ type: "shutdown" });
  }

  async #ensureGpa(): Promise<GpaState> {
    if (this.#gpaLoaded) {
      return this.#gpa;
    }
    const thread = await this.services.persistence.getThread(this.threadId);
    this.#gpa = parseGpaState(thread.gpaStateJson);
    this.#gpaLoaded = true;
    return this.#gpa;
  }

  async #commitGpa(next: GpaState): Promise<void> {
    this.#gpa = next;
    await this.services.persistence.updateThread(this.threadId, {
      gpaStateJson: JSON.stringify(next)
    });
    await this.services.emit({
      type: "gpa.updated",
      threadId: this.threadId,
      payload: { gpa: next },
      createdAt: new Date().toISOString()
    });
  }

  public async setGpaStage(stage: GpaStage): Promise<void> {
    await this.#ensureGpa();
    await this.#commitGpa({
      ...this.#gpa,
      stage,
      awaitingConfirmation: null,
      updatedAt: new Date().toISOString()
    });
  }

  public getGpa(): GpaState {
    return this.#gpa;
  }

  async submissionLoop(): Promise<void> {
    while (true) {
      const submission = await this.#queue.take();
      if (submission.type === "shutdown") {
        break;
      }
      if (submission.type === "interrupt") {
        this.#abortController.abort();
        continue;
      }
      if (submission.type === "approval_response" || submission.type === "user_input_response") {
        continue;
      }
      if (this.#activeTurnRunId && submission.type === "user_input") {
        this.#pendingInput.push(submission.content);
        continue;
      }
      if (submission.type === "user_input") {
        await this.runTurn(submission.content);
      }
    }
  }

  private async runTurn(initialInput: string): Promise<void> {
    const thread = await this.services.persistence.getThread(this.threadId);
    const enabledPluginIds = await this.services.getEnabledPluginIdsForThread(this.threadId);
    const accessibleMcpServerIds = await this.services.getAccessibleMcpServerIdsForThread(
      this.threadId
    );
    const visibleKnowledgeBases = await this.services.listKnowledgeBases(this.threadId);
    const visibleKnowledgeBaseIds = visibleKnowledgeBases.map((entry: { id: string }) => entry.id);
    const model = resolveModel(this.services.config, thread.modelId);
    const provider = resolveProvider(this.services.config, thread.providerId);
    const selectedSkills = this.services.skills.selectForThread({
      explicitSkillIds: thread.selectedSkillIds,
      query: initialInput,
      allowedPluginIds: enabledPluginIds
    });
    const skillContext = this.services.skills.buildContext(selectedSkills);
    const skillDependencyWarnings = buildSkillDependencyWarnings(
      selectedSkills,
      this.services.mcp.listConfigs(),
      accessibleMcpServerIds
    );
    const knowledgeContext = await this.services.buildKnowledgeContext(this.threadId);
    const workflowPackContext = await this.services.buildWorkflowPackContext(this.threadId);
    const tools = await this.buildVisibleTools(accessibleMcpServerIds);
    const turn = await this.services.persistence.startTurn({
      threadId: this.threadId,
      kind: "regular",
      status: "running",
      providerId: provider.id,
      modelId: model.id,
      resolvedModelSnapshotJson: JSON.stringify(model),
      promptTokens: 0,
      completionTokens: 0,
      errorMessage: null
    });

    this.#activeTurnRunId = turn.id;
    await this.services.persistence.updateThread(this.threadId, {
      status: "running",
      updatedAt: new Date().toISOString()
    });
    await this.recordMessage("user", initialInput, turn.id);

    const history = await this.services.persistence.listMessages(this.threadId);

    // 简短确认语（确认/OK/开始等）按 doc/GPA.md 推进阶段：GOAL→PLAN→ACT
    await this.#ensureGpa();
    if (
      detectGpaConfirmation(initialInput) &&
      (this.#gpa.stage === "goal" || this.#gpa.stage === "plan")
    ) {
      const advanced = nextStageAfterConfirmation(this.#gpa.stage);
      await this.#commitGpa({
        ...this.#gpa,
        stage: advanced,
        awaitingConfirmation: null,
        updatedAt: new Date().toISOString()
      });
    }

    try {
      let transcript = compactTranscript(history);
      let rounds = 0;

      while (rounds < 8) {
        rounds += 1;
        const prompt = buildRuntimePrompt(
          model,
          skillContext,
          knowledgeContext,
          workflowPackContext,
          skillDependencyWarnings
        );
        const adapter = this.services.providerFactory.create(provider);
        let streamedVisibleContent = "";
        const decision = await adapter.runTurn({
          systemPrompt: `${buildDecisionSystemPrompt(model)}\n\n${prompt.systemPrompt}${
            buildGpaSystemDirective(this.#gpa) || ""
          }`,
          transcript,
          availableTools: tools,
          model,
          provider,
          stream: model.supportsStreaming,
          onTextDelta: async (delta) => {
            streamedVisibleContent += delta;
            await this.services.emit({
              type: "assistant.delta",
              threadId: this.threadId,
              payload: {
                turnRunId: turn.id,
                delta,
                content: streamedVisibleContent
              },
              createdAt: new Date().toISOString()
            });
          },
          abortSignal: this.#abortController.signal
        });

        // 代码级强制：GOAL/PLAN 阶段严禁工具调用，拦截并提示模型用文字回应
        if (!gpaStageAllowsTools(this.#gpa) && decision.toolCalls.length > 0) {
          const blockedNote = `⚠️ GPA 约束：当前处于【${gpaStageLabel(
            this.#gpa.stage
          )}】阶段，系统已拦截本次全部工具调用。请仅用文字输出本阶段要求的内容，并在结尾给出 ⏳ 等待确认。`;
          transcript.push({ role: "user", content: blockedNote });
          decision.toolCalls = [];
        }

        if (decision.assistantMessage) {
          const assistantMessage = await this.recordMessage("assistant", decision.assistantMessage, turn.id);
          transcript.push({ role: "assistant", content: assistantMessage.content });
          if (streamedVisibleContent) {
            await this.services.emit({
              type: "assistant.completed",
              threadId: this.threadId,
              payload: { turnRunId: turn.id, messageId: assistantMessage.id },
              createdAt: new Date().toISOString()
            });
          }
        }

        if (decision.toolCalls.length === 0 && decision.endTurn && this.#pendingInput.length === 0) {
          await this.services.persistence.finishTurn(turn.id, {
            status: "completed",
            completedAt: new Date().toISOString()
          });
          await this.services.persistence.updateThread(this.threadId, {
            status: "completed",
            updatedAt: new Date().toISOString()
          });
          break;
        }

        for (const toolCall of decision.toolCalls) {
          const browserTabs = await this.services.listBrowserTabs(this.threadId);
          const toolRecord = await this.services.persistence.recordToolCall({
            threadId: this.threadId,
            turnRunId: turn.id,
            toolName: toolCall.name,
            argumentsJson: JSON.stringify(toolCall.arguments),
            resultJson: null,
            status: "running",
            riskLevel: "medium",
            approvalMode: this.services.config.desktop.approvals
          });

          await this.services.emit({
            type: "tool.started",
            threadId: this.threadId,
            payload: {
              toolCallId: toolRecord.id,
              toolName: toolCall.name
            },
            createdAt: new Date().toISOString()
          });

          const result = await this.services.toolRuntime.execute(toolCall, {
            cwd: thread.cwd ?? process.cwd(),
            appHome: "",
            threadId: this.threadId,
            turnRunId: turn.id,
            approvalMode: this.services.config.desktop.approvals,
            browserTabs,
            knowledgeBases: visibleKnowledgeBases,
            searchKnowledge: (query, knowledgeBaseIds) =>
              this.services.searchKnowledge(query, knowledgeBaseIds ?? visibleKnowledgeBaseIds),
            readKnowledgeConcept: this.services.readKnowledgeConcept,
            listFiles: this.services.listFiles,
            readFile: this.services.readFile,
            writeFile: this.services.writeFile,
            requestApproval: (input) => this.services.requestApproval(this.threadId, turn.id, input),
            requestUserInput: (input) => this.services.requestUserInput(this.threadId, turn.id, input),
            spawnChildAgent: (input) => this.services.spawnChildAgent(this.threadId, input),
            webSearch: this.services.webSearch,
            openPage: (url) => this.services.openPage(this.threadId, url),
            findInPage: this.services.findInPage,
            listBrowserTabs: () => this.services.listBrowserTabs(this.threadId),
            openBrowserTab: (url) => this.services.openBrowserTab(this.threadId, url),
            navigateBrowserTab: (tabId, url) => this.services.navigateBrowserTab(this.threadId, tabId, url),
            reloadBrowserTab: (tabId) => this.services.reloadBrowserTab(this.threadId, tabId),
            goBackBrowserTab: (tabId) => this.services.goBackBrowserTab(this.threadId, tabId),
            goForwardBrowserTab: (tabId) => this.services.goForwardBrowserTab(this.threadId, tabId),
            focusBrowserTab: (tabId) => this.services.focusBrowserTab(this.threadId, tabId),
            readBrowserPageText: (tabId) => this.services.readBrowserPageText(this.threadId, tabId),
            captureBrowserSnapshot: (tabId) => this.services.captureBrowserSnapshot(this.threadId, tabId, turn.id),
            getThreadOutputDir: () => this.services.getThreadOutputDir(this.threadId),
            listMcpResources: async (server) => {
              if (server) {
                assertAccessibleMcpServer(server, accessibleMcpServerIds);
                return this.services.listMcpResources(server);
              }
              return (await this.services.listMcpResources()).filter((resource) =>
                accessibleMcpServerIds.includes(resource.server)
              );
            },
            listMcpResourceTemplates: async (server) => {
              if (server) {
                assertAccessibleMcpServer(server, accessibleMcpServerIds);
                return this.services.listMcpResourceTemplates(server);
              }
              return (await this.services.listMcpResourceTemplates()).filter((template) =>
                accessibleMcpServerIds.includes(template.server)
              );
            },
            readMcpResource: async (server, uri) => {
              assertAccessibleMcpServer(server, accessibleMcpServerIds);
              return this.services.readMcpResource(server, uri);
            },
            callMcpTool: async (server, tool, argumentsJson) => {
              assertAccessibleMcpServer(server, accessibleMcpServerIds);
              return this.services.callMcpTool(server, tool, argumentsJson);
            }
          });

          await this.services.persistence.finishToolCall(toolRecord.id, {
            status: result.ok ? "completed" : "failed",
            resultJson: JSON.stringify(result),
            completedAt: new Date().toISOString()
          });
          await this.services.emit({
            type: "tool.completed",
            threadId: this.threadId,
            payload: {
              toolCallId: toolRecord.id,
              toolName: toolCall.name,
              ok: result.ok
            },
            createdAt: new Date().toISOString()
          });

          const toolMessage = await this.recordMessage(
            "tool",
            `${toolCall.name}\n${result.content}`,
            turn.id,
            { toolCallId: toolRecord.id }
          );
          transcript.push({ role: "tool", content: toolMessage.content });
        }

        if (this.#pendingInput.length > 0) {
          const pending = this.#pendingInput.splice(0, this.#pendingInput.length);
          for (const item of pending) {
            const message = await this.recordMessage("user", item, turn.id);
            transcript.push({ role: "user", content: message.content });
          }
          continue;
        }

        if (decision.endTurn && decision.toolCalls.length === 0) {
          await this.services.persistence.finishTurn(turn.id, {
            status: "completed",
            completedAt: new Date().toISOString()
          });
          await this.services.persistence.updateThread(this.threadId, {
            status: "completed",
            updatedAt: new Date().toISOString()
          });
          break;
        }
      }

      // GOAL/PLAN 阶段产出后，置为等待用户确认；ACT 阶段不挂起
      if (this.#gpa.stage === "goal" || this.#gpa.stage === "plan") {
        if (this.#gpa.awaitingConfirmation !== this.#gpa.stage) {
          await this.#commitGpa({
            ...this.#gpa,
            awaitingConfirmation: this.#gpa.stage,
            updatedAt: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      await this.services.persistence.finishTurn(turn.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      await this.services.persistence.updateThread(this.threadId, {
        status: "failed",
        updatedAt: new Date().toISOString()
      });
      throw error;
    } finally {
      this.#activeTurnRunId = null;
    }
  }

  private async buildVisibleTools(accessibleMcpServerIds: string[]) {
    await this.services.mcp.refresh(accessibleMcpServerIds);
    const mcpTools = await this.services.mcp.listToolSpecs(accessibleMcpServerIds);
    const { direct } = this.services.toolRuntime.listToolSpecs(mcpTools);
    return direct;
  }

  private async recordMessage(
    role: MessageRecord["role"],
    content: string,
    turnRunId: string,
    metadata?: Record<string, unknown>
  ): Promise<MessageRecord> {
    const message = await this.services.persistence.createMessage({
      threadId: this.threadId,
      turnRunId,
      role,
      content,
      metadataJson: metadata ? JSON.stringify(metadata) : null
    });
    await this.services.emit({
      type: "message.created",
      threadId: this.threadId,
      payload: { message },
      createdAt: new Date().toISOString()
    });
    return message;
  }
}

export class AgentRuntimeService {
  readonly #sessions = new Map<string, ThreadSessionRuntime>();

  public constructor(private readonly services: RuntimeServices) {}

  public ensureThread(threadId: string): ThreadSessionRuntime {
    const existing = this.#sessions.get(threadId);
    if (existing) {
      return existing;
    }
    const runtime = new ThreadSessionRuntime(threadId, this.services);
    runtime.start();
    this.#sessions.set(threadId, runtime);
    return runtime;
  }

  public submitUserInput(threadId: string, content: string): void {
    this.ensureThread(threadId).submit({ type: "user_input", content });
  }

  public interrupt(threadId: string): void {
    this.ensureThread(threadId).submit({ type: "interrupt" });
  }

  public async setGpaStage(threadId: string, stage: GpaStage): Promise<void> {
    const runtime = this.ensureThread(threadId);
    await runtime.setGpaStage(stage);
  }

  public getGpa(threadId: string): GpaState {
    return this.ensureThread(threadId).getGpa();
  }

  public forgetThread(threadId: string): void {
    const runtime = this.#sessions.get(threadId);
    if (!runtime) {
      return;
    }
    runtime.stop();
    this.#sessions.delete(threadId);
  }
}

function buildRuntimePrompt(
  model: ModelProfile,
  skillContext: RuntimePromptBundle["skillContext"],
  knowledgeContext: string | null,
  workflowPackContext: string | null,
  skillDependencyWarnings: string[]
): RuntimePromptBundle {
  const blocks = [
    "You are codexh, a desktop agent for project and chat workflows.",
    "Prefer progressive disclosure: inspect facts before making edits.",
    "When a tool can gather needed facts, call it instead of guessing.",
    "Respond as an IDE software engineering agent using an event stream format.",
    "Your visible output is consumed by a renderer that understands structured event blocks.",
    "Prefer XML-like event envelopes when possible: <event type=\"commentary\">...</event>.",
    "Allowed event types: commentary, tool_call, tool_result, file_view, file_change, test_result, final.",
    "Before substantial work emit 1-2 sentences of commentary. After each tool use, summarize with tool_result. When surfacing files, use file_view or file_change. Use test_result for validation. End with a concise final covering result, verification, and risks.",
    "Do not expose chain-of-thought. Do not fabricate tool usage, file changes, or verification.",
    `Context window: ${model.contextWindow}.`
  ];
  if (skillContext?.text) {
    blocks.push(skillContext.text);
  }
  if (knowledgeContext) {
    blocks.push("## Knowledge", knowledgeContext);
  }
  if (workflowPackContext) {
    blocks.push("## Workflow Packs", workflowPackContext);
  }
  if (skillDependencyWarnings.length > 0) {
    blocks.push("## MCP Dependency Warnings", skillDependencyWarnings.join("\n"));
  }
  return {
    systemPrompt: blocks.join("\n\n"),
    skillContext,
    knowledgeContext,
    workflowPackContext
  };
}

function compactTranscript(messages: MessageRecord[]): ProviderTurnInput["transcript"] {
  const maxMessages = 24;
  const visible = messages.slice(-maxMessages);
  return visible.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function resolveModel(config: AppConfig, modelId: string): ModelProfile {
  const model = config.models.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  return model;
}

function resolveProvider(config: AppConfig, providerId: string) {
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return provider;
}

function assertAccessibleMcpServer(serverId: string, accessibleServerIds: string[]): void {
  if (!accessibleServerIds.includes(serverId)) {
    throw new Error(`MCP server ${serverId} is not enabled for this thread.`);
  }
}

function buildSkillDependencyWarnings(
  skills: SkillMetadata[],
  serverConfigs: McpServerConfig[],
  accessibleServerIds: string[]
): string[] {
  const usableConfigs = serverConfigs.filter(
    (config) =>
      accessibleServerIds.includes(config.id) &&
      (config.command || (config.url && config.source !== "plugin"))
  );
  const warnings = new Set<string>();

  for (const skill of skills) {
    const missing = skill.dependencies.filter((dependency) => {
      if (dependency.type?.toLowerCase() !== "mcp") {
        return false;
      }

      const dependencyValue = dependency.value?.toLowerCase();
      const dependencyUrl = dependency.url?.toLowerCase();
      return !usableConfigs.some((config) => {
        const id = config.id.toLowerCase();
        const name = config.name.toLowerCase();
        const url = config.url?.toLowerCase();
        return (
          dependencyValue === id ||
          dependencyValue === name ||
          dependencyUrl === url
        );
      });
    });

    if (missing.length === 0) {
      continue;
    }

    warnings.add(
      `- ${skill.qualifiedName}: missing MCP dependencies ${missing
        .map((dependency) => dependency.value ?? dependency.url ?? "unknown")
        .join(", ")}`
    );
  }

  return [...warnings];
}
