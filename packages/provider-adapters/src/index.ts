import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import * as cheerio from "cheerio";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { appendGrokCompletionAuditInstruction, normalizeGrokCompletionAuditDecision } from "./models";

export {
  resolveModelCompat,
  gptCompat,
  deepseekCompat,
  grokCompat,
  glmCompat,
  qwenCompat,
  senseNovaCompat,
  kimiCompat,
  hunyuanCompat,
  agnesCompat,
  geminiCompat
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

export class ProviderStreamIncompleteError extends Error {
  public readonly reason: "missing_finish_reason" | "length" | "content_filter" | "insufficient_system_resource";

  public constructor(reason: "missing_finish_reason" | "length" | "content_filter" | "insufficient_system_resource") {
    super(
      reason === "length"
        ? "Provider stream terminated because the response reached its output limit."
        : reason === "content_filter"
          ? "Provider stream terminated because its response was filtered."
          : reason === "insufficient_system_resource"
            ? "Provider stream was interrupted because the upstream model service reported insufficient system resources."
            : "Provider stream terminated before emitting a completion signal."
    );
    this.reason = reason;
    this.name = "ProviderStreamIncompleteError";
  }
}

export class ProviderRequestLimitError extends Error {
  public constructor(
    public readonly requestBytes: number,
    public readonly maxRequestBytes: number
  ) {
    super(`Provider request is ${requestBytes} UTF-8 bytes, exceeding the configured limit of ${maxRequestBytes} bytes by ${requestBytes - maxRequestBytes} bytes without removable historical context.`);
    this.name = "ProviderRequestLimitError";
  }
}

export interface ProviderRequestLimits {
  maxRequestBytes: number;
  maxTools: number;
}

export function resolveProviderRequestLimits(
  provider: ProviderDefinition,
  model: Pick<ModelProfile, "id" | "displayName">
): ProviderRequestLimits {
  const identity = [
    model.id,
    model.displayName ?? "",
    provider.id,
    provider.name ?? "",
    provider.baseUrl ?? ""
  ].join(" ").toLowerCase();
  // DeepSeek's compatible chat endpoint accepts the normal 128 KiB request
  // envelope. Keep a 4 KiB compaction headroom below it while allowing
  // already-compacted requests that are only slightly above the old 120 KiB
  // project default to proceed.
  const defaultMaxRequestBytes = identity.includes("deepseek") ? 128 * 1024 : 0;
  const defaultMaxTools = /deepseek|kimi|moonshot/.test(identity) ? 50 : 0;
  return {
    maxRequestBytes: normalizeProviderLimit(provider.maxRequestBytes, defaultMaxRequestBytes),
    maxTools: normalizeProviderLimit(provider.maxTools, defaultMaxTools)
  };
}

function normalizeProviderLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

type WireMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  reasoning_content?: unknown;
};
const COMPACTED_ASSISTANT_HISTORY = "[Earlier assistant progress omitted to fit the provider request limit.]";
const COMPACTED_TOOL_HISTORY = "[Earlier tool output truncated to fit the provider request limit.]";
const COMPACTED_RECENT_TOOL_RESULT = "[Recent tool output shortened to fit the provider request limit.]";
const COMPACTED_SYSTEM_CONTEXT = "[Supplementary system context shortened to fit the provider request limit.]";
const INTERNAL_CONTEXT_SUMMARY_PREFIX = "[Internal context compaction summary.";
const COMPACTED_INTERNAL_CONTEXT_SUMMARY = "[Earlier internal context summary omitted to fit the provider request limit.]";
const PROVIDER_REQUEST_SAFETY_MARGIN_BYTES = 4 * 1024;
const PROVIDER_REQUEST_SAFETY_MARGIN_THRESHOLD_BYTES = 64 * 1024;

function serializedRequestBytes(request: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

function resolveProviderRequestTargetBytes(maxRequestBytes: number): number {
  if (maxRequestBytes < PROVIDER_REQUEST_SAFETY_MARGIN_THRESHOLD_BYTES) return maxRequestBytes;
  return Math.max(1, maxRequestBytes - PROVIDER_REQUEST_SAFETY_MARGIN_BYTES);
}

function mergeWireMessageContent(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  if (Array.isArray(left) && typeof right === "string") return [...left, { type: "text", text: right }];
  if (typeof left === "string" && Array.isArray(right)) return [{ type: "text", text: left }, ...right];
  if (typeof left === "string" && typeof right === "string") return left && right ? `${left}\n\n${right}` : left || right;
  return right !== undefined && right !== null ? right : left;
}

function coalesceStrictWireMessages(messages: WireMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const raw of messages) {
    const message = raw?.role === "assistant" && (raw.content === null || raw.content === undefined)
      ? { ...raw, content: "" }
      : { ...raw };
    const previous = out.at(-1);
    const sameTextRole =
      (message.role === "assistant" || message.role === "user") &&
      previous?.role === message.role &&
      !Array.isArray(previous.tool_calls) &&
      !Array.isArray(message.tool_calls);
    const textBeforeToolCall =
      message.role === "assistant" && previous?.role === "assistant" &&
      !Array.isArray(previous.tool_calls) && Array.isArray(message.tool_calls);
    if (previous && (sameTextRole || textBeforeToolCall)) {
      message.content = mergeWireMessageContent(previous.content, message.content);
      out[out.length - 1] = message;
    } else {
      out.push(message);
    }
  }
  return out;
}

function removeDuplicatedFollowUpCapsule(messages: WireMessage[]): WireMessage[] {
  const systemIndex = messages.findIndex((message) => message.role === "system" && typeof message.content === "string");
  if (systemIndex < 0) return messages;
  const system = messages[systemIndex]!;
  const content = system.content as string;
  const storedContextStart = content.indexOf("## Previous Turn Context Capsules");
  const followUpStart = content.indexOf("## Follow-up Source Continuity", storedContextStart + 1);
  if (storedContextStart < 0 || followUpStart < 0) return messages;
  const separatorStart = content.lastIndexOf("\n\n", storedContextStart);
  const nextMessages = [...messages];
  nextMessages[systemIndex] = {
    ...system,
    content: `${content.slice(0, separatorStart >= 0 ? separatorStart : storedContextStart).trimEnd()}\n\n${content.slice(followUpStart)}`
  };
  return nextMessages;
}

function rewriteSystemHeadingSection(
  messages: WireMessage[],
  heading: string,
  rewrite: (section: string) => string
): WireMessage[] {
  const systemIndex = messages.findIndex((message) => message.role === "system" && typeof message.content === "string");
  if (systemIndex < 0) return messages;
  const system = messages[systemIndex]!;
  const content = system.content as string;
  const start = content.indexOf(heading);
  if (start < 0) return messages;
  const nextHeading = content.indexOf("\n## ", start + heading.length);
  const end = nextHeading >= 0 ? nextHeading + 1 : content.length;
  const replacement = rewrite(content.slice(start, end)).trim();
  const nextContent = `${content.slice(0, start).trimEnd()}${replacement ? `\n\n${replacement}` : ""}${content.slice(end).trimStart() ? `\n\n${content.slice(end).trimStart()}` : ""}`;
  const nextMessages = [...messages];
  nextMessages[systemIndex] = { ...system, content: nextContent };
  return nextMessages;
}

function removeSystemHeadingSection(messages: WireMessage[], heading: string): WireMessage[] {
  return rewriteSystemHeadingSection(messages, heading, () => "");
}

function filterAvailableSkillsSection(messages: WireMessage[], prioritiesToRemove: Set<string>): WireMessage[] {
  return rewriteSystemHeadingSection(messages, "## Available Skills", (section) => section
    .split("\n")
    .filter((line) => {
      const priority = line.match(/; priority: ([^;]+);/)?.[1];
      return !priority || !prioritiesToRemove.has(priority);
    })
    .join("\n"));
}

function compactInternalContextSummaries(messages: WireMessage[]): WireMessage[] {
  return messages.map((message) =>
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(INTERNAL_CONTEXT_SUMMARY_PREFIX)
      ? { ...message, content: COMPACTED_INTERNAL_CONTEXT_SUMMARY }
      : message
  );
}

function buildCompactedRecentToolContent(content: string, retainedCharacters: number): string {
  if (retainedCharacters <= 0) return COMPACTED_RECENT_TOOL_RESULT;
  const characters = Array.from(content);
  if (retainedCharacters >= characters.length) return content;
  const headLength = Math.ceil(retainedCharacters * 0.6);
  const tailLength = retainedCharacters - headLength;
  return [
    characters.slice(0, headLength).join("").trimEnd(),
    COMPACTED_RECENT_TOOL_RESULT,
    characters.slice(characters.length - tailLength).join("").trimStart()
  ].filter(Boolean).join("\n\n");
}

function compactRecentToolResultsToFit(
  request: Record<string, unknown>,
  messages: WireMessage[],
  toolIndexes: number[],
  maxRequestBytes: number
): boolean {
  for (const index of toolIndexes) {
    if (serializedRequestBytes(request) <= maxRequestBytes) return true;
    const message = messages[index]!;
    if (typeof message.content !== "string" || message.content.length === 0) continue;
    const originalContent = message.content;
    const characterCount = Array.from(originalContent).length;
    let low = 0;
    let high = characterCount - 1;
    let best: string | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      messages[index] = {
        ...message,
        content: buildCompactedRecentToolContent(originalContent, middle)
      };
      if (serializedRequestBytes(request) <= maxRequestBytes) {
        best = messages[index]!.content as string;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    messages[index] = {
      ...message,
      content: best ?? COMPACTED_RECENT_TOOL_RESULT
    };
    if (serializedRequestBytes(request) <= maxRequestBytes) return true;
  }
  return serializedRequestBytes(request) <= maxRequestBytes;
}

function buildCompactedSystemContent(content: string, retainedCharacters: number): string {
  if (retainedCharacters <= 0) return COMPACTED_SYSTEM_CONTEXT;
  const characters = Array.from(content);
  if (retainedCharacters >= characters.length) return content;
  const headLength = Math.ceil(retainedCharacters * 0.75);
  const tailLength = retainedCharacters - headLength;
  return [
    characters.slice(0, headLength).join("").trimEnd(),
    COMPACTED_SYSTEM_CONTEXT,
    characters.slice(characters.length - tailLength).join("").trimStart()
  ].filter(Boolean).join("\n\n");
}

/**
 * System prompts are regenerated for every turn, unlike the current user request.
 * Compress them only as a final fallback after tool schemas and historical evidence.
 */
function compactSystemContextToFit(
  request: Record<string, unknown>,
  messages: WireMessage[],
  maxRequestBytes: number
): boolean {
  const systemIndexes = messages
    .map((message, index) => message.role === "system" && typeof message.content === "string" ? index : -1)
    .filter((index) => index >= 0)
    .sort((left, right) => String(messages[right]!.content).length - String(messages[left]!.content).length);

  for (const index of systemIndexes) {
    if (serializedRequestBytes(request) <= maxRequestBytes) return true;
    const message = messages[index]!;
    const originalContent = message.content as string;
    const characterCount = Array.from(originalContent).length;
    let low = 0;
    let high = characterCount - 1;
    let best: string | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      messages[index] = {
        ...message,
        content: buildCompactedSystemContent(originalContent, middle)
      };
      if (serializedRequestBytes(request) <= maxRequestBytes) {
        best = messages[index]!.content as string;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    messages[index] = {
      ...message,
      content: best ?? COMPACTED_SYSTEM_CONTEXT
    };
    if (serializedRequestBytes(request) <= maxRequestBytes) return true;
  }
  return serializedRequestBytes(request) <= maxRequestBytes;
}

interface ToolDescriptionCandidate {
  owner: Record<string, unknown>;
  value: string;
}

function cloneToolSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneToolSchemaValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneToolSchemaValue(entry)])
  );
}

function collectToolDescriptionCandidates(
  value: unknown,
  candidates: ToolDescriptionCandidate[]
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectToolDescriptionCandidates(entry, candidates);
    return;
  }
  if (!value || typeof value !== "object") return;
  const owner = value as Record<string, unknown>;
  if (typeof owner.description === "string" && owner.description.length > 0) {
    candidates.push({ owner, value: owner.description });
  }
  for (const [key, entry] of Object.entries(owner)) {
    if (key !== "description") collectToolDescriptionCandidates(entry, candidates);
  }
}

function compactToolSchemasToFit(
  request: Record<string, unknown>,
  maxRequestBytes: number
): Record<string, unknown> {
  if (!Array.isArray(request.tools) || request.tools.length === 0) return request;
  const tools = request.tools.map(cloneToolSchemaValue);
  const candidates: ToolDescriptionCandidate[] = [];
  collectToolDescriptionCandidates(tools, candidates);
  candidates.sort((left, right) => Buffer.byteLength(right.value, "utf8") - Buffer.byteLength(left.value, "utf8"));
  let next: Record<string, unknown> = { ...request, tools };

  for (const candidate of candidates) {
    if (serializedRequestBytes(next) <= maxRequestBytes) return next;
    let low = 0;
    let high = candidate.value.length - 1;
    let best: string | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      candidate.owner.description = `${candidate.value.slice(0, middle).trimEnd()}...`;
      if (serializedRequestBytes(next) <= maxRequestBytes) {
        best = candidate.owner.description as string;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best !== null) {
      candidate.owner.description = best;
      return next;
    }
    delete candidate.owner.description;
  }

  while (tools.length > 0 && serializedRequestBytes(next) > maxRequestBytes) {
    tools.pop();
  }
  if (tools.length === 0) {
    next = { ...next };
    delete next.tools;
    delete next.parallel_tool_calls;
    delete next.tool_choice;
  }
  return next;
}

export function applyProviderRequestLimits(
  request: Record<string, unknown>,
  provider: ProviderDefinition,
  model: Pick<ModelProfile, "id" | "displayName">
): Record<string, unknown> {
  const limits = resolveProviderRequestLimits(provider, model);
  const identity = [
    model.id,
    model.displayName ?? "",
    provider.id,
    provider.name ?? "",
    provider.baseUrl ?? ""
  ].join(" ").toLowerCase();
  const targetRequestBytes = resolveProviderRequestTargetBytes(limits.maxRequestBytes);
  let next = request;
  if (limits.maxTools > 0 && Array.isArray(next.tools) && next.tools.length > limits.maxTools) {
    next = { ...next, tools: next.tools.slice(0, limits.maxTools) };
  }
  if (limits.maxRequestBytes <= 0 || serializedRequestBytes(next) <= targetRequestBytes) return next;
  if (Array.isArray(next.messages)) {
    const copiedMessages = (next.messages as WireMessage[]).map((message) => ({ ...message }));
    const messagesWithoutInternalSummaries = compactInternalContextSummaries(copiedMessages);
    const normalizedMessages = identity.includes("deepseek")
      ? coalesceStrictWireMessages(messagesWithoutInternalSummaries)
      : messagesWithoutInternalSummaries;
    let messages = removeDuplicatedFollowUpCapsule(normalizedMessages);
    next = { ...next, messages };
    if (serializedRequestBytes(next) <= targetRequestBytes) return next;

    messages = removeSystemHeadingSection(messages, "## Previous Turn Context Capsules");
    next = { ...next, messages };
    if (serializedRequestBytes(next) <= targetRequestBytes) return next;

    messages = filterAvailableSkillsSection(messages, new Set(["normal"]));
    next = { ...next, messages };
    if (serializedRequestBytes(next) <= targetRequestBytes) return next;

    messages = filterAvailableSkillsSection(messages, new Set(["normal", "recommended"]));
    next = { ...next, messages };
    if (serializedRequestBytes(next) <= targetRequestBytes) return next;

    messages = removeSystemHeadingSection(messages, "## Workflow Packs");
    next = { ...next, messages };
    if (serializedRequestBytes(next) <= targetRequestBytes) return next;

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.role !== "assistant" || Array.isArray(message.tool_calls) || typeof message.content !== "string" || message.content.length < 1_024) continue;
      messages[index] = { ...message, content: COMPACTED_ASSISTANT_HISTORY };
      if (serializedRequestBytes(next) <= targetRequestBytes) return next;
    }

    const toolIndexes = messages.flatMap((message, index) => message.role === "tool" ? [index] : []);
    const newestToolIndexes = new Set(toolIndexes.slice(-2));
    for (const index of toolIndexes) {
      if (newestToolIndexes.has(index)) continue;
      const message = messages[index]!;
      if (typeof message.content !== "string" || message.content.length <= 4_096) continue;
      messages[index] = { ...message, content: `${message.content.slice(0, 2_048)}\n\n${COMPACTED_TOOL_HISTORY}` };
      if (serializedRequestBytes(next) <= targetRequestBytes) return next;
    }
    if (compactRecentToolResultsToFit(next, messages, toolIndexes.slice(-2), targetRequestBytes)) {
      return next;
    }
  }

  next = compactToolSchemasToFit(next, targetRequestBytes);
  if (serializedRequestBytes(next) <= targetRequestBytes) return next;
  if (Array.isArray(next.messages)) {
    const messages = next.messages as WireMessage[];
    if (compactSystemContextToFit(next, messages, targetRequestBytes)) return next;
  }
  if (serializedRequestBytes(next) <= limits.maxRequestBytes) return next;
  throw new ProviderRequestLimitError(serializedRequestBytes(next), limits.maxRequestBytes);
}

async function reportProviderRequestMeasurement(
  input: ProviderTurnInput,
  request: Record<string, unknown>
): Promise<void> {
  const limits = resolveProviderRequestLimits(input.provider, input.model);
  await input.onRequestMeasured?.({
    requestBytes: serializedRequestBytes(request),
    maxRequestBytes: limits.maxRequestBytes,
    targetRequestBytes: resolveProviderRequestTargetBytes(limits.maxRequestBytes),
    maxTools: limits.maxTools,
    toolCount: Array.isArray(request.tools) ? request.tools.length : 0
  });
}

async function reportProviderTrace(
  input: ProviderTurnInput,
  phase: "request" | "response" | "error",
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await input.onProviderTrace?.({ phase, payload });
  } catch {
    // Diagnostics must never interrupt the actual provider request.
  }
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
        if (provider.transport === "responses") {
          return new OpenAiResponsesProvider(provider, { fetch: this.#fetch });
        }
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

/**
 * Appends request-shape diagnostics to a failed chat-completions call so the
 * exact trigger (tool count, message shape, upstream error code) survives in
 * logs, and dumps the full payload to ~/.codexh/logs for offline analysis.
 * The upstream message is kept intact at the front, so downstream matchers
 * (context-overflow detection, retry classification) keep working.
 */
function enrichProviderRequestError(
  error: unknown,
  request: Record<string, unknown>,
  modelId: string
): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const tools = Array.isArray(request.tools) ? request.tools.length : 0;
  const messages = Array.isArray(request.messages)
    ? (request.messages as Array<{ role?: unknown }>)
    : [];
  const roleSummary = messages.map((message) => String(message.role ?? "?")).join(",");
  let bytes = -1;
  try {
    bytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  } catch {
    // Non-serializable payloads still get the rest of the diagnostics.
  }

  const candidate = error as {
    status?: unknown;
    code?: unknown;
    param?: unknown;
    type?: unknown;
    error?: { code?: unknown; param?: unknown; type?: unknown };
  };
  const upstreamParts: string[] = [];
  const upstreamCode = candidate.error?.code ?? candidate.code;
  const upstreamParam = candidate.error?.param ?? candidate.param;
  const upstreamType = candidate.error?.type ?? candidate.type;
  if (upstreamCode != null) upstreamParts.push(`code=${String(upstreamCode)}`);
  if (upstreamParam != null) upstreamParts.push(`param=${String(upstreamParam)}`);
  if (upstreamType != null) upstreamParts.push(`type=${String(upstreamType)}`);
  const upstreamNote = upstreamParts.length > 0 ? ` upstream(${upstreamParts.join(" ")})` : "";

  let dumpNote = "";
  try {
    const dir = join(homedir(), ".codexh", "logs");
    const file = join(dir, `provider-request-error-${Date.now()}.json`);
    void mkdir(dir, { recursive: true })
      .then(() => writeFile(file, JSON.stringify(request, null, 2), "utf8"))
      .catch(() => undefined);
    dumpNote = ` dump=${file}`;
  } catch {
    // Dumping is best-effort; never mask the original error.
  }

  error.message = `${error.message} [provider-request model=${modelId} tools=${tools} messages=${messages.length}(${roleSummary}) bytes=${bytes}${upstreamNote}${dumpNote}]`;
  return error;
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
    const compat = resolveModelCompat(input.model, input.provider);
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
    const normalizedRequest = compat.normalizeRequestParams(ctx, baseRequest);

    if (input.stream && input.model.supportsStreaming) {
      const streamRequest = applyProviderRequestLimits({
        ...normalizedRequest,
        stream: true,
        // OpenAI and most compatible gateways only attach usage on the final
        // chunk when this flag is set.
        stream_options: { include_usage: true }
      }, this.provider, input.model);
      await reportProviderRequestMeasurement(input, streamRequest);
      await reportProviderTrace(input, "request", {
        transport: "chat.completions",
        stream: true,
        request: streamRequest
      });
      let streamResponse: any;
      try {
        streamResponse = await this.#client.chat.completions.create(
          streamRequest as any,
          { signal: input.abortSignal }
        ) as any;
      } catch (error) {
        await reportProviderTrace(input, "error", {
          transport: "chat.completions",
          stream: true,
          error: error instanceof Error ? error.message : String(error)
        });
        throw enrichProviderRequestError(error, streamRequest, input.model.id);
      }
      if (!isAsyncIterable(streamResponse)) {
        const fallbackDecision = compat.parseResponse(streamResponse, ctx, Boolean(nativeTools));
        const fallbackReasoning = compat.extractReasoningFromMessage(streamResponse?.choices?.[0]?.message);
        return compat.normalizeDecision(fallbackReasoning
          ? { ...fallbackDecision, reasoningSummary: fallbackReasoning }
          : fallbackDecision, ctx);
      }
      const stream = streamResponse as AsyncIterable<any>;
      let text = "";
      let visibleText = "";
      let reasoning = "";
      let streamUsage: unknown;
      let finishReason: string | null = null;
      const streamedNativeCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
      for await (const chunk of stream) {
        if (chunk?.usage) {
          streamUsage = chunk.usage;
        }
        const choice = chunk?.choices?.[0];
        if (typeof choice?.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const delta = choice?.delta;
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
      if (!finishReason) {
        throw new ProviderStreamIncompleteError("missing_finish_reason");
      }
      if (finishReason === "length") {
        throw new ProviderStreamIncompleteError("length");
      }
      if (finishReason === "content_filter") {
        throw new ProviderStreamIncompleteError("content_filter");
      }
      if (finishReason === "insufficient_system_resource") {
        throw new ProviderStreamIncompleteError("insufficient_system_resource");
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
      await reportProviderTrace(input, "response", {
        transport: "chat.completions",
        stream: true,
        finishReason,
        text,
        reasoningContent: reasoning,
        toolCalls: nativeCalls,
        usage: streamUsage
      });
      if (nativeCalls.length > 0) {
        // Strip inline <think> reasoning from the persisted message; the
        // reasoning already streamed into the draft via extractVisibleStreamText.
        return compat.normalizeDecision(applyReasoning(withTokenUsage({
          assistantMessage: stripThinkBlocks(text).trim() || undefined,
          toolCalls: nativeCalls,
          endTurn: false,
          goalCompleted: false,
          isStructured: true
        }, streamUsage)), ctx);
      }
      return compat.normalizeDecision(applyReasoning(withTokenUsage(
        nativeTools
          ? nativeTextDecision(text.trim(), input.availableTools)
          : parseDecisionFromText(text.trim()),
        streamUsage
      )), ctx);
    }

    const request = applyProviderRequestLimits(normalizedRequest, this.provider, input.model);
    await reportProviderRequestMeasurement(input, request);
    await reportProviderTrace(input, "request", {
      transport: "chat.completions",
      stream: false,
      request
    });
    let response: any;
    try {
      response = await this.#client.chat.completions.create(request as any, {
        signal: input.abortSignal
      });
    } catch (error) {
      await reportProviderTrace(input, "error", {
        transport: "chat.completions",
        stream: false,
        error: error instanceof Error ? error.message : String(error)
      });
      throw enrichProviderRequestError(error, request, input.model.id);
    }
    await reportProviderTrace(input, "response", {
      transport: "chat.completions",
      stream: false,
      response
    });
    const finishReason = response?.choices?.[0]?.finish_reason;
    if (finishReason === "length") throw new ProviderStreamIncompleteError("length");
    if (finishReason === "content_filter") throw new ProviderStreamIncompleteError("content_filter");
    if (finishReason === "insufficient_system_resource") {
      throw new ProviderStreamIncompleteError("insufficient_system_resource");
    }
    const nonStreamDecision = compat.parseResponse(response, ctx, Boolean(nativeTools));
    const nonStreamReasoning = compat.extractReasoningFromMessage(response?.choices?.[0]?.message);
    return compat.normalizeDecision(nonStreamReasoning
      ? { ...nonStreamDecision, reasoningSummary: nonStreamReasoning }
      : nonStreamDecision, ctx);
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

/**
 * OpenAI Responses-compatible transport used by xAI's current agent API.
 * It is deliberately separate from Chat Completions: the request transcript,
 * streaming events, and function-result wire shapes are different.
 */
class OpenAiResponsesProvider implements ProviderAdapter {
  readonly #client: OpenAI;
  readonly #chatFallback: OpenAiCompatibleProvider;

  public constructor(
    private readonly provider: ProviderDefinition,
    options?: { fetch?: ProviderFetch }
  ) {
    this.#client = new OpenAI({
      apiKey: resolveApiKey(provider),
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers
    });
    this.#chatFallback = new OpenAiCompatibleProvider(provider, options);
  }

  public async runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision> {
    const nativeTools = !input.forceTextToolProtocol && input.model.supportsToolCalling && input.availableTools.length > 0
      ? input.availableTools.map((tool) => ({
          type: "function" as const,
          name: nativeToolName(tool.name),
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false
        }))
      : undefined;
    const reasoningEffort = input.reasoningEffort ?? input.model.defaultReasoningEffort;
    const request: Record<string, unknown> = {
      model: input.model.id,
      instructions: input.systemPrompt || undefined,
      input: await buildResponsesInput(input),
      max_output_tokens: input.model.defaultMaxOutputTokens,
      ...(nativeTools ? { tools: nativeTools, parallel_tool_calls: input.model.supportsParallelToolCalls } : {}),
      ...(reasoningEffort && reasoningEffort !== "none" && reasoningEffort !== "minimal"
        ? { reasoning: { effort: reasoningEffort, summary: "concise" } }
        : {})
    };

    try {
      if (input.stream && input.model.supportsStreaming) {
        const limitedRequest = applyProviderRequestLimits({ ...request, stream: true }, this.provider, input.model);
        await reportProviderRequestMeasurement(input, limitedRequest);
        const stream = await this.#client.responses.create(limitedRequest as any, {
          signal: input.abortSignal
        }) as any;
        if (isAsyncIterable(stream)) {
          return consumeResponsesStream(stream, input);
        }
        return parseResponsesResponse(stream, input);
      }
      const limitedRequest = applyProviderRequestLimits(request, this.provider, input.model);
      await reportProviderRequestMeasurement(input, limitedRequest);
      const response = await this.#client.responses.create(limitedRequest as any, { signal: input.abortSignal });
      return parseResponsesResponse(response, input);
    } catch (error) {
      if (supportsChatCompletionsFallback(error)) {
        return this.#chatFallback.runTurn(input);
      }
      throw error;
    }
  }
}

function supportsChatCompletionsFallback(error: unknown): boolean {
  const status = isRecord(error) ? error.status : undefined;
  return status === 404 || status === 405 || status === 501;
}

export function nativeToolName(name: string): string {
  // Provider function names have a narrow character set. Replacing punctuation
  // with underscores is ambiguous (`foo.bar` and `foo_bar` collide), so use a
  // stable compact digest only on the provider boundary.
  return `tool_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function isDeepSeekModel(
  model: Pick<ModelProfile, "id" | "displayName">,
  provider?: Pick<ProviderDefinition, "id" | "name" | "baseUrl">
): boolean {
  return [
    model.id,
    model.displayName ?? "",
    provider?.id ?? "",
    provider?.name ?? "",
    provider?.baseUrl ?? ""
  ].join(" ").toLowerCase().includes("deepseek");
}

function isDeepSeekThinkingModel(
  model: Pick<ModelProfile, "id" | "displayName">,
  provider?: Pick<ProviderDefinition, "id" | "name" | "baseUrl">
): boolean {
  const identity = [
    model.id,
    model.displayName ?? "",
    provider?.id ?? "",
    provider?.name ?? "",
    provider?.baseUrl ?? ""
  ].join(" ").toLowerCase();
  return isDeepSeekModel(model, provider) && /reasoner|\br1\b|thinking|\bv4-(?:flash|pro)\b/.test(identity);
}

function originalToolName(nativeName: string, availableTools: ProviderTurnInput["availableTools"]): string | null {
  const canonicalName = canonicalizeProviderToolName(nativeName);
  return availableTools.find((tool) =>
    nativeToolName(tool.name) === nativeName ||
    tool.name === nativeName ||
    tool.name === canonicalName
  )?.name ?? null;
}

export function normalizeToolCallsForAvailableTools(
  toolCalls: ProviderTurnDecision["toolCalls"],
  availableTools: ProviderTurnInput["availableTools"]
): ProviderTurnDecision["toolCalls"] {
  if (availableTools.length === 0) return toolCalls;
  return toolCalls.flatMap((call) => {
    const name = originalToolName(call.name, availableTools);
    return name ? [{ ...call, name }] : [];
  });
}

export const TOOL_ARGS_TRUNCATED_KEY = "__tool_args_truncated__";
export const TOOL_ARGS_INVALID_KEY = "__tool_args_invalid__";

export function parseNativeToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) {
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
      // repair didn't help — classify the remaining malformed payload below
    }
    // A balanced but invalid payload is a model formatting error, not
    // necessarily an output truncation. Keep the two cases distinct so the
    // runtime does not switch protocols or blame max_tokens for bad JSON.
    const marker = looksLikeTruncatedJson(value)
      ? TOOL_ARGS_TRUNCATED_KEY
      : TOOL_ARGS_INVALID_KEY;
    return { [marker]: true, __raw_length__: value.length };
  }
}

function looksLikeTruncatedJson(raw: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of raw.trim()) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return inString || depth > 0;
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
  // Strip <think> reasoning blocks once here so every downstream path
  // (native tool calls, native text, decision parsing) sees clean content.
  const content = stripThinkBlocks(message?.content?.trim() || "").trim();
  if (nativeCalls.length > 0) {
    return withTokenUsage({
      assistantMessage: content || undefined,
      toolCalls: nativeCalls,
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    }, response.usage);
  }
  return withTokenUsage(
    hasNativeTools
      ? nativeTextDecision(content, input.availableTools)
      : parseDecisionFromText(content),
    response.usage
  );
}

function objectToolArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nativeTextDecision(
  text: string,
  availableTools: ProviderTurnInput["availableTools"] = []
): ProviderTurnDecision {
  // Inline <think> reasoning is draft-only; never persist it in the message.
  const cleaned = stripThinkBlocks(text).trim();
  if (!cleaned) {
    return {
      assistantMessage: undefined,
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false
    };
  }
  if (isBareToolInvocationText(cleaned)) {
    return {
      assistantMessage: cleaned,
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false,
      requestTextToolProtocol: true
    };
  }
  const structuredDecision = parseDecisionFromText(cleaned);
  if (structuredDecision.isStructured) {
    return {
      ...structuredDecision,
      toolCalls: normalizeToolCallsForAvailableTools(structuredDecision.toolCalls, availableTools)
    };
  }
  if (looksLikeMalformedDecisionProtocol(cleaned)) {
    // A native-tool model can emit a partial or malformed text envelope when
    // it loses the tool-call protocol. Treating that text as a final answer
    // lets the runtime accept an off-track turn. Reset to the text protocol so
    // the next request gets one strict JSON decision envelope.
    return {
      assistantMessage: undefined,
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false,
      requestTextToolProtocol: true
    };
  }
  return {
    assistantMessage: cleaned,
    toolCalls: [],
    endTurn: true,
    goalCompleted: true,
    isStructured: true
  };
}

function looksLikeMalformedDecisionProtocol(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /^```(?:json)?\b/i.test(trimmed) ||
    /^<(?:(?:[|｜]DSML[|｜])?(?:tool_calls|function_calls|invoke|request_user_input))\b/i.test(trimmed) ||
    /\b(?:assistant_message|tool_calls|end_turn|goal_completed)\b/.test(trimmed) ||
    /(?:valid\s+JSON\s+decision\s+envelope|Agent\s+decision|JSON\s+decision\s+envelope|可执行的\s*Agent\s*决策|JSON.*(?:解析失败|无法解析))/i.test(trimmed);
}

export function isBareToolInvocationText(text: string): boolean {
  const normalized = text.trim();
  return /^(?:(?:web_search|browser|shell|fs|knowledge|mcp|database|git|code|project|skills|multi_agents|image|video|memories)(?:[._][a-z0-9-]+)+|apply_patch|request_user_input|spawn_agent|send_message|followup_task|wait_agent|interrupt_agent|list_agents)$/i.test(
    normalized
  );
}

class AnthropicProvider implements ProviderAdapter {
  readonly #client: Anthropic;

  public constructor(private readonly provider: ProviderDefinition) {
    this.#client = new Anthropic({
      apiKey: resolveApiKey(provider),
      // Keep a global Anthropic OAuth token from overriding this provider's API key.
      authToken: null,
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers
    });
  }

  public async runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision> {
    const compatContext: ModelCompatContext = { model: input.model, input };
    const nativeTools = !input.forceTextToolProtocol && input.model.supportsToolCalling && input.availableTools.length > 0
      ? input.availableTools.map((tool) => ({
          name: nativeToolName(tool.name),
          description: tool.description,
          input_schema: tool.inputSchema as any
        }))
      : undefined;
    const reasoningEffort = input.reasoningEffort ?? input.model.defaultReasoningEffort;
    const request: Record<string, unknown> = {
      model: input.model.id,
      system: appendGrokCompletionAuditInstruction(compatContext, input.systemPrompt),
      max_tokens: input.model.defaultMaxOutputTokens ?? 2048,
      messages: await buildAnthropicMessages(input),
      ...(nativeTools ? {
        tools: nativeTools,
        tool_choice: { type: "auto", disable_parallel_tool_use: !input.model.supportsParallelToolCalls }
      } : {}),
      ...(reasoningEffort && reasoningEffort !== "none" && reasoningEffort !== "minimal"
        ? { thinking: { type: "adaptive" }, output_config: { effort: reasoningEffort } }
        : {})
    };
    if (input.stream && input.model.supportsStreaming) {
      const limitedRequest = applyProviderRequestLimits({ ...request, stream: true }, this.provider, input.model);
      await reportProviderRequestMeasurement(input, limitedRequest);
      const stream = await this.#client.messages.create(limitedRequest as any, {
        signal: input.abortSignal
      }) as any;
      if (isAsyncIterable(stream)) return consumeAnthropicStream(stream, input, Boolean(nativeTools));
      return parseAnthropicResponse(stream, input, Boolean(nativeTools));
    }
    const limitedRequest = applyProviderRequestLimits(request, this.provider, input.model);
    await reportProviderRequestMeasurement(input, limitedRequest);
    const response = await this.#client.messages.create(limitedRequest as any, { signal: input.abortSignal });
    return parseAnthropicResponse(response, input, Boolean(nativeTools));
  }
}

function parseAnthropicResponse(
  response: any,
  input: ProviderTurnInput,
  hasNativeTools: boolean
): ProviderTurnDecision {
  const stopReason = typeof response?.stop_reason === "string" ? response.stop_reason : "end_turn";
  throwForAnthropicStopReason(stopReason);
  const content = Array.isArray(response?.content) ? response.content : [];
  const text = content
    .flatMap((block: any) => block?.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("\n")
    .trim();
  const reasoning = content
    .flatMap((block: any) => block?.type === "thinking" && typeof block.thinking === "string" ? [block.thinking] : [])
    .join("\n")
    .trim();
  const toolCalls = content.flatMap((block: any) => {
    if (block?.type !== "tool_use" || typeof block.name !== "string") return [];
    const name = originalToolName(block.name, input.availableTools);
    return name ? [{
      id: typeof block.id === "string" && block.id ? block.id : crypto.randomUUID(),
      name,
      arguments: objectToolArguments(block.input)
    }] : [];
  });
  const decision = toolCalls.length > 0
    ? {
        assistantMessage: text || undefined,
        toolCalls,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      }
    : hasNativeTools
      ? nativeTextDecision(text)
      : parseDecisionFromText(text);
  const withUsage = withTokenUsage(decision, response?.usage);
  const withReasoning = reasoning && !withUsage.reasoningSummary
    ? { ...withUsage, reasoningSummary: reasoning }
    : withUsage;
  return normalizeGrokCompletionAuditDecision({ model: input.model, input }, withReasoning, text, reasoning);
}

async function consumeAnthropicStream(
  stream: AsyncIterable<any>,
  input: ProviderTurnInput,
  hasNativeTools: boolean
): Promise<ProviderTurnDecision> {
  let text = "";
  let visibleText = "";
  let reasoning = "";
  let stopReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let completed = false;
  const blocks = new Map<number, { id?: string; name?: string; input: string }>();

  for await (const event of stream) {
    switch (event?.type) {
      case "message_start":
        usage = mergeProviderUsage(usage, event.message?.usage);
        break;
      case "content_block_start": {
        const index = typeof event.index === "number" ? event.index : blocks.size;
        const block = event.content_block;
        if (block?.type === "tool_use") {
          blocks.set(index, {
            id: typeof block.id === "string" ? block.id : undefined,
            name: typeof block.name === "string" ? block.name : undefined,
            input: isRecord(block.input) && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ""
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          text += delta.text;
          const nextVisibleText = extractVisibleStreamText(text);
          if (nextVisibleText.startsWith(visibleText)) {
            const visibleDelta = nextVisibleText.slice(visibleText.length);
            if (visibleDelta) await input.onTextDelta?.(visibleDelta);
          }
          visibleText = nextVisibleText;
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          reasoning += delta.thinking;
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const index = typeof event.index === "number" ? event.index : 0;
          const call = blocks.get(index) ?? { input: "" };
          call.input += delta.partial_json;
          blocks.set(index, call);
        }
        break;
      }
      case "message_delta":
        usage = mergeProviderUsage(usage, event.usage);
        if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
        break;
      case "message_stop":
        completed = true;
        break;
    }
  }

  if (!completed) throw new ProviderStreamIncompleteError("missing_finish_reason");
  throwForAnthropicStopReason(stopReason ?? "end_turn");
  const toolCalls = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, call]) => {
      const name = call.name ? originalToolName(call.name, input.availableTools) : null;
      return name ? [{
        id: call.id || crypto.randomUUID(),
        name,
        arguments: parseNativeToolArguments(call.input)
      }] : [];
    });
  const decision = toolCalls.length > 0
    ? { assistantMessage: text || undefined, toolCalls, endTurn: false, goalCompleted: false, isStructured: true }
    : hasNativeTools
      ? nativeTextDecision(text)
      : parseDecisionFromText(text);
  const withUsage = withTokenUsage(decision, usage);
  const withReasoning = reasoning ? { ...withUsage, reasoningSummary: reasoning } : withUsage;
  return normalizeGrokCompletionAuditDecision({ model: input.model, input }, withReasoning, text, reasoning);
}

function throwForAnthropicStopReason(stopReason: string): void {
  if (stopReason === "max_tokens") throw new ProviderStreamIncompleteError("length");
  if (stopReason === "refusal") throw new Error("Anthropic refused to generate a response.");
}

function mergeProviderUsage(
  previous: Record<string, unknown> | undefined,
  next: unknown
): Record<string, unknown> | undefined {
  return isRecord(next) ? { ...previous, ...next } : previous;
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

    let payload: unknown = null;
    let rawText = "";
    if (typeof response.text === "function") {
      rawText = await response.text();
      if (rawText.trim()) {
        try {
          payload = JSON.parse(rawText);
        } catch {
          payload = null;
        }
      }
    } else if (typeof response.json === "function") {
      payload = await response.json();
    }
    if (response.ok === false) {
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

export { imageGenerationProtocolForModel, providerSupportsMediaGeneration, IMAGE_GENERATION_PROTOCOL_LABELS } from "./models/media-protocol";

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

  // Agnes-style completion payloads carry the MP4 URL in `metadata.url`.
  const metadata = payload.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = extractGeneratedVideoPayload(metadata as Record<string, unknown>);
    if (nested) {
      return nested;
    }
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
    // Some gateways return the image as a URL inside `result` rather than
    // base64; decoding a URL as base64 would yield corrupted bytes that
    // surface as a broken/wrong image artifact downstream.
    if (/^https?:\/\//i.test(result)) {
      return { url: result, mimeType: readString(payload.output_format) ?? undefined };
    }
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
    reasoning_content?: string;
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
        content: isDeepSeekModel(input.model, input.provider) ? (message.content || "") : (message.content || null),
        ...(isDeepSeekThinkingModel(input.model, input.provider)
          ? { reasoning_content: message.reasoningContent ?? "" }
          : {}),
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

async function buildResponsesInput(input: ProviderTurnInput): Promise<any[]> {
  const items: any[] = [];
  const calls = new Map<string, RuntimeToolCall>();
  for (const message of input.transcript) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) {
        items.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
      }
      for (const call of message.toolCalls) {
        calls.set(call.id, call);
        items.push({
          type: "function_call",
          call_id: call.id,
          name: nativeToolName(call.name),
          arguments: JSON.stringify(call.arguments)
        });
      }
      continue;
    }
    if (message.role === "tool" && message.toolCallId) {
      const call = calls.get(message.toolCallId);
      if (call) {
        items.push({
          type: "function_call_output",
          call_id: call.id,
          output: message.content
        });
        continue;
      }
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    items.push({
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: contentWithFileAttachments(message.content, message.attachments) }]
    });
  }
  return items;
}

function parseResponsesResponse(response: any, input: ProviderTurnInput): ProviderTurnDecision {
  const status = typeof response?.status === "string" ? response.status : "completed";
  if (status === "incomplete") {
    throw new ProviderStreamIncompleteError("length");
  }
  if (status === "failed") {
    throw new Error(response?.error?.message || "The Responses API request failed.");
  }
  const text = extractResponsesText(response?.output);
  const reasoning = extractResponsesReasoning(response?.output);
  const toolCalls = extractResponsesToolCalls(response?.output, input);
  const decision = toolCalls.length > 0
    ? {
        assistantMessage: text || undefined,
        toolCalls,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      }
    : nativeTextDecision(text);
  const withUsage = withTokenUsage(decision, response?.usage);
  return reasoning && !withUsage.reasoningSummary
    ? { ...withUsage, reasoningSummary: reasoning }
    : withUsage;
}

async function consumeResponsesStream(stream: AsyncIterable<any>, input: ProviderTurnInput): Promise<ProviderTurnDecision> {
  let text = "";
  let visibleText = "";
  let reasoning = "";
  let terminalResponse: any;
  const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
  const itemToIndex = new Map<string, number>();
  for await (const event of stream) {
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      const nextVisibleText = extractVisibleStreamText(text);
      if (nextVisibleText.startsWith(visibleText)) {
        const visibleDelta = nextVisibleText.slice(visibleText.length);
        if (visibleDelta) await input.onTextDelta?.(visibleDelta);
      }
      visibleText = nextVisibleText;
      continue;
    }
    if (event?.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
      reasoning += event.delta;
      continue;
    }
    if (event?.type === "response.output_item.added" && event.item?.type === "function_call") {
      const index = typeof event.output_index === "number" ? event.output_index : calls.size;
      calls.set(index, {
        id: event.item.call_id,
        name: event.item.name,
        arguments: typeof event.item.arguments === "string" ? event.item.arguments : ""
      });
      if (typeof event.item.id === "string") itemToIndex.set(event.item.id, index);
      continue;
    }
    if (event?.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const index = typeof event.output_index === "number"
        ? event.output_index
        : itemToIndex.get(event.item_id) ?? 0;
      const call = calls.get(index) ?? { arguments: "" };
      call.arguments += event.delta;
      calls.set(index, call);
      continue;
    }
    if (event?.type === "response.completed") {
      terminalResponse = event.response;
      continue;
    }
    if (event?.type === "response.incomplete") {
      throw new ProviderStreamIncompleteError("length");
    }
    if (event?.type === "response.failed") {
      throw new Error(event.response?.error?.message || "The Responses API stream failed.");
    }
  }
  if (!terminalResponse) throw new ProviderStreamIncompleteError("missing_finish_reason");
  const streamedCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, call]) => {
      const name = call.name ? originalToolName(call.name, input.availableTools) : null;
      return name ? [{ id: call.id || crypto.randomUUID(), name, arguments: parseNativeToolArguments(call.arguments) }] : [];
    });
  const decision = streamedCalls.length > 0
    ? { assistantMessage: text || undefined, toolCalls: streamedCalls, endTurn: false, goalCompleted: false, isStructured: true }
    : nativeTextDecision(text);
  const withUsage = withTokenUsage(decision, terminalResponse.usage);
  return reasoning ? { ...withUsage, reasoningSummary: reasoning } : withUsage;
}

function extractResponsesText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output.flatMap((item: any) => {
    if (item?.type !== "message" || !Array.isArray(item.content)) return [];
    return item.content.flatMap((part: any) => part?.type === "output_text" && typeof part.text === "string" ? [part.text] : []);
  }).join("\n").trim();
}

function extractResponsesReasoning(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output.flatMap((item: any) => {
    if (item?.type !== "reasoning" || !Array.isArray(item.summary)) return [];
    return item.summary.flatMap((part: any) => typeof part?.text === "string" ? [part.text] : []);
  }).join("\n").trim();
}

function extractResponsesToolCalls(output: unknown, input: ProviderTurnInput): RuntimeToolCall[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item: any) => {
    if (item?.type !== "function_call" || typeof item.name !== "string") return [];
    const name = originalToolName(item.name, input.availableTools);
    return name ? [{
      id: typeof item.call_id === "string" && item.call_id ? item.call_id : crypto.randomUUID(),
      name,
      arguments: parseNativeToolArguments(typeof item.arguments === "string" ? item.arguments : "")
    }] : [];
  });
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

/**
 * <think> tag patterns. Besides the plain form, gateways emit suffixed
 * variants — Hunyuan relays wrap reasoning in <think:6124c78e>…</think:6124c78e>
 * (a per-session hash). A literal <think> match never closes there, which both
 * leaks the tags into output and suppresses the visible stream forever
 * ("卡在思考里出不来结果"). `\b[^>]*` accepts any suffix while still rejecting
 * lookalikes such as <thinking>.
 */
const THINK_OPEN_TAG = /<think\b[^>]*>/i;
const THINK_CLOSE_TAG = /<\/think\b[^>]*>/i;
const THINK_BLOCK = /<think\b[^>]*>[\s\S]*?(?:<\/think\b[^>]*>|$)/gi;

/**
 * Strip <think>...</think> reasoning blocks that reasoning-style models embed
 * directly in content (DeepSeek-R1-class models behind gateways, QwQ, relay
 * mappings that merge reasoning into content). Handles unterminated trailing
 * blocks (model hit the token limit mid-thought). Shared baseline behavior:
 * every compat shell inherits it through the baseline parse/extract hooks.
 */
export function stripThinkBlocks(text: string): string {
  return text.replace(THINK_BLOCK, "");
}

/**
 * Streaming variant of stripThinkBlocks. While a <think> block is still open
 * the buffered reasoning yields nothing visible (only pre-think text, which
 * is normally empty since reasoning comes first); once closed, the remainder
 * is surfaced. Compat shells that pass native-tool-call content through
 * verbatim should run it through this helper first.
 */
export function stripThinkBlocksFromStream(text: string): string {
  const thinkStart = text.search(THINK_OPEN_TAG);
  if (thinkStart === -1) {
    return text;
  }
  const closeMatch = THINK_CLOSE_TAG.exec(text);
  if (!closeMatch || closeMatch.index < thinkStart) {
    return text.slice(0, thinkStart);
  }
  return text.slice(0, thinkStart) + text.slice(closeMatch.index + closeMatch[0].length);
}

/**
 * Split a streaming buffer into surfaced reasoning (<think> bodies with the
 * tags hidden, including the partial body while the block is still open) and
 * the remainder that follows the last closed block. The draft shows the
 * reasoning so users can watch the think process; final parsing still runs
 * stripThinkBlocks, so the persisted message only contains the reply.
 */
function splitSurfacedThinkStream(text: string): { reasoning: string; rest: string } {
  let reasoning = "";
  let rest = text;
  for (;;) {
    const openMatch = THINK_OPEN_TAG.exec(rest);
    if (!openMatch) {
      return { reasoning, rest };
    }
    reasoning += rest.slice(0, openMatch.index);
    const afterOpen = rest.slice(openMatch.index + openMatch[0].length);
    const closeMatch = THINK_CLOSE_TAG.exec(afterOpen);
    if (!closeMatch) {
      return { reasoning: reasoning + afterOpen, rest: "" };
    }
    reasoning += afterOpen.slice(0, closeMatch.index);
    rest = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  }
}

/**
 * Hide a trailing fragment that can still grow into a <think> / </think>
 * tag ("<", "</th", "<think:61" …). Emitting it would leak raw markup into
 * the draft and break the prefix-monotonicity the stream delta loop relies
 * on; holding it back only ever appends once the fragment resolves.
 */
function dropTrailingPartialThinkTag(visible: string): string {
  const match = /<\/?[a-z0-9:-]*$/i.exec(visible);
  if (!match || match[0] === "") {
    return visible;
  }
  const core = match[0].replace(/^<\/?/, "").toLowerCase();
  return "think".startsWith(core) || core.startsWith("think")
    ? visible.slice(0, match.index)
    : visible;
}

/**
 * Streaming-draft variant of stripThinkBlocksFromStream: surface the <think>
 * reasoning content in the draft (tags hidden) so the user can watch the
 * think process while it streams, instead of showing nothing until the
 * block closes. Final parsing still strips the blocks, so the persisted
 * message only contains the reply.
 */
export function surfaceThinkBlocksInStream(text: string): string {
  const { reasoning, rest } = splitSurfacedThinkStream(text);
  return dropTrailingPartialThinkTag(reasoning + rest);
}

export function parseDecisionFromText(text: string): ProviderTurnDecision {
  // Reasoning-style models may wrap or precede the payload with a <think>
  // block; strip it before any protocol parsing so neither the envelope
  // extractor nor the visible-text fallback ever surfaces reasoning.
  const content = normalizeDeepseekDsmlTags(stripThinkBlocks(text));
  const taggedToolCalls = tryParseTaggedToolCalls(content);
  if (taggedToolCalls) {
    const assistantMessage = stripTaggedToolCalls(content).trim();
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

  const embeddedUserInput = tryParseStandaloneRequestUserInput(content);
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

  const parsed = tryParseJsonDecision(content);
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
    assistantMessage: content.trim() || "模型未返回结构化结果。",
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
  // Reasoning-style models stream <think> blocks inline: surface the
  // reasoning in the draft so users can watch the think process, while
  // structured protocol payloads stay suppressed until they can be decoded.
  const { reasoning, rest } = splitSurfacedThinkStream(text);
  const match = rest.match(/"assistant_message"\s*:\s*"((?:\\.|[^"\\])*)/s);
  if (match?.[1]) {
    let decoded: string;
    try {
      decoded = JSON.parse(`"${match[1]}"`);
    } catch {
      decoded = match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
    return reasoning ? `${reasoning}\n\n${decoded}` : decoded;
  }

  const trimmed = rest.trimStart();
  // Suppress structured protocol payloads until their assistant_message can
  // be decoded; surfaced reasoning stays visible in the draft.
  if (trimmed.startsWith("{") || trimmed.startsWith("<")) return reasoning;
  return dropTrailingPartialThinkTag(reasoning + rest);
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
    const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
    const outputReasoningTokens = numberOrZero(outputDetails.thinking_tokens ?? usage.thinking_tokens);
    return finalizeTokenUsage({
      totalTokens: inputTokens + outputTokens,
      inputTokens,
      inputCacheHitTokens,
      inputCacheMissTokens: Math.max(0, numberOrZero(usage.input_tokens)),
      inputCacheWriteTokens,
      outputTokens,
      outputReasoningTokens,
      outputContentTokens: Math.max(0, outputTokens - outputReasoningTokens)
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

/**
 * DeepSeek V4 and several local/compatible gateways expose the model's
 * internal tool protocol directly instead of converting it to OpenAI's
 * `message.tool_calls` field:
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="tool_name">
 *   <｜DSML｜parameter name="path" string="true">src/app.ts</｜DSML｜parameter>
 *
 * Normalize only the DSML namespace here so the existing XML parser can also
 * handle the ASCII `<|DSML|...>` form emitted by some relays.
 */
function normalizeDeepseekDsmlTags(text: string): string {
  return text.replace(/<((?:\/)?)(?:[|｜]DSML[|｜])/g, "<$1");
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, body: string) => {
    const normalized = body.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return "\"";
    if (normalized === "apos") return "'";
    const radix = normalized.startsWith("#x") ? 16 : 10;
    const digits = normalized.startsWith("#x") ? normalized.slice(2) : normalized.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function tryParseTaggedToolCalls(text: string): ProviderTurnDecision["toolCalls"] | null {
  const normalizedText = normalizeDeepseekDsmlTags(text);
  const openingTag = normalizedText.match(/<(tool_calls|function_calls)\b[^>]*>/i);
  if (openingTag?.index === undefined || openingTag.index < 0) {
    return null;
  }

  const afterOpen = normalizedText.slice(openingTag.index + openingTag[0].length);
  const containerName = openingTag[1] ?? "tool_calls";
  const closingMatches = [...afterOpen.matchAll(new RegExp(`</${containerName}\\s*>`, "gi"))];
  if (closingMatches.length === 0) {
    return null;
  }

  const lastClosing = closingMatches[closingMatches.length - 1];
  const payload = afterOpen
    .slice(0, lastClosing.index ?? 0)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .replace(/<\/(?:tool_calls|function_calls)\s*>/gi, "")
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
    const argumentParameter = parameters.find(
      (parameter) => readXmlAttribute(parameter[1] ?? "", "name") === "arguments"
    );
    const rawArguments = argumentParameter
      ? decodeXmlText(argumentParameter[2]?.trim() ?? "")
      : "";
    let argumentsJson: Record<string, unknown> = {};
    if (rawArguments) {
      const parsedArguments = tryParseModelJson(rawArguments);
      if (!parsedArguments || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
        return [];
      }
      argumentsJson = parsedArguments as Record<string, unknown>;
    } else {
      for (const parameter of parameters) {
        const parameterName = readXmlAttribute(parameter[1] ?? "", "name");
        if (!parameterName || parameterName === "arguments") continue;
        const rawValue = parameter[2]?.trim() ?? "";
        const decodedValue = decodeXmlText(rawValue);
        if (readXmlAttribute(parameter[1] ?? "", "string") === "true") {
          argumentsJson[parameterName] = decodedValue;
          continue;
        }
        const parsedValue = tryParseModelJson(decodedValue);
        argumentsJson[parameterName] = parsedValue ?? decodedValue;
      }
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

export function stripTaggedToolCalls(text: string): string {
  const normalizedText = normalizeDeepseekDsmlTags(text);
  const completeTag = /<(?:tool_calls|function_calls)\b[^>]*>[\s\S]*?<\/(?:tool_calls|function_calls)\s*>/gi;
  const completeResult = /<tool_result\b[^>]*>[\s\S]*?<\/tool_result\s*>/gi;
  const withoutCompleteTags = normalizedText.replace(completeTag, "").replace(completeResult, "");
  // Suppress an incomplete tag until the stream completes and it can be
  // parsed. This keeps control JSON out of the transcript during streaming.
  const visible = withoutCompleteTags
    .replace(/<(?:tool_calls|function_calls)\b[^>]*>[\s\S]*$/i, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*$/i, "")
    .replace(/<\/tool_(?:calls|result)\s*>/gi, "")
    .replace(/<\/function_calls\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
  return stripPartialToolTagPrefix(visible);
}

function stripPartialToolTagPrefix(text: string): string {
  const tagStart = text.lastIndexOf("<");
  if (tagStart === -1) {
    return text;
  }

  const trailing = text.slice(tagStart).toLowerCase();
  return "<tool_calls".startsWith(trailing) ||
    "<function_calls".startsWith(trailing) ||
    "<tool_result".startsWith(trailing)
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
    "assistant_message is visible to the user: write concise, well-structured Markdown and choose the format that makes the information easiest to scan. Before writing a multi-item answer, identify its structure: use a table for compact side-by-side comparison when items share clear fields and a table improves comparison; use a continuous numbered list for ordered steps or priorities; use a bulleted list for independent facts; use short paragraphs for explanation; and use > blockquotes for caveats or important constraints. Do not force information into a table when fields are uneven or prose would become harder to read. For answers longer than two paragraphs, use descriptive ##/### headings. Never restart a numbered list at 1 for each item, never wrap every ordinary noun in inline code (reserve it for literals, paths, commands, IDs, and API names), and write sources as [label](URL) links. Put explanatory text inside the same list item. Every non-final response with tool calls must include one short, natural conversational sentence in the user's language describing what you are about to do and why; never send progress without a tool call. Do not expose tool names, Skill IDs, internal hashes, raw commands, file paths, call counts, or protocol details in this sentence because those belong in the expandable execution details.",
    "Never expose private chain-of-thought; reasoning_summary is internal only and must never be rendered.",
    "tool_calls must be an array of { name, arguments }.",
    "For every GPA ACT decision, include completed_task_ids: use [] when no new PLAN task is complete, otherwise cumulatively list every completed PLAN task id. Before starting a later PLAN task, return a decision that marks the preceding accepted task complete. completion_evidence must be an array of { task_id, tool_call_id, kind }, where kind is observation, delivery, or verification and tool_call_id comes from an actual successful tool result.",
    "When request_user_input is listed, call it only for a material decision that tools and the current context cannot resolve safely. Provide one to four concise questions with two to four mutually exclusive options, then wait for the tool result. Do not place such questions in assistant_message, and do not use it for facts that can be inspected or verified with tools. Do not call tools that were not listed.",
    "Only call tools that were provided in the tool list.",
    "When shell.exec is listed, it is the command execution tool. Do not state that command execution is unavailable; call shell.exec with {\"command\": \"...\"} instead.",
    ...(process.platform === "win32"
      ? ["The desktop shell is Windows PowerShell. Use PowerShell syntax, not Bash/CMD syntax; recognizable CMD commands may be adapted automatically. Never write files through shell.exec: use apply_patch."]
      : []),
    "For every file creation or content edit, use apply_patch. Create a new file with an Add File patch.",
    "For apply_patch, send arguments.patch as raw Codex patch text. Add example: *** Begin Patch\\n*** Add File: relative/path.ext\\n+content\\n*** End Patch. Update example: *** Begin Patch\\n*** Update File: relative/path.ext\\n@@\\n unchanged context\\n-old text\\n+new text\\n*** End Patch. Every update hunk line must start with a space, -, or +. Do not send file_path or patch_content.",
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
