import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { finalizeTokenUsage, modelJsonCandidates, tryParseModelJson } from "@shared-types";
import type {
  MessageAttachment,
  ModelProfile,
  ProviderDefinition,
  ProviderTurnDecision,
  ProviderTurnInput,
  ProviderType,
  RuntimeToolCall,
  TokenUsage
} from "@shared-types";
import type {
  ImageGenerationProtocol,
  ModelCompat,
  ModelCompatContext
} from "./models";
import { resolveModelCompat } from "./models";

export {
  resolveModelCompat,
  gptCompat,
  deepseekCompat,
  grokCompat,
  glmCompat,
  qwenCompat,
  senseNovaCompat
} from "./models";
export type {
  ModelCompat,
  ModelCompatContext,
  ModelCompatToolCallMode,
  ModelGenerationContext,
  ImageGenerationProtocol,
  ImageGenerationPlan,
  VideoGenerationPlan,
  defineCompat
} from "./models";

export interface ProviderAdapter {
  runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision>;
  generateImage?(input: { model: ModelProfile; prompt: string; abortSignal?: AbortSignal }): Promise<GeneratedImageResult>;
  generateVideo?(input: {
    model: ModelProfile;
    prompt: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<{ data: Uint8Array; mimeType: string }>;
}

export type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface GeneratedImageResult {
  data: Uint8Array;
  mimeType: string;
  protocol: ImageGenerationProtocol;
  responseModel?: string;
}

export class ProviderFactory {
  readonly #fetch: ProviderFetch;

  public constructor(options?: { fetch?: ProviderFetch }) {
    this.#fetch = options?.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  public create(provider: ProviderDefinition): ProviderAdapter {
    switch (provider.type) {
      case "mock":
        return new MockProvider();
      case "anthropic":
        return new AnthropicProvider(provider);
      case "gemini":
        return new GeminiProvider(provider);
      case "openrouter":
      case "ollama":
      case "vllm":
      case "gateway":
      case "openai-compatible":
        return new OpenAiCompatibleProvider(provider, { fetch: this.#fetch });
      default:
        return assertNever(provider.type);
    }
  }
}

class MockProvider implements ProviderAdapter {
  public async runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision> {
    const userMessage = [...input.transcript].reverse().find((message) => message.role === "user");
    const content = userMessage?.content.toLowerCase() ?? "";

    if (content.includes("$")) {
      const explicitSkill = input.availableTools.find((tool) => content.includes(tool.name.toLowerCase()));
      if (explicitSkill) {
        return {
          assistantMessage: `我会先调用 ${explicitSkill.name} 来收集执行上下文。`,
          toolCalls: [{ id: crypto.randomUUID(), name: explicitSkill.name, arguments: {} }],
          endTurn: false,
          goalCompleted: false,
          isStructured: true
        };
      }
    }

    if (content.includes("搜索") || content.includes("search")) {
      return {
        assistantMessage: "我先查一下本地与网络上下文。",
        toolCalls: [
          {
            id: crypto.randomUUID(),
            name: "web_search.search_query",
            arguments: {
              query: userMessage?.content ?? ""
            }
          }
        ],
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      };
    }

    if (content.includes("文件") || content.includes("read")) {
      return {
        assistantMessage: "我先读取相关文件。",
        toolCalls: [
          {
            id: crypto.randomUUID(),
            name: "fs.read_directory",
            arguments: {
              path: "."
            }
          }
        ],
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      };
    }

    return {
      assistantMessage:
        "运行时已准备好。当前默认是 mock provider，所以我会优先通过工具收集事实，再继续推进任务。",
      toolCalls: [],
      endTurn: true,
      goalCompleted: true,
      isStructured: true,
      reasoningSummary: "mock-provider"
    };
  }
}

class OpenAiCompatibleProvider implements ProviderAdapter {
  readonly #client: OpenAI;
  readonly #fetch: ProviderFetch;

  public constructor(
    private readonly provider: ProviderDefinition,
    options?: { fetch?: ProviderFetch }
  ) {
    this.#fetch = options?.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#client = new OpenAI({
      apiKey: resolveApiKey(provider),
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers
    });
  }

  public async runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision> {
    const compat = resolveModelCompat(input.model);
    const ctx: ModelCompatContext = { model: input.model, input };
    const toolCallMode = compat.resolveToolCallMode(ctx);
    const nativeTools = toolCallMode.useNativeTools
      ? input.availableTools.map((tool) => ({
          type: "function" as const,
          function: {
            name: nativeToolName(tool.name),
            description: tool.description,
            parameters: tool.inputSchema
          }
        }))
      : undefined;
    const baseRequest: Record<string, unknown> = {
      model: input.model.id,
      messages: await buildOpenAiCompatibleMessages(input),
      temperature: input.model.defaultTemperature,
      max_tokens: input.model.defaultMaxOutputTokens,
      ...(nativeTools ? { tools: nativeTools, parallel_tool_calls: input.model.supportsParallelToolCalls } : {}),
      ...(!nativeTools && toolCallMode.useJsonOutput ? { response_format: { type: "json_object" as const } } : {})
    };
    const request = compat.normalizeRequestParams(ctx, baseRequest);

    if (input.stream && input.model.supportsStreaming) {
      const streamResponse = await this.#client.chat.completions.create(
        {
          ...request,
          stream: true,
          // OpenAI and most compatible gateways only attach usage on the final
          // chunk when this flag is set.
          stream_options: { include_usage: true }
        },
        { signal: input.abortSignal }
      ) as any;
      if (!isAsyncIterable(streamResponse)) {
        const fallbackDecision = compat.parseResponse(streamResponse, ctx, Boolean(nativeTools));
        const fallbackReasoning = compat.extractReasoningFromMessage(streamResponse?.choices?.[0]?.message);
        return fallbackReasoning
          ? { ...fallbackDecision, reasoningSummary: fallbackReasoning }
          : fallbackDecision;
      }
      const stream = streamResponse;
      let text = "";
      let visibleText = "";
      let reasoning = "";
      let streamUsage: unknown;
      const streamedNativeCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
      for await (const chunk of stream) {
        if (chunk?.usage) {
          streamUsage = chunk.usage;
        }
        const delta = chunk?.choices?.[0]?.delta;
        const content = delta?.content ?? "";
        if (content) {
          text += content;
          const nextVisibleText = compat.extractVisibleStreamText(text);
          if (nextVisibleText.startsWith(visibleText)) {
            const visibleDelta = nextVisibleText.slice(visibleText.length);
            if (visibleDelta) {
              await input.onTextDelta?.(visibleDelta);
            }
          }
          visibleText = nextVisibleText;
        }
        const reasoningDelta = compat.extractReasoningFromDelta(delta);
        if (reasoningDelta) reasoning += reasoningDelta;

        for (const toolCall of delta?.tool_calls ?? []) {
          const index = typeof toolCall.index === "number" ? toolCall.index : 0;
          const current = streamedNativeCalls.get(index) ?? { arguments: "" };
          if (typeof toolCall.id === "string" && toolCall.id) current.id = toolCall.id;
          if (typeof toolCall.function?.name === "string" && toolCall.function.name) {
            current.name = toolCall.function.name;
          }
          if (typeof toolCall.function?.arguments === "string") {
            current.arguments += toolCall.function.arguments;
          }
          streamedNativeCalls.set(index, current);
        }
      }
      const trimmedReasoning = reasoning.trim();
      const applyReasoning = (decision: ProviderTurnDecision): ProviderTurnDecision =>
        trimmedReasoning && !decision.reasoningSummary
          ? { ...decision, reasoningSummary: trimmedReasoning }
          : decision;
      const nativeCalls = [...streamedNativeCalls.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, call]) => {
          const name = call.name ? originalToolName(call.name, input.availableTools) : null;
          if (!name) return [];
          return [{
            id: call.id || crypto.randomUUID(),
            name,
            arguments: parseNativeToolArguments(call.arguments)
          }];
        });
      if (nativeCalls.length > 0) {
        return applyReasoning(withTokenUsage({
          assistantMessage: text.trim() || undefined,
          toolCalls: nativeCalls,
          endTurn: false,
          goalCompleted: false,
          isStructured: true
        }, streamUsage));
      }
      return applyReasoning(withTokenUsage(
        nativeTools ? nativeTextDecision(text.trim()) : parseDecisionFromText(text.trim()),
        streamUsage
      ));
    }

    const response = await this.#client.chat.completions.create(request as any, {
      signal: input.abortSignal
    });
    const nonStreamDecision = compat.parseResponse(response, ctx, Boolean(nativeTools));
    const nonStreamReasoning = compat.extractReasoningFromMessage(response?.choices?.[0]?.message);
    return nonStreamReasoning
      ? { ...nonStreamDecision, reasoningSummary: nonStreamReasoning }
      : nonStreamDecision;
  }

  public async generateImage(input: { model: ModelProfile; prompt: string; abortSignal?: AbortSignal }): Promise<GeneratedImageResult> {
    const compat = resolveModelCompat(input.model);
    const plan = compat.resolveImageGeneration({ model: input.model, prompt: input.prompt });
    if (plan.protocol === "openai-compatible") {
      const response = await this.#client.images.generate({
        model: input.model.id,
        prompt: input.prompt,
        n: 1,
        size: "1024x1024",
        response_format: "b64_json"
      }, { signal: input.abortSignal });
      const image = response.data?.[0];
      if (image?.b64_json) {
        return { data: Buffer.from(image.b64_json, "base64"), mimeType: "image/png", protocol: plan.protocol };
      }
      if (image?.url) {
        const downloaded = await this.#fetch(image.url, { signal: input.abortSignal });
        if (!downloaded.ok) throw new Error(`Image download failed: HTTP ${downloaded.status}`);
        return {
          data: new Uint8Array(await downloaded.arrayBuffer()),
          mimeType: downloaded.headers.get("content-type")?.split(";")[0] || "image/png",
          protocol: plan.protocol
        };
      }
      throw new Error("The image generation service returned no image data.");
    }
    return this.requestImage(
      plan.endpoint!,
      plan.payload,
      input.abortSignal,
      plan.label ?? "Image generation request",
      plan.protocol
    );
  }

  private async requestImage(
    endpoint: string,
    payload: Record<string, unknown>,
    abortSignal: AbortSignal | undefined,
    label: string,
    protocol: ImageGenerationProtocol
  ): Promise<GeneratedImageResult> {
    const baseUrl = normalizeProviderBaseUrl(this.provider.baseUrl);
    if (!baseUrl) {
      throw new Error(`Provider ${this.provider.id} is missing baseUrl for image generation.`);
    }
    const response = await this.#fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolveApiKey(this.provider)}`,
        "Content-Type": "application/json",
        ...(this.provider.headers ?? {})
      },
      body: JSON.stringify(payload),
      signal: abortSignal
    });
    const responsePayload = await readJsonResponse(response, label);
    const image = extractGeneratedImagePayload(responsePayload);
    if (!image) {
      throw new Error(`${label} returned no image data.`);
    }
    const downloaded = await downloadGeneratedImage(image, abortSignal, this.#fetch);
    return {
      ...downloaded,
      protocol,
      responseModel: readString(responsePayload.model) ?? readString(responsePayload.model_id) ?? undefined
    };
  }

  public async generateVideo(input: {
    model: ModelProfile;
    prompt: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) {
    const compat = resolveModelCompat(input.model);
    const plan = compat.resolveVideoGeneration({ model: input.model, prompt: input.prompt });
    const baseUrl = normalizeProviderBaseUrl(this.provider.baseUrl);
    if (!baseUrl) {
      throw new Error(`Provider ${this.provider.id} is missing baseUrl for video generation.`);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${resolveApiKey(this.provider)}`,
      "Content-Type": "application/json",
      ...(this.provider.headers ?? {})
    };

    const createResponse = await this.#fetch(`${baseUrl}${plan.endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(plan.payload),
      signal: input.abortSignal
    });
    const createPayload = await readJsonResponse(createResponse, "Video generation request");
    const syncVideo = extractGeneratedVideoPayload(createPayload);
    if (syncVideo) {
      return downloadGeneratedVideo(syncVideo, input.abortSignal, this.#fetch);
    }

    const requestId = extractVideoRequestId(createPayload);
    if (!requestId) {
      throw new Error("The video generation service did not return a request id or video payload.");
    }

    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? VIDEO_GENERATION_TIMEOUT_MS;
    const pollIntervalMs = input.pollIntervalMs ?? VIDEO_GENERATION_POLL_INTERVAL_MS;
    while (timeoutMs === 0 || Date.now() - startedAt < timeoutMs) {
      throwIfAborted(input.abortSignal);
      await sleep(pollIntervalMs, input.abortSignal);

      const statusResponse = await this.#fetch(`${baseUrl}/videos/${encodeURIComponent(requestId)}`, {
        headers: {
          Authorization: headers.Authorization,
          ...(this.provider.headers ?? {})
        },
        signal: input.abortSignal
      });
      const statusPayload = await readJsonResponse(statusResponse, "Video generation status");
      const status = typeof statusPayload.status === "string" ? statusPayload.status.toLowerCase() : "";

      if (status === "done" || status === "completed" || status === "succeeded" || status === "success") {
        const video = extractGeneratedVideoPayload(statusPayload);
        if (!video) {
          throw new Error("The video generation service finished without a downloadable video.");
        }
        return downloadGeneratedVideo(video, input.abortSignal, this.#fetch);
      }

      if (status === "failed" || status === "error") {
        throw new Error(extractVideoErrorMessage(statusPayload) || "Video generation failed.");
      }

      if (status === "expired") {
        throw new Error("Video generation request expired before completion.");
      }
    }

    throw new Error("Video generation timed out while waiting for the provider result.");
  }
}

export function nativeToolName(name: string): string {
  // Provider function names have a narrow character set. Replacing punctuation
  // with underscores is ambiguous (`foo.bar` and `foo_bar` collide), so use a
  // stable compact digest only on the provider boundary.
  return `tool_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function originalToolName(nativeName: string, availableTools: ProviderTurnInput["availableTools"]): string | null {
  return availableTools.find((tool) => nativeToolName(tool.name) === nativeName)?.name ?? null;
}

export const TOOL_ARGS_TRUNCATED_KEY = "__tool_args_truncated__";

export function parseNativeToolArguments(value: string): Record<string, unknown> {
  if (!value || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // JSON parse failed. Try repairing common issues (literal newlines /
    // tabs / carriage returns inside string values) before giving up.
    try {
      const repaired = repairJsonStringValues(value);
      if (repaired !== value) {
        const parsed = JSON.parse(repaired);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      }
    } catch {
      // repair didn't help — fall through to truncation marker
    }
    // JSON parse failed on non-empty input — the model's output was likely
    // truncated by max_tokens or a mid-stream disconnect. Return a marker so
    // the agent runtime can detect it and ask the model to retry with shorter
    // output instead of silently passing empty arguments to the tool.
    return { [TOOL_ARGS_TRUNCATED_KEY]: true, __raw_length__: value.length };
  }
}

/**
 * Escapes literal control characters (newline, carriage return, tab) inside
 * JSON string values. Some models (notably DeepSeek) emit raw newlines inside
 * string values instead of the \n escape sequence, which makes JSON.parse
 * fail. This function walks the string and only escapes control characters
 * that appear *inside* quoted string values, leaving the JSON structure intact.
 */
function repairJsonStringValues(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        result += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }
      result += ch;
    } else {
      if (ch === '"') {
        inString = true;
      }
      result += ch;
    }
  }
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function");
}

export function parseOpenAiCompatibleResponse(
  response: any,
  hasNativeTools: boolean,
  input: ProviderTurnInput
): ProviderTurnDecision {
  const message = response.choices[0]?.message;
  const nativeCalls = message?.tool_calls?.flatMap((call: any) => {
    if (call.type !== "function") return [];
    const name = originalToolName(call.function.name, input.availableTools);
    if (!name) return [];
    return [{
      id: call.id || crypto.randomUUID(),
      name,
      arguments: parseNativeToolArguments(call.function.arguments)
    }];
  }) ?? [];
  if (nativeCalls.length > 0) {
    return withTokenUsage({
      assistantMessage: message?.content?.trim() || undefined,
      toolCalls: nativeCalls,
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    }, response.usage);
  }
  const text = message?.content?.trim() || "";
  return withTokenUsage(
    hasNativeTools ? nativeTextDecision(text) : parseDecisionFromText(text),
    response.usage
  );
}

function objectToolArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nativeTextDecision(text: string): ProviderTurnDecision {
  if (!text) {
    return {
      assistantMessage: "The model returned neither a native tool call nor a final response.",
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false
    };
  }
  if (isBareToolInvocationText(text)) {
    return {
      assistantMessage: text,
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false,
      requestTextToolProtocol: true
    };
  }
  const structuredDecision = parseDecisionFromText(text);
  if (structuredDecision.isStructured) {
    return structuredDecision;
  }
  return {
    assistantMessage: text,
    toolCalls: [],
    endTurn: true,
    goalCompleted: true,
    isStructured: true
  };
}

export function isBareToolInvocationText(text: string): boolean {
  const normalized = text.trim();
  return /^(?:(?:web_search|browser|shell|fs|knowledge|mcp|database|git|code|project|skills|multi_agents|image|video)(?:[._][a-z0-9-]+)+|apply_patch|request_user_input)$/i.test(
    normalized
  );
}

class AnthropicProvider implements ProviderAdapter {
  readonly #client: Anthropic;

  public constructor(private readonly provider: ProviderDefinition) {
    this.#client = new Anthropic({
      apiKey: resolveApiKey(provider),
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers
    });
  }

  public async runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision> {
    const nativeTools = !input.forceTextToolProtocol && input.model.supportsToolCalling && input.availableTools.length > 0
      ? input.availableTools.map((tool) => ({
          name: nativeToolName(tool.name),
          description: tool.description,
          input_schema: tool.inputSchema as any
        }))
      : undefined;
    const response = await this.#client.messages.create(
      {
        model: input.model.id,
        system: input.systemPrompt,
        max_tokens: input.model.defaultMaxOutputTokens ?? 2048,
        messages: await buildAnthropicMessages(input),
        ...(nativeTools ? { tools: nativeTools } : {})
      } as any,
      { signal: input.abortSignal }
    );

    const nativeCalls = response.content.flatMap((part) => {
      if (part.type !== "tool_use") return [];
      const name = originalToolName(part.name, input.availableTools);
      if (!name) return [];
      return [{
        id: part.id || crypto.randomUUID(),
        name,
        arguments: objectToolArguments(part.input)
      }];
    });
    if (nativeCalls.length > 0) {
      return withTokenUsage({
        assistantMessage: response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim() || undefined,
        toolCalls: nativeCalls,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      }, response.usage);
    }
    const text = response.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n")
      .trim();

    return withTokenUsage(
      nativeTools ? nativeTextDecision(text) : parseDecisionFromText(text),
      response.usage
    );
  }
}

class GeminiProvider implements ProviderAdapter {
  public constructor(private readonly provider: ProviderDefinition) {}

  public async runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision> {
    const apiKey = resolveApiKey(this.provider);
    const endpoint = this.provider.baseUrl
      ? `${this.provider.baseUrl.replace(/\/$/, "")}/models/${input.model.id}:generateContent?key=${apiKey}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${input.model.id}:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.provider.headers
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: input.systemPrompt }]
        },
        contents: await buildGeminiContents(input),
        ...(input.model.supportsToolCalling && input.availableTools.length > 0
          ? {
              tools: [{
                functionDeclarations: input.availableTools.map((tool) => ({
                  name: nativeToolName(tool.name),
                  description: tool.description,
                  parameters: tool.inputSchema
                }))
              }]
            }
          : {})
      }),
      signal: input.abortSignal
    });

    const rawText = await response.text();
    let payload: unknown = null;
    if (rawText.trim()) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const detail =
        (payload && typeof payload === "object" && !Array.isArray(payload)
          ? extractVideoErrorMessage(payload as Record<string, unknown>)
          : null) ||
        rawText.trim() ||
        response.statusText;
      throw new Error(`Gemini generateContent failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }

    const json = (payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {}) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        cachedContentTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    };

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const nativeCalls = parts.flatMap((part, index) => {
      const nativeName = part.functionCall?.name;
      if (!nativeName) return [];
      const name = originalToolName(nativeName, input.availableTools);
      if (!name) return [];
      return [{
        id: `gemini-${crypto.randomUUID()}-${index}`,
        name,
        arguments: objectToolArguments(part.functionCall?.args)
      }];
    });
    if (nativeCalls.length > 0) {
      return withTokenUsage({
        assistantMessage: parts.map((part) => part.text ?? "").join("\n").trim() || undefined,
        toolCalls: nativeCalls,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      }, json.usageMetadata);
    }
    const text = parts.map((part) => part.text ?? "").join("\n").trim();
    const usesNativeTools = !input.forceTextToolProtocol && input.model.supportsToolCalling && input.availableTools.length > 0;
    return withTokenUsage(
      usesNativeTools ? nativeTextDecision(text) : parseDecisionFromText(text),
      json.usageMetadata
    );
  }
}

function resolveApiKey(provider: ProviderDefinition): string {
  if (provider.apiKey) {
    return provider.apiKey;
  }
  if (provider.apiKeyEnv) {
    const value = process.env[provider.apiKeyEnv];
    if (value) {
      return value;
    }
  }
  throw new Error(`Provider ${provider.id} is missing apiKey or apiKeyEnv.`);
}

const VIDEO_GENERATION_POLL_INTERVAL_MS = 5_000;
const VIDEO_GENERATION_TIMEOUT_MS = 10 * 60_000;

function normalizeProviderBaseUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl?.trim()) {
    return null;
  }
  return baseUrl.trim().replace(/\/$/, "");
}

export function imageGenerationProtocolForModel(model: Pick<ModelProfile, "id" | "displayName">): ImageGenerationProtocol {
  const identity = `${model.id} ${model.displayName}`.toLowerCase();
  if (/\bgpt-image(?:[-_]|\b)/.test(identity)) return "gpt-image-api";
  if (/\bgpt-5(?:[._-]|\b)/.test(identity)) return "gpt-responses";
  if (/\bgrok(?:[-_][a-z0-9]+)*[-_]imagine[-_]image\b/.test(identity)) return "grok-images";
  return "openai-compatible";
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const detail =
      (payload && typeof payload === "object" && !Array.isArray(payload)
        ? extractVideoErrorMessage(payload as Record<string, unknown>)
        : null) ||
      text.trim() ||
      response.statusText;
    throw new Error(`${label} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${label} returned an unexpected response.`);
  }

  return payload as Record<string, unknown>;
}

function extractVideoRequestId(payload: Record<string, unknown>): string | null {
  for (const key of ["request_id", "id", "task_id", "taskId", "requestId"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const data = payload.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return extractVideoRequestId(data as Record<string, unknown>);
  }

  return null;
}

function extractGeneratedVideoPayload(payload: Record<string, unknown>): { url?: string; b64?: string; mimeType?: string } | null {
  const directUrl = readString(payload.url) ?? readString(payload.video_url) ?? readString(payload.videoUrl);
  const directB64 = readString(payload.b64_json) ?? readString(payload.b64Json) ?? readString(payload.base64);
  if (directUrl || directB64) {
    return { url: directUrl ?? undefined, b64: directB64 ?? undefined, mimeType: readString(payload.mime_type) ?? readString(payload.mimeType) ?? undefined };
  }

  const video = payload.video;
  if (video && typeof video === "object" && !Array.isArray(video)) {
    const nested = extractGeneratedVideoPayload(video as Record<string, unknown>);
    if (nested) {
      return nested;
    }
  }

  const data = payload.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const nested = extractGeneratedVideoPayload(item as Record<string, unknown>);
        if (nested) {
          return nested;
        }
      }
    }
  } else if (data && typeof data === "object") {
    return extractGeneratedVideoPayload(data as Record<string, unknown>);
  }

  return null;
}

function extractGeneratedImagePayload(payload: Record<string, unknown>): { url?: string; b64?: string; mimeType?: string } | null {
  const directUrl = readString(payload.url) ?? readString(payload.image_url) ?? readString(payload.imageUrl);
  const directB64 = readString(payload.b64_json) ?? readString(payload.b64Json) ?? readString(payload.base64);
  if (directUrl || directB64) {
    return {
      url: directUrl ?? undefined,
      b64: directB64 ?? undefined,
      mimeType: readString(payload.mime_type) ?? readString(payload.mimeType) ?? readString(payload.output_format) ?? undefined
    };
  }

  const result = readString(payload.result);
  if (result) {
    return { b64: result, mimeType: readString(payload.output_format) ?? "image/png" };
  }

  for (const value of [payload.image, payload.data, payload.output]) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          const nested = extractGeneratedImagePayload(item as Record<string, unknown>);
          if (nested) return nested;
        }
      }
    } else if (value && typeof value === "object") {
      const nested = extractGeneratedImagePayload(value as Record<string, unknown>);
      if (nested) return nested;
    }
  }

  return null;
}

function extractVideoErrorMessage(payload: Record<string, unknown>): string | null {
  const error = payload.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = readString((error as Record<string, unknown>).message);
    if (message) {
      return message;
    }
  }
  return readString(payload.message) ?? readString(payload.detail) ?? null;
}

async function downloadGeneratedVideo(
  video: { url?: string; b64?: string; mimeType?: string },
  abortSignal?: AbortSignal,
  fetchImpl: ProviderFetch = (input, init) => globalThis.fetch(input, init)
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (video.b64) {
    return {
      data: Buffer.from(video.b64, "base64"),
      mimeType: video.mimeType || "video/mp4"
    };
  }

  if (!video.url) {
    throw new Error("The video generation service returned no video data.");
  }

  let downloaded: Response;
  try {
    downloaded = await fetchImpl(video.url, { signal: abortSignal });
  } catch (error) {
    throwIfAborted(abortSignal);
    const detail = error instanceof Error ? error.message : String(error);
    throw new GeneratedVideoDownloadError(video.url, detail);
  }

  if (!downloaded.ok) {
    throw new GeneratedVideoDownloadError(video.url, `HTTP ${downloaded.status}`);
  }

  return {
    data: new Uint8Array(await downloaded.arrayBuffer()),
    mimeType: downloaded.headers.get("content-type")?.split(";")[0] || video.mimeType || "video/mp4"
  };
}

async function downloadGeneratedImage(
  image: { url?: string; b64?: string; mimeType?: string },
  abortSignal?: AbortSignal,
  fetchImpl: ProviderFetch = (input, init) => globalThis.fetch(input, init)
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (image.b64) {
    const encoded = image.b64.replace(/^data:image\/[^;]+;base64,/i, "");
    return {
      data: Buffer.from(encoded, "base64"),
      mimeType: normalizeImageMimeType(image.mimeType)
    };
  }
  if (!image.url) {
    throw new Error("The image generation service returned no image data.");
  }
  const downloaded = await fetchImpl(image.url, { signal: abortSignal });
  if (!downloaded.ok) {
    throw new Error(`Image download failed: HTTP ${downloaded.status}`);
  }
  return {
    data: new Uint8Array(await downloaded.arrayBuffer()),
    mimeType: downloaded.headers.get("content-type")?.split(";")[0] || normalizeImageMimeType(image.mimeType)
  };
}

function normalizeImageMimeType(value: string | undefined): string {
  const normalized = value?.toLowerCase().trim();
  if (!normalized) return "image/png";
  if (normalized.startsWith("image/")) return normalized;
  if (normalized === "jpg") return "image/jpeg";
  if (["jpeg", "png", "webp", "gif"].includes(normalized)) return `image/${normalized}`;
  return "image/png";
}

export class GeneratedVideoDownloadError extends Error {
  readonly code = "VIDEO_DOWNLOAD_FAILED" as const;
  readonly videoUrl: string;

  constructor(videoUrl: string, detail?: string) {
    const suffix = detail?.trim() ? `（${detail.trim()}）` : "";
    super(`视频生成成功，但下载失败${suffix}。请用下面的地址自行下载：\n${videoUrl}`);
    this.name = "GeneratedVideoDownloadError";
    this.videoUrl = videoUrl;
  }
}

export function isGeneratedVideoDownloadError(error: unknown): error is GeneratedVideoDownloadError {
  return (
    error instanceof GeneratedVideoDownloadError ||
    (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "VIDEO_DOWNLOAD_FAILED" &&
      "videoUrl" in error &&
      typeof (error as { videoUrl?: unknown }).videoUrl === "string" &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    )
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Video generation aborted.");
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Video generation aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function buildOpenAiCompatibleMessages(input: ProviderTurnInput) {
  const messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: any;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }> = [];

  if (input.systemPrompt.trim()) {
    messages.push({
      role: "system",
      content: input.systemPrompt
    });
  }

  for (const message of input.transcript) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: nativeToolName(call.name),
            arguments: JSON.stringify(call.arguments)
          }
        }))
      });
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
      continue;
    }
    messages.push({
      role: normalizeOpenAiCompatibleRole(message.role),
      content: await buildOpenAiContent(contentWithFileAttachments(message.content, message.attachments), message.attachments)
    });
  }

  return mergeAdjacentProviderMessages(messages, "content");
}

function normalizeOpenAiCompatibleRole(role: ProviderTurnInput["transcript"][number]["role"]) {
  switch (role) {
    case "system":
      return "system";
    case "assistant":
      return "assistant";
    case "tool":
      return "assistant";
    default:
      return "user";
  }
}

async function buildAnthropicMessages(input: ProviderTurnInput): Promise<any[]> {
  const messages: any[] = [];
  const calls = new Map<string, RuntimeToolCall>();
  for (const message of input.transcript) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) calls.set(call.id, call);
      messages.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: nativeToolName(call.name),
            input: call.arguments
          }))
        ]
      });
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (call) {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: call.id,
            content: message.content,
            ...(message.toolResultOk === false ? { is_error: true } : {})
          }]
        });
        continue;
      }
    }
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: await buildAnthropicContent(
        contentWithFileAttachments(message.content, message.attachments),
        message.attachments
      )
    });
  }
  return mergeAdjacentProviderMessages(messages, "content");
}

async function buildGeminiContents(input: ProviderTurnInput): Promise<any[]> {
  const contents: any[] = [];
  const calls = new Map<string, RuntimeToolCall>();
  for (const message of input.transcript) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) calls.set(call.id, call);
      contents.push({
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            functionCall: { name: nativeToolName(call.name), args: call.arguments }
          }))
        ]
      });
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (call) {
        contents.push({
          role: "user",
          parts: [{
            functionResponse: {
              name: nativeToolName(call.name),
              response: message.toolResultOk === false
                ? { error: message.content }
                : { content: message.content }
            }
          }]
        });
        continue;
      }
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: await buildGeminiParts(
        contentWithFileAttachments(message.content, message.attachments),
        message.attachments
      )
    });
  }
  return mergeAdjacentProviderMessages(contents, "parts");
}

function mergeAdjacentProviderMessages(messages: any[], contentKey: "content" | "parts"): any[] {
  const merged: any[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (
      previous?.role === message.role &&
      Array.isArray(previous[contentKey]) &&
      Array.isArray(message[contentKey])
    ) {
      previous[contentKey] = [...previous[contentKey], ...message[contentKey]];
    } else {
      merged.push(message);
    }
  }
  return merged;
}

export function parseDecisionFromText(text: string): ProviderTurnDecision {
  const taggedToolCalls = tryParseTaggedToolCalls(text);
  if (taggedToolCalls) {
    const assistantMessage = stripTaggedToolCalls(text).trim();
    return {
      assistantMessage: assistantMessage || undefined,
      toolCalls: taggedToolCalls.map((call) => ({
        ...call,
        name: canonicalizeProviderToolName(call.name)
      })),
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    };
  }

  const embeddedUserInput = tryParseStandaloneRequestUserInput(text);
  if (embeddedUserInput) {
    return {
      assistantMessage: embeddedUserInput.cleanedContent || undefined,
      toolCalls: [{
        id: crypto.randomUUID(),
        name: "request_user_input",
        arguments: {
          title: embeddedUserInput.title,
          questions: embeddedUserInput.questions
        }
      }],
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    };
  }

  const parsed = tryParseJsonDecision(text);
  if (parsed) {
    return {
      assistantMessage: typeof parsed.assistant_message === "string" ? parsed.assistant_message : undefined,
      clarification: parseClarification(parsed.clarification),
      toolCalls: Array.isArray(parsed.tool_calls)
        ? parsed.tool_calls
            .filter((call): call is { name: string; arguments?: Record<string, unknown> } =>
              !!call && typeof call === "object" && typeof call.name === "string"
            )
            .map((call) => ({
              id: crypto.randomUUID(),
              name: canonicalizeProviderToolName(call.name),
              arguments: call.arguments ?? {}
            }))
        : [],
      endTurn: parsed.end_turn !== false,
      goalCompleted: parsed.goal_completed === true,
      completedTaskIds: parseCompletedTaskIds(parsed.completed_task_ids ?? parsed.completedTaskIds),
      completionEvidence: parseCompletionEvidence(
        parsed.completion_evidence ?? parsed.completionEvidence
      ),
      isStructured: true,
      reasoningSummary:
        typeof parsed.reasoning_summary === "string" ? parsed.reasoning_summary : undefined
    };
  }

  return {
    assistantMessage: text || "模型未返回结构化结果。",
    toolCalls: [],
    endTurn: false,
    goalCompleted: false,
    isStructured: false
  };
}

function parseCompletedTaskIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
  )];
  return ids.length > 0 ? ids : undefined;
}

function parseCompletionEvidence(
  value: unknown
): ProviderTurnDecision["completionEvidence"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const evidence = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const taskId = typeof record.task_id === "string"
      ? record.task_id
      : typeof record.taskId === "string"
        ? record.taskId
        : "";
    const toolCallId = typeof record.tool_call_id === "string"
      ? record.tool_call_id
      : typeof record.toolCallId === "string"
        ? record.toolCallId
        : "";
    const kind = record.kind;
    if (
      !taskId.trim() ||
      !toolCallId.trim() ||
      (kind !== "observation" && kind !== "delivery" && kind !== "verification")
    ) {
      return [];
    }
    return [{
      taskId: taskId.trim().toUpperCase(),
      toolCallId: toolCallId.trim(),
      kind: kind as "observation" | "delivery" | "verification"
    }];
  });
  return evidence.length > 0 ? evidence : undefined;
}

export function extractVisibleStreamText(text: string): string {
  const match = text.match(/"assistant_message"\s*:\s*"((?:\\.|[^"\\])*)/s);
  if (match?.[1]) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
  }

  const trimmed = text.trimStart();
  // Suppress structured protocol payloads until their assistant_message can be decoded.
  if (trimmed.startsWith("{") || trimmed.startsWith("<")) return "";
  return text;
}

function parseClarification(value: unknown): ProviderTurnDecision["clarification"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const options = Array.isArray(raw.options)
    ? raw.options.slice(0, 4).flatMap((option, index) => {
        if (typeof option === "string" && option.trim()) {
          return [{ id: `option_${index + 1}`, label: option.trim() }];
        }
        if (!option || typeof option !== "object" || Array.isArray(option)) {
          return [];
        }
        const item = option as Record<string, unknown>;
        const label = typeof item.label === "string" ? item.label.trim() : "";
        if (!label) return [];
        return [{
          id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `option_${index + 1}`,
          label,
          description: typeof item.description === "string" ? item.description.trim() || undefined : undefined,
          recommended: item.recommended === true
        }];
      })
    : [];
  return title && question && options.length >= 2
    ? { title, question, options, allowFreeText: raw.allow_free_text === true }
    : undefined;
}

async function buildOpenAiContent(content: string, attachments?: MessageAttachment[]): Promise<any> {
  const images = attachments?.filter((attachment) => attachment.kind === "image") ?? [];
  if (images.length === 0) return content;
  return [
    { type: "text", text: content },
    ...(await Promise.all(images.map(async (attachment) => ({
      type: "image_url",
      image_url: { url: await attachmentDataUrl(attachment) }
    }))))
  ];
}

async function buildAnthropicContent(content: string, attachments?: MessageAttachment[]): Promise<any> {
  const images = attachments?.filter((attachment) => attachment.kind === "image") ?? [];
  if (images.length === 0) return content;
  return [
    { type: "text", text: content },
    ...(await Promise.all(images.map(async (attachment) => {
      const data = await readFile(attachment.absolutePath);
      return { type: "image", source: { type: "base64", media_type: attachment.mimeType, data: data.toString("base64") } };
    })))
  ];
}

async function buildGeminiParts(content: string, attachments?: MessageAttachment[]): Promise<any[]> {
  const images = attachments?.filter((attachment) => attachment.kind === "image") ?? [];
  return [
    { text: content },
    ...(await Promise.all(images.map(async (attachment) => ({
      inlineData: { mimeType: attachment.mimeType, data: (await readFile(attachment.absolutePath)).toString("base64") }
    }))))
  ];
}

async function attachmentDataUrl(attachment: MessageAttachment): Promise<string> {
  const data = await readFile(attachment.absolutePath);
  return `data:${attachment.mimeType};base64,${data.toString("base64")}`;
}

function contentWithFileAttachments(content: string, attachments?: MessageAttachment[]): string {
  const files = attachments?.filter((attachment) => attachment.kind === "file") ?? [];
  if (files.length === 0) return content;
  return [content, ...files.map((file) => `[Attached file]\n${file.absolutePath}`)].filter(Boolean).join("\n\n");
}

function withTokenUsage(decision: ProviderTurnDecision, rawUsage: unknown): ProviderTurnDecision {
  const usage = parseProviderTokenUsage(rawUsage);
  if (!usage) return decision;
  return {
    ...decision,
    usage,
    outputTokens: usage.outputTokens || decision.outputTokens
  };
}

export function parseProviderTokenUsage(rawUsage: unknown): TokenUsage | null {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const usage = rawUsage as Record<string, unknown>;

  // OpenAI-compatible
  if (typeof usage.prompt_tokens === "number" || typeof usage.completion_tokens === "number") {
    const inputTokens = numberOrZero(usage.prompt_tokens);
    const outputTokens = numberOrZero(usage.completion_tokens);
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
    const inputCacheHitTokens = numberOrZero(details.cached_tokens ?? usage.cached_tokens);
    const outputReasoningTokens = numberOrZero(completionDetails.reasoning_tokens ?? usage.reasoning_tokens);
    return finalizeTokenUsage({
      totalTokens: numberOrZero(usage.total_tokens) || inputTokens + outputTokens,
      inputTokens,
      inputCacheHitTokens,
      inputCacheMissTokens: Math.max(0, inputTokens - inputCacheHitTokens),
      inputCacheWriteTokens: numberOrZero(details.cache_write_tokens ?? usage.cache_write_tokens),
      outputTokens,
      outputReasoningTokens,
      outputContentTokens: Math.max(0, outputTokens - outputReasoningTokens)
    });
  }

  // Anthropic
  if (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number") {
    const inputCacheHitTokens = numberOrZero(usage.cache_read_input_tokens);
    const inputCacheWriteTokens = numberOrZero(usage.cache_creation_input_tokens);
    const inputTokens = numberOrZero(usage.input_tokens) + inputCacheHitTokens + inputCacheWriteTokens;
    const outputTokens = numberOrZero(usage.output_tokens);
    return finalizeTokenUsage({
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      inputCacheHitTokens,
      inputCacheMissTokens: Math.max(0, numberOrZero(usage.input_tokens)),
      inputCacheWriteTokens,
      outputTokens,
      outputReasoningTokens: 0,
      outputContentTokens: outputTokens
    });
  }

  // Gemini
  if (
    typeof usage.promptTokenCount === "number" ||
    typeof usage.candidatesTokenCount === "number" ||
    typeof usage.totalTokenCount === "number"
  ) {
    const inputTokens = numberOrZero(usage.promptTokenCount);
    const outputTokens = numberOrZero(usage.candidatesTokenCount);
    const inputCacheHitTokens = numberOrZero(usage.cachedContentTokenCount);
    const outputReasoningTokens = numberOrZero(usage.thoughtsTokenCount);
    return finalizeTokenUsage({
      totalTokens: numberOrZero(usage.totalTokenCount) || inputTokens + outputTokens,
      inputTokens,
      inputCacheHitTokens,
      inputCacheMissTokens: Math.max(0, inputTokens - inputCacheHitTokens),
      inputCacheWriteTokens: 0,
      outputTokens,
      outputReasoningTokens,
      outputContentTokens: Math.max(0, outputTokens - outputReasoningTokens)
    });
  }

  return null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function tryParseTaggedToolCalls(text: string): ProviderTurnDecision["toolCalls"] | null {
  const openingTag = text.match(/<tool_calls\b[^>]*>/i);
  if (openingTag?.index === undefined || openingTag.index < 0) {
    return null;
  }

  const afterOpen = text.slice(openingTag.index + openingTag[0].length);
  const closingMatches = [...afterOpen.matchAll(/<\/tool_calls\s*>/gi)];
  if (closingMatches.length === 0) {
    return null;
  }

  const lastClosing = closingMatches[closingMatches.length - 1];
  const payload = afterOpen
    .slice(0, lastClosing.index ?? 0)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/<\/tool_calls\s*>/gi, "")
    .trim();

  return tryParseTaggedJsonToolCalls(payload) ?? tryParseTaggedInvokeToolCalls(payload);
}

type StandaloneRequestUserInput = {
  title: string;
  questions: Array<{
    id: string;
    label: string;
    prompt: string;
    options: Array<{ id: string; label: string; recommended?: boolean }>;
    allowFreeText: boolean;
  }>;
  cleanedContent: string;
};

function tryParseStandaloneRequestUserInput(text: string): StandaloneRequestUserInput | null {
  const blockMatch = text.match(/<request_user_input\b[\s\S]*?<\/request_user_input\s*>/i);
  if (!blockMatch) {
    return null;
  }

  const fragment = blockMatch[0];
  const $ = cheerio.load(fragment, {
    xml: {
      xmlMode: true,
      decodeEntities: true
    }
  });
  const root = $("request_user_input").first();
  if (root.length === 0) {
    return null;
  }

  const cleanedContent = text
    .replace(fragment, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const readAttribute = (element: cheerio.Cheerio<cheerio.Element>, name: string): string =>
    element.attr(name)?.trim() ?? "";
  const splitOptions = (value: string): string[] => value
    .split(/[、,，;/|]/)
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, 4);

  const questions: StandaloneRequestUserInput["questions"] = [];
  root.find("question").each((index, node) => {
    if (questions.length >= 4) {
      return false;
    }
    const question = $(node);
    const id = readAttribute(question, "id") || `q${index + 1}`;
    const label = readAttribute(question, "label") || `Q${index + 1}`;
    const prompt = readAttribute(question, "prompt") || label;
    const nestedOptions = question
      .find("option")
      .toArray()
      .map((optionNode) => {
        const option = $(optionNode);
        return readAttribute(option, "label") || option.text().trim();
      })
      .filter(Boolean);
    const optionLabels = nestedOptions.length > 0
      ? nestedOptions.slice(0, 4)
      : splitOptions(readAttribute(question, "options"));
    if (!prompt || optionLabels.length === 0) {
      return;
    }
    questions.push({
      id,
      label: label.slice(0, 48),
      prompt,
      options: optionLabels.map((option, optionIndex) => ({
        id: `option_${optionIndex + 1}`,
        label: option,
        recommended: optionIndex === 0
      })),
      allowFreeText: true
    });
  });

  // Fallback: some models (e.g. DeepSeek) emit the request_user_input payload
  // as a JSON object inside the XML tags instead of using XML attributes and
  // child elements. Try parsing the tag's text content as JSON.
  if (questions.length === 0) {
    const jsonContent = root.text().trim();
    if (jsonContent) {
      const jsonParsed = tryParseRequestUserInputJson(jsonContent);
      if (jsonParsed) {
        return {
          title: jsonParsed.title,
          questions: jsonParsed.questions,
          cleanedContent
        };
      }
    }
  }

  if (questions.length === 0) {
    return null;
  }

  return {
    title: readAttribute(root, "title") || "需要确认几个选项",
    questions,
    cleanedContent
  };
}

function tryParseRequestUserInputJson(jsonContent: string): { title: string; questions: StandaloneRequestUserInput["questions"] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "需要确认几个选项";
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  const questions: StandaloneRequestUserInput["questions"] = [];
  for (const rawQuestion of rawQuestions) {
    if (questions.length >= 4) break;
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) continue;
    const q = rawQuestion as Record<string, unknown>;
    const id = typeof q.id === "string" && q.id.trim() ? q.id.trim() : `q${questions.length + 1}`;
    const label = typeof q.label === "string" && q.label.trim() ? q.label.trim() : `Q${questions.length + 1}`;
    const prompt = typeof q.prompt === "string" && q.prompt.trim() ? q.prompt.trim() : label;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: StandaloneRequestUserInput["questions"][number]["options"] = [];
    for (const rawOption of rawOptions) {
      if (options.length >= 4) break;
      if (typeof rawOption === "string") {
        if (!rawOption.trim()) continue;
        options.push({ id: `option_${options.length + 1}`, label: rawOption.trim(), recommended: options.length === 0 });
      } else if (rawOption && typeof rawOption === "object" && !Array.isArray(rawOption)) {
        const opt = rawOption as Record<string, unknown>;
        const optLabel = typeof opt.label === "string" ? opt.label.trim() : typeof opt.id === "string" ? opt.id.trim() : "";
        if (!optLabel) continue;
        options.push({
          id: typeof opt.id === "string" && opt.id.trim() ? opt.id.trim() : `option_${options.length + 1}`,
          label: optLabel,
          recommended: typeof opt.recommended === "boolean" ? opt.recommended : false
        });
      }
    }
    if (options.length === 0) continue;
    questions.push({
      id,
      label: label.slice(0, 48),
      prompt,
      options,
      allowFreeText: true
    });
  }
  if (questions.length === 0) {
    return null;
  }
  return { title, questions };
}

function tryParseTaggedJsonToolCalls(payload: string): ProviderTurnDecision["toolCalls"] | null {
  const parsed = tryParseModelJson(payload);
  if (!parsed) return null;

  const rawCalls = Array.isArray(parsed) ? parsed : [parsed];
  const toolCalls = rawCalls.flatMap((rawCall) => normalizeTaggedToolCall(rawCall));
  return toolCalls.length > 0 ? toolCalls : null;
}

function tryParseTaggedInvokeToolCalls(payload: string): ProviderTurnDecision["toolCalls"] | null {
  const invokes = [...payload.matchAll(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke\s*>/gi)];
  if (invokes.length === 0) {
    return null;
  }

  const toolCalls = invokes.flatMap((match) => {
    const name = readXmlAttribute(match[1] ?? "", "name");
    if (!name) {
      return [];
    }

    const body = match[2] ?? "";
    const parameters = [...body.matchAll(/<parameter\b([^>]*)>([\s\S]*?)<\/parameter\s*>/gi)];
    const rawArguments = parameters.find((parameter) => readXmlAttribute(parameter[1] ?? "", "name") === "arguments")?.[2]?.trim();
    let argumentsJson: Record<string, unknown> = {};
    if (rawArguments) {
      const parsedArguments = tryParseModelJson(rawArguments);
      if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
        return [];
      }
      argumentsJson = parsedArguments as Record<string, unknown>;
    }

    return [{ id: crypto.randomUUID(), name, arguments: argumentsJson }];
  });

  return toolCalls.length > 0 ? toolCalls : null;
}

function normalizeTaggedToolCall(rawCall: unknown): ProviderTurnDecision["toolCalls"] {
  if (!rawCall || typeof rawCall !== "object") {
    return [];
  }

  const call = rawCall as {
    name?: unknown;
    arguments?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  const name = typeof call.name === "string" ? call.name : call.function?.name;
  const rawArguments = call.arguments ?? call.function?.arguments;
  if (typeof name !== "string" || !name.trim()) {
    return [];
  }

  let argumentsJson: Record<string, unknown> = {};
  if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    argumentsJson = rawArguments as Record<string, unknown>;
  } else if (typeof rawArguments === "string") {
    const parsedArguments = tryParseModelJson(rawArguments);
    if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
      return [];
    }
    argumentsJson = parsedArguments as Record<string, unknown>;
  }

  return [{
    id: crypto.randomUUID(),
    name: canonicalizeProviderToolName(String(name)),
    arguments: argumentsJson
  }];
}

function readXmlAttribute(source: string, name: string): string | null {
  const match = source.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1]?.trim() || null;
}

function stripTaggedToolCalls(text: string): string {
  const completeTag = /<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls\s*>/gi;
  const completeResult = /<tool_result\b[^>]*>[\s\S]*?<\/tool_result\s*>/gi;
  const withoutCompleteTags = text.replace(completeTag, "").replace(completeResult, "");
  // Suppress an incomplete tag until the stream completes and it can be
  // parsed. This keeps control JSON out of the transcript during streaming.
  const visible = withoutCompleteTags
    .replace(/<tool_calls\b[^>]*>[\s\S]*$/i, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*$/i, "")
    .replace(/<\/tool_(?:calls|result)\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
  return stripPartialToolTagPrefix(visible);
}

function stripPartialToolTagPrefix(text: string): string {
  const tagStart = text.lastIndexOf("<");
  if (tagStart === -1) {
    return text;
  }

  const trailing = text.slice(tagStart).toLowerCase();
  return "<tool_calls".startsWith(trailing) || "<tool_result".startsWith(trailing)
    ? text.slice(0, tagStart)
    : text;
}

function tryParseJsonDecision(text: string): Record<string, any> | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text;
  for (const candidate of modelJsonCandidates(fenced)) {
    const parsed = tryParseModelJson(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    // Do not treat lightweight payloads (e.g. multimodal intent {intent,prompt})
    // as Agent decision envelopes — that strips assistantMessage to empty.
    if (!looksLikeAgentDecisionEnvelope(parsed as Record<string, unknown>)) {
      continue;
    }
    return parsed as Record<string, any>;
  }
  return null;
}

function looksLikeAgentDecisionEnvelope(parsed: Record<string, unknown>): boolean {
  return (
    "assistant_message" in parsed ||
    "tool_calls" in parsed ||
    "end_turn" in parsed ||
    "goal_completed" in parsed ||
    "completed_task_ids" in parsed ||
    "completedTaskIds" in parsed ||
    "completion_evidence" in parsed ||
    "completionEvidence" in parsed ||
    "clarification" in parsed ||
    "reasoning_summary" in parsed
  );
}

const PROVIDER_TOOL_NAME_ALIASES: Record<string, string> = {
  image_gen: "image.generate",
  imagegen: "image.generate",
  "image-gen": "image.generate",
  generate_image: "image.generate",
  video_gen: "video.generate",
  videogen: "video.generate",
  "video-gen": "video.generate",
  generate_video: "video.generate"
};

function canonicalizeProviderToolName(name: string): string {
  const trimmed = name.trim();
  return PROVIDER_TOOL_NAME_ALIASES[trimmed] ?? PROVIDER_TOOL_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function assertNever(_value: ProviderType): never {
  throw new Error("Unsupported provider type.");
}

export function buildDecisionSystemPrompt(model: ModelProfile): string {
  return [
    "You are codexh, a desktop agent.",
    "When native function tools are provided, invoke them through the provider tool-call channel; never serialize a tool call into assistant text.",
    "With native function tools, call tools through the provider channel. When the entire original goal is complete, return the final JSON decision envelope described below; if more work is needed, call the next tool instead of returning a progress promise.",
    "When no native tools are provided, return exactly one valid JSON object and no text outside that JSON object.",
    "The JSON decision keys are: assistant_message, tool_calls, end_turn, goal_completed, completed_task_ids, completion_evidence, reasoning_summary.",
    "assistant_message is visible to the user: write concise Markdown or one short progress update before tool calls.",
    "Never expose private chain-of-thought; reasoning_summary is internal only and must never be rendered.",
    "tool_calls must be an array of { name, arguments }.",
    "For every GPA ACT decision, include completed_task_ids: use [] when no new PLAN task is complete, otherwise cumulatively list every completed PLAN task id. Before starting a later PLAN task, return a decision that marks the preceding accepted task complete. completion_evidence must be an array of { task_id, tool_call_id, kind }, where kind is observation, delivery, or verification and tool_call_id comes from an actual successful tool result.",
    "When request_user_input is listed, use that tool for a material user decision instead of placing questions in assistant_message. Do not call tools that were not listed.",
    "Only call tools that were provided in the tool list.",
    "When shell.exec is listed, it is the command execution tool. Do not state that command execution is unavailable; call shell.exec with {\"command\": \"...\"} instead.",
    ...(process.platform === "win32"
      ? ["The desktop shell is Windows PowerShell. Use PowerShell syntax, not Bash/CMD syntax; recognizable CMD commands may be adapted automatically. Never write files through shell.exec: use apply_patch."]
      : []),
    "For every file creation or content edit, use apply_patch. Create a new file with an Add File patch.",
    "For apply_patch, send arguments.patch with this exact raw grammar: *** Begin Patch\\n*** Add File: relative/path.ext\\n+content\\n*** End Patch. Do not send a Git diff, file_path, or patch_content.",
    "When reviewing or comparing code structure (functions/classes/methods), prefer code.ast_diff with {\"path\": \"relative/file\"} (optional against). Still use apply_patch for writes.",
    "For large source files, call code.outline first, then fs.read_file with optional {\"offset\": startLine, \"limit\": lineCount} instead of reading the entire file.",
    "To inspect the selected project folder, call fs.read_directory with { path: \".\" }. Never call read or use Unix paths such as /home.",
    "A successful directory listing, including an empty folder, is sufficient context. Do not repeat it: create or edit the requested files with apply_patch in the very next tool call.",
    "After an Add File patch succeeds, never use Add File for that path again in the same task. Read it and use Update File only if a follow-up edit is necessary.",
    "When a tool result reports the same failure twice, do not repeat the identical call. Inspect new evidence and change the tool, arguments, or implementation approach.",
    "There is no create_file tool. Never invent a tool name or substitute one for a provided tool.",
    "When no tool is needed, return an empty tool_calls array.",
    "Never put patches, diffs, or source code in assistant_message. Use tool_calls for file writes; assistant_message may only contain a short progress update or final summary.",
    "To inspect the selected project folder, call fs.read_directory with { path: \".\" }. Never call read or use Unix paths such as /home.",
    "A successful directory listing, including an empty folder, is sufficient context. Do not repeat it: create or edit the requested files with apply_patch in the very next tool call.",
    "There is no create_file tool. Never invent a tool name or substitute one for a provided tool.",
    "When no tool is needed, return an empty tool_calls array.",
    "Never state or imply that a file was created, changed, tested, or that a task is complete unless the corresponding tool call has already run and its result is in the transcript.",
    "After any tool has run, set end_turn to true only when every deliverable in the original user goal is complete and verified. In that final response set goal_completed to true, leave tool_calls empty, and write a concise final summary. A completed subtask is never sufficient. Otherwise set end_turn and goal_completed to false.",
    `Current model: ${model.displayName}.`
  ].join("\n");
}
