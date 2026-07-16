import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { modelJsonCandidates, tryParseModelJson } from "@shared-types";
import type {
  MessageAttachment,
  ModelProfile,
  ProviderDefinition,
  ProviderTurnDecision,
  ProviderTurnInput,
  ProviderType,
  RuntimeToolCall
} from "@shared-types";

export interface ProviderAdapter {
  runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision>;
  generateImage?(input: { model: ModelProfile; prompt: string; abortSignal?: AbortSignal }): Promise<{ data: Uint8Array; mimeType: string }>;
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
    const nativeTools = input.model.supportsToolCalling && input.availableTools.length > 0
      ? input.availableTools.map((tool) => ({
          type: "function" as const,
          function: {
            name: nativeToolName(tool.name),
            description: tool.description,
            parameters: tool.inputSchema
          }
        }))
      : undefined;
    const request: any = {
      model: input.model.id,
      messages: await buildOpenAiCompatibleMessages(input),
      temperature: input.model.defaultTemperature,
      max_tokens: input.model.defaultMaxOutputTokens,
      ...(nativeTools ? { tools: nativeTools, parallel_tool_calls: input.model.supportsParallelToolCalls } : {}),
      ...(!nativeTools && input.model.supportsJsonOutput ? { response_format: { type: "json_object" as const } } : {})
    };

    if (!nativeTools && input.stream && input.model.supportsStreaming) {
      const stream = await this.#client.chat.completions.create(
        { ...request, stream: true },
        { signal: input.abortSignal }
      ) as any;
      let text = "";
      let visibleText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (!delta) {
          continue;
        }
        text += delta;
        const nextVisibleText = extractVisibleStreamText(text);
        if (nextVisibleText.startsWith(visibleText)) {
          const visibleDelta = nextVisibleText.slice(visibleText.length);
          if (visibleDelta) {
            await input.onTextDelta?.(visibleDelta);
          }
        }
        visibleText = nextVisibleText;
      }
      return parseDecisionFromText(text.trim());
    }

    const response = await this.#client.chat.completions.create(request, {
      signal: input.abortSignal
    });
    const message = response.choices[0]?.message;
    const nativeCalls = message?.tool_calls?.flatMap((call) => {
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
      return withOutputTokens({
        assistantMessage: message?.content?.trim() || undefined,
        toolCalls: nativeCalls,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      }, response.usage?.completion_tokens);
    }
    const text = message?.content?.trim() || "";
    return withOutputTokens(
      nativeTools ? nativeTextDecision(text) : parseDecisionFromText(text),
      response.usage?.completion_tokens
    );
  }

  public async generateImage(input: { model: ModelProfile; prompt: string; abortSignal?: AbortSignal }) {
    const response = await this.#client.images.generate({
      model: input.model.id,
      prompt: input.prompt,
      n: 1,
      size: "1024x1024",
      response_format: "b64_json"
    }, { signal: input.abortSignal });
    const image = response.data?.[0];
    if (image?.b64_json) {
      return { data: Buffer.from(image.b64_json, "base64"), mimeType: "image/png" };
    }
    if (image?.url) {
      const downloaded = await this.#fetch(image.url, { signal: input.abortSignal });
      if (!downloaded.ok) throw new Error(`Image download failed: HTTP ${downloaded.status}`);
      return {
        data: new Uint8Array(await downloaded.arrayBuffer()),
        mimeType: downloaded.headers.get("content-type")?.split(";")[0] || "image/png"
      };
    }
    throw new Error("The image generation service returned no image data.");
  }

  public async generateVideo(input: {
    model: ModelProfile;
    prompt: string;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) {
    const baseUrl = normalizeProviderBaseUrl(this.provider.baseUrl);
    if (!baseUrl) {
      throw new Error(`Provider ${this.provider.id} is missing baseUrl for video generation.`);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${resolveApiKey(this.provider)}`,
      "Content-Type": "application/json",
      ...(this.provider.headers ?? {})
    };

    const createResponse = await this.#fetch(`${baseUrl}/videos/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model.id,
        prompt: input.prompt,
        duration: 10,
        aspect_ratio: "16:9",
        resolution: "480p"
      }),
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

function parseNativeToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
    const nativeTools = input.model.supportsToolCalling && input.availableTools.length > 0
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
      return withOutputTokens({
        assistantMessage: response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim() || undefined,
        toolCalls: nativeCalls,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      }, response.usage.output_tokens);
    }
    const text = response.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n")
      .trim();

    return withOutputTokens(
      nativeTools ? nativeTextDecision(text) : parseDecisionFromText(text),
      response.usage.output_tokens
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

    const json = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
        };
      }>;
      usageMetadata?: {
        candidatesTokenCount?: number;
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
      return withOutputTokens({
        assistantMessage: parts.map((part) => part.text ?? "").join("\n").trim() || undefined,
        toolCalls: nativeCalls,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      }, json.usageMetadata?.candidatesTokenCount);
    }
    const text = parts.map((part) => part.text ?? "").join("\n").trim();
    const usesNativeTools = input.model.supportsToolCalling && input.availableTools.length > 0;
    return withOutputTokens(
      usesNativeTools ? nativeTextDecision(text) : parseDecisionFromText(text),
      json.usageMetadata?.candidatesTokenCount
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

function extractVisibleStreamText(text: string): string {
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

  // Do not render a fallback stream. Some compatible models emit raw tool
  // payloads without a reliable wrapper; the runtime publishes only a parsed,
  // validated assistant message to the transcript.
  return "";
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

function withOutputTokens(decision: ProviderTurnDecision, outputTokens?: number): ProviderTurnDecision {
  return typeof outputTokens === "number" && Number.isFinite(outputTokens)
    ? { ...decision, outputTokens }
    : decision;
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

  if (questions.length === 0) {
    return null;
  }

  return {
    title: readAttribute(root, "title") || "需要确认几个选项",
    questions,
    cleanedContent: text
      .replace(fragment, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  };
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
