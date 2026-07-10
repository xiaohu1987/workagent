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
          endTurn: false
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
        endTurn: false
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
        endTurn: false
      };
    }

    return {
      assistantMessage:
        "运行时已准备好。当前默认是 mock provider，所以我会优先通过工具收集事实，再继续推进任务。",
      toolCalls: [],
      endTurn: true,
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
    const response = await this.#client.responses.create({
      model: input.model.id,
      instructions: input.systemPrompt,
      input: input.transcript.map((message) => ({
        role: message.role === "tool" ? "assistant" : message.role,
        content: message.content
      })),
      temperature: input.model.defaultTemperature,
      max_output_tokens: input.model.defaultMaxOutputTokens
    });

    const text = response.output_text?.trim() || "";
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
    const response = await this.#client.messages.create({
      model: input.model.id,
      system: input.systemPrompt,
      max_tokens: input.model.defaultMaxOutputTokens ?? 2048,
      messages: input.transcript
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" || message.role === "tool" ? "assistant" : "user",
          content: message.content
        }))
    });

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
      reasoningSummary:
        typeof parsed.reasoning_summary === "string" ? parsed.reasoning_summary : undefined
    };
  }

  return {
    assistantMessage: text || "模型未返回结构化结果。",
    toolCalls: [],
    endTurn: true
  };
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
    "Always decide the next action using a JSON object.",
    "Return keys: assistant_message, tool_calls, end_turn, reasoning_summary.",
    "tool_calls must be an array of { name, arguments }.",
    "Only call tools that were provided in the tool list.",
    "When no tool is needed, return an empty tool_calls array.",
    `Current model: ${model.displayName}.`
  ].join("\n");
}
