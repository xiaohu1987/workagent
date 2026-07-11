import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ProviderDefinition, ProviderTurnInput } from "@shared-types";

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responsesCreate: vi.fn(),
  openAIConstructor: vi.fn()
}));

vi.mock("openai", () => {
  class OpenAI {
    chat = {
      completions: {
        create: mocks.chatCreate
      }
    };

    responses = {
      create: mocks.responsesCreate
    };

    public constructor(...args: unknown[]) {
      mocks.openAIConstructor(...args);
    }
  }

  return {
    default: OpenAI
  };
});

import { buildDecisionSystemPrompt, ProviderFactory } from "@provider-adapters";

describe("OpenAiCompatibleProvider", () => {
  beforeEach(() => {
    mocks.chatCreate.mockReset();
    mocks.responsesCreate.mockReset();
    mocks.openAIConstructor.mockReset();
  });

  it("uses chat completions for openai-compatible providers", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"assistant_message":"OK","tool_calls":[],"end_turn":true,"goal_completed":true}'
          }
        }
      ]
    });

    const provider: ProviderDefinition = {
      id: "company-gateway",
      type: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret"
    };
    const model: ModelProfile = {
      id: "l-deepseek-v4-flash",
      providerId: "company-gateway",
      displayName: "l-deepseek-v4-flash",
      contextWindow: 128_000,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: true,
      supportsReasoningSummary: true,
      defaultTemperature: 0.2,
      defaultMaxOutputTokens: 4096
    };
    const input: ProviderTurnInput = {
      systemPrompt: "Return JSON only.",
      transcript: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "tool", content: "Tool output" }
      ],
      availableTools: [],
      model,
      provider
    };

    const adapter = new ProviderFactory().create(provider);
    const decision = await adapter.runTurn(input);

    expect(mocks.openAIConstructor).toHaveBeenCalledWith({
      apiKey: "secret",
      baseURL: "https://gateway.example/v1",
      defaultHeaders: undefined
    });
    expect(mocks.responsesCreate).not.toHaveBeenCalled();
    expect(mocks.chatCreate).toHaveBeenCalledTimes(1);
    expect(mocks.chatCreate).toHaveBeenCalledWith(
      {
        model: "l-deepseek-v4-flash",
        messages: [
          { role: "system", content: "Return JSON only." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
          { role: "assistant", content: "Tool output" }
        ],
        temperature: 0.2,
        max_tokens: 4096,
        response_format: { type: "json_object" }
      },
      {
        signal: undefined
      }
    );
    expect(decision).toEqual({
      assistantMessage: "OK",
      toolCalls: [],
      endTurn: true,
      goalCompleted: true,
      isStructured: true,
      reasoningSummary: undefined
    });
  });

  it("does not treat an unstructured progress message as a completed decision", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: "I created the files and will now start the next task."
          }
        }
      ]
    });

    const provider: ProviderDefinition = {
      id: "company-gateway",
      type: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret"
    };
    const model: ModelProfile = {
      id: "l-deepseek-v4-flash",
      providerId: "company-gateway",
      displayName: "l-deepseek-v4-flash",
      contextWindow: 128_000,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: true,
      supportsReasoningSummary: true
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Build a game" }],
      availableTools: [],
      model,
      provider
    });

    expect(decision).toMatchObject({
      assistantMessage: "I created the files and will now start the next task.",
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false
    });
  });

  it("requires an explicit goal_completed declaration", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"assistant_message":"Only one file is done","tool_calls":[],"end_turn":true}'
          }
        }
      ]
    });

    const provider: ProviderDefinition = {
      id: "company-gateway",
      type: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret"
    };
    const model: ModelProfile = {
      id: "test-model",
      providerId: "company-gateway",
      displayName: "Test model",
      contextWindow: 8_192,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: false,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Build a game" }],
      availableTools: [],
      model,
      provider
    });

    expect(decision).toMatchObject({ endTurn: true, goalCompleted: false, isStructured: true });
  });
});

describe("decision system prompt", () => {
  it("directs file creation through apply_patch rather than an invented tool", () => {
    const prompt = buildDecisionSystemPrompt({
      id: "test-model",
      providerId: "test-provider",
      displayName: "Test model",
      contextWindow: 8_192,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsParallelToolCalls: false,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    });

    expect(prompt).toContain("use apply_patch");
    expect(prompt).toContain("There is no create_file tool");
    expect(prompt).toContain("arguments.patch");
    expect(prompt).toContain("fs.read_directory");
    expect(prompt).toContain("Do not repeat it");
    expect(prompt).toContain("goal_completed");
    expect(prompt).toContain("shell.exec");
  });
});
