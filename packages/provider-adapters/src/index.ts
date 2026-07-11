import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ModelProfile,
  ProviderDefinition,
  ProviderTurnDecision,
  ProviderTurnInput,
  ProviderType
} from "@shared-types";

export interface ProviderAdapter {
  runTurn(input: ProviderTurnInput): Promise<ProviderTurnDecision>;
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
      messages: buildOpenAiCompatibleMessages(input),
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
    return parseDecisionFromText(text);
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
        messages: input.transcript
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" || message.role === "tool" ? "assistant" : "user",
            content: message.content
          }))
      },
      { signal: input.abortSignal }
    );

    const text = response.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n")
      .trim();

    return parseDecisionFromText(text);
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
        contents: input.transcript.map((message) => ({
          role: message.role === "assistant" || message.role === "tool" ? "model" : "user",
          parts: [{ text: message.content }]
        }))
      }),
      signal: input.abortSignal
    });

    const json = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const text =
      json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() ??
      "";
    return parseDecisionFromText(text);
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

function buildOpenAiCompatibleMessages(input: ProviderTurnInput) {
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
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
      content: message.content
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
  const parsed = tryParseJsonDecision(text);
  if (parsed) {
    return {
      assistantMessage: typeof parsed.assistant_message === "string" ? parsed.assistant_message : undefined,
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

  // Some OpenAI-compatible models ignore the decision envelope and stream
  // ordinary Markdown. Preserve that visible text instead of waiting for the
  // full response, while keeping partial JSON control data out of the UI.
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("```json")) {
    return "";
  }

  return text;
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
    "Return keys: assistant_message, tool_calls, end_turn, goal_completed, reasoning_summary.",
    "assistant_message is visible to the user: write concise Markdown or one short progress update before tool calls.",
    "Never expose private chain-of-thought; reasoning_summary is internal only and must never be rendered.",
    "tool_calls must be an array of { name, arguments }.",
    "Only call tools that were provided in the tool list.",
    "When shell.exec is listed, it is the command execution tool. Do not state that command execution is unavailable; call shell.exec with {\"command\": \"...\"} instead.",
    "For every file creation or content edit, use apply_patch. Create a new file with an Add File patch.",
    "For apply_patch, send arguments.patch with this exact raw grammar: *** Begin Patch\\n*** Add File: relative/path.ext\\n+content\\n*** End Patch. Do not send a Git diff, file_path, or patch_content.",
    "To inspect the selected project folder, call fs.read_directory with { path: \".\" }. Never call read or use Unix paths such as /home.",
    "A successful directory listing, including an empty folder, is sufficient context. Do not repeat it: create or edit the requested files with apply_patch in the very next tool call.",
    "After an Add File patch succeeds, never use Add File for that path again in the same task. Read it and use Update File only if a follow-up edit is necessary.",
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
