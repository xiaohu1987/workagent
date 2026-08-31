import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import type { ProviderFactory } from "@provider-adapters";
import type {
  AppConfig,
  BrowserRecordingAction,
  BrowserRecordingRepairCandidate,
  MessageRecord,
  ModelProfile,
  ProviderDefinition,
  RuntimeEvent,
  RuntimeToolCall,
  ToolSpecDefinition,
  ThreadRecord
} from "@shared-types";
import { modelJsonCandidates, tryParseModelJson } from "@shared-types";
import type { DatabaseService } from "./storage";
import { z } from "zod";

export type BrowserRecordingChatContext = {
  summary: string;
  screenshotPath?: string;
};

export type BrowserRecordingPlaywrightTools = {
  specs: ToolSpecDefinition[];
  execute: (call: RuntimeToolCall) => Promise<string>;
};

export type BrowserRecordingChatHandle = {
  threadId: string;
  recordingId: string;
  runId: string;
  turnRunId: string | null;
  model: ModelProfile | null;
  provider: ProviderDefinition | null;
  closed: boolean;
};

type ChatBridgeOptions = {
  db: DatabaseService;
  getConfig: () => AppConfig;
  providerFactory: ProviderFactory;
  emit: (event: RuntimeEvent) => Promise<void>;
  isThreadBusy: (threadId: string) => boolean;
};

/** Routes recording runtime progress and bounded model narration into one chat. */
export class BrowserRecordingChatBridge {
  readonly #options: ChatBridgeOptions;
  readonly #handles = new Map<string, BrowserRecordingChatHandle>();
  readonly #lastProgressAt = new Map<string, number>();

  public constructor(options: ChatBridgeOptions) {
    this.#options = options;
  }

  public async begin(input: { threadId: string; recordingId: string; operation: "recording" | "playback" }): Promise<BrowserRecordingChatHandle> {
    const threadId = input.threadId.trim();
    if (!threadId) throw new Error("请先选择一个聊天。");
    if (this.#options.isThreadBusy(threadId)) throw new Error("当前聊天正在执行其他任务，请等待完成后再开始浏览器操作。");
    const thread = this.#options.db.getThread(threadId);
    const selection = resolveChatModel(this.#options.getConfig(), thread);
    const runId = randomUUID();
    const turn = selection.provider && selection.model
      ? this.#options.db.startTurn({
          threadId,
          kind: "regular",
          status: "running",
          providerId: selection.provider.id,
          modelId: selection.model.id,
          resolvedModelSnapshotJson: JSON.stringify(selection.model),
          promptTokens: 0,
          completionTokens: 0,
          errorMessage: null
        })
      : null;
    const handle: BrowserRecordingChatHandle = {
      threadId,
      recordingId: input.recordingId,
      runId,
      turnRunId: turn?.id ?? null,
      model: selection.model,
      provider: selection.provider,
      closed: false
    };
    this.#handles.set(runId, handle);
    await this.message(handle, input.operation === "recording"
      ? "已启动 Playwright 浏览器录制。你可以在外部浏览器中操作，完成后点击停止。"
      : "已启动 Playwright 浏览器回放，正在执行录制步骤。", "started");
    return handle;
  }

  public async progress(handle: BrowserRecordingChatHandle, message: string, force = false): Promise<void> {
    if (handle.closed) return;
    const now = Date.now();
    const previous = this.#lastProgressAt.get(handle.runId) ?? 0;
    if (!force && now - previous < 1_200) return;
    this.#lastProgressAt.set(handle.runId, now);
    await this.message(handle, message, "progress");
  }

  public async narrate(handle: BrowserRecordingChatHandle, prompt: string, context?: BrowserRecordingChatContext): Promise<void> {
    if (handle.closed || !handle.provider || !handle.model) return;
    const draftId = randomUUID();
    let content = "";
    let deltaSequence = 0;
    await this.#options.emit({
      type: "assistant.draft.updated",
      threadId: handle.threadId,
      payload: {
        turnRunId: handle.turnRunId ?? handle.runId,
        draftId,
        sequence: 0,
        deltaSequence: 0,
        phase: "generating",
        content: "",
        startedAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString()
    });
    try {
      const transcript = this.#options.db.listRecentMessages(handle.threadId, 8)
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: message.content }));
      transcript.push({
        role: "user",
        content: [prompt, context?.summary ? `Playwright 页面上下文：\n${context.summary}` : ""].filter(Boolean).join("\n\n")
      });
      const attachments = context?.screenshotPath && handle.model.supportsMultimodalInput
        ? [{
            id: randomUUID(),
            kind: "image" as const,
            name: "playwright-failure.png",
            mimeType: "image/png",
            absolutePath: context.screenshotPath,
            sizeBytes: screenshotSize(context.screenshotPath),
            source: "generated" as const
          }]
        : undefined;
      const decision = await this.#options.providerFactory.create(handle.provider).runTurn({
        systemPrompt: "你是 CodeXH 的浏览器操作助手。根据 Playwright 执行状态，用简短中文说明当前进展、页面变化或失败原因。不要调用工具，不要返回 JSON，不要虚构未观察到的操作。",
        transcript: transcript.map((message, index) => index === transcript.length - 1 && attachments
          ? { ...message, attachments }
          : message),
        availableTools: [],
        model: { ...handle.model, supportsStreaming: handle.model.supportsStreaming },
        provider: handle.provider,
        stream: handle.model.supportsStreaming,
        onTextDelta: async (delta) => {
          content += delta;
          deltaSequence += 1;
          await this.#options.emit({
            type: "assistant.draft.updated",
            threadId: handle.threadId,
            payload: {
              turnRunId: handle.turnRunId ?? handle.runId,
              draftId,
              sequence: 0,
              deltaSequence,
              phase: "generating",
              delta,
              startedAt: new Date().toISOString()
            },
            createdAt: new Date().toISOString()
          });
        }
      });
      content = (decision.assistantMessage ?? content).trim();
      if (!content) content = "Playwright 已继续执行。";
      const message = await this.message(handle, content, "narration");
      await this.#options.emit({
        type: "assistant.completed",
        threadId: handle.threadId,
        payload: { turnRunId: handle.turnRunId ?? handle.runId, draftId, messageId: message.id },
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      await this.#options.emit({
        type: "assistant.completed",
        threadId: handle.threadId,
        payload: { turnRunId: handle.turnRunId ?? handle.runId, draftId, discarded: true },
        createdAt: new Date().toISOString()
      }).catch(() => undefined);
      await this.progress(handle, `LLM 状态说明失败：${compactError(error)}`, true);
    }
  }

  public async requestRepairCandidate(
    handle: BrowserRecordingChatHandle,
    input: { actions: BrowserRecordingAction[]; failedAction?: BrowserRecordingAction; context: BrowserRecordingChatContext; baseRevision: string; source?: "enhancement" | "replay-failure"; playwright?: BrowserRecordingPlaywrightTools }
  ): Promise<BrowserRecordingRepairCandidate | null> {
    if (handle.closed || !handle.provider || !handle.model) return null;
    const failedIndex = input.failedAction ? input.actions.findIndex((action) => action.id === input.failedAction!.id) : -1;
    const relevantActions = input.failedAction && failedIndex >= 0
      ? input.actions.slice(Math.max(0, failedIndex - 3), Math.min(input.actions.length, failedIndex + 4))
      : input.actions.slice(0, 80);
    const contextSummary = input.context.summary.slice(0, 14_000);
    const prompt = [
      "你是 Playwright 修复器。只返回一行 JSON，不要 Markdown、解释、TypeScript 或工具调用。",
      "最多返回 3 个 operation；允许 replace、insertBefore、insertAfter、delete。没有安全修复时返回 operations=[]。",
      "action 必须是完整的结构化 Playwright 动作；fill/select/upload 只能引用已有 valueKey/fileKey，不得编造输入值或文件路径。",
      ...(input.playwright ? ["你只能调用本次请求提供的 playwright.* 工具检查和操作当前保留页面；禁止调用 mcp.call、browser.* 或任何外部浏览器工具，禁止 newPage/newContext/导航到新网址，也不得执行任意 JavaScript。工具验证完成后仍必须返回结构化修复 JSON。"] : []),
      `baseRevision: ${input.baseRevision}`,
      ...(input.failedAction ? [`failedActionId: ${input.failedAction.id}`, `失败动作：${JSON.stringify(input.failedAction)}`] : ["这是录制完成后的增强，请只修正明显脆弱定位器或补充必要等待。"]),
      `失败步骤附近动作：${JSON.stringify(relevantActions)}`,
      `页面上下文（已截断）：\n${contextSummary}`,
      '严格返回：{"operations":[{"op":"replace|insertBefore|insertAfter|delete","actionId":"...","action":{}}],"rationale":["最多两条"],"confidence":0.0}'
    ].join("\n\n");
    const attachments = input.context.screenshotPath && handle.model.supportsMultimodalInput
      ? [{ id: randomUUID(), kind: "image" as const, name: "playwright-repair-context.png", mimeType: "image/png", absolutePath: input.context.screenshotPath, sizeBytes: screenshotSize(input.context.screenshotPath), source: "generated" as const }]
      : undefined;
    const adapter = this.#options.providerFactory.create(handle.provider);
    const availableTools = input.playwright?.specs ?? [];
    const request = (content: string, withAttachment: boolean, transcript: Array<{ role: "user" | "assistant" | "tool"; content: string; toolCalls?: RuntimeToolCall[]; toolCallId?: string }>) => adapter.runTurn({
      systemPrompt: "你是 CodeXH Playwright 修复器。只输出一行符合要求的 JSON。",
      transcript: transcript.map((message, index) => index === 0 && withAttachment && attachments ? { ...message, attachments } : message),
      availableTools,
      model: { ...handle.model!, supportsStreaming: false },
      provider: handle.provider!,
      stream: false
    });
    try {
      let decision: Awaited<ReturnType<typeof request>> | null = null;
      const transcript: Array<{ role: "user" | "assistant" | "tool"; content: string; toolCalls?: RuntimeToolCall[]; toolCallId?: string }> = [{ role: "user", content: prompt }];
      for (let toolTurn = 0; toolTurn < 6; toolTurn += 1) {
        try {
          decision = await request(toolTurn === 0 ? prompt : "继续使用受控 Playwright 工具验证页面，然后返回修复 JSON。", toolTurn === 0, transcript);
        } catch {
          decision = await request(`${prompt}\n\n再次强调：只输出 JSON，禁止任何分析文字。`, false, [{ role: "user", content: `${prompt}\n\n再次强调：只输出 JSON，禁止任何分析文字。` }]);
        }
        if (!decision.toolCalls?.length || !input.playwright) break;
        transcript.push({ role: "assistant", content: decision.assistantMessage ?? "", toolCalls: decision.toolCalls });
        for (const call of decision.toolCalls) {
          const result = await input.playwright.execute(call).catch((error) => `工具执行失败：${compactError(error)}`);
          transcript.push({ role: "tool", toolCallId: call.id, content: result.slice(0, 12_000) });
        }
      }
      if (!decision) return null;
      let parsed = parseCandidate(decision.assistantMessage ?? "");
      if (!parsed) {
        const compactPrompt = `只输出一行 JSON 修复候选。失败动作：${JSON.stringify(input.failedAction ?? null)}。附近动作：${JSON.stringify(relevantActions)}。页面可见文本：${contextSummary.slice(0, 4_000)}。若无法确定返回 {"operations":[],"rationale":[],"confidence":0}。`;
        const retry = await request(compactPrompt, false, [{ role: "user", content: compactPrompt }]).catch(() => null);
        parsed = retry ? parseCandidate(retry.assistantMessage ?? "") : null;
      }
      if (!parsed) return null;
      return {
        id: randomUUID(),
        recordingId: handle.recordingId,
        threadId: handle.threadId,
        baseRevision: input.baseRevision,
        operations: parsed.operations,
        rationale: parsed.rationale,
        confidence: parsed.confidence,
        createdAt: new Date().toISOString(),
        source: input.source ?? "replay-failure",
        ...(input.failedAction ? { failedActionId: input.failedAction.id } : {})
      };
    } catch (error) {
      await this.progress(handle, `LLM 未能生成 Playwright 修复候选：${compactError(error)}`, true);
      return null;
    }
  }

  public async complete(handle: BrowserRecordingChatHandle, message: string, status: "completed" | "failed" | "cancelled" = "completed"): Promise<void> {
    if (handle.closed) return;
    handle.closed = true;
    await this.message(handle, message, status);
    if (handle.turnRunId) {
      this.#options.db.finishTurn(handle.turnRunId, {
        status: status === "completed" ? "completed" : status === "cancelled" ? "aborted" : "failed",
        completedAt: new Date().toISOString(),
        errorMessage: status === "failed" ? message : null
      });
    }
    this.#handles.delete(handle.runId);
    this.#lastProgressAt.delete(handle.runId);
  }

  private async message(handle: BrowserRecordingChatHandle, content: string, phase: string): Promise<MessageRecord> {
    const message = this.#options.db.createMessage({
      threadId: handle.threadId,
      turnRunId: handle.turnRunId,
      role: "assistant",
      content,
      metadataJson: JSON.stringify({ displayKind: "browser_recording", recordingId: handle.recordingId, runId: handle.runId, phase })
    });
    await this.#options.emit({
      type: "message.created",
      threadId: handle.threadId,
      payload: { message },
      createdAt: new Date().toISOString()
    });
    return message;
  }
}

function resolveChatModel(config: AppConfig, thread: ThreadRecord): { provider: ProviderDefinition | null; model: ModelProfile | null } {
  const reasoning = config.models.filter((model) => model.role === "reasoning");
  const requested = reasoning.find((model) => model.providerId === thread.providerId && model.id === thread.modelId);
  const fallback = reasoning.find((model) => model.providerId === config.defaultProvider && model.id === config.defaultModel);
  const model = requested ?? fallback ?? reasoning[0] ?? null;
  return { model, provider: model ? config.providers.find((provider) => provider.id === model.providerId) ?? null : null };
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 500);
}

function screenshotSize(filePath: string): number {
  try {
    return fsSync.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function parseCandidate(text: string): {
  operations: BrowserRecordingRepairCandidate["operations"];
  rationale: string[];
  confidence: number;
} | null {
  for (const candidate of modelJsonCandidates(text)) {
    const value = tryParseModelJson(candidate);
    if (!value || typeof value !== "object") continue;
    const parsed = repairCandidateSchema.safeParse(value);
    if (!parsed.success) continue;
    return {
      operations: parsed.data.operations.slice(0, 20),
      rationale: parsed.data.rationale.slice(0, 10),
      confidence: parsed.data.confidence
    };
  }
  return null;
}

const locatorSchema = z.object({
  strategy: z.enum(["testId", "role", "label", "placeholder", "name", "id", "text", "css"]),
  value: z.string().min(1).max(1_000),
  role: z.string().max(100).optional(),
  exact: z.boolean().optional(),
  nth: z.number().int().min(0).max(1_000).optional(),
  frame: z.object({ name: z.string().max(500).optional(), url: z.string().max(2_000).optional() }).strict().optional()
}).strict();

const actionBaseSchema = z.object({
  id: z.string().min(1).max(200),
  pageId: z.string().min(1).max(200),
  createdAt: z.string().max(100).optional().default("")
}).strict();

const actionSchema = z.union([
  actionBaseSchema.extend({ type: z.literal("navigate"), url: z.string().min(1).max(4_000) }),
  actionBaseSchema.extend({ type: z.literal("openPage"), url: z.string().max(4_000), openerPageId: z.string().max(200).optional() }),
  actionBaseSchema.extend({ type: z.literal("waitFor"), locator: locatorSchema, state: z.enum(["attached", "visible", "hidden", "enabled"]), timeoutMs: z.number().int().positive().max(120_000).optional() }),
  actionBaseSchema.extend({ type: z.literal("waitForUrl"), url: z.string().min(1).max(4_000), timeoutMs: z.number().int().positive().max(120_000).optional() }),
  actionBaseSchema.extend({ type: z.literal("waitForPage"), openerPageId: z.string().max(200).optional(), timeoutMs: z.number().int().positive().max(120_000).optional() }),
  actionBaseSchema.extend({ type: z.literal("click"), locator: locatorSchema, expectedUrl: z.string().max(4_000).optional(), opensPageId: z.string().max(200).optional() }),
  actionBaseSchema.extend({ type: z.literal("fill"), locator: locatorSchema, valueKey: z.string().min(1).max(200) }),
  actionBaseSchema.extend({ type: z.literal("select"), locator: locatorSchema, valueKey: z.string().min(1).max(200) }),
  actionBaseSchema.extend({ type: z.literal("check"), locator: locatorSchema, checked: z.boolean() }),
  actionBaseSchema.extend({ type: z.literal("press"), locator: locatorSchema.nullable(), key: z.string().min(1).max(100), expectedUrl: z.string().max(4_000).optional(), opensPageId: z.string().max(200).optional() }),
  actionBaseSchema.extend({ type: z.literal("scroll"), x: z.number().finite(), y: z.number().finite() }),
  actionBaseSchema.extend({ type: z.literal("upload"), locator: locatorSchema, fileKey: z.string().min(1).max(200) })
]);

const repairCandidateSchema = z.object({
  operations: z.array(z.object({
    op: z.enum(["replace", "insertBefore", "insertAfter", "delete"]),
    actionId: z.string().min(1).max(200),
    action: actionSchema.optional()
  }).strict().superRefine((operation, context) => {
    if (operation.op !== "delete" && !operation.action) {
      context.addIssue({ code: "custom", message: "非删除候选必须提供 action。", path: ["action"] });
    }
  })).max(100),
  rationale: z.array(z.string().max(2_000)).max(20).default([]),
  confidence: z.number().finite().min(0).max(1).default(0)
}).strict();
