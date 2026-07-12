import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  ArtifactRecord,
  McpServerConfig,
  MessageRecord,
  ModelProfile,
  ProviderTurnDecision,
  ProviderTurnInput,
  RuntimeEvent,
  RuntimePromptBundle,
  RuntimeThreadSnapshot,
  SkillMetadata,
  ThreadRecord,
  ToolCallRecord,
  ToolResult,
  ToolSpecDefinition,
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

export const MAX_REPEATED_TASK_FAILURES = 5;
export const MODEL_DECISION_TIMEOUT_MS = 90_000;
export const CONTEXT_COMPACTION_THRESHOLD = 0.8;
export const CONTEXT_COMPACTION_TARGET = 0.6;

type Submission =
  | { type: "user_input"; content: string }
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
  runTerminalCommand(threadId: string, cwd: string, command: string): Promise<{ output: string; localUrl?: string }>;
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
  captureBrowserSnapshot(threadId: string, tabId: string, turnRunId: string): Promise<any>;
  getThreadOutputDir(threadId: string): Promise<string>;
  listMcpResources(server?: string): Promise<any[]>;
  listMcpResourceTemplates(server?: string): Promise<any[]>;
  readMcpResource(server: string, uri: string): Promise<any>;
  callMcpTool(server: string, tool: string, argumentsJson: Record<string, unknown>): Promise<any>;
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

  async #clearGpaAfterExecution(): Promise<void> {
    if (this.#gpa.stage !== "act") {
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
      if (this.#activeTurnRunId && submission.type === "user_input") {
        this.#pendingInput.push(submission.content);
        continue;
      }
      if (submission.type === "user_input") {
        try {
          await this.runTurn(submission.content);
        } catch (error) {
          console.error(`[runtime] Failed to run thread ${this.threadId}`, error);
          await this.services.log("turn.unhandled_error", this.threadId, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
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
    const knowledgeContext = await this.services.buildKnowledgeContext(this.threadId);
    const workflowPackContext = await this.services.buildWorkflowPackContext(this.threadId);
    const tools = await this.buildVisibleTools(accessibleMcpServerIds);
    const availableToolsPrompt = formatAvailableTools(tools);
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

    let interruptedVisibleContent = "";

    try {
      let transcript = compactTranscript(history);
      let hasExecutedToolCall = false;
      const successfulToolCallFingerprints = new Set<string>();
      const failedToolCallFingerprints = new Map<string, number>();
      const successfullyCreatedFiles = new Set<string>();
      let terminalThread: ThreadRecord | null = null;
      const taskFailureCounts = new Map<string, number>();
      let repeatedTaskFailure: { taskKey: string; attempts: number; lastError: string } | null = null;
      let executionRecoveryAttempts = 0;
      let prematureCompletionAttempts = 0;

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
          skillDependencyWarnings
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
        let decision = await waitForAbortOrTimeout(
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
              // ACT progress is represented by real tool events. Holding text until the
              // decision is validated prevents discarded "about to write" messages from
              // accumulating in the chat when a model misses a tool call.
              if (this.#gpa.stage === "act") {
                return;
              }
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
            abortSignal: modelTurnAbortController.signal
          }),
          abortController.signal,
          MODEL_DECISION_TIMEOUT_MS,
          () => modelTurnAbortController.abort()
        );

        if (abortController.signal.aborted) {
          throw new Error("Turn interrupted.");
        }

        // 代码级强制：GOAL/PLAN 阶段严禁工具调用，拦截并提示模型用文字回应
        if (!gpaStageAllowsTools(this.#gpa) && decision.toolCalls.length > 0) {
          const blockedNote = `⚠️ GPA 约束：当前处于【${gpaStageLabel(
            this.#gpa.stage
          )}】阶段，系统已拦截本次全部工具调用。请仅用文字输出本阶段要求的内容，并在结尾给出 ⏳ 等待确认。`;
          transcript.push({ role: "user", content: blockedNote });
          decision.toolCalls = [];
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

        if (decision.toolCalls.length > 0) {
          prematureCompletionAttempts = 0;
          if (decision.toolCalls[0]?.name !== "fs.read_directory" || executionRecoveryAttempts < 2) {
            executionRecoveryAttempts = 0;
          }
        }

        if (decision.assistantMessage && !isPatchPayload(decision.assistantMessage)) {
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
          terminalThread = await this.services.persistence.updateThread(this.threadId, {
            status: "completed",
            updatedAt: new Date().toISOString()
          });
          break;
        }

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
              toolName: toolCall.name
            },
            createdAt: new Date().toISOString()
          });

          hasExecutedToolCall = true;
          let result: ToolResult;
          try {
            result = await waitForAbort(
              this.services.toolRuntime.execute(toolCall, {
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
              runTerminalCommand: (command) =>
                this.services.runTerminalCommand(this.threadId, thread.cwd ?? process.cwd(), command),
              requestApproval: (input) => this.services.requestApproval(this.threadId, turn.id, input),
              requestUserInput: (input) => this.services.requestUserInput(this.threadId, turn.id, input),
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
              },
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

        if (this.#pendingInput.length > 0) {
          const pending = this.#pendingInput.splice(0, this.#pendingInput.length);
          for (const item of pending) {
            const message = await this.recordMessage("user", item, turn.id);
            transcript.push({ role: "user", content: message.content });
          }
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
        if (interruptedVisibleContent.trim()) {
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
      if (error instanceof ModelDecisionTimeoutError) {
        await this.services.log("provider.turn_timeout", this.threadId, {
          turnRunId: turn.id,
          timeoutMs: MODEL_DECISION_TIMEOUT_MS
        });
      }
      const updatedThread = await this.services.persistence.updateThread(this.threadId, {
        status: "failed",
        updatedAt: completedAt
      });
      await this.#clearGpaAfterExecution();
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

  public submitUserInput(threadId: string, content: string): void {
    this.ensureThread(threadId).submit({ type: "user_input", content });
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

export function getAddedPatchFiles(argumentsJson: Record<string, unknown>): string[] {
  const patch = argumentsJson.patch;
  if (typeof patch !== "string") {
    return [];
  }
  return [...patch.matchAll(/^\*\*\* Add File: (.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

export function formatAvailableTools(tools: ToolSpecDefinition[]): string {
  const definitions = tools.map((tool) => {
    return `- ${tool.name}: ${tool.description} Input schema: ${JSON.stringify(tool.inputSchema)}.`;
  });

  return [
    "## Available Executable Tools",
    "The following tools are available in this turn. They are real executable tools, not examples. Never claim that command execution is unavailable while shell.exec appears below.",
    "For shell commands, call shell.exec with {\"command\": \"...\"}. For a local web project, do not open index.html with Start-Process. Start an HTTP server instead, then open its http://127.0.0.1:<port> URL. When starting a long-running local server on Windows, use a background command such as Start-Process so the tool call can complete.",
    ...definitions
  ].join("\n");
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
    `Current local date: ${formatRuntimeDate(new Date())}. Use this date for time-sensitive queries. Do not add, infer, or reuse a year that the user did not request.`,
    "Prefer progressive disclosure: inspect facts before making edits.",
    "When a tool can gather needed facts, call it instead of guessing.",
    "Before responding, decide whether an available Skill is the best fit. When it is, call skills.load with that skill_id before following its instructions. Use Function Calling for Skills and external tools rather than merely claiming a Skill was used.",
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
    content: message.content
  }));
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
  const recentMessages = transcript.slice(-8);
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
