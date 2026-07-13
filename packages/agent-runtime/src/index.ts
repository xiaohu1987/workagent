import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
  AppConfig,
  ArtifactRecord,
  BrowserTabRecord,
  BrowserAssertionCheck,
  BrowserViewport,
  CompletionEvidenceKind,
  MessageAttachment,
  McpServerConfig,
  MessageRecord,
  ModelProfile,
  ProviderDefinition,
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
import { DEFAULT_RUNTIME_TIMEOUTS } from "@shared-types";
import { buildDecisionSystemPrompt, isGeneratedVideoDownloadError, ProviderFactory } from "@provider-adapters";
import { SkillsManager } from "@skills-runtime";
import { McpManager } from "@mcp-runtime";
import { ToolRuntime, canonicalizeToolName } from "@tool-runtime";
import {
  buildGpaSystemDirective,
  buildGpaTextClarificationQuestions,
  DEFAULT_GPA_STATE,
  detectGpaConfirmation,
  gpaStageAllowsTools,
  gpaStageLabel,
  nextStageAfterConfirmation,
  parseGpaPlanTasks,
  parseGpaState
} from "./gpa";
import {
  buildMultimodalIntentClassifySystemPrompt,
  buildMultimodalIntentClassifyTranscript,
  parseMultimodalIntentClassification,
  type MultimodalIntentClassification
} from "./multimodal-intent";
import type { GpaStage, GpaState } from "@shared-types";

export {
  buildGpaTextClarificationQuestions,
  canEnterGpaAct,
  parseGpaPlanTasks,
  parseGpaState
} from "./gpa";
export {
  detectMultimodalIntent,
  parseMultimodalIntentClassification,
  buildMultimodalIntentClassifySystemPrompt,
  buildMultimodalIntentClassifyTranscript
} from "./multimodal-intent";

export const MAX_REPEATED_TASK_FAILURES = 5;
export const MODEL_DECISION_TIMEOUT_MS = DEFAULT_RUNTIME_TIMEOUTS.modelDecisionMs;
export const MAX_MODEL_TIMEOUT_RETRIES = DEFAULT_RUNTIME_TIMEOUTS.modelTimeoutRetries;
export const MAX_AGENT_PROTOCOL_FAILURES = 2;
export const RECOVERY_MODEL_DECISION_TIMEOUT_MS = DEFAULT_RUNTIME_TIMEOUTS.recoveryModelDecisionMs;
export const CONTEXT_COMPACTION_THRESHOLD = 0.9;
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

export interface SuccessfulToolEvidence {
  toolCallId: string;
  toolRecordId?: string;
  toolName: string;
  kinds: CompletionEvidenceKind[];
  verifiedPaths?: string[];
}

export interface ActCompletionValidationResult {
  valid: boolean;
  reasons: string[];
  missingTaskIds: string[];
  missingEvidenceTaskIds: string[];
  invalidEvidenceToolCallIds: string[];
  missingDelivery: boolean;
  missingVerification: boolean;
  missingBrowserVerification?: string[];
}

interface BrowserVerificationEvidenceState {
  required: boolean;
  canvasRequired: boolean;
  desktopAssertions: Set<string>;
  mobileAssertions: Set<string>;
  desktopScreenshots: Set<string>;
  mobileScreenshots: Set<string>;
  screenshotAttachmentsSent: Set<string>;
  tabIds: Set<string>;
  visualSkippedReason?: "model_not_multimodal";
  operationIndex?: number;
  latestFrontendDeliveryIndex?: number;
  latestPageLoadIndex?: number;
}

interface BrowserCompletionRequirement {
  desktopOnly: boolean;
  canvasRequired: boolean;
  desktopAssertionCount: number;
  mobileAssertionCount: number;
  desktopScreenshotCount: number;
  mobileScreenshotCount: number;
  screenshotAttachmentCount: number;
  modelSupportsMultimodalInput: boolean;
  visualSkippedReason?: "model_not_multimodal";
}

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
  closeBrowserTabs(threadId: string, tabIds: string[]): Promise<void>;
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
  setBrowserViewport(threadId: string, tabId: string, viewport: BrowserViewport | null): Promise<any>;
  assertBrowserPage(threadId: string, tabId: string, checks: BrowserAssertionCheck[]): Promise<any>;
  captureBrowserScreenshot(threadId: string, tabId: string, turnRunId: string, fullPage?: boolean): Promise<any>;
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
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      onTimeout?.();
      reject(new ModelDecisionTimeoutError(timeoutMs));
    }, timeoutMs) : null;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
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
    // ACT is reached only through a confirmed PLAN. Keeping this check in the
    // runtime prevents an outdated renderer or IPC caller from bypassing GPA.
    if (
      stage === "act" &&
      (this.#gpa.stage !== "plan" || this.#gpa.planTasks.length === 0)
    ) {
      await this.services.log("gpa.act_transition_rejected", this.threadId, {
        currentStage: this.#gpa.stage,
        planTaskCount: this.#gpa.planTasks.length,
        reason: "ACT requires a confirmed, validated PLAN."
      });
      return;
    }
    await this.#commitGpa({
      ...this.#gpa,
      stage,
      awaitingConfirmation: null,
      planTasks: stage === "goal" || stage === "off" ? [] : this.#gpa.planTasks,
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
    // Tool availability follows the model profile's tool-calling flag only.
    // Runtime protocol failures must not permanently disable tools or force a model switch.
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
    const agentOpenedBrowserTabIds = new Set<string>();
    const browserVerificationEvidence: BrowserVerificationEvidenceState = {
      required: false,
      canvasRequired: false,
      desktopAssertions: new Set(),
      mobileAssertions: new Set(),
      desktopScreenshots: new Set(),
      mobileScreenshots: new Set(),
      screenshotAttachmentsSent: new Set(),
      tabIds: new Set(),
      visualSkippedReason: model.supportsMultimodalInput ? undefined : "model_not_multimodal"
    };
    const trackOpenedBrowserTabs = async <T>(operation: () => Promise<T>): Promise<T> => {
      const before = new Set(
        (await this.services.listBrowserTabs(this.threadId)).map((tab: { id: string }) => tab.id)
      );
      try {
        return await operation();
      } finally {
        const after = await this.services.listBrowserTabs(this.threadId);
        for (const tab of after) {
          if (!before.has(tab.id)) agentOpenedBrowserTabIds.add(tab.id);
        }
      }
    };
    this.#abortController = abortController;
    this.#activeTurnRunId = turn.id;
    try {
      await this.services.persistence.updateThread(this.threadId, {
        status: "running",
        updatedAt: new Date().toISOString()
      });
      const priorMessages = await this.services.persistence.listMessages(this.threadId);
      await this.recordMessage("user", displayContent ?? initialInput, turn.id, attachments.length > 0 ? { attachments } : undefined);

      const multimodalClassification = await this.classifyMultimodalIntent({
        currentInput: initialInput,
        attachments,
        priorMessages: priorMessages.map((message) => ({ role: message.role, content: message.content })),
        model,
        provider,
        abortController,
        turnId: turn.id
      });
      if (multimodalClassification.intent === "image" || multimodalClassification.intent === "video") {
        await this.runMultimodalIntentTurn({
          intent: multimodalClassification.intent,
          turnId: turn.id,
          prompt: multimodalClassification.prompt,
          abortController
        });
        return;
      }

      const history = await this.services.persistence.listMessages(this.threadId);

      // 简短确认语（确认/OK/开始等）按 doc/GPA.md 推进阶段：GOAL→PLAN→ACT
      await this.#ensureGpa();
      const isInternalGpaConfirmation = initialInput.startsWith("[internal:gpa-confirm]");
      if (
        (isInternalGpaConfirmation || detectGpaConfirmation(initialInput)) &&
        (this.#gpa.stage === "goal" || this.#gpa.stage === "plan")
      ) {
        // PLAN must be visible and have parsed tasks before ACT can ever run.
        // This guard also protects existing UI clients that might submit a stale
        // plan confirmation after a malformed model response.
        if (this.#gpa.stage === "plan" && this.#gpa.planTasks.length === 0) {
          await this.services.log("gpa.plan_confirmation_rejected", this.threadId, {
            turnRunId: turn.id,
            reason: "No validated plan tasks were persisted."
          });
        } else {
          const advanced = nextStageAfterConfirmation(this.#gpa.stage);
          await this.#commitGpa({
            ...this.#gpa,
            stage: advanced,
            awaitingConfirmation: null,
            updatedAt: new Date().toISOString()
          });
        }
      }

      let interruptedVisibleContent = "";

      try {
        let transcript = buildRuntimeTranscript(history);
      let hasExecutedToolCall = false;
      const successfulToolCallFingerprints = new Set<string>();
      const successfulToolEvidence: SuccessfulToolEvidence[] = [];
      const desktopOnlyBrowserVerification = /(?:desktop[- ]only|desktop only|仅桌面|桌面专用)/i.test(initialInput);
      const failedToolCallFingerprints = new Map<string, number>();
      const successfullyCreatedFiles = new Set<string>();
      const knowledgeSources = new Map<string, KnowledgeSourceReference>();
      const browserSources = new Map<string, BrowserSourceReference>();
      const visibleAssistantMessages = new Set<string>();
      let terminalThread: ThreadRecord | null = null;
      const taskFailureCounts = new Map<string, number>();
      let repeatedTaskFailure: { taskKey: string; attempts: number; lastError: string } | null = null;
      const readRepeatedTaskFailure = () => repeatedTaskFailure as {
        taskKey: string;
        attempts: number;
        lastError: string;
      } | null;
      let executionRecoveryAttempts = 0;
      let prematureCompletionAttempts = 0;
      let modelTimeoutAttempts = 0;
      let agentProtocolFailureAttempts = 0;
      let gpaAnalysisValidationAttempts = 0;
      const requiresAgentDecisionProtocol = () => this.#gpa.stage === "off" || this.#gpa.stage === "act";

      if (this.#gpa.stage !== "off" && !agentToolsEnabled) {
        throw new AgentModelCompatibilityError(
          model.displayName,
          0,
          "Tool calling is disabled for this model. Enable tool calling in model settings to use GPA."
        );
      }

      const registerAgentProtocolFailure = async (reason: string) => {
        agentProtocolFailureAttempts += 1;
        const exhausted = agentProtocolFailureAttempts >= MAX_AGENT_PROTOCOL_FAILURES;
        await this.services.log("agent.model_protocol_failure", this.threadId, {
          turnRunId: turn.id,
          modelId: model.id,
          modelName: model.displayName,
          attempt: agentProtocolFailureAttempts,
          maxAttempts: MAX_AGENT_PROTOCOL_FAILURES,
          reason,
          incompatible: false,
          exhausted
        });
        if (exhausted) {
          throw new Error(`Agent decision protocol failed repeatedly: ${reason}`);
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

      const compactTranscriptForModel = async (systemPrompt: string) => {
        const compaction = compactTranscriptForContext(transcript, model.contextWindow, systemPrompt);
        if (!compaction.compacted) {
          return;
        }

        transcript = compaction.transcript;
        const compactionPayload = {
          turnRunId: turn.id,
          contextWindow: model.contextWindow,
          threshold: CONTEXT_COMPACTION_THRESHOLD,
          target: CONTEXT_COMPACTION_TARGET,
          beforeTokens: compaction.beforeTokens,
          afterTokens: compaction.afterTokens,
          messagesBefore: compaction.messagesBefore,
          messagesAfter: transcript.length
        };
        await this.services.log("agent.context_compacted", this.threadId, compactionPayload);
        await this.services.emit({
          type: "agent.context_compacted",
          threadId: this.threadId,
          payload: compactionPayload,
          createdAt: new Date().toISOString()
        });
      };

      while (!repeatedTaskFailure) {
        const prompt = buildRuntimePrompt(
          model,
          skillContext,
          knowledgeContext,
          workflowPackContext,
          skillDependencyWarnings,
          knowledgeEnabled,
          tools.some((tool) => tool.name === "image.generate"),
          tools.some((tool) => tool.name === "video.generate")
        );
        const adapter = this.services.providerFactory.create(provider);
        let streamedVisibleContent = "";
        const modelTurnAbortController = createChildAbortController(abortController.signal);
        const systemPrompt = `${buildDecisionSystemPrompt(model)}\n\n${prompt.systemPrompt}${
          buildGpaSystemDirective(this.#gpa) || ""
        }${buildBrowserVerificationDirective(this.#gpa.stage)}\n\n${availableToolsPrompt}`;
        await compactTranscriptForModel(systemPrompt);
        const decisionTimeoutMs = requiresAgentDecisionProtocol() && agentProtocolFailureAttempts > 0
          ? this.services.config.timeouts.recoveryModelDecisionMs
          : this.services.config.timeouts.modelDecisionMs;
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

          // Timeouts use their own retry budget. Do not fold them into agent
          // protocol failures, or a 2-strike protocol limit will abort before
          // the configured modelTimeoutRetries can finish.
          modelTimeoutAttempts += 1;
          const maxTimeoutRetries = this.services.config.timeouts.modelTimeoutRetries;
          const retrying = modelTimeoutAttempts <= maxTimeoutRetries;
          await this.services.log("provider.turn_timeout", this.threadId, {
            turnRunId: turn.id,
            timeoutMs: decisionTimeoutMs,
            attempt: modelTimeoutAttempts,
            maxRetries: maxTimeoutRetries,
            retrying,
            reason: "The model did not return an Agent decision before the response timeout."
          });

          if (!retrying) {
            throw error;
          }

          await this.services.emit({
            type: "agent.retrying",
            threadId: this.threadId,
            payload: {
              attempt: modelTimeoutAttempts,
              maxAttempts: maxTimeoutRetries,
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

        const textClarificationQuestions =
          !decision.clarification &&
          !decision.toolCalls.some((call) => call.name === "request_user_input")
            ? buildGpaTextClarificationQuestions(this.#gpa.stage, decision.assistantMessage)
            : [];
        if (textClarificationQuestions.length > 0) {
          await this.services.log("gpa.text_clarification_promoted", this.threadId, {
            turnRunId: turn.id,
            stage: this.#gpa.stage,
            questionCount: textClarificationQuestions.length
          });
          decision.toolCalls = [{
            id: randomUUID(),
            name: "request_user_input",
            arguments: {
              title: this.#gpa.stage === "plan" ? "计划细节待确认" : "目标细节待确认",
              questions: textClarificationQuestions
            }
          }];
          decision.assistantMessage = undefined;
          decision.endTurn = false;
          decision.goalCompleted = false;
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
            gpaAnalysisValidationAttempts += 1;
            await this.services.log("gpa.analysis_output_invalid", this.threadId, {
              turnRunId: turn.id,
              stage: this.#gpa.stage,
              attempt: gpaAnalysisValidationAttempts,
              reason: "The model did not return a valid structured decision envelope."
            });
            if (gpaAnalysisValidationAttempts >= MAX_AGENT_PROTOCOL_FAILURES) {
              throw new Error(
                "GPA analysis failed: the model did not return a valid visible response. Please switch to a model that supports structured GPA output and try again."
              );
            }
            transcript.push({
              role: "user",
              content:
                "Return a valid structured GPA response now. Do not call tools. Your assistant_message must contain the complete user-visible analysis for this stage."
            });
            continue;
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
        if (
          this.#gpa.stage === "act" &&
          decision.toolCalls.length === 0 &&
          decision.endTurn
        ) {
          const completionValidation = validateActCompletion({
            decision,
            planTasks: this.#gpa.planTasks,
            successfulEvidence: successfulToolEvidence,
            browserVerification: browserVerificationEvidence.required ? {
              desktopOnly: desktopOnlyBrowserVerification,
              canvasRequired: browserVerificationEvidence.canvasRequired,
              desktopAssertionCount: browserVerificationEvidence.desktopAssertions.size,
              mobileAssertionCount: browserVerificationEvidence.mobileAssertions.size,
              desktopScreenshotCount: browserVerificationEvidence.desktopScreenshots.size,
              mobileScreenshotCount: browserVerificationEvidence.mobileScreenshots.size,
              screenshotAttachmentCount: browserVerificationEvidence.screenshotAttachmentsSent.size,
              modelSupportsMultimodalInput: model.supportsMultimodalInput,
              visualSkippedReason: browserVerificationEvidence.visualSkippedReason
            } : undefined
          });
          if (!completionValidation.valid) {
            prematureCompletionAttempts += 1;
            if (assistantMessage) {
              await this.services.emit({
                type: "assistant.execution_output",
                threadId: this.threadId,
                payload: {
                  turnRunId: turn.id,
                  title: "未通过完成校验的执行输出",
                  content: assistantMessage
                },
                createdAt: new Date().toISOString()
              });
            }
            await this.services.log("turn.completion_evidence_rejected", this.threadId, {
              turnRunId: turn.id,
              attempt: prematureCompletionAttempts,
              reasons: completionValidation.reasons,
              missingTaskIds: completionValidation.missingTaskIds,
              missingEvidenceTaskIds: completionValidation.missingEvidenceTaskIds,
              invalidEvidenceToolCallIds: completionValidation.invalidEvidenceToolCallIds,
              missingDelivery: completionValidation.missingDelivery,
              missingVerification: completionValidation.missingVerification,
              missingBrowserVerification: completionValidation.missingBrowserVerification,
              successfulEvidence: successfulToolEvidence.map((item) => ({
                toolCallId: item.toolCallId,
                toolName: item.toolName,
                kinds: item.kinds,
                verifiedPaths: item.verifiedPaths
              }))
            });

            const recoveryInstruction = buildActCompletionRecoveryInstruction(completionValidation);
            if (prematureCompletionAttempts >= MAX_REPEATED_TASK_FAILURES) {
              const answers = await this.services.requestUserInput(this.threadId, turn.id, {
                title: "任务完成条件尚未满足",
                kind: "generic",
                allowSkip: false,
                questions: [{
                  id: "recovery",
                  label: "是否继续处理？",
                  prompt: `模型已连续 ${prematureCompletionAttempts} 次尝试提前结束，但仍缺少可验证的交付或验证证据。`,
                  options: [
                    {
                      id: "continue",
                      label: "继续尝试",
                      description: "保持 GPA ACT，要求模型根据缺失证据继续执行。",
                      recommended: true
                    },
                    {
                      id: "stop",
                      label: "停止任务",
                      description: "停止当前任务并保留已有工具结果。"
                    }
                  ]
                }]
              });
              if (answers.recovery === "continue") {
                prematureCompletionAttempts = 0;
                transcript.push({ role: "user", content: recoveryInstruction });
                await this.services.log("turn.completion_evidence_retry_continued", this.threadId, {
                  turnRunId: turn.id
                });
                continue;
              }
              repeatedTaskFailure = {
                taskKey: "goal-completion-verification",
                attempts: prematureCompletionAttempts,
                lastError: completionValidation.reasons.join(" ")
              };
              break;
            }
            transcript.push({ role: "user", content: recoveryInstruction });
            continue;
          }
          await this.services.log("turn.completion_evidence_accepted", this.threadId, {
            turnRunId: turn.id,
            completedTaskIds: decision.completedTaskIds,
            evidenceCount: decision.completionEvidence?.length ?? 0
          });
        }
        const parsedPlanTasks = this.#gpa.stage === "plan"
          ? parseGpaPlanTasks(assistantMessage ?? "")
          : [];
        if (
          (this.#gpa.stage === "goal" || this.#gpa.stage === "plan") &&
          decision.toolCalls.length === 0 &&
          decision.endTurn &&
          (!assistantMessage || (this.#gpa.stage === "plan" && parsedPlanTasks.length === 0))
        ) {
          gpaAnalysisValidationAttempts += 1;
          await this.services.log("gpa.analysis_output_invalid", this.threadId, {
            turnRunId: turn.id,
            stage: this.#gpa.stage,
            attempt: gpaAnalysisValidationAttempts,
            hasAssistantMessage: Boolean(assistantMessage),
            parsedTaskCount: parsedPlanTasks.length
          });
          if (gpaAnalysisValidationAttempts >= MAX_AGENT_PROTOCOL_FAILURES) {
            throw new Error(
              `GPA ${this.#gpa.stage.toUpperCase()} failed: the model did not return a valid visible response. Please switch to a model that supports structured GPA output and try again.`
            );
          }
          transcript.push({
            role: "user",
            content:
              this.#gpa.stage === "plan"
                ? "Your previous PLAN response was not shown because it did not contain a valid task list. Return a user-visible PLAN now. Include at least one task on its own line using exactly `T1: task title` (then T2, T3 as needed), plus acceptance criteria. Do not call tools."
                : "Your previous GOAL response was not shown because it was empty. Return a complete, user-visible GOAL analysis with the objective, acceptance criteria, constraints, and any needed clarification. Do not call tools."
          });
          continue;
        }
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
            if (this.#gpa.stage === "plan" && parsedPlanTasks.length > 0) {
              await this.#commitGpa({
                ...this.#gpa,
                planTasks: parsedPlanTasks,
                awaitingConfirmation: null,
                updatedAt: new Date().toISOString()
              });
            }
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
        for (const rawToolCall of decision.toolCalls) {
          if (abortController.signal.aborted) {
            throw new Error("Turn interrupted.");
          }
          let toolCall = {
            ...rawToolCall,
            name: canonicalizeToolName(rawToolCall.name)
          };
          let toolCallFingerprint = createToolCallFingerprint(toolCall.name, toolCall.arguments);
          let toolTaskKey = getToolCallTaskKey(toolCall.name, toolCall.arguments);
          const browserTabs = await this.services.listBrowserTabs(this.threadId);
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
            const retargetedToolCall = retargetStaleBrowserObservationToolCall(toolCall, browserTabs);
            if (retargetedToolCall) {
              toolCall = retargetedToolCall;
              toolCallFingerprint = createToolCallFingerprint(toolCall.name, toolCall.arguments);
              toolTaskKey = getToolCallTaskKey(toolCall.name, toolCall.arguments);
              await this.services.log("tool.browser_tab_retargeted", this.threadId, {
                turnRunId: turn.id,
                toolName: toolCall.name,
                previousTabId: rawToolCall.arguments.tabId,
                activeTabId: toolCall.arguments.tabId
              });
            } else {
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
              toolCallId: toolRecord.id,
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
                  questions: input.questions.slice(0, 4)
                });
              },
              requestUserInputEnabled: this.#gpa.stage !== "off",
              spawnChildAgent: (input) => this.services.spawnChildAgent(this.threadId, input),
              webSearch: (query) => trackOpenedBrowserTabs(
                () => this.services.webSearch(this.threadId, query)
              ),
              openPage: (url) => trackOpenedBrowserTabs(
                () => this.services.openPage(this.threadId, url)
              ),
              findInPage: this.services.findInPage,
              listBrowserTabs: () => this.services.listBrowserTabs(this.threadId),
              openBrowserTab: (url) => trackOpenedBrowserTabs(
                () => this.services.openBrowserTab(this.threadId, url)
              ),
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
              setBrowserViewport: (tabId, viewport) => this.services.setBrowserViewport(this.threadId, tabId, viewport),
              assertBrowserPage: (tabId, checks) => this.services.assertBrowserPage(this.threadId, tabId, checks),
              captureBrowserScreenshot: (tabId, fullPage) => this.services.captureBrowserScreenshot(this.threadId, tabId, turn.id, fullPage),
              emitBrowserVerificationEvent: (type, payload) => this.services.emit({
                type,
                threadId: this.threadId,
                payload: { ...payload, turnRunId: turn.id },
                createdAt: new Date().toISOString()
              }),
              captureBrowserSnapshot: (tabId) => this.services.captureBrowserSnapshot(this.threadId, tabId, turn.id),
              getThreadOutputDir: () => this.services.getThreadOutputDir(this.threadId),
              abortSignal: abortController.signal,
              generateImageWithDefaultModel: async ({ prompt, toolCallId }) => {
                const generated = await this.createGeneratedImageArtifact({
                  turnId: turn.id,
                  prompt,
                  toolCallId: toolCallId ?? toolRecord.id,
                  abortSignal: abortController.signal
                });
                return generated;
              },
              generateVideoWithDefaultModel: async ({ prompt, toolCallId }) => {
                const generated = await this.createGeneratedVideoArtifact({
                  turnId: turn.id,
                  prompt,
                  toolCallId: toolCallId ?? toolRecord.id,
                  abortSignal: abortController.signal
                });
                return generated;
              },
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
                ...(this.#gpa.stage === "off" ? ["request_user_input"] : []),
                ...(resolveDefaultModalityModel(this.services.config, "image") ? [] : ["image.generate"]),
                ...(resolveDefaultModalityModel(this.services.config, "video") ? [] : ["video.generate"])
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
            content: `${toolMessage.content}\n[tool_call_id: ${toolCall.id}]`,
            toolCallId: toolCall.id,
            toolResultOk: result.ok
          });
          if (result.ok && result.attachments?.length && model.supportsMultimodalInput) {
            transcript.push({
              role: "user",
              content: "[Internal browser verification screenshot. Inspect the rendered page using visible evidence. Do not mention this internal message.]",
              attachments: result.attachments
            });
            browserVerificationEvidence.screenshotAttachmentsSent.add(toolCall.id);
          }
          if (toolCall.name === "image.generate" && result.ok) {
            const attachment = result.json?.attachment as MessageAttachment | undefined;
            const artifactId = typeof result.json?.artifactId === "string" ? result.json.artifactId : undefined;
            if (attachment) {
              await this.recordMessage("assistant", "已生成图片。", turn.id, {
                attachments: [attachment],
                artifactId
              });
            }
          }
          if (toolCall.name === "video.generate" && result.ok) {
            const attachment = result.json?.attachment as MessageAttachment | undefined;
            const artifactId = typeof result.json?.artifactId === "string" ? result.json.artifactId : undefined;
            if (attachment) {
              await this.recordMessage("assistant", "已生成视频。", turn.id, {
                attachments: [attachment],
                artifactId
              });
            }
          }
          if (toolCall.name === "request_user_input" && result.ok) {
            reevaluateAfterUserInput = true;
            break;
          }
          if (result.ok) {
            const workspaceCwd = thread.cwd ?? await this.services.getThreadOutputDir(this.threadId);
            const pathVerification = await verifySuccessfulToolDeliveryPaths(
              toolCall.name,
              toolCall.arguments,
              result,
              workspaceCwd
            );
            const evidence = classifySuccessfulToolEvidence({
              toolCallId: toolCall.id,
              toolRecordId: toolRecord.id,
              toolName: toolCall.name,
              hasPriorDelivery: successfulToolEvidence.some((item) => item.kinds.includes("delivery")),
              verifiedPaths: pathVerification.verifiedPaths,
              requiresVerifiedPath: pathVerification.requiresVerifiedPath
            });
            successfulToolEvidence.push(evidence);
            updateBrowserVerificationEvidence(browserVerificationEvidence, toolCall, result);
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

        // Compact only after the complete native tool batch is recorded so call
        // envelopes and their results remain together in the retained context.
        await compactTranscriptForModel(systemPrompt);

        if (reevaluateAfterUserInput) {
          continue;
        }

        const failure = readRepeatedTaskFailure();
        if (failure) {
          await this.services.log("turn.repeated_task_failure_confirmation_requested", this.threadId, {
            turnRunId: turn.id,
            taskKey: failure.taskKey,
            attempts: failure.attempts,
            lastError: failure.lastError
          });
          const answers = await this.services.requestUserInput(this.threadId, turn.id, {
            title: "同一操作连续失败",
            kind: "generic",
            allowSkip: false,
            questions: [{
              id: "recovery",
              label: "是否继续处理？",
              prompt:
                `操作 ${failure.taskKey} 已连续失败 ${failure.attempts} 次。最后结果：${failure.lastError.slice(0, 500)}`,
              options: [
                {
                  id: "continue",
                  label: "继续尝试",
                  description: "保留当前任务；Agent 会先检查前置条件并改用不同方案。",
                  recommended: true
                },
                {
                  id: "stop",
                  label: "结束任务",
                  description: "停止当前任务，并保留已完成的工作和失败记录。"
                }
              ]
            }]
          });

          if (answers.recovery === "continue") {
            taskFailureCounts.clear();
            failedToolCallFingerprints.clear();
            repeatedTaskFailure = null;
            executionRecoveryAttempts = 0;
            await this.services.log("turn.repeated_task_failure_continued", this.threadId, {
              turnRunId: turn.id,
              taskKey: failure.taskKey,
              previousAttempts: failure.attempts
            });
            transcript.push({
              role: "user",
              content:
                "The user explicitly chose to continue after repeated failures. Do not repeat the same failed tool call unchanged. First inspect the target, path, permissions, or command preconditions, then use a materially different patch, command, or approach. Continue the original task after obtaining new evidence."
            });
            continue;
          }
        }

      }

      const terminalRepeatedTaskFailure = readRepeatedTaskFailure();
      if (terminalRepeatedTaskFailure) {
        const errorMessage =
          `The same task (${terminalRepeatedTaskFailure.taskKey}) failed ${terminalRepeatedTaskFailure.attempts} consecutive times. ` +
          `Last error: ${terminalRepeatedTaskFailure.lastError}`;
        await this.recordMessage(
          "assistant",
          buildRepeatedTaskRecoveryMessage(terminalRepeatedTaskFailure),
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
          taskKey: terminalRepeatedTaskFailure.taskKey,
          attempts: terminalRepeatedTaskFailure.attempts,
          lastError: terminalRepeatedTaskFailure.lastError
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
      if (
        this.#gpa.stage === "goal" ||
        (this.#gpa.stage === "plan" && this.#gpa.planTasks.length > 0)
      ) {
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
      } else {
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
      }
    }
    } catch (error) {
      if (abortController.signal.aborted) {
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
        await this.services.emit({
          type: "thread.updated",
          threadId: this.threadId,
          payload: { thread: updatedThread },
          createdAt: completedAt
        });
      } else {
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
      }
    } finally {
      for (const tabId of browserVerificationEvidence.tabIds) {
        if (agentOpenedBrowserTabIds.has(tabId)) continue;
        try {
          await this.services.setBrowserViewport(this.threadId, tabId, null);
        } catch (error) {
          await this.services.log("browser.viewport_restore_failed", this.threadId, {
            turnRunId: turn.id,
            tabId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (agentOpenedBrowserTabIds.size > 0) {
        const tabIds = [...agentOpenedBrowserTabIds];
        try {
          await this.services.closeBrowserTabs(this.threadId, tabIds);
          await this.services.log("browser.task_tabs_released", this.threadId, {
            turnRunId: turn.id,
            tabIds,
            count: tabIds.length
          });
        } catch (error) {
          await this.services.log("browser.task_tabs_release_failed", this.threadId, {
            turnRunId: turn.id,
            tabIds,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      this.#activeTurnRunId = null;
      if (this.#abortController === abortController) {
        this.#abortController = null;
      }
      // Wakeups that arrived while this turn was active may have no-op'd.
      // Re-check the queue so a message sent right after Stop is not stuck.
      this.submit({ type: "queue_wakeup" });
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
    const imageReady = !!resolveDefaultModalityModel(this.services.config, "image");
    const videoReady = !!resolveDefaultModalityModel(this.services.config, "video");
    const withKnowledge = knowledgeEnabled
      ? direct
      : direct.filter((tool) => tool.name !== "knowledge.search" && tool.name !== "knowledge.read");
    const withMedia = withKnowledge.filter((tool) => {
      if (tool.name === "image.generate") return imageReady;
      if (tool.name === "video.generate") return videoReady;
      return true;
    });
    return {
      tools: !agentToolsEnabled
        ? []
        : gpaEnabled
        ? withMedia
        : withMedia.filter((tool) => tool.name !== "request_user_input"),
      mcpTools
    };
  }

  private async classifyMultimodalIntent(input: {
    currentInput: string;
    attachments: MessageAttachment[];
    priorMessages: Array<{ role: string; content: string }>;
    model: ModelProfile;
    provider: ProviderDefinition;
    abortController: AbortController;
    turnId: string;
  }): Promise<MultimodalIntentClassification> {
    const fallback: MultimodalIntentClassification = { intent: "none", prompt: "", parseOk: false };
    try {
      const adapter = this.services.providerFactory.create(input.provider);
      const classifyAbort = createChildAbortController(input.abortController.signal);
      const decision = await waitForAbortOrTimeout(
        adapter.runTurn({
          systemPrompt: buildMultimodalIntentClassifySystemPrompt(),
          transcript: buildMultimodalIntentClassifyTranscript({
            priorMessages: input.priorMessages,
            currentInput: input.currentInput,
            attachments: input.attachments
          }),
          availableTools: [],
          model: input.model,
          provider: input.provider,
          stream: false,
          abortSignal: classifyAbort.signal
        }),
        input.abortController.signal,
        this.services.config.timeouts.multimodalIntentClassifyMs,
        () => classifyAbort.abort()
      );

      const raw =
        typeof decision.assistantMessage === "string" && decision.assistantMessage.trim()
          ? decision.assistantMessage
          : "";
      const classification = parseMultimodalIntentClassification(raw);
      await this.services.log("multimodal.intent_classify", this.threadId, {
        turnRunId: input.turnId,
        intent: classification.intent,
        parseOk: classification.parseOk,
        viaModel: true,
        promptPreview: classification.prompt.slice(0, 200),
        rawPreview: raw.slice(0, 240)
      });
      return classification;
    } catch (error) {
      if (input.abortController.signal.aborted) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      await this.services.log("multimodal.intent_classify", this.threadId, {
        turnRunId: input.turnId,
        intent: "none",
        parseOk: false,
        viaModel: true,
        failed: true,
        reason: error instanceof Error ? error.message : String(error)
      });
      return fallback;
    }
  }

  private async runMultimodalIntentTurn(input: {
    intent: "image" | "video";
    turnId: string;
    prompt: string;
    abortController: AbortController;
  }): Promise<void> {
    const label = input.intent === "image" ? "图片" : "视频";
    const modality = this.services.config.multimodal?.[input.intent];
    if (modality && modality.enabled === false) {
      await this.finishWithFriendlyTip(
        input.turnId,
        `${label}生成已关闭。请到「设置 → 多模态」开启${label}生成；开启后直接回复「再试试」即可继续。`
      );
      return;
    }

    const target = input.intent === "image"
      ? resolveDefaultModalityModel(this.services.config, "image")
      : resolveDefaultModalityModel(this.services.config, "video");

    if (!target) {
      const hasRoleModels = this.services.config.models.some((model) => model.role === input.intent);
      await this.finishWithFriendlyTip(
        input.turnId,
        hasRoleModels
          ? `尚未设置默认${label}模型。请到「设置 → 多模态」指定默认${label}模型；设置后直接回复「再试试」即可继续。`
          : `尚未配置${label}模型。请先在「供应商设置」添加模型，再到「设置 → 多模态」加入并设为默认；完成后直接回复「再试试」即可继续。`
      );
      return;
    }

    if (input.intent === "image") {
      await this.runImageGeneration({
        turnId: input.turnId,
        model: target.model,
        provider: target.provider,
        prompt: input.prompt,
        abortController: input.abortController
      });
      return;
    }

    await this.runVideoGeneration({
      turnId: input.turnId,
      model: target.model,
      provider: target.provider,
      prompt: input.prompt,
      abortController: input.abortController
    });
  }

  private async finishWithFriendlyTip(turnId: string, message: string): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.recordMessage("assistant", message, turnId);
    await this.services.persistence.finishTurn(turnId, { status: "completed", completedAt, errorMessage: null });
    const thread = await this.services.persistence.updateThread(this.threadId, { status: "completed", updatedAt: completedAt });
    await this.services.emit({
      type: "assistant.completed",
      threadId: this.threadId,
      payload: { turnRunId: turnId },
      createdAt: completedAt
    });
    await this.services.emit({ type: "thread.updated", threadId: this.threadId, payload: { thread }, createdAt: completedAt });
  }

  private async createGeneratedImageArtifact(input: {
    turnId: string;
    prompt: string;
    toolCallId?: string | null;
    abortSignal?: AbortSignal;
  }): Promise<{
    fileName: string;
    absolutePath: string;
    mimeType: string;
    modelId: string;
    providerId: string;
    modelDisplayName: string;
    attachment: MessageAttachment;
    artifact: ArtifactRecord;
  }> {
    const target = resolveDefaultModalityModel(this.services.config, "image");
    if (!target) {
      const hasRoleModels = this.services.config.models.some((model) => model.role === "image");
      throw new Error(
        hasRoleModels
          ? "尚未设置默认图片模型。请到「设置 → 多模态」指定一个默认图片模型后再试。"
          : "尚未配置图片模型。请先在「供应商设置」添加模型，再到「设置 → 多模态」加入图片模型并设为默认。"
      );
    }
    if (this.services.config.multimodal?.image?.enabled === false) {
      throw new Error("图片生成已关闭。可到「设置 → 多模态」开启图片生成功能后再试。");
    }

    const adapter = this.services.providerFactory.create(target.provider);
    if (!adapter.generateImage) {
      throw new Error("当前默认图片供应商不支持 OpenAI 兼容图片生成接口。请确认中转提供 /images/generations。");
    }
    const image = await waitForAbort(adapter.generateImage({
      model: target.model,
      prompt: input.prompt,
      abortSignal: input.abortSignal
    }), input.abortSignal ?? new AbortController().signal);

    const outputDir = await this.services.getThreadOutputDir(this.threadId);
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `generated-${Date.now()}-${randomUUID().slice(0, 8)}.${imageExtensionForMime(image.mimeType)}`;
    const absolutePath = path.join(outputDir, fileName);
    await fs.writeFile(absolutePath, image.data);
    const attachment: MessageAttachment = {
      id: randomUUID(),
      kind: "image",
      name: fileName,
      mimeType: image.mimeType,
      absolutePath,
      sizeBytes: image.data.byteLength,
      source: "generated"
    };
    const artifact = await this.services.persistence.addArtifact({
      threadId: this.threadId,
      turnRunId: input.turnId,
      messageId: null,
      toolCallId: input.toolCallId ?? null,
      artifactKind: "generated-image",
      displayName: fileName,
      absolutePath,
      relativePath: fileName,
      mimeType: image.mimeType,
      sizeBytes: image.data.byteLength,
      sha256: createHash("sha256").update(image.data).digest("hex"),
      sourceKind: "image-generation",
      isUserVisible: true,
      status: "ready"
    });
    await this.services.log("image.generate", this.threadId, {
      turnRunId: input.turnId,
      toolCallId: input.toolCallId ?? null,
      modelId: target.model.id,
      providerId: target.provider.id,
      fileName,
      promptPreview: input.prompt.slice(0, 200)
    });
    return {
      fileName,
      absolutePath,
      mimeType: image.mimeType,
      modelId: target.model.id,
      providerId: target.provider.id,
      modelDisplayName: target.model.displayName || target.model.id,
      attachment,
      artifact
    };
  }

  private async createGeneratedVideoArtifact(input: {
    turnId: string;
    prompt: string;
    toolCallId?: string | null;
    abortSignal?: AbortSignal;
  }): Promise<{
    fileName: string;
    absolutePath: string;
    mimeType: string;
    modelId: string;
    providerId: string;
    modelDisplayName: string;
    attachment: MessageAttachment;
    artifact: ArtifactRecord;
  }> {
    const target = resolveDefaultModalityModel(this.services.config, "video");
    if (!target) {
      const hasRoleModels = this.services.config.models.some((model) => model.role === "video");
      throw new Error(
        hasRoleModels
          ? "尚未设置默认视频模型。请到「设置 → 多模态」指定一个默认视频模型后再试。"
          : "尚未配置视频模型。请先在「供应商设置」添加模型，再到「设置 → 多模态」加入视频模型并设为默认。"
      );
    }
    if (this.services.config.multimodal?.video?.enabled === false) {
      throw new Error("视频生成已关闭。可到「设置 → 多模态」开启视频生成功能后再试。");
    }

    const adapter = this.services.providerFactory.create(target.provider);
    if (!adapter.generateVideo) {
      throw new Error("当前默认视频供应商尚未接入视频生成接口。请确认服务端已提供兼容的视频生成能力。");
    }
    const video = await waitForAbort(adapter.generateVideo({
      model: target.model,
      prompt: input.prompt,
      abortSignal: input.abortSignal,
      timeoutMs: this.services.config.timeouts.videoGenerationMs,
      pollIntervalMs: this.services.config.timeouts.videoPollIntervalMs
    }), input.abortSignal ?? new AbortController().signal);

    const outputDir = await this.services.getThreadOutputDir(this.threadId);
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `generated-${Date.now()}-${randomUUID().slice(0, 8)}.${videoExtensionForMime(video.mimeType)}`;
    const absolutePath = path.join(outputDir, fileName);
    await fs.writeFile(absolutePath, video.data);
    const attachment: MessageAttachment = {
      id: randomUUID(),
      kind: "video",
      name: fileName,
      mimeType: video.mimeType,
      absolutePath,
      sizeBytes: video.data.byteLength,
      source: "generated"
    };
    const artifact = await this.services.persistence.addArtifact({
      threadId: this.threadId,
      turnRunId: input.turnId,
      messageId: null,
      toolCallId: input.toolCallId ?? null,
      artifactKind: "generated-video",
      displayName: fileName,
      absolutePath,
      relativePath: fileName,
      mimeType: video.mimeType,
      sizeBytes: video.data.byteLength,
      sha256: createHash("sha256").update(video.data).digest("hex"),
      sourceKind: "video-generation",
      isUserVisible: true,
      status: "ready"
    });
    await this.services.log("video.generate", this.threadId, {
      turnRunId: input.turnId,
      toolCallId: input.toolCallId ?? null,
      modelId: target.model.id,
      providerId: target.provider.id,
      fileName,
      promptPreview: input.prompt.slice(0, 200)
    });
    return {
      fileName,
      absolutePath,
      mimeType: video.mimeType,
      modelId: target.model.id,
      providerId: target.provider.id,
      modelDisplayName: target.model.displayName || target.model.id,
      attachment,
      artifact
    };
  }

  private async runImageGeneration(input: {
    turnId: string;
    model: ModelProfile;
    provider: ProviderDefinition;
    prompt: string;
    abortController: AbortController;
  }): Promise<void> {
    const startedAt = new Date().toISOString();
    try {
      void input.model;
      void input.provider;
      const generated = await this.createGeneratedImageArtifact({
        turnId: input.turnId,
        prompt: input.prompt,
        abortSignal: input.abortController.signal
      });
      const completedAt = new Date().toISOString();
      const message = await this.recordMessage("assistant", "已生成图片。", input.turnId, {
        attachments: [generated.attachment],
        artifactId: generated.artifact.id
      });
      await this.services.persistence.finishTurn(input.turnId, { status: "completed", completedAt, errorMessage: null });
      const thread = await this.services.persistence.updateThread(this.threadId, { status: "completed", updatedAt: completedAt });
      await this.services.emit({ type: "assistant.completed", threadId: this.threadId, payload: { turnRunId: input.turnId, messageId: message.id }, createdAt: completedAt });
      await this.services.emit({ type: "thread.updated", threadId: this.threadId, payload: { thread }, createdAt: completedAt });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const reason = error instanceof Error ? error.message : String(error);
      await this.recordMessage("assistant", `图片生成失败：${reason}`, input.turnId);
      await this.services.persistence.finishTurn(input.turnId, { status: "failed", completedAt, errorMessage: reason });
      const thread = await this.services.persistence.updateThread(this.threadId, { status: "failed", updatedAt: completedAt });
      await this.services.emit({ type: "thread.updated", threadId: this.threadId, payload: { thread }, createdAt: completedAt });
      await this.services.log("image.generate_failed", this.threadId, {
        turnRunId: input.turnId,
        startedAt,
        error: reason
      });
    }
  }

  private async runVideoGeneration(input: {
    turnId: string;
    model: ModelProfile;
    provider: ProviderDefinition;
    prompt: string;
    abortController: AbortController;
  }): Promise<void> {
    const startedAt = new Date().toISOString();
    try {
      void input.model;
      void input.provider;
      const generated = await this.createGeneratedVideoArtifact({
        turnId: input.turnId,
        prompt: input.prompt,
        abortSignal: input.abortController.signal
      });
      const completedAt = new Date().toISOString();
      const message = await this.recordMessage("assistant", "已生成视频。", input.turnId, {
        attachments: [generated.attachment],
        artifactId: generated.artifact.id
      });
      await this.services.persistence.finishTurn(input.turnId, { status: "completed", completedAt, errorMessage: null });
      const thread = await this.services.persistence.updateThread(this.threadId, { status: "completed", updatedAt: completedAt });
      await this.services.emit({ type: "assistant.completed", threadId: this.threadId, payload: { turnRunId: input.turnId, messageId: message.id }, createdAt: completedAt });
      await this.services.emit({ type: "thread.updated", threadId: this.threadId, payload: { thread }, createdAt: completedAt });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const reason = error instanceof Error ? error.message : String(error);
      const assistantContent = isGeneratedVideoDownloadError(error)
        ? reason
        : `视频生成失败：${reason}`;
      await this.recordMessage("assistant", assistantContent, input.turnId);
      await this.services.persistence.finishTurn(input.turnId, { status: "failed", completedAt, errorMessage: reason });
      const thread = await this.services.persistence.updateThread(this.threadId, { status: "failed", updatedAt: completedAt });
      await this.services.emit({ type: "thread.updated", threadId: this.threadId, payload: { thread }, createdAt: completedAt });
      await this.services.log("video.generate_failed", this.threadId, {
        turnRunId: input.turnId,
        startedAt,
        error: reason,
        ...(isGeneratedVideoDownloadError(error) ? { videoUrl: error.videoUrl, stage: "download" } : {})
      });
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

const RETARGETABLE_BROWSER_OBSERVATION_TOOLS = new Set([
  "browser.inspect_page",
  "browser.read_page_text",
  "browser.reload"
]);

export function retargetStaleBrowserObservationToolCall(
  toolCall: RuntimeToolCall,
  browserTabs: BrowserTabRecord[]
): RuntimeToolCall | null {
  if (!RETARGETABLE_BROWSER_OBSERVATION_TOOLS.has(toolCall.name)) {
    return null;
  }
  const requestedTabId = typeof toolCall.arguments.tabId === "string" ? toolCall.arguments.tabId : "";
  const activeTab = browserTabs.find((tab) => tab.isActive);
  if (!requestedTabId || !activeTab || activeTab.id === requestedTabId) {
    return null;
  }
  return {
    ...toolCall,
    arguments: { ...toolCall.arguments, tabId: activeTab.id }
  };
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

const OBSERVATION_TOOL_NAMES = new Set([
  "fs.read_file",
  "fs.read_directory",
  "code.search",
  "code.ast_diff",
  "git.status",
  "git.diff",
  "knowledge.search",
  "knowledge.read",
  "web_search.search_query",
  "web_search.open_page",
  "web_search.find_in_page",
  "browser.list_tabs",
  "browser.read_page_text",
  "browser.inspect_page",
  "browser.wait_for",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "mcp.list_tools"
]);

const DELIVERY_TOOL_NAMES = new Set([
  "apply_patch",
  "fs.write_file",
  "git.commit",
  "git.worktree_add",
  "git.worktree_remove",
  "browser.click",
  "browser.fill",
  "browser.select_option",
  "browser.press_key",
  "mcp.call"
]);

const SELF_VERIFYING_ARTIFACT_TOOLS = new Set([
  "image.generate",
  "video.generate"
]);

const POST_DELIVERY_VERIFICATION_TOOLS = new Set([
  "fs.read_file",
  "fs.read_directory",
  "code.ast_diff",
  "git.status",
  "git.diff",
  "shell.exec",
  "browser.read_page_text",
  "browser.inspect_page",
  "browser.wait_for",
  "browser.assert_page",
  "browser.capture_snapshot",
  "browser.capture_screenshot"
]);

const FRONTEND_DELIVERY_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"
]);

function buildBrowserVerificationDirective(stage: GpaStage): string {
  if (stage !== "act") return "";
  return [
    "\n\nFrontend verification policy:",
    "After changing HTML, CSS, JavaScript, JSX, TSX, Vue, Svelte, Canvas, or other browser-rendered resources, you must verify the current result in the app browser before completing.",
    "Use the same tab and follow: reload/open page -> browser.set_viewport -> browser.assert_page -> browser.capture_screenshot.",
    "Verify desktop 1440x900 and mobile 390x844 unless the user explicitly requested a desktop-only page.",
    "Assertions must include relevant text/elements, images_loaded, no_horizontal_overflow, no_severe_console_errors, and canvas_nonblank for Canvas/game work.",
    "A screenshot from before the latest file change is invalid. If the model supports images, inspect the screenshot attachment before claiming visual quality.",
    "If the model does not support images, rely on deterministic assertions and explicitly state `未执行视觉模型检查（model_not_multimodal）` in the final summary."
  ].join(" ");
}

function updateBrowserVerificationEvidence(
  state: BrowserVerificationEvidenceState,
  toolCall: RuntimeToolCall,
  result: ToolResult
): void {
  state.operationIndex = (state.operationIndex ?? 0) + 1;
  const operationIndex = state.operationIndex;
  const touchedPaths = getDeliveredFilePaths(toolCall.name, toolCall.arguments, result);
  const frontendPaths = touchedPaths.filter((filePath) => FRONTEND_DELIVERY_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  if (frontendPaths.length > 0) {
    state.required = true;
    state.latestFrontendDeliveryIndex = operationIndex;
    state.desktopAssertions.clear();
    state.mobileAssertions.clear();
    state.desktopScreenshots.clear();
    state.mobileScreenshots.clear();
    state.screenshotAttachmentsSent.clear();
    const payload = JSON.stringify(toolCall.arguments);
    if (/canvas|getContext\s*\(|three(?:\.js)?|pixi|phaser|game/i.test(payload)) state.canvasRequired = true;
  }

  if (["browser.open_tab", "browser.navigate", "browser.reload"].includes(toolCall.name)) {
    state.latestPageLoadIndex = operationIndex;
  }
  const currentDelivery = state.latestFrontendDeliveryIndex ?? 0;
  const pageIsFresh = (state.latestPageLoadIndex ?? 0) >= currentDelivery;
  if (!state.required || !pageIsFresh) return;

  const tabId = typeof toolCall.arguments.tabId === "string" ? toolCall.arguments.tabId : "";
  if (tabId) state.tabIds.add(tabId);

  const viewport = result.json?.viewport as BrowserViewport | undefined;
  const bucket = viewport && viewport.width <= 500 ? "mobile" : "desktop";
  if (toolCall.name === "browser.assert_page" && result.json?.passed === true) {
    const results = Array.isArray(result.json.results) ? result.json.results as Array<{ check?: { type?: string }; passed?: boolean }> : [];
    if (state.canvasRequired && !results.some((entry) => entry.check?.type === "canvas_nonblank" && entry.passed === true)) return;
    (bucket === "mobile" ? state.mobileAssertions : state.desktopAssertions).add(toolCall.id);
  }
  if (toolCall.name === "browser.capture_screenshot") {
    const width = Number(result.json?.width ?? 0);
    const height = Number(result.json?.height ?? 0);
    if (width > 0 && height > 0 && result.attachments?.some((attachment) => attachment.kind === "image")) {
      (bucket === "mobile" ? state.mobileScreenshots : state.desktopScreenshots).add(toolCall.id);
    }
  }
}

function getDeliveredFilePaths(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult
): string[] {
  if (toolName === "apply_patch") {
    const patch = [args.patch, args.patch_content, args.patchText].find((value): value is string => typeof value === "string") ?? "";
    return [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((match) => match[1].trim());
  }
  if (toolName === "fs.write_file") {
    const candidate = typeof result.json?.path === "string" ? result.json.path : typeof args.path === "string" ? args.path : "";
    return candidate ? [candidate] : [];
  }
  return [];
}

export function classifySuccessfulToolEvidence(input: {
  toolCallId: string;
  toolRecordId?: string;
  toolName: string;
  hasPriorDelivery: boolean;
  verifiedPaths?: string[];
  requiresVerifiedPath?: boolean;
}): SuccessfulToolEvidence {
  const kinds = new Set<CompletionEvidenceKind>();
  if (OBSERVATION_TOOL_NAMES.has(input.toolName)) {
    kinds.add("observation");
  }
  if (
    DELIVERY_TOOL_NAMES.has(input.toolName) &&
    (!input.requiresVerifiedPath || (input.verifiedPaths?.length ?? 0) > 0)
  ) {
    kinds.add("delivery");
  }
  if (SELF_VERIFYING_ARTIFACT_TOOLS.has(input.toolName)) {
    kinds.add("delivery");
    kinds.add("verification");
  }
  if (input.hasPriorDelivery && POST_DELIVERY_VERIFICATION_TOOLS.has(input.toolName)) {
    kinds.add("verification");
  }
  return {
    toolCallId: input.toolCallId,
    toolRecordId: input.toolRecordId,
    toolName: input.toolName,
    kinds: [...kinds],
    verifiedPaths: input.verifiedPaths
  };
}

export function validateActCompletion(input: {
  decision: Pick<
    ProviderTurnDecision,
    "assistantMessage" | "toolCalls" | "endTurn" | "goalCompleted" |
    "completedTaskIds" | "completionEvidence"
  >;
  planTasks: GpaState["planTasks"];
  successfulEvidence: SuccessfulToolEvidence[];
  browserVerification?: BrowserCompletionRequirement;
}): ActCompletionValidationResult {
  const reasons: string[] = [];
  const planTaskIds = input.planTasks.map((task) => task.id.toUpperCase());
  const completedTaskIds = new Set(
    (input.decision.completedTaskIds ?? []).map((id) => id.toUpperCase())
  );
  const missingTaskIds = planTaskIds.filter((id) => !completedTaskIds.has(id));
  const evidenceById = new Map<string, SuccessfulToolEvidence>();
  for (const evidence of input.successfulEvidence) {
    evidenceById.set(evidence.toolCallId, evidence);
    if (evidence.toolRecordId) {
      evidenceById.set(evidence.toolRecordId, evidence);
    }
  }

  const validEvidenceByTask = new Map<string, SuccessfulToolEvidence[]>();
  const invalidEvidenceToolCallIds = new Set<string>();
  for (const reference of input.decision.completionEvidence ?? []) {
    const actual = evidenceById.get(reference.toolCallId);
    if (!actual || !actual.kinds.includes(reference.kind)) {
      invalidEvidenceToolCallIds.add(reference.toolCallId);
      continue;
    }
    const taskId = reference.taskId.toUpperCase();
    const current = validEvidenceByTask.get(taskId) ?? [];
    current.push(actual);
    validEvidenceByTask.set(taskId, current);
  }

  const missingEvidenceTaskIds = planTaskIds.filter(
    (id) => (validEvidenceByTask.get(id)?.length ?? 0) === 0
  );
  const referencedEvidence = [...validEvidenceByTask.values()].flat();
  const missingDelivery = !referencedEvidence.some((item) => item.kinds.includes("delivery"));
  const missingVerification = !referencedEvidence.some((item) => item.kinds.includes("verification"));
  const missingBrowserVerification: string[] = [];
  const browser = input.browserVerification;
  if (browser) {
    if (browser.desktopAssertionCount === 0) missingBrowserVerification.push("desktop page assertions");
    if (browser.desktopScreenshotCount === 0) missingBrowserVerification.push("desktop screenshot");
    if (!browser.desktopOnly && browser.mobileAssertionCount === 0) missingBrowserVerification.push("mobile page assertions");
    if (!browser.desktopOnly && browser.mobileScreenshotCount === 0) missingBrowserVerification.push("mobile screenshot");
    if (browser.modelSupportsMultimodalInput && browser.screenshotAttachmentCount === 0) {
      missingBrowserVerification.push("screenshot visual context");
    }
    if (
      browser.modelSupportsMultimodalInput &&
      !/(?:截图|视觉|screenshot|visual)/i.test(input.decision.assistantMessage ?? "")
    ) {
      missingBrowserVerification.push("final screenshot inspection result");
    }
    if (!browser.modelSupportsMultimodalInput && browser.visualSkippedReason !== "model_not_multimodal") {
      missingBrowserVerification.push("visual skip reason");
    }
    if (
      !browser.modelSupportsMultimodalInput &&
      !/(?:未执行视觉模型检查|model_not_multimodal|visual model check was not performed)/i.test(input.decision.assistantMessage ?? "")
    ) {
      missingBrowserVerification.push("final visual-skip disclosure");
    }
  }

  if (!input.decision.endTurn) reasons.push("The model did not end the turn.");
  if (input.decision.toolCalls.length > 0) reasons.push("Tool calls are still pending.");
  if (!input.decision.goalCompleted) reasons.push("The model did not declare the original goal complete.");
  if (!input.decision.assistantMessage?.trim()) reasons.push("The final user-visible summary is empty.");
  if (isProgressOnlyAssistantMessage(input.decision.assistantMessage ?? "")) {
    reasons.push("The assistant message is progress commentary, not a final summary.");
  }
  if (planTaskIds.length === 0) reasons.push("The confirmed GPA plan has no validated tasks.");
  if (missingTaskIds.length > 0) reasons.push(`Plan tasks are not declared complete: ${missingTaskIds.join(", ")}.`);
  if (missingEvidenceTaskIds.length > 0) {
    reasons.push(`Plan tasks have no valid tool evidence: ${missingEvidenceTaskIds.join(", ")}.`);
  }
  if (invalidEvidenceToolCallIds.size > 0) {
    reasons.push(`Completion evidence references unknown or mismatched tool calls: ${[...invalidEvidenceToolCallIds].join(", ")}.`);
  }
  if (missingDelivery) reasons.push("No verified delivery evidence was referenced.");
  if (missingVerification) reasons.push("No post-delivery verification evidence was referenced.");
  if (missingBrowserVerification.length > 0) {
    reasons.push(`Frontend browser verification is incomplete: ${missingBrowserVerification.join(", ")}.`);
  }

  return {
    valid: reasons.length === 0,
    reasons,
    missingTaskIds,
    missingEvidenceTaskIds,
    invalidEvidenceToolCallIds: [...invalidEvidenceToolCallIds],
    missingDelivery,
    missingVerification,
    missingBrowserVerification
  };
}

export function buildActCompletionRecoveryInstruction(
  result: ActCompletionValidationResult
): string {
  const nextAction = result.missingDelivery
    ? "Call the next delivery tool now. For file work, use apply_patch or fs.write_file and wait for its successful result."
    : result.missingVerification
      ? "Call a verification tool now, such as a test/build command or a read-back of the changed files."
      : (result.missingBrowserVerification?.length ?? 0) > 0
        ? "Complete browser verification on the same rendered tab: reload it, run browser.set_viewport and browser.assert_page, then browser.capture_screenshot for each required viewport."
      : "Return a corrected final JSON decision using only the successful tool call ids already present in the transcript.";
  return [
    "[Internal completion validation. Do not display or quote this instruction to the user.]",
    "The task was not completed because the runtime could not verify the claimed result.",
    ...result.reasons,
    nextAction,
    "Do not return progress prose. Set goal_completed to true only after completed_task_ids covers every PLAN task and completion_evidence references real successful tool_call_id values for delivery and verification."
  ].join(" ");
}

async function verifySuccessfulToolDeliveryPaths(
  toolName: string,
  argumentsJson: Record<string, unknown>,
  result: ToolResult,
  workspaceCwd: string
): Promise<{ verifiedPaths: string[]; requiresVerifiedPath: boolean }> {
  const candidates: string[] = [];
  let requiresVerifiedPath = false;
  if (toolName === "apply_patch") {
    const patch = [argumentsJson.patch, argumentsJson.patch_content, argumentsJson.patchText].find(
      (value): value is string => typeof value === "string"
    ) ?? "";
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) {
      candidates.push(match[1].trim());
    }
    requiresVerifiedPath = candidates.length > 0;
  } else if (toolName === "fs.write_file") {
    const resultPath = result.json?.path;
    const argumentPath = argumentsJson.path;
    const candidate = typeof resultPath === "string"
      ? resultPath
      : typeof argumentPath === "string"
        ? argumentPath
        : "";
    if (candidate) candidates.push(candidate);
    requiresVerifiedPath = true;
  } else if (toolName === "image.generate" || toolName === "video.generate") {
    const attachment = result.json?.attachment as MessageAttachment | undefined;
    if (attachment?.absolutePath) candidates.push(attachment.absolutePath);
  }

  const verifiedPaths: string[] = [];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const absolutePath = path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.resolve(workspaceCwd, candidate);
    try {
      await fs.access(absolutePath);
      verifiedPaths.push(absolutePath);
    } catch {
      // A claimed file delivery is not evidence until the path exists on disk.
    }
  }
  return { verifiedPaths, requiresVerifiedPath };
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
      "任务已停止：当前模型未开启工具调用，无法执行 Agent 决策。",
      `模型：${error.modelName}`,
      `原因：${error.lastReason}`,
      "请在模型设置中开启工具调用后重试。普通聊天仍可继续使用当前模型。",
      "为避免误执行，系统没有根据普通文本猜测命令或文件修改；已完成的工具结果和项目文件会被保留。"
    ].join("\n");
  }

  if (error instanceof ModelDecisionTimeoutError) {
    return [
      "任务暂时停止：模型在限定时间内没有返回可执行决策，已自动重试多次仍未成功。",
      "建议：确认当前模型和服务地址可用后重试。",
      "项目文件没有被未经验证地修改，已有的工具结果和日志会保留供下一次任务继续使用。"
    ].join("\n");
  }

  if (error instanceof Error && error.message.startsWith("Agent decision protocol failed repeatedly:")) {
    return [
      "任务暂时停止：模型连续多次未能返回可执行的 Agent 决策。",
      `原因：${error.message.replace(/^Agent decision protocol failed repeatedly:\s*/, "")}`,
      "建议：稍后重试，或检查当前模型服务是否可用。已完成的工具结果和项目文件会被保留。"
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

export function isProgressOnlyAssistantMessage(content: string): boolean {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }
  if (/<event\s+type=["']commentary["'][^>]*>/i.test(normalized) &&
      !/<event\s+type=["']final["'][^>]*>/i.test(normalized)) {
    return true;
  }
  return /^(?:(?:好的|好)[，,。!！\s]*)?(?:计划已确认|开始实施|开始执行|正在|接下来|下一步|准备(?:开始)?|我(?:将|会|先)|先(?:来|从)|starting\b|working\s+on\b|fetching\b|next\s+i\s+will\b|i\s+will\b)/i.test(normalized);
}

function isDeferredExecutionPayload(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (isProgressOnlyAssistantMessage(trimmed)) {
    return true;
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
  return model.supportsToolCalling === true;
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
  knowledgeEnabled: boolean,
  imageGenerateAvailable = false,
  videoGenerateAvailable = false
): RuntimePromptBundle {
  const blocks = [
    "You are codexh, a desktop agent for project and chat workflows.",
    `Current local date: ${formatRuntimeDate(new Date())}. Use this date for time-sensitive queries. Do not add, infer, or reuse a year that the user did not request.`,
    "Prefer progressive disclosure: inspect facts before making edits.",
    "When a tool can gather needed facts, call it instead of guessing.",
    "Before responding, decide whether an available Skill is the best fit. When it is, call skills.load with that skill_id before following its instructions. Use Function Calling for Skills and external tools rather than merely claiming a Skill was used."
  ];
  if (imageGenerateAvailable) {
    blocks.push(
      "When the user asks to generate, draw, recreate, or vary an image (including follow-ups like 再换一张/再来一张), load the generate_image skill and call image.generate. That tool uses the default image model from Settings → Multimodal, not the chat reasoning model. Never call image_gen, imagegen, or any invented image tool name. Never claim an image was created without a successful image.generate result."
    );
  }
  if (videoGenerateAvailable) {
    blocks.push(
      "When the user asks to generate or recreate a video, load the generate_video skill and call video.generate. That tool uses the default video model from Settings → Multimodal, not the chat reasoning model. Never call video_gen, videogen, or any invented video tool name. Never claim a video was created without a successful video.generate result."
    );
  }
  blocks.push(
    "For MCP capabilities, call mcp.list_tools first. Then call mcp.call only with a server and tool from that directory. Use MCP resource tools only when a listed resource is needed.",
    "For browser automation, call browser.inspect_page before browser.click, browser.fill, browser.select_option, or browser.press_key. Use only element ids returned by the latest inspection, then inspect again after navigation or page changes. Never guess selectors or claim a browser action succeeded without a tool result."
  );
  if (knowledgeEnabled) {
    blocks.push(
      "For local knowledge questions, call knowledge.search first. It returns ranked document chunks with source_path and locator; use knowledge.read only for the relevant chunk. Cite the source file and locator in your answer when you rely on retrieved material. Never use fs.read_file on a knowledge Bundle or index path. If search returns no results, refine the query once or explain that no matching local material was found; do not repeat the same progress reply."
    );
  }
  blocks.push(
    "When using text extracted from a browser page, cite the page title or URL in your answer. The chat will show the page source automatically.",
    "Respond as an IDE software engineering agent using an event stream format.",
    "Your visible output is consumed by a renderer that understands structured event blocks.",
    "Prefer XML-like event envelopes when possible: <event type=\"commentary\">...</event>.",
    "Allowed event types: commentary, tool_call, tool_result, file_view, file_change, test_result, final.",
    "Before substantial work emit 1-2 sentences of commentary. After each tool use, summarize with tool_result. When surfacing files, use file_view or file_change. Use test_result for validation. End with a concise final covering result, verification, and risks.",
    "Do not expose chain-of-thought. Do not fabricate tool usage, file changes, or verification.",
    `Context window: ${model.contextWindow}.`
  );
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

export function buildRuntimeTranscript(messages: MessageRecord[]): ProviderTurnInput["transcript"] {
  return messages.map((message) => ({
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

function videoExtensionForMime(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("x-matroska") || mimeType.includes("mkv")) return "mkv";
  return "mp4";
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

function resolveDefaultModalityModel(
  config: AppConfig,
  role: "image" | "video"
): { provider: ProviderDefinition; model: ModelProfile } | null {
  const modality = config.multimodal?.[role];
  if (!modality || modality.enabled === false) {
    return null;
  }
  const providerId = modality.defaultProviderId?.trim();
  const modelId = modality.defaultModelId?.trim();
  if (!providerId || !modelId) {
    return null;
  }
  const model = config.models.find(
    (entry) => entry.id === modelId && entry.providerId === providerId && entry.role === role
  );
  const provider = config.providers.find((entry) => entry.id === providerId);
  if (!model || !provider) {
    return null;
  }
  return {
    provider,
    model: {
      ...model,
      supportsImageGeneration: role === "image",
      supportsVideoGeneration: role === "video"
    }
  };
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
