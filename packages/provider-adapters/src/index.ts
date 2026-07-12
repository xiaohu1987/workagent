import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import type {
  MessageAttachment,
  ModelProfile,
  ProviderDefinition,
  ProviderTurnDecision,
  ProviderTurnInput,
  ProviderType
} from "@shared-types";

export interface ProviderAdapter {
  runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision>;
  generateImage?(input: { model: ModelProfile; prompt: string; abortSignal?: AbortSignal }): Promise<{ data: Uint8Array; mimeType: string }>;
}

export class ProviderFactory {
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
        return new OpenAiCompatibleProvider(provider);
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

  public constructor(private readonly provider: ProviderDefinition) {
    this.#client = new OpenAI({
      apiKey: resolveApiKey(provider),
      baseURL: provider.baseUrl,
      defaultHeaders: provider.headers
    });
  }

  public async runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision> {
    const request = {
      model: input.model.id,
      messages: await buildOpenAiCompatibleMessages(input),
      temperature: input.model.defaultTemperature,
      max_tokens: input.model.defaultMaxOutputTokens,
      ...(input.model.supportsJsonOutput ? { response_format: { type: "json_object" as const } } : {})
    };

    if (input.stream && input.model.supportsStreaming) {
      const stream = await this.#client.chat.completions.create(
        { ...request, stream: true },
        { signal: input.abortSignal }
      );
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
    const text = response.choices[0]?.message?.content?.trim() || "";
    return withOutputTokens(parseDecisionFromText(text), response.usage?.completion_tokens);
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
      const downloaded = await fetch(image.url, { signal: input.abortSignal });
      if (!downloaded.ok) throw new Error(`Image download failed: HTTP ${downloaded.status}`);
      return {
        data: new Uint8Array(await downloaded.arrayBuffer()),
        mimeType: downloaded.headers.get("content-type")?.split(";")[0] || "image/png"
      };
    }
    throw new Error("The image generation service returned no image data.");
  }
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
    const response = await this.#client.messages.create(
      {
        model: input.model.id,
        system: input.systemPrompt,
        max_tokens: input.model.defaultMaxOutputTokens ?? 2048,
        messages: await Promise.all(input.transcript
          .filter((message) => message.role !== "system")
          .map(async (message) => ({
            role: message.role === "assistant" || message.role === "tool" ? "assistant" : "user",
            content: await buildAnthropicContent(contentWithFileAttachments(message.content, message.attachments), message.attachments)
          })))
      },
      { signal: input.abortSignal }
    );

    const text = response.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n")
      .trim();

    return withOutputTokens(parseDecisionFromText(text), response.usage.output_tokens);
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
        contents: await Promise.all(input.transcript.map(async (message) => ({
          role: message.role === "assistant" || message.role === "tool" ? "model" : "user",
          parts: await buildGeminiParts(contentWithFileAttachments(message.content, message.attachments), message.attachments)
        })))
      }),
      signal: input.abortSignal
    });

    const json = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
      usageMetadata?: {
        candidatesTokenCount?: number;
      };
    };

    const text =
      json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() ??
      "";
    return withOutputTokens(parseDecisionFromText(text), json.usageMetadata?.candidatesTokenCount);
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

async function buildOpenAiCompatibleMessages(input: ProviderTurnInput) {
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: any;
  }> = [];

  if (input.systemPrompt.trim()) {
    messages.push({
      role: "system",
      content: input.systemPrompt
    });
  }

  for (const message of input.transcript) {
    messages.push({
      role: normalizeOpenAiCompatibleRole(message.role),
      content: await buildOpenAiContent(contentWithFileAttachments(message.content, message.attachments), message.attachments)
    });
  }

  return messages;
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

function parseDecisionFromText(text: string): ProviderTurnDecision {
  const taggedToolCalls = tryParseTaggedToolCalls(text);
  if (taggedToolCalls) {
    const assistantMessage = stripTaggedToolCalls(text).trim();
    return {
      assistantMessage: assistantMessage || undefined,
      toolCalls: taggedToolCalls,
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
              name: call.name,
              arguments: call.arguments ?? {}
            }))
        : [],
      endTurn: parsed.end_turn !== false,
      goalCompleted: parsed.goal_completed === true,
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

function tryParseTaggedJsonToolCalls(payload: string): ProviderTurnDecision["toolCalls"] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

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
      try {
        const parsedArguments = JSON.parse(rawArguments);
        if (parsedArguments && typeof parsedArguments === "object" && !Array.isArray(parsedArguments)) {
          argumentsJson = parsedArguments as Record<string, unknown>;
        }
      } catch {
        return [];
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
    try {
      const parsedArguments = JSON.parse(rawArguments);
      if (parsedArguments && typeof parsedArguments === "object" && !Array.isArray(parsedArguments)) {
        argumentsJson = parsedArguments as Record<string, unknown>;
      }
    } catch {
      return [];
    }
  }

  return [{ id: crypto.randomUUID(), name, arguments: argumentsJson }];
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
  const firstBrace = fenced.indexOf("{");
  const lastBrace = fenced.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(fenced.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function assertNever(_value: ProviderType): never {
  throw new Error("Unsupported provider type.");
}

export function buildDecisionSystemPrompt(model: ModelProfile): string {
  return [
    "You are codexh, a desktop agent.",
    "Return exactly one valid JSON object and no text outside that JSON object.",
    "Return keys: assistant_message, clarification, tool_calls, end_turn, goal_completed, reasoning_summary.",
    "assistant_message is visible to the user: write concise Markdown or one short progress update before tool calls.",
    "Never expose private chain-of-thought; reasoning_summary is internal only and must never be rendered.",
    "tool_calls must be an array of { name, arguments }.",
    "clarification is optional and only for a material user decision. Its shape is { title, question, options, allow_free_text }, where options contains 2-4 { id, label, description, recommended } objects. When clarification is present, tool_calls must be empty and end_turn must be false.",
    "Only call tools that were provided in the tool list.",
    "When shell.exec is listed, it is the command execution tool. Do not state that command execution is unavailable; call shell.exec with {\"command\": \"...\"} instead.",
    "For every file creation or content edit, use apply_patch. Create a new file with an Add File patch.",
    "For apply_patch, send arguments.patch with this exact raw grammar: *** Begin Patch\\n*** Add File: relative/path.ext\\n+content\\n*** End Patch. Do not send a Git diff, file_path, or patch_content.",
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
