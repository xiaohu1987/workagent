import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ProviderDefinition, ProviderTurnInput } from "@shared-types";

const mocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responsesCreate: vi.fn(),
  openAIConstructor: vi.fn(),
  anthropicCreate: vi.fn(),
  anthropicConstructor: vi.fn()
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

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: mocks.anthropicCreate };

    public constructor(...args: unknown[]) {
      mocks.anthropicConstructor(...args);
    }
  }

  return { default: Anthropic };
});

import { buildDecisionSystemPrompt, nativeToolName, ProviderFactory } from "@provider-adapters";

describe("native tool names", () => {
  it("uses a stable provider-safe name without punctuation collisions", () => {
    expect(nativeToolName("fs.read_directory")).toBe(nativeToolName("fs.read_directory"));
    expect(nativeToolName("mcp.server.tool")).not.toBe(nativeToolName("mcp_server_tool"));
    expect(nativeToolName("mcp.server.tool")).toMatch(/^tool_[a-f0-9]{24}$/);
  });
});

describe("OpenAiCompatibleProvider", () => {
  beforeEach(() => {
    mocks.chatCreate.mockReset();
    mocks.responsesCreate.mockReset();
    mocks.openAIConstructor.mockReset();
    mocks.anthropicCreate.mockReset();
    mocks.anthropicConstructor.mockReset();
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

  it("uses native function calls when tools are available", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: nativeToolName("fs.read_directory"), arguments: '{"path":"."}' }
          }]
        }
      }],
      usage: { completion_tokens: 8 }
    });
    const provider: ProviderDefinition = { id: "gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "tool-model", providerId: "gateway", displayName: "Tool model", contextWindow: 8_192,
      supportsStreaming: true, supportsToolCalling: true, supportsParallelToolCalls: true,
      supportsJsonOutput: true, supportsMultimodalInput: false, supportsReasoningSummary: false
    };
    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the function tool.",
      transcript: [{ role: "user", content: "Inspect the workspace." }],
      availableTools: [{
        name: "fs.read_directory",
        description: "List a directory.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        riskLevel: "low"
      }],
      model,
      provider,
      stream: true
    });

    expect(mocks.chatCreate).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: nativeToolName("fs.read_directory") })
      })],
      parallel_tool_calls: true
    }), { signal: undefined });
    expect(decision).toMatchObject({
      toolCalls: [{ id: "call-1", name: "fs.read_directory", arguments: { path: "." } }],
      endTurn: false,
      isStructured: true,
      outputTokens: 8
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

  it("executes XML-tagged tool calls returned by compatible coding models", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '<tool_calls> [{"name":"fs.read_file","arguments":{"path":"js/pathfinder.js"}},{"name":"fs.read_file","arguments":{"path":"css/style.css"}}] </tool_calls></tool_calls>'
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
      supportsParallelToolCalls: true,
      supportsJsonOutput: false,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Read the project files" }],
      availableTools: [],
      model,
      provider
    });

    expect(decision).toMatchObject({
      toolCalls: [
        { name: "fs.read_file", arguments: { path: "js/pathfinder.js" } },
        { name: "fs.read_file", arguments: { path: "css/style.css" } }
      ],
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    });
    expect(decision.assistantMessage).toBeUndefined();
  });

  it("parses invoke-style XML tool calls returned by compatible coding models", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              'I will inspect the project first.\n\n<tool_calls>\n<invoke name="fs.read_file">\n<parameter name="arguments">{"path":"js/game.js"}</parameter>\n</invoke>\n<invoke name="fs.read_file">\n<parameter name="arguments">{"path":"js/app.js"}</parameter>\n</invoke>\n</tool_calls>'
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
      supportsParallelToolCalls: true,
      supportsJsonOutput: false,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Read the project files" }],
      availableTools: [],
      model,
      provider
    });

    expect(decision).toMatchObject({
      assistantMessage: "I will inspect the project first.",
      toolCalls: [
        { name: "fs.read_file", arguments: { path: "js/game.js" } },
        { name: "fs.read_file", arguments: { path: "js/app.js" } }
      ],
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    });
  });

  it("does not stream XML-tagged tool calls into the visible assistant message", async () => {
    async function* streamToolCall() {
      yield {
        choices: [
          {
            delta: {
              content: "<tool"
            }
          }
        ]
      };
      yield {
        choices: [
          {
            delta: {
              content: '_calls> [{"name":"fs.read_directory","arguments":{"path":"."}}] </tool_calls>'
            }
          }
        ]
      };
    }

    mocks.chatCreate.mockResolvedValue(streamToolCall());
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
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsParallelToolCalls: false,
      supportsJsonOutput: false,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };
    const visibleDeltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "List the project files" }],
      availableTools: [],
      model,
      provider,
      stream: true,
      onTextDelta: async (delta) => {
        visibleDeltas.push(delta);
      }
    });

    expect(visibleDeltas).toEqual([]);
    expect(decision.toolCalls).toHaveLength(1);
    expect(decision.toolCalls[0]).toMatchObject({
      name: "fs.read_directory",
      arguments: { path: "." }
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

  it("replays native call envelopes and correlated tool results", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "Directory inspected." } }]
    });
    const provider: ProviderDefinition = { id: "gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "tool-model", providerId: "gateway", displayName: "Tool model", contextWindow: 8_192,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: false,
      supportsJsonOutput: true, supportsMultimodalInput: false, supportsReasoningSummary: false
    };
    const tool = {
      name: "fs.read_directory", description: "List a directory.", riskLevel: "low" as const,
      inputSchema: { type: "object", properties: { path: { type: "string" } } }
    };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use tools.",
      transcript: [
        { role: "user", content: "Inspect." },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: tool.name, arguments: { path: "." } }] },
        { role: "tool", content: "fs.read_directory\nREADME.md", toolCallId: "call-1" }
      ],
      availableTools: [tool], model, provider
    });

    expect(mocks.chatCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call-1" })] }),
        expect.objectContaining({ role: "tool", tool_call_id: "call-1", content: "fs.read_directory\nREADME.md" })
      ])
    }), { signal: undefined });
  });
});

describe("native provider tool protocols", () => {
  const tool = {
    name: "fs.read_directory", description: "List a directory.", riskLevel: "low" as const,
    inputSchema: { type: "object", properties: { path: { type: "string" } } }
  };
  const model: ModelProfile = {
    id: "tool-model", providerId: "provider", displayName: "Tool model", contextWindow: 8_192,
    supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: false,
    supportsJsonOutput: true, supportsMultimodalInput: false, supportsReasoningSummary: false
  };

  it("uses Anthropic tool_use blocks instead of text JSON", async () => {
    mocks.anthropicCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "anthropic-call", name: nativeToolName(tool.name), input: { path: "." } }],
      usage: { output_tokens: 7 }
    });
    const provider: ProviderDefinition = { id: "provider", type: "anthropic", apiKey: "secret" };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the function.", transcript: [{ role: "user", content: "Inspect." }],
      availableTools: [tool], model, provider
    });

    expect(mocks.anthropicCreate).toHaveBeenCalledWith(expect.objectContaining({
      tools: [expect.objectContaining({ name: nativeToolName(tool.name) })]
    }), { signal: undefined });
    expect(decision).toMatchObject({
      toolCalls: [{ id: "anthropic-call", name: tool.name, arguments: { path: "." } }],
      endTurn: false, isStructured: true, outputTokens: 7
    });
  });

  it("returns an Anthropic tool result through the matching tool_use id", async () => {
    mocks.anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Directory is ready." }],
      usage: { output_tokens: 4 }
    });
    const provider: ProviderDefinition = { id: "provider", type: "anthropic", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Finish after the tool result.",
      transcript: [
        { role: "user", content: "Inspect." },
        { role: "assistant", content: "", toolCalls: [{ id: "anthropic-1", name: tool.name, arguments: { path: "." } }] },
        {
          role: "tool",
          toolCallId: "anthropic-1",
          toolResultOk: false,
          content: "fs.read_directory\nPermission denied"
        }
      ],
      availableTools: [tool], model, provider
    });

    const request = mocks.anthropicCreate.mock.calls.at(-1)?.[0];
    expect(request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ type: "tool_use", id: "anthropic-1" })]
      }),
      expect.objectContaining({
        role: "user",
        content: [expect.objectContaining({
          type: "tool_result",
          tool_use_id: "anthropic-1",
          is_error: true
        })]
      })
    ]));
  });

  it("uses Gemini functionCall blocks instead of text JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        candidates: [{ content: { parts: [{ functionCall: { name: nativeToolName(tool.name), args: { path: "." } } }] } }],
        usageMetadata: { candidatesTokenCount: 5 }
      })
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider: ProviderDefinition = { id: "provider", type: "gemini", apiKey: "secret" };
    try {
      const decision = await new ProviderFactory().create(provider).runTurn({
        systemPrompt: "Use the function.", transcript: [{ role: "user", content: "Inspect." }],
        availableTools: [tool], model, provider
      });
      const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(request.tools[0].functionDeclarations[0].name).toBe(nativeToolName(tool.name));
      expect(decision).toMatchObject({
        toolCalls: [{ name: tool.name, arguments: { path: "." } }],
        endTurn: false, isStructured: true, outputTokens: 5
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns Gemini tool results through functionResponse", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ candidates: [{ content: { parts: [{ text: "Directory is ready." }] } }] })
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider: ProviderDefinition = { id: "provider", type: "gemini", apiKey: "secret" };
    try {
      await new ProviderFactory().create(provider).runTurn({
        systemPrompt: "Finish after the tool result.",
        transcript: [
          { role: "user", content: "Inspect." },
          { role: "assistant", content: "", toolCalls: [{ id: "gemini-1", name: tool.name, arguments: { path: "." } }] },
          {
            role: "tool",
            toolCallId: "gemini-1",
            toolResultOk: false,
            content: "fs.read_directory\nPermission denied"
          }
        ],
        availableTools: [tool], model, provider
      });
      const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(request.contents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "model",
          parts: [expect.objectContaining({ functionCall: expect.objectContaining({ name: nativeToolName(tool.name) }) })]
        }),
        expect.objectContaining({
          role: "user",
          parts: [expect.objectContaining({
            functionResponse: expect.objectContaining({
              name: nativeToolName(tool.name),
              response: expect.objectContaining({ error: expect.stringContaining("Permission denied") })
            })
          })]
        })
      ]));
    } finally {
      vi.unstubAllGlobals();
    }
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
