import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
  AppConfig,
  ArtifactRecord,
  MessageAttachment,
  McpServerConfig,
  MessageRecord,
  ModelProfile,
  ProviderTurnDecision,
  ProviderTurnInput,
  QueuedMessageRecord,
  RuntimeEvent,
  RuntimePromptBundle,
  RuntimeThreadSnapshot,
  RuntimeToolCall,
  SkillMetadata,
  ThreadRecord,
  ToolCallRecord,
  ToolResult,
  ToolSpecDefinition,
  TurnRunRecord,
  UserInputQuestion
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

export const MAX_REPEATED_TASK_FAILURES = 5;
export const MODEL_DECISION_TIMEOUT_MS = 90_000;
export const MAX_MODEL_TIMEOUT_RETRIES = 5;
export const MAX_AGENT_PROTOCOL_FAILURES = 2;
export const RECOVERY_MODEL_DECISION_TIMEOUT_MS = 20_000;
export const CONTEXT_COMPACTION_THRESHOLD = 0.8;
export const CONTEXT_COMPACTION_TARGET = 0.6;

type Submission =
  | { type: "queue_wakeup" }
  | { type: "approval_response"; requestId: string; approved: boolean }
  | { type: "user_input_response"; promptId: string; answers: Record<string, string> }
  | { type: "shutdown" };

type KnowledgeSourceReference = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  sourcePath: string;
  locator?: string;
};

type BrowserSourceReference = {
  title: string;
  url: string;
};

interface RuntimePersistence {
  getThread(threadId: string): Promise<ThreadRecord>;
  updateThread(threadId: string, patch: Partial<ThreadRecord>): Promise<ThreadRecord>;
  listMessages(threadId: string): Promise<MessageRecord[]>;
  claimNextQueuedMessage(threadId: string): Promise<QueuedMessageRecord | null>;
  completeQueuedMessage(id: string): Promise<void>;
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
  runTerminalCommand(threadId: string, cwd: string, command: string): Promise<{ output: string; localUrl?: string }>;
  requestApproval(threadId: string, turnRunId: string, input: {
    title: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    payload: Record<string, unknown>;
  }): Promise<boolean>;
  requestUserInput(threadId: string, turnRunId: string, input: {
    title: string;
    kind: "generic" | "gpa_plan_clarification";
    allowSkip: boolean;
    questions: UserInputQuestion[];
  }): Promise<Record<string, string>>;
  spawnChildAgent(parentThreadId: string, input: {
    prompt: string;
    role: string;
    modelId?: string;
  }): Promise<string>;
  webSearch(threadId: string, query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
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
  inspectBrowserPage(threadId: string, tabId: string): Promise<any>;
  inspectBrowserTarget(threadId: string, tabId: string, elementId: string): Promise<any>;
  clickBrowserElement(threadId: string, tabId: string, elementId: string): Promise<any>;
  fillBrowserElement(threadId: string, tabId: string, elementId: string, value: string): Promise<any>;
  selectBrowserOption(threadId: string, tabId: string, elementId: string, value: string): Promise<any>;
  scrollBrowserPage(threadId: string, tabId: string, deltaY: number): Promise<any>;
  pressBrowserKey(threadId: string, tabId: string, key: string): Promise<any>;
  waitForBrowserPage(threadId: string, tabId: string, input: { text?: string; elementId?: string; timeoutMs?: number }): Promise<any>;
  captureBrowserScreenshot(threadId: string, tabId: string, turnRunId: string): Promise<any>;
  captureBrowserSnapshot(threadId: string, tabId: string, turnRunId: string): Promise<any>;
  getThreadOutputDir(threadId: string): Promise<string>;
  listMcpResources(server?: string): Promise<any[]>;
  listMcpResourceTemplates(server?: string): Promise<any[]>;
  listMcpTools(server?: string): Promise<any[]>;
  readMcpResource(server: string, uri: string): Promise<any>;
  callMcpTool(server: string, tool: string, argumentsJson: Record<string, unknown>): Promise<any>;
  markModelAgentIncompatible(threadId: string, modelId: string, reason: string): Promise<void>;
  emit(event: RuntimeEvent): Promise<void>;
  log(kind: string, threadId: string, payload: Record<string, unknown>): Promise<void>;
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

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Turn interrupted.")));

    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ModelDecisionTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    super(`The model decision timed out after ${timeoutMs}ms.`);
    this.name = "ModelDecisionTimeoutError";
  }
}

function createChildAbortController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) {
    child.abort();
    return child;
  }
  parent.addEventListener("abort", () => child.abort(), { once: true });
  return child;
}

function waitForAbortOrTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      onTimeout?.();
      reject(new ModelDecisionTimeoutError(timeoutMs));
    }, timeoutMs);

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => finish(() => reject(new Error("Turn interrupted.")));

    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ThreadSessionRuntime {
  readonly #queue = new AsyncQueue<Submission>();
  #abortController: AbortController | null = null;
  #activeTurnRunId: string | null = null;
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

  public interrupt(): boolean {
    if (!this.#abortController) {
      return false;
    }
    this.#abortController.abort();
    return true;
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

  async #clearGpaAfterExecution(force = false): Promise<void> {
    if (this.#gpa.stage === "off" || (!force && this.#gpa.stage !== "act")) {
      return;
    }

    await this.#commitGpa({
      ...this.#gpa,
      stage: "off",
      awaitingConfirmation: null,
      planTasks: [],
      updatedAt: new Date().toISOString()
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

  public async setGpaFullAccess(fullAccess: boolean): Promise<void> {
    await this.#ensureGpa();
    await this.#commitGpa({
      ...this.#gpa,
      fullAccess,
      updatedAt: new Date().toISOString()
    });
  }

  public async setKnowledgeEnabled(knowledgeEnabled: boolean): Promise<void> {
    await this.#ensureGpa();
    await this.#commitGpa({
      ...this.#gpa,
      knowledgeEnabled,
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
      if (submission.type === "approval_response" || submission.type === "user_input_response") {
        continue;
      }
      if (submission.type === "queue_wakeup") {
        await this.drainQueuedMessages();
      }
    }
  }

  private async drainQueuedMessages(): Promise<void> {
    while (!this.#activeTurnRunId) {
      const queued = await this.services.persistence.claimNextQueuedMessage(this.threadId);
      if (!queued) {
        return;
      }
      await this.services.emit({
        type: "queue.updated",
        threadId: this.threadId,
        payload: { queueItemId: queued.id, action: "dispatching" },
        createdAt: new Date().toISOString()
      });
      try {
        await this.runTurn(queued.content, queued.attachments, queued.displayContent);
      } catch (error) {
        console.error(`[runtime] Failed to run thread ${this.threadId}`, error);
        await this.services.log("turn.unhandled_error", this.threadId, {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        await this.services.persistence.completeQueuedMessage(queued.id);
        await this.services.emit({
          type: "queue.updated",
          threadId: this.threadId,
          payload: { queueItemId: queued.id, action: "dispatched" },
          createdAt: new Date().toISOString()
        });
      }
    }
  }

  private async runTurn(initialInput: string, attachments: MessageAttachment[] = [], displayContent?: string): Promise<void> {
    const thread = await this.services.persistence.getThread(this.threadId);
    const gpa = await this.#ensureGpa();
    const knowledgeEnabled = gpa.knowledgeEnabled;
    const enabledPluginIds = await this.services.getEnabledPluginIdsForThread(this.threadId);
    const accessibleMcpServerIds = await this.services.getAccessibleMcpServerIdsForThread(
      this.threadId
    );
    const visibleKnowledgeBases = knowledgeEnabled
      ? await this.services.listKnowledgeBases(this.threadId)
      : [];
    const visibleKnowledgeBaseIds = visibleKnowledgeBases.map((entry: { id: string }) => entry.id);
    const model = resolveModel(this.services.config, thread.modelId);
    const provider = resolveProvider(this.services.config, thread.providerId);
    const selectedSkills = this.services.skills.selectForThread({
      explicitSkillIds: thread.selectedSkillIds,
      query: initialInput,
      allowedPluginIds: enabledPluginIds
    });
    const availableSkills = this.services.skills.listForThread(enabledPluginIds);
    const skillContext = this.services.skills.buildContext(availableSkills, {
      explicitSkillIds: thread.selectedSkillIds
    });
    const availableSkillIds = availableSkills.map((skill) => skill.id);
    const skillDependencyWarnings = buildSkillDependencyWarnings(
      selectedSkills,
      this.services.mcp.listConfigs(),
      accessibleMcpServerIds
    );
    const knowledgeContext = knowledgeEnabled
      ? await this.services.buildKnowledgeContext(this.threadId)
      : null;
    const workflowPackContext = await this.services.buildWorkflowPackContext(this.threadId);
    // Older configurations predate agentCapability. Preserve their existing
    // tool-enabled behavior and only block a model after an explicit failed
    // verification or a runtime incompatibility downgrade.
    const agentToolsEnabled = isAgentToolEnabled(model);
    const { tools, mcpTools } = await this.buildVisibleTools(
      accessibleMcpServerIds,
      knowledgeEnabled,
      agentToolsEnabled
    );
    // Native provider APIs already receive full function schemas. Repeating them
    // in the system prompt wastes context and can make weaker models emit text
    // tool payloads instead of using the provider tool-call channel.
    const availableToolsPrompt = formatAvailableTools(tools, {
      includeSchemas: !agentToolsEnabled
    });
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

    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#activeTurnRunId = turn.id;
    await this.services.persistence.updateThread(this.threadId, {
      status: "running",
      updatedAt: new Date().toISOString()
    });
    await this.recordMessage("user", displayContent ?? initialInput, turn.id, attachments.length > 0 ? { attachments } : undefined);

    if (model.supportsImageGeneration) {
      await this.runImageGeneration({
        turnId: turn.id,
        model,
        provider,
        prompt: initialInput,
        abortController
      });
      this.#activeTurnRunId = null;
      if (this.#abortController === abortController) this.#abortController = null;
      return;
    }

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

    let interruptedVisibleContent = "";

    try {
      let transcript = compactTranscript(history);
      let hasExecutedToolCall = false;
      const successfulToolCallFingerprints = new Set<string>();
      const failedToolCallFingerprints = new Map<string, number>();
      const successfullyCreatedFiles = new Set<string>();
      const knowledgeSources = new Map<string, KnowledgeSourceReference>();
      const browserSources = new Map<string, BrowserSourceReference>();
      const visibleAssistantMessages = new Set<string>();
      let terminalThread: ThreadRecord | null = null;
      const taskFailureCounts = new Map<string, number>();
      let repeatedTaskFailure: { taskKey: string; attempts: number; lastError: string } | null = null;
      let executionRecoveryAttempts = 0;
      let prematureCompletionAttempts = 0;
      let modelTimeoutAttempts = 0;
      let agentProtocolFailureAttempts = 0;
      const requiresAgentDecisionProtocol = () => this.#gpa.stage === "off" || this.#gpa.stage === "act";

      if (this.#gpa.stage !== "off" && !agentToolsEnabled) {
        throw new AgentModelCompatibilityError(
          model.displayName,
          0,
          model.agentCapability === "unsupported"
            ? model.agentCapabilityReason ?? "This model is marked incompatible with Agent tool calling."
            : "Tool calling is disabled for this model. Enable it or select a different model for GPA."
        );
      }

      const registerAgentProtocolFailure = async (reason: string) => {
        agentProtocolFailureAttempts += 1;
        const incompatible = agentProtocolFailureAttempts >= MAX_AGENT_PROTOCOL_FAILURES;
        await this.services.log("agent.model_protocol_failure", this.threadId, {
          turnRunId: turn.id,
          modelId: model.id,
          modelName: model.displayName,
          attempt: agentProtocolFailureAttempts,
          maxAttempts: MAX_AGENT_PROTOCOL_FAILURES,
          reason,
          incompatible
        });
        if (incompatible) {
          await this.services.markModelAgentIncompatible(this.threadId, model.id, reason);
          throw new AgentModelCompatibilityError(model.displayName, agentProtocolFailureAttempts, reason);
        }
      };

      const registerTaskFailure = async (taskKey: string, lastError: string, logKind?: string) => {
        const attempts = (taskFailureCounts.get(taskKey) ?? 0) + 1;
        taskFailureCounts.set(taskKey, attempts);
        if (logKind) {
          await this.services.log(logKind, this.threadId, {
            turnRunId: turn.id,
            taskKey,
            attempts,
            lastError
          });
        }
        if (attempts >= MAX_REPEATED_TASK_FAILURES) {
          repeatedTaskFailure = { taskKey, attempts, lastError };
        }
        return attempts;
      };

      const recoverActExecution = async (reason: string) => {
        await registerAgentProtocolFailure(reason);
        executionRecoveryAttempts += 1;
        const bootstrapWorkspace =
          !hasExecutedToolCall &&
          executionRecoveryAttempts === 2 &&
          tools.some((tool) => tool.name === "fs.read_directory");

        await this.services.log("agent.execution_recovery", this.threadId, {
          turnRunId: turn.id,
          attempt: executionRecoveryAttempts,
          reason,
          bootstrapWorkspace,
          hasExecutedToolCall
        });
        transcript.push({
          role: "user",
          content: buildExecutionRecoveryInstruction({
            attempt: executionRecoveryAttempts,
            reason,
            bootstrapWorkspace
          })
        });
        return bootstrapWorkspace;
      };

      while (!repeatedTaskFailure) {
        const prompt = buildRuntimePrompt(
          model,
          skillContext,
          knowledgeContext,
          workflowPackContext,
          skillDependencyWarnings,
          knowledgeEnabled
        );
        const adapter = this.services.providerFactory.create(provider);
        let streamedVisibleContent = "";
        const modelTurnAbortController = createChildAbortController(abortController.signal);
        const systemPrompt = `${buildDecisionSystemPrompt(model)}\n\n${prompt.systemPrompt}${
          buildGpaSystemDirective(this.#gpa) || ""
        }\n\n${availableToolsPrompt}`;
        const compaction = compactTranscriptForContext(transcript, model.contextWindow, systemPrompt);
        if (compaction.compacted) {
          transcript = compaction.transcript;
          await this.services.log("agent.context_compacted", this.threadId, {
            turnRunId: turn.id,
            contextWindow: model.contextWindow,
            threshold: CONTEXT_COMPACTION_THRESHOLD,
            target: CONTEXT_COMPACTION_TARGET,
            beforeTokens: compaction.beforeTokens,
            afterTokens: compaction.afterTokens,
            messagesBefore: compaction.messagesBefore,
            messagesAfter: transcript.length
          });
        }
        const decisionTimeoutMs = requiresAgentDecisionProtocol() && agentProtocolFailureAttempts > 0
          ? RECOVERY_MODEL_DECISION_TIMEOUT_MS
          : MODEL_DECISION_TIMEOUT_MS;
        let decision: ProviderTurnDecision;
        try {
          decision = await waitForAbortOrTimeout(
            adapter.runTurn({
              systemPrompt,
              transcript,
              availableTools: tools,
              model,
              provider,
              stream: model.supportsStreaming,
              onTextDelta: async (delta) => {
                if (abortController.signal.aborted) {
                  return;
                }
                streamedVisibleContent += delta;
                interruptedVisibleContent = streamedVisibleContent;
                // The renderer receives text only after the complete decision is
                // validated. This prevents malformed tool payloads from leaking
                // into the user-facing transcript during streaming.
                return;
              },
              abortSignal: modelTurnAbortController.signal
            }),
            abortController.signal,
            decisionTimeoutMs,
            () => modelTurnAbortController.abort()
          );
        } catch (error) {
          if (!(error instanceof ModelDecisionTimeoutError) || abortController.signal.aborted) {
            throw error;
          }

          modelTimeoutAttempts += 1;
          if (requiresAgentDecisionProtocol()) {
            await registerAgentProtocolFailure(
              "The model did not return an Agent decision before the response timeout."
            );
          }
          const retrying = modelTimeoutAttempts <= MAX_MODEL_TIMEOUT_RETRIES;
          await this.services.log("provider.turn_timeout", this.threadId, {
            turnRunId: turn.id,
            timeoutMs: decisionTimeoutMs,
            attempt: modelTimeoutAttempts,
            maxRetries: MAX_MODEL_TIMEOUT_RETRIES,
            retrying
          });

          if (!retrying) {
            throw error;
          }

          await this.services.emit({
            type: "agent.retrying",
            threadId: this.threadId,
            payload: {
              attempt: modelTimeoutAttempts,
              maxAttempts: MAX_MODEL_TIMEOUT_RETRIES,
              reason: "model_timeout"
            },
            createdAt: new Date().toISOString()
          });
          transcript.push({
            role: "user",
            content:
              "The previous model request timed out. Continue from the existing verified context now. " +
              "Return the required structured decision without repeating completed work."
          });
          continue;
        }
        modelTimeoutAttempts = 0;

        if (abortController.signal.aborted) {
          throw new Error("Turn interrupted.");
        }

        if (decision.clarification && this.#gpa.stage !== "off") {
          const clarification = decision.clarification;
          // Compatibility bridge for adapters that still return the legacy
          // structured field. Plain assistant text is never inferred as input.
          decision.clarification = undefined;
          decision.toolCalls = [{
            id: randomUUID(),
            name: "request_user_input",
            arguments: {
              title: clarification.title,
              questions: [{
                id: "gpa_clarification",
                label: clarification.title,
                prompt: clarification.question,
                options: clarification.options,
                allowFreeText: clarification.allowFreeText
              }]
            }
          }];
          decision.endTurn = false;
          decision.goalCompleted = false;
        }

        if (!gpaStageAllowsTools(this.#gpa) && decision.toolCalls.some((call) => call.name !== "request_user_input")) {
          const blockedNote = `⚠️ GPA 约束：当前处于【${gpaStageLabel(
            this.#gpa.stage
          )}】阶段，系统已拦截本次全部工具调用。请仅用文字输出本阶段要求的内容，并在结尾给出 ⏳ 等待确认。`;
          transcript.push({ role: "user", content: blockedNote });
          decision.toolCalls = decision.toolCalls.filter((call) => call.name === "request_user_input");
        }

        // GOAL and PLAN are single-response analysis stages. Some providers keep
        // end_turn false while emitting a valid plan, which previously made the
        // runtime store that same plan and sample again indefinitely.
        if (shouldFinishGpaAnalysisTurn(this.#gpa.stage, decision)) {
          decision.endTurn = true;
        }

        if (!decision.isStructured) {
          if (this.#gpa.stage === "goal" || this.#gpa.stage === "plan") {
            await this.services.persistence.finishTurn(turn.id, {
              status: "completed",
              completedAt: new Date().toISOString()
            });
            terminalThread = await this.services.persistence.updateThread(this.threadId, {
              status: "completed",
              updatedAt: new Date().toISOString()
            });
            break;
          }
          const bootstrapWorkspace = await recoverActExecution(
            "The response was not a valid JSON decision envelope."
          );
          if (!bootstrapWorkspace) {
            continue;
          }
          decision = {
            ...decision,
            assistantMessage: undefined,
            toolCalls: [{ id: randomUUID(), name: "fs.read_directory", arguments: { path: "." } }],
            endTurn: false,
            goalCompleted: false,
            isStructured: true
          };
        }

        if (this.#gpa.stage === "act" && decision.toolCalls.length === 0 && !decision.endTurn) {
          const bootstrapWorkspace = await recoverActExecution(
            "The decision did not execute a tool and did not complete the task."
          );
          if (!bootstrapWorkspace) {
            continue;
          }
          decision = {
            ...decision,
            assistantMessage: undefined,
            toolCalls: [{ id: randomUUID(), name: "fs.read_directory", arguments: { path: "." } }],
            endTurn: false,
            goalCompleted: false
          };
        }

        if (
          this.#gpa.stage === "act" &&
          !hasExecutedToolCall &&
          decision.toolCalls.length === 0 &&
          decision.endTurn
        ) {
          const bootstrapWorkspace = await recoverActExecution(
            "The ACT stage was ended before any tool was executed."
          );
          if (!bootstrapWorkspace) {
            continue;
          }
          decision = {
            ...decision,
            assistantMessage: undefined,
            toolCalls: [{ id: randomUUID(), name: "fs.read_directory", arguments: { path: "." } }],
            endTurn: false,
            goalCompleted: false
          };
        }

        if (
          this.#gpa.stage === "act" &&
          hasExecutedToolCall &&
          decision.toolCalls.length === 0 &&
          decision.endTurn &&
          !decision.goalCompleted
        ) {
          prematureCompletionAttempts += 1;
          if (prematureCompletionAttempts >= MAX_REPEATED_TASK_FAILURES) {
            repeatedTaskFailure = {
              taskKey: "goal-completion-verification",
              attempts: prematureCompletionAttempts,
              lastError:
                "The model repeatedly attempted to end the task without declaring that the original goal was complete."
            };
            break;
          }
          await this.services.log("turn.premature_completion_blocked", this.threadId, {
            turnRunId: turn.id,
            attempts: prematureCompletionAttempts,
            originalGoal: initialInput
          });
          transcript.push({
            role: "user",
            content:
              "The original user goal is not proven complete. Do not end the task after a single subtask. " +
              "Continue implementing and verifying every requested deliverable. Return goal_completed: true only in the final response after all work is complete."
          });
          continue;
        }

        const originalToolCallCount = decision.toolCalls.length;
        decision.toolCalls = prioritizeUserInputToolCall(decision.toolCalls);
        if (decision.toolCalls.length !== originalToolCallCount) {
          await this.services.log("agent.user_input_batch_trimmed", this.threadId, {
            turnRunId: turn.id,
            originalToolCallCount,
            retainedToolCallId: decision.toolCalls[0]?.id
          });
        }

        if (decision.toolCalls.length > 0) {
          prematureCompletionAttempts = 0;
          if (decision.toolCalls[0]?.name !== "fs.read_directory" || executionRecoveryAttempts < 2) {
            executionRecoveryAttempts = 0;
            agentProtocolFailureAttempts = 0;
          }
          // Native provider APIs require the original call envelope before its result.
          // This remains transient and is not added to the visible chat history.
          transcript.push({ role: "assistant", content: "", toolCalls: decision.toolCalls });
        }

        const assistantMessage = decision.assistantMessage?.trim();
        const deferredExecutionPayload = assistantMessage && isDeferredExecutionPayload(assistantMessage);
        if (deferredExecutionPayload) {
          await this.services.emit({
            type: "assistant.execution_output",
            threadId: this.threadId,
            payload: {
              turnRunId: turn.id,
              title: "待整理的模型执行输出",
              content: assistantMessage
            },
            createdAt: new Date().toISOString()
          });
          await this.services.log("assistant.execution_output_deferred", this.threadId, {
            turnRunId: turn.id,
            contentLength: assistantMessage.length,
            hasToolCalls: decision.toolCalls.length > 0,
            endTurn: decision.endTurn
          });
          decision.assistantMessage = undefined;

          if (decision.toolCalls.length === 0 && decision.endTurn) {
            transcript.push({
              role: "user",
              content:
                "The previous response was raw execution output and was hidden from the user. " +
                "Use the verified tool results to produce a concise user-facing final answer now. " +
                "Do not repeat tool payloads, JSON results, or internal execution text."
            });
            decision.endTurn = false;
            decision.goalCompleted = false;
            continue;
          }
        } else if (decision.toolCalls.length > 0) {
          // Progress prose belongs to the execution panel while tools are still
          // running. Only a validated final response is written to the chat.
          decision.assistantMessage = undefined;
        }

        if (decision.assistantMessage && !isPatchPayload(decision.assistantMessage)) {
          const fingerprint = normalizeAssistantMessageForDeduplication(decision.assistantMessage);
          if (!visibleAssistantMessages.has(fingerprint)) {
            visibleAssistantMessages.add(fingerprint);
            const sourceMetadata = {
              ...(knowledgeSources.size > 0 ? { knowledgeSources: [...knowledgeSources.values()] } : {}),
              ...(browserSources.size > 0 ? { browserSources: [...browserSources.values()] } : {})
            };
            const assistantMessage = await this.recordMessage(
              "assistant",
              decision.assistantMessage,
              turn.id,
              Object.keys(sourceMetadata).length > 0 ? sourceMetadata : undefined
            );
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
        }

        if (decision.toolCalls.length === 0 && decision.endTurn) {
          await this.services.persistence.finishTurn(turn.id, {
            status: "completed",
            completedAt: new Date().toISOString()
          });
          terminalThread = await this.services.persistence.updateThread(this.threadId, {
            status: "completed",
            updatedAt: new Date().toISOString()
          });
          break;
        }

        let reevaluateAfterUserInput = false;
        for (const toolCall of decision.toolCalls) {
          if (abortController.signal.aborted) {
            throw new Error("Turn interrupted.");
          }
          const toolCallFingerprint = createToolCallFingerprint(toolCall.name, toolCall.arguments);
          const toolTaskKey = getToolCallTaskKey(toolCall.name, toolCall.arguments);
          const duplicateCreatedFile = getAddedPatchFiles(toolCall.arguments).find((filePath) =>
            successfullyCreatedFiles.has(filePath)
          );
          if (duplicateCreatedFile) {
            const taskKey = `${toolCall.name}:${duplicateCreatedFile}`;
            const lastError =
              `The file ${duplicateCreatedFile} was already created successfully in this task.`;
            transcript.push({
              role: "user",
              content:
                `${lastError} ` +
                "Do not use Add File for it again. Read it first and use an Update File patch only when a change is required."
            });
            await registerTaskFailure(taskKey, lastError, "tool.duplicate_file_create_blocked");
            if (repeatedTaskFailure) {
              break;
            }
            continue;
          }
          if (successfulToolCallFingerprints.has(toolCallFingerprint)) {
            const lastError =
              `The identical tool call ${toolCall.name} already completed successfully earlier in this task.`;
            const correction =
              `${lastError} ` +
              "Do not repeat it. Use its result to continue the task, choose a different tool, or return a completed decision.";
            transcript.push({ role: "user", content: correction });
            await registerTaskFailure(toolTaskKey, lastError, "tool.duplicate_call_blocked");
            if (repeatedTaskFailure) {
              break;
            }
            continue;
          }
          const failedCallAttempts = failedToolCallFingerprints.get(toolCallFingerprint) ?? 0;
          if (failedCallAttempts >= 2) {
            const lastError =
              `The identical tool call ${toolCall.name} already failed ${failedCallAttempts} times.`;
            transcript.push({
              role: "user",
              content: buildStrategySwitchInstruction({
                toolName: toolCall.name,
                taskKey: toolTaskKey,
                attempts: failedCallAttempts,
                lastError
              })
            });
            await registerTaskFailure(toolTaskKey, lastError, "tool.strategy_switch_enforced");
            if (repeatedTaskFailure) {
              break;
            }
            continue;
          }
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
              turnRunId: toolRecord.turnRunId,
              toolName: toolCall.name,
              argumentsJson: toolRecord.argumentsJson,
              riskLevel: toolRecord.riskLevel,
              approvalMode: toolRecord.approvalMode,
              startedAt: toolRecord.startedAt
            },
            createdAt: new Date().toISOString()
          });

          hasExecutedToolCall = true;
          let result: ToolResult;
          try {
            // Projectless chats must never inherit the desktop application's launch folder.
            const workspaceCwd = thread.cwd ?? await this.services.getThreadOutputDir(this.threadId);
            result = await waitForAbort(
              this.services.toolRuntime.execute(toolCall, {
              cwd: workspaceCwd,
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
              runTerminalCommand: (command) =>
                this.services.runTerminalCommand(this.threadId, workspaceCwd, command),
              requestApproval: (input) => this.services.requestApproval(this.threadId, turn.id, input),
              requestUserInput: (input) => {
                const isGpaClarification = this.#gpa.stage !== "off";
                return this.services.requestUserInput(this.threadId, turn.id, {
                  title: input.title,
                  kind: isGpaClarification ? "gpa_plan_clarification" : "generic",
                  allowSkip: false,
                  questions: input.questions.slice(0, 3)
                });
              },
              requestUserInputEnabled: this.#gpa.stage !== "off",
              spawnChildAgent: (input) => this.services.spawnChildAgent(this.threadId, input),
              webSearch: (query) => this.services.webSearch(this.threadId, query),
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
              inspectBrowserPage: (tabId) => this.services.inspectBrowserPage(this.threadId, tabId),
              inspectBrowserTarget: (tabId, elementId) => this.services.inspectBrowserTarget(this.threadId, tabId, elementId),
              clickBrowserElement: (tabId, elementId) => this.services.clickBrowserElement(this.threadId, tabId, elementId),
              fillBrowserElement: (tabId, elementId, value) => this.services.fillBrowserElement(this.threadId, tabId, elementId, value),
              selectBrowserOption: (tabId, elementId, value) => this.services.selectBrowserOption(this.threadId, tabId, elementId, value),
              scrollBrowserPage: (tabId, deltaY) => this.services.scrollBrowserPage(this.threadId, tabId, deltaY),
              pressBrowserKey: (tabId, key) => this.services.pressBrowserKey(this.threadId, tabId, key),
              waitForBrowserPage: (tabId, input) => this.services.waitForBrowserPage(this.threadId, tabId, input),
              captureBrowserScreenshot: (tabId) => this.services.captureBrowserScreenshot(this.threadId, tabId, turn.id),
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
              listMcpTools: async (server) => {
                if (server) {
                  assertAccessibleMcpServer(server, accessibleMcpServerIds);
                  return this.services.listMcpTools(server);
                }
                return (await this.services.listMcpTools()).filter((tool) =>
                  accessibleMcpServerIds.includes(tool.server)
                );
              },
              readMcpResource: async (server, uri) => {
                assertAccessibleMcpServer(server, accessibleMcpServerIds);
                return this.services.readMcpResource(server, uri);
              },
              callMcpTool: async (server, tool, argumentsJson) => {
                assertAccessibleMcpServer(server, accessibleMcpServerIds);
                return this.services.callMcpTool(server, tool, argumentsJson);
              },
              deferredToolSpecs: mcpTools,
              hiddenToolNames: [
                ...(knowledgeEnabled ? [] : ["knowledge.search", "knowledge.read"]),
                ...(this.#gpa.stage === "off" ? ["request_user_input"] : [])
              ],
              loadSkill: (skillId) =>
                this.services.skills.loadInstructions(skillId, availableSkillIds)
              }),
              abortController.signal
            );
          } catch (error) {
            if (abortController.signal.aborted) {
              throw error;
            }
            result = {
              ok: false,
              content: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
            };
            await this.services.log("tool.execution_error", this.threadId, {
              turnRunId: turn.id,
              toolName: toolCall.name,
              error: error instanceof Error ? error.message : String(error)
            });
          }

          if (abortController.signal.aborted) {
            throw new Error("Turn interrupted.");
          }

          const completedAt = new Date().toISOString();
          const resultJson = JSON.stringify(result);
          const status = result.ok ? "completed" : "failed";
          await this.services.persistence.finishToolCall(toolRecord.id, {
            status,
            resultJson,
            completedAt
          });
          await this.services.emit({
            type: "tool.completed",
            threadId: this.threadId,
            payload: {
              toolCallId: toolRecord.id,
              toolName: toolCall.name,
              turnRunId: toolRecord.turnRunId,
              resultJson,
              status,
              completedAt,
              ok: result.ok
            },
            createdAt: new Date().toISOString()
          });

          if (result.ok) {
            collectKnowledgeSources(toolCall.name, result, visibleKnowledgeBases, knowledgeSources);
            collectBrowserSources(toolCall.name, result, browserSources);
          }

          const toolMessage = await this.recordMessage(
            "tool",
            `${toolCall.name}\n${result.content}`,
            turn.id,
            { toolCallId: toolRecord.id }
          );
          transcript.push({
            role: "tool",
            content: toolMessage.content,
            toolCallId: toolCall.id,
            toolResultOk: result.ok
          });
          if (toolCall.name === "request_user_input" && result.ok) {
            reevaluateAfterUserInput = true;
            break;
          }
          if (result.ok) {
            successfulToolCallFingerprints.add(toolCallFingerprint);
            failedToolCallFingerprints.delete(toolCallFingerprint);
            for (const filePath of getAddedPatchFiles(toolCall.arguments)) {
              successfullyCreatedFiles.add(filePath);
            }
            taskFailureCounts.delete(toolTaskKey);
          } else {
            const attempts = (failedToolCallFingerprints.get(toolCallFingerprint) ?? 0) + 1;
            failedToolCallFingerprints.set(toolCallFingerprint, attempts);
            await registerTaskFailure(toolTaskKey, result.content);
            if (attempts >= 2) {
              await this.services.log("agent.strategy_switch_requested", this.threadId, {
                turnRunId: turn.id,
                toolName: toolCall.name,
                taskKey: toolTaskKey,
                attempts,
                lastError: result.content
              });
              transcript.push({
                role: "user",
                content: buildStrategySwitchInstruction({
                  toolName: toolCall.name,
                  taskKey: toolTaskKey,
                  attempts,
                  lastError: result.content
                })
              });
            }
            if (repeatedTaskFailure) {
              break;
            }
          }
        }

        if (reevaluateAfterUserInput) {
          continue;
        }

      }

      if (repeatedTaskFailure) {
        const errorMessage =
          `The same task (${repeatedTaskFailure.taskKey}) failed ${repeatedTaskFailure.attempts} consecutive times. ` +
          `Last error: ${repeatedTaskFailure.lastError}`;
        await this.recordMessage(
          "assistant",
          buildRepeatedTaskRecoveryMessage(repeatedTaskFailure),
          turn.id
        );
        await this.services.persistence.finishTurn(turn.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          errorMessage
        });
        terminalThread = await this.services.persistence.updateThread(this.threadId, {
          status: "failed",
          updatedAt: new Date().toISOString()
        });
        await this.services.log("turn.repeated_task_failure", this.threadId, {
          turnRunId: turn.id,
          taskKey: repeatedTaskFailure.taskKey,
          attempts: repeatedTaskFailure.attempts,
          lastError: repeatedTaskFailure.lastError
        });
      }

      if (terminalThread) {
        await this.#clearGpaAfterExecution();
        await this.services.emit({
          type: "thread.updated",
          threadId: this.threadId,
          payload: { thread: terminalThread },
          createdAt: new Date().toISOString()
        });
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
      if (abortController.signal.aborted) {
        let messageId: string | undefined;
        if (interruptedVisibleContent.trim() && !isDeferredExecutionPayload(interruptedVisibleContent)) {
          const message = await this.recordMessage(
            "assistant",
            interruptedVisibleContent,
            turn.id
          );
          messageId = message.id;
        }
        const completedAt = new Date().toISOString();
        await this.services.persistence.finishTurn(turn.id, {
          status: "interrupted",
          completedAt,
          errorMessage: null
        });
        const updatedThread = await this.services.persistence.updateThread(this.threadId, {
          status: "idle",
          updatedAt: completedAt
        });
        await this.#clearGpaAfterExecution(true);
        if (interruptedVisibleContent) {
          await this.services.emit({
            type: "assistant.completed",
            threadId: this.threadId,
            payload: { turnRunId: turn.id, messageId },
            createdAt: completedAt
          });
        }
        await this.services.emit({
          type: "thread.updated",
          threadId: this.threadId,
          payload: { thread: updatedThread },
          createdAt: completedAt
        });
        return;
      }
      const completedAt = new Date().toISOString();
      await this.services.log("turn.failed", this.threadId, {
        turnRunId: turn.id,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.recordMessage("assistant", buildRuntimeFailureRecoveryMessage(error), turn.id);
      await this.services.persistence.finishTurn(turn.id, {
        status: "failed",
        completedAt,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      const updatedThread = await this.services.persistence.updateThread(this.threadId, {
        status: "failed",
        updatedAt: completedAt
      });
      await this.#clearGpaAfterExecution(true);
      await this.services.emit({
        type: "thread.updated",
        threadId: this.threadId,
        payload: { thread: updatedThread },
        createdAt: completedAt
      });
      return;
    } finally {
      this.#activeTurnRunId = null;
      if (this.#abortController === abortController) {
        this.#abortController = null;
      }
    }
  }

  private async buildVisibleTools(
    accessibleMcpServerIds: string[],
    knowledgeEnabled: boolean,
    agentToolsEnabled: boolean
  ) {
    await this.services.mcp.refresh(accessibleMcpServerIds);
    const mcpTools = await this.services.mcp.listToolSpecs(accessibleMcpServerIds);
    const { direct } = this.services.toolRuntime.listToolSpecs(mcpTools);
    const gpaEnabled = this.#gpa.stage !== "off";
    const withKnowledge = knowledgeEnabled
      ? direct
      : direct.filter((tool) => tool.name !== "knowledge.search" && tool.name !== "knowledge.read");
    return {
      tools: !agentToolsEnabled
        ? []
        : gpaEnabled
        ? withKnowledge
        : withKnowledge.filter((tool) => tool.name !== "request_user_input"),
      mcpTools
    };
  }

  private async runImageGeneration(input: {
    turnId: string;
    model: ModelProfile;
    provider: ReturnType<typeof resolveProvider>;
    prompt: string;
    abortController: AbortController;
  }): Promise<void> {
    const completedAt = new Date().toISOString();
    try {
      const adapter = this.services.providerFactory.create(input.provider);
      if (!adapter.generateImage) {
        throw new Error("The selected provider does not support the OpenAI-compatible image generation API.");
      }
      const image = await waitForAbort(adapter.generateImage({
        model: input.model,
        prompt: input.prompt,
        abortSignal: input.abortController.signal
      }), input.abortController.signal);
      const outputDir = await this.services.getThreadOutputDir(this.threadId);
      await fs.mkdir(outputDir, { recursive: true });
      const fileName = `generated-${Date.now()}-${randomUUID().slice(0, 8)}.${imageExtensionForMime(image.mimeType)}`;
      const absolutePath = path.join(outputDir, fileName);
      await fs.writeFile(absolutePath, image.data);
      const attachment: MessageAttachment = {
        id: randomUUID(), kind: "image", name: fileName, mimeType: image.mimeType,
        absolutePath, sizeBytes: image.data.byteLength, source: "generated"
      };
      const artifact = await this.services.persistence.addArtifact({
        threadId: this.threadId, turnRunId: input.turnId, messageId: null, toolCallId: null,
        artifactKind: "generated-image", displayName: fileName, absolutePath, relativePath: fileName,
        mimeType: image.mimeType, sizeBytes: image.data.byteLength,
        sha256: createHash("sha256").update(image.data).digest("hex"), sourceKind: "image-generation",
        isUserVisible: true, status: "ready"
      });
      const message = await this.recordMessage("assistant", "已生成图片。", input.turnId, { attachments: [attachment], artifactId: artifact.id });
      await this.services.persistence.finishTurn(input.turnId, { status: "completed", completedAt, errorMessage: null });
      const thread = await this.services.persistence.updateThread(this.threadId, { status: "completed", updatedAt: completedAt });
      await this.services.emit({ type: "assistant.completed", threadId: this.threadId, payload: { turnRunId: input.turnId, messageId: message.id }, createdAt: completedAt });
      await this.services.emit({ type: "thread.updated", threadId: this.threadId, payload: { thread }, createdAt: completedAt });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.recordMessage("assistant", `图片生成失败：${reason}`, input.turnId);
      await this.services.persistence.finishTurn(input.turnId, { status: "failed", completedAt, errorMessage: reason });
      const thread = await this.services.persistence.updateThread(this.threadId, { status: "failed", updatedAt: completedAt });
      await this.services.emit({ type: "thread.updated", threadId: this.threadId, payload: { thread }, createdAt: completedAt });
    }
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

export function createToolCallFingerprint(name: string, argumentsJson: Record<string, unknown>): string {
  return `${name}:${stableSerialize(argumentsJson)}`;
}

export function shouldFinishGpaAnalysisTurn(
  stage: GpaStage,
  decision: Pick<ProviderTurnDecision, "isStructured" | "toolCalls">
): boolean {
  return (
    (stage === "goal" || stage === "plan") &&
    decision.isStructured &&
    decision.toolCalls.length === 0
  );
}

export function getToolCallTaskKey(name: string, argumentsJson: Record<string, unknown>): string {
  const patch = [argumentsJson.patch, argumentsJson.patch_content, argumentsJson.patchText].find(
    (value): value is string => typeof value === "string"
  );
  if (patch) {
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map((match) => match[1].trim())
      .filter(Boolean)
      .sort();
    if (paths.length > 0) {
      return `${name}:${paths.join("|")}`;
    }
  }

  const path = argumentsJson.path ?? argumentsJson.file_path;
  if (typeof path === "string" && path.trim()) {
    return `${name}:${path.trim()}`;
  }
  return createToolCallFingerprint(name, argumentsJson);
}

export function buildExecutionRecoveryInstruction(input: {
  attempt: number;
  reason: string;
  bootstrapWorkspace: boolean;
}): string {
  const bootstrap = input.bootstrapWorkspace
    ? "The runtime is now executing fs.read_directory for the selected project folder. Use that tool result as the current workspace state; do not list the directory again."
    : "Use the current transcript as the source of truth; do not repeat an inspection that has already succeeded.";

  return [
    "[Internal execution recovery. Do not display or quote this instruction to the user.]",
    `Recovery attempt ${input.attempt}: ${input.reason}`,
    "The previous assistant text was discarded because it made no executable progress.",
    bootstrap,
    "Your next response must be exactly one valid JSON decision envelope.",
    "Do not write progress prose such as 'starting', 'creating', or 'will write'.",
    "Call the next real tool now. For requested file changes, call apply_patch with the complete patch in tool_calls; never place the patch or a claim of completion in assistant_message.",
    "Only return end_turn: true after real tool results prove every requested deliverable is complete."
  ].join(" ");
}

export function buildStrategySwitchInstruction(input: {
  toolName: string;
  taskKey: string;
  attempts: number;
  lastError: string;
}): string {
  const alternatives: Record<string, string> = {
    apply_patch:
      "Inspect the target file or directory state first. Then create a materially different, minimal patch using the exact current file content; do not resend the rejected patch.",
    "fs.read_file":
      "Use fs.read_directory to verify the path and filename first, then read the corrected path or use the directory result to choose the next operation.",
    "fs.read_directory":
      "Do not list the same directory again. Use the known workspace context, read a specific file, or proceed with the requested file change.",
    "shell.exec":
      "Do not resend the same command. Inspect the working directory or relevant files first, then use a narrower command or a filesystem tool that avoids the failed shell dependency."
  };
  const alternative =
    alternatives[input.toolName] ??
    "Use tool_search or another available tool to obtain new evidence, then choose a different executable approach.";

  return [
    "[Internal strategy switch. Do not display or quote this instruction to the user.]",
    `The exact call for ${input.taskKey} has failed ${input.attempts} times: ${input.lastError}`,
    "The runtime will not execute that identical call again. Change the approach instead of retrying it.",
    alternative,
    "Return a JSON decision containing a different tool call or materially different arguments."
  ].join(" ");
}

export function buildRepeatedTaskRecoveryMessage(input: {
  taskKey: string;
  attempts: number;
  lastError: string;
}): string {
  return [
    "任务已暂停，因为同一个可执行操作连续失败，继续重复执行不会产生新的结果。",
    `操作：${input.taskKey}`,
    `已尝试：${input.attempts} 次。最后结果：${input.lastError}`,
    "建议：检查目标文件或命令的前置条件；修正权限、路径或参数后重新发送任务。",
    "如果目标需要不同的实现方式，请直接说明期望结果，agent 会基于现有工具改用可执行方案，而不是重复相同操作。"
  ].join("\n");
}

export function buildRuntimeFailureRecoveryMessage(error: unknown): string {
  if (error instanceof AgentModelCompatibilityError) {
    return [
      "任务已停止：当前模型无法稳定返回 Agent 所需的可执行决策。",
      `模型：${error.modelName}`,
      `已连续出现 ${error.failures} 次协议失败：${error.lastReason}`,
      "请在模型选择中切换到支持工具调用或结构化 JSON 输出的模型后，再重新执行 GPA/Agent 任务。普通聊天仍可继续使用当前模型。",
      "为避免误执行，系统没有根据普通文本猜测命令或文件修改；已完成的工具结果和项目文件会被保留。"
    ].join("\n");
  }

  if (error instanceof ModelDecisionTimeoutError) {
    return [
      "任务暂时停止：模型在限定时间内没有返回可执行决策。",
      "建议：确认当前模型和服务地址可用后重试；也可以切换到响应更快、支持工具调用的模型。",
      "项目文件没有被未经验证地修改，已有的工具结果和日志会保留供下一次任务继续使用。"
    ].join("\n");
  }

  const detail = error instanceof Error ? error.message : String(error);
  return [
    "任务暂时停止：运行时遇到了无法自动恢复的异常。",
    `原因：${detail}`,
    "建议：根据原因修正项目路径、权限、工具配置或模型配置后重试。已有执行记录已保留；重新提交时 agent 会从当前项目状态继续，而不是假设未完成的修改已经成功。"
  ].join("\n");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

  public wakeQueuedMessages(threadId: string): void {
    this.ensureThread(threadId).submit({ type: "queue_wakeup" });
  }

  public interrupt(threadId: string): boolean {
    return this.#sessions.get(threadId)?.interrupt() ?? false;
  }

  public async setGpaStage(threadId: string, stage: GpaStage): Promise<void> {
    const runtime = this.ensureThread(threadId);
    await runtime.setGpaStage(stage);
  }

  public async setGpaFullAccess(threadId: string, fullAccess: boolean): Promise<void> {
    const runtime = this.ensureThread(threadId);
    await runtime.setGpaFullAccess(fullAccess);
  }

  public async setKnowledgeEnabled(threadId: string, knowledgeEnabled: boolean): Promise<void> {
    const runtime = this.ensureThread(threadId);
    await runtime.setKnowledgeEnabled(knowledgeEnabled);
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

function isPatchPayload(content: string): boolean {
  return /^\s*(?:```(?:diff|patch)?\s*)?\*\*\* Begin Patch\b/m.test(content);
}

export class AgentModelCompatibilityError extends Error {
  public constructor(
    public readonly modelName: string,
    public readonly failures: number,
    public readonly lastReason: string
  ) {
    super(`Model ${modelName} is incompatible with Agent decision execution: ${lastReason}`);
    this.name = "AgentModelCompatibilityError";
  }
}

function isDeferredExecutionPayload(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (/^<\/?tool_(?:calls|result)\b/i.test(trimmed)) {
    return true;
  }

  if (/^(?:web_search|browser|shell|fs|knowledge|mcp|execute_command|read_file|write_file|apply_patch)(?:[._][\w-]+)+\s*[\[\{(]/i.test(trimmed)) {
    return true;
  }

  if (!/^[\[{]/.test(trimmed)) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.some((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, unknown>;
      return ["tool_calls", "tool_result", "query", "url", "snippet", "results", "output"].some((key) => key in record);
    });
  } catch {
    return false;
  }
}

export function getAddedPatchFiles(argumentsJson: Record<string, unknown>): string[] {
  const patch = argumentsJson.patch;
  if (typeof patch !== "string") {
    return [];
  }
  return [...patch.matchAll(/^\*\*\* Add File: (.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

/**
 * A user-input request pauses the turn. Native provider APIs require every
 * function call in a batch to receive a result, so do not leave sibling calls
 * outstanding while the runtime waits for the user.
 */
export function prioritizeUserInputToolCall(calls: RuntimeToolCall[]): RuntimeToolCall[] {
  const userInputCall = calls.find((call) => call.name === "request_user_input");
  return userInputCall ? [userInputCall] : calls;
}

export function isAgentToolEnabled(model: ModelProfile): boolean {
  return model.supportsToolCalling && model.agentCapability !== "unsupported";
}

export function formatAvailableTools(
  tools: ToolSpecDefinition[],
  options: { includeSchemas?: boolean } = {}
): string {
  const includeSchemas = options.includeSchemas ?? true;
  const definitions = tools.map((tool) => {
    return includeSchemas
      ? `- ${tool.name}: ${tool.description} Input schema: ${JSON.stringify(tool.inputSchema)}.`
      : `- ${tool.name}: ${tool.description}`;
  });

  return [
    "## Available Executable Tools",
    tools.length > 0
      ? "The following tools are available in this turn. They are real executable tools, not examples. Never claim that command execution is unavailable while shell.exec appears below."
      : "No executable tools are available in this turn.",
    "For shell commands, call shell.exec with {\"command\": \"...\"}. For a local web project, do not open index.html with Start-Process. Start an HTTP server instead, then open its http://127.0.0.1:<port> URL. When starting a long-running local server on Windows, use a background command such as Start-Process so the tool call can complete.",
    ...definitions
  ].join("\n");
}

function buildGpaPlanRevisionInstruction(): string {
  return [
    "GPA plan clarification was answered. Stop ACT execution and revise the remaining plan now.",
    "Keep already completed work, update only unfinished tasks, dependencies, risks, and acceptance criteria.",
    "Do not call tools in this PLAN revision. Present the complete revised remaining plan and wait for explicit user confirmation before returning to ACT."
  ].join(" ");
}

function collectKnowledgeSources(
  toolName: string,
  result: ToolResult,
  visibleKnowledgeBases: Array<{ id?: string; displayName?: string }>,
  sources: Map<string, KnowledgeSourceReference>
): void {
  if (toolName !== "knowledge.search" && toolName !== "knowledge.read") return;

  const candidates = toolName === "knowledge.search"
    ? Array.isArray(result.json?.results) ? result.json.results : []
    : result.json?.concept ? [result.json.concept] : [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const knowledgeBaseId = typeof item.knowledgeBaseId === "string" ? item.knowledgeBaseId : "";
    const sourcePath = typeof item.sourcePath === "string" ? item.sourcePath : "";
    if (!knowledgeBaseId || !sourcePath) continue;

    const locator = typeof item.locator === "string" ? item.locator : undefined;
    const knowledgeBaseName = visibleKnowledgeBases.find((base) => base.id === knowledgeBaseId)?.displayName
      ?? "本地知识库";
    const key = `${knowledgeBaseId}:${sourcePath}:${locator ?? ""}`;
    sources.set(key, { knowledgeBaseId, knowledgeBaseName, sourcePath, locator });
  }
}

function collectBrowserSources(
  toolName: string,
  result: ToolResult,
  sources: Map<string, BrowserSourceReference>
): void {
  if (toolName === "web_search.search_query") {
    const results = Array.isArray(result.json?.results) ? result.json.results : [];
    for (const candidate of results) {
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as Record<string, unknown>;
      const url = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(url)) continue;
      const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : url;
      sources.set(url, { title, url });
    }
    return;
  }

  if (![
    "web_search.open_page",
    "browser.read_page_text",
    "browser.reload",
    "browser.go_back",
    "browser.go_forward"
  ].includes(toolName)) return;

  const root = result.json ?? {};
  const page = root.page && typeof root.page === "object" ? root.page as Record<string, unknown> : root;
  const url = typeof page.url === "string" ? page.url : "";
  if (!/^https?:\/\//i.test(url)) return;
  const title = typeof page.title === "string" && page.title.trim() ? page.title.trim() : url;
  sources.set(url, { title, url });
}

function buildRuntimePrompt(
  model: ModelProfile,
  skillContext: RuntimePromptBundle["skillContext"],
  knowledgeContext: string | null,
  workflowPackContext: string | null,
  skillDependencyWarnings: string[],
  knowledgeEnabled: boolean
): RuntimePromptBundle {
  const blocks = [
    "You are codexh, a desktop agent for project and chat workflows.",
    `Current local date: ${formatRuntimeDate(new Date())}. Use this date for time-sensitive queries. Do not add, infer, or reuse a year that the user did not request.`,
    "Prefer progressive disclosure: inspect facts before making edits.",
    "When a tool can gather needed facts, call it instead of guessing.",
    "Before responding, decide whether an available Skill is the best fit. When it is, call skills.load with that skill_id before following its instructions. Use Function Calling for Skills and external tools rather than merely claiming a Skill was used.",
    "For MCP capabilities, call mcp.list_tools first. Then call mcp.call only with a server and tool from that directory. Use MCP resource tools only when a listed resource is needed.",
    "For browser automation, call browser.inspect_page before browser.click, browser.fill, browser.select_option, or browser.press_key. Use only element ids returned by the latest inspection, then inspect again after navigation or page changes. Never guess selectors or claim a browser action succeeded without a tool result.",
    "Respond as an IDE software engineering agent using an event stream format.",
    "Your visible output is consumed by a renderer that understands structured event blocks.",
    "Prefer XML-like event envelopes when possible: <event type=\"commentary\">...</event>.",
    "Allowed event types: commentary, tool_call, tool_result, file_view, file_change, test_result, final.",
    "Before substantial work emit 1-2 sentences of commentary. After each tool use, summarize with tool_result. When surfacing files, use file_view or file_change. Use test_result for validation. End with a concise final covering result, verification, and risks.",
    "Do not expose chain-of-thought. Do not fabricate tool usage, file changes, or verification.",
    `Context window: ${model.contextWindow}.`
  ];
  if (knowledgeEnabled) {
    blocks.splice(5, 0, "For local knowledge questions, call knowledge.search first. It returns ranked document chunks with source_path and locator; use knowledge.read only for the relevant chunk. Cite the source file and locator in your answer when you rely on retrieved material. Never use fs.read_file on a knowledge Bundle or index path. If search returns no results, refine the query once or explain that no matching local material was found; do not repeat the same progress reply.");
  }
  blocks.splice(6, 0, "When using text extracted from a browser page, cite the page title or URL in your answer. The chat will show the page source automatically.");
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

function formatRuntimeDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function compactTranscript(messages: MessageRecord[]): ProviderTurnInput["transcript"] {
  const maxMessages = 24;
  const visible = messages.slice(-maxMessages);
  return visible.map((message) => ({
    role: message.role,
    content: message.content,
    attachments: getMessageAttachments(message)
  }));
}

function getMessageAttachments(message: MessageRecord): MessageAttachment[] | undefined {
  if (!message.metadataJson) return undefined;
  try {
    const metadata = JSON.parse(message.metadataJson) as { attachments?: unknown };
    return Array.isArray(metadata.attachments) ? metadata.attachments as MessageAttachment[] : undefined;
  } catch {
    return undefined;
  }
}

export function compactTranscriptForContext(
  transcript: ProviderTurnInput["transcript"],
  contextWindow: number,
  systemPrompt: string
): {
  transcript: ProviderTurnInput["transcript"];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  messagesBefore: number;
} {
  const safeContextWindow = Math.max(1, contextWindow);
  const systemTokens = estimateRuntimeTokens(systemPrompt);
  const transcriptTokens = estimateRuntimeTranscriptTokens(transcript);
  const beforeTokens = systemTokens + transcriptTokens;
  if (beforeTokens / safeContextWindow < CONTEXT_COMPACTION_THRESHOLD) {
    return {
      transcript,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      messagesBefore: transcript.length
    };
  }

  const targetTranscriptTokens = Math.max(
    256,
    Math.floor(safeContextWindow * CONTEXT_COMPACTION_TARGET) - systemTokens
  );
  // A native function-call assistant message and every following tool result
  // form one protocol unit. Do not leave tool results in the context after
  // truncating their originating call envelope.
  const recentMessages = selectProtocolSafeRecentMessages(transcript, 8);
  const earlierMessages = transcript.slice(0, Math.max(0, transcript.length - recentMessages.length));
  const summaryBudget = Math.max(120, Math.floor(targetTranscriptTokens * 0.3));
  const recentBudget = Math.max(
    96,
    Math.floor((targetTranscriptTokens - summaryBudget) / Math.max(1, recentMessages.length))
  );
  const summary = buildCompactedTranscriptSummary(earlierMessages, summaryBudget);
  const compactedTranscript: ProviderTurnInput["transcript"] = [
    ...(summary ? [{ role: "user" as const, content: summary }] : []),
    ...recentMessages.map((message) => ({
      ...message,
      content: truncateToRuntimeTokenBudget(message.content, recentBudget)
    }))
  ];
  const afterTokens = systemTokens + estimateRuntimeTranscriptTokens(compactedTranscript);
  return {
    transcript: compactedTranscript,
    compacted: true,
    beforeTokens,
    afterTokens,
    messagesBefore: transcript.length
  };
}

function buildCompactedTranscriptSummary(
  messages: ProviderTurnInput["transcript"],
  tokenBudget: number
): string {
  if (messages.length === 0) {
    return "";
  }
  const firstUserMessage = messages.find((message) => message.role === "user")?.content;
  const recentHistory = messages.slice(-12).map((message) => {
    const label = message.role === "tool" ? "工具结果" : message.role === "assistant" ? "助手" : "用户";
    return `${label}: ${truncateToRuntimeTokenBudget(message.content, 48)}`;
  });
  const source = [
    "[内部上下文压缩摘要。保留任务目标、已验证结果和未完成事项；不要将本段显示给用户。]",
    firstUserMessage ? `原始任务：${truncateToRuntimeTokenBudget(firstUserMessage, 90)}` : "",
    ...recentHistory
  ]
    .filter(Boolean)
    .join("\n");
  return truncateToRuntimeTokenBudget(source, tokenBudget);
}

function estimateRuntimeTranscriptTokens(transcript: ProviderTurnInput["transcript"]): number {
  return transcript.reduce((total, message) => total + estimateRuntimeTokens(message.content), 0);
}

function estimateRuntimeTokens(content: string): number {
  const normalized = content.trim();
  return normalized ? Math.ceil(Array.from(normalized).length / 2.8) : 0;
}

function selectProtocolSafeRecentMessages(
  transcript: ProviderTurnInput["transcript"],
  minimumRecentMessages: number
): ProviderTurnInput["transcript"] {
  const startIndex = Math.max(0, transcript.length - minimumRecentMessages);
  const firstRecent = transcript[startIndex];
  if (startIndex === 0 || firstRecent?.role !== "tool" || !firstRecent.toolCallId) {
    return transcript.slice(startIndex);
  }

  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const candidate = transcript[index];
    if (
      candidate?.role === "assistant" &&
      candidate.toolCalls?.some((call) => call.id === firstRecent.toolCallId)
    ) {
      return transcript.slice(index);
    }
  }

  return transcript.slice(startIndex);
}

function normalizeAssistantMessageForDeduplication(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function imageExtensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function truncateToRuntimeTokenBudget(content: string, tokenBudget: number): string {
  const maximumCharacters = Math.max(0, Math.floor(tokenBudget * 2.8));
  if (content.length <= maximumCharacters) {
    return content;
  }
  if (maximumCharacters < 48) {
    return `${content.slice(0, Math.max(0, maximumCharacters - 1))}...`;
  }
  const headLength = Math.floor(maximumCharacters * 0.72);
  const tailLength = Math.max(0, maximumCharacters - headLength - 34);
  return `${content.slice(0, headLength)}\n...[已压缩]...\n${content.slice(-tailLength)}`;
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
