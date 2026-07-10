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

import { ProviderFactory } from "@provider-adapters";

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
            content: '{"assistant_message":"OK","tool_calls":[],"end_turn":true}'
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
        max_tokens: 4096
      },
      {
        signal: undefined
      }
    );
    expect(decision).toEqual({
      assistantMessage: "OK",
      toolCalls: [],
      endTurn: true,
      reasoningSummary: undefined
    });
  });
});
