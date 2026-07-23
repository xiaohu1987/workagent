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

import { buildDecisionSystemPrompt, imageGenerationProtocolForModel, nativeToolName, parseDecisionFromText, parseProviderTokenUsage, ProviderFactory } from "@provider-adapters";

describe("native tool names", () => {
  it("uses a stable provider-safe name without punctuation collisions", () => {
    expect(nativeToolName("fs.read_directory")).toBe(nativeToolName("fs.read_directory"));
    expect(nativeToolName("mcp.server.tool")).not.toBe(nativeToolName("mcp_server_tool"));
    expect(nativeToolName("mcp.server.tool")).toMatch(/^tool_[a-f0-9]{24}$/);
  });
});

describe("completion evidence parsing", () => {
  it("parses GPA task ids and tool-backed evidence from a final decision", () => {
    const decision = parseDecisionFromText(JSON.stringify({
      assistant_message: "Done",
      tool_calls: [],
      end_turn: true,
      goal_completed: true,
      completed_task_ids: ["t1", "T2"],
      completion_evidence: [
        { task_id: "t1", tool_call_id: "patch-1", kind: "delivery" },
        { task_id: "T2", tool_call_id: "test-1", kind: "verification" }
      ]
    }));

    expect(decision.completedTaskIds).toEqual(["T1", "T2"]);
    expect(decision.completionEvidence).toEqual([
      { taskId: "T1", toolCallId: "patch-1", kind: "delivery" },
      { taskId: "T2", toolCallId: "test-1", kind: "verification" }
    ]);
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

  it("routes GPT Image models through the Image API request shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "gpt-image-2",
      data: [{ b64_json: Buffer.from("gpt-image").toString("base64") }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "openai-images", type: "openai-compatible", baseUrl: "https://api.example/v1", apiKey: "secret"
    });
    const result = await adapter.generateImage!({
      model: {
        id: "gpt-image-2", providerId: "openai-images", displayName: "GPT Image 2", contextWindow: 128_000,
        supportsStreaming: false, supportsToolCalling: false, supportsParallelToolCalls: false, supportsJsonOutput: false,
        supportsMultimodalInput: true, supportsReasoningSummary: false
      },
      prompt: "a red lantern in snow"
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.example/v1/images/generations", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "gpt-image-2", prompt: "a red lantern in snow", n: 1, size: "1024x1024", quality: "medium", output_format: "png"
    });
    expect(result).toMatchObject({ protocol: "gpt-image-api", responseModel: "gpt-image-2", mimeType: "image/png" });
  });

  it("routes GPT-5 image generation through Responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ type: "image_generation_call", result: Buffer.from("response-image").toString("base64") }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "openai-responses", type: "openai-compatible", baseUrl: "https://api.example/v1", apiKey: "secret"
    });
    const result = await adapter.generateImage!({
      model: {
        id: "gpt-5.6", providerId: "openai-responses", displayName: "GPT-5.6", contextWindow: 128_000,
        supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: false, supportsJsonOutput: true,
        supportsMultimodalInput: true, supportsReasoningSummary: false
      },
      prompt: "a blue bird"
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example/v1/responses");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "gpt-5.6", input: "a blue bird", tools: [{ type: "image_generation", action: "generate" }]
    });
    expect(result.protocol).toBe("gpt-responses");
  });

  it("routes Grok Image models without GPT-only output parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("grok-image").toString("base64") }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "grok-images", type: "openai-compatible", baseUrl: "https://api.example/v1", apiKey: "secret"
    });
    const result = await adapter.generateImage!({
      model: {
        id: "grok-imagine-image", providerId: "grok-images", displayName: "Grok Imagine Image", contextWindow: 128_000,
        supportsStreaming: false, supportsToolCalling: false, supportsParallelToolCalls: false, supportsJsonOutput: false,
        supportsMultimodalInput: true, supportsReasoningSummary: false
      },
      prompt: "a cat in a library"
    });

    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: "grok-imagine-image", prompt: "a cat in a library", n: 1
    });
    expect(result.protocol).toBe("grok-images");
  });

  it("recognizes image model families from their configured model names", () => {
    expect(imageGenerationProtocolForModel({ id: "gpt-image-2", displayName: "GPT Image 2" })).toBe("gpt-image-api");
    expect(imageGenerationProtocolForModel({ id: "gpt-5.6", displayName: "GPT-5.6" })).toBe("gpt-responses");
    expect(imageGenerationProtocolForModel({ id: "grok-imagine-image", displayName: "Grok Imagine Image" })).toBe("grok-images");
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

  it("streams only the decoded assistant_message before a JSON tool batch", async () => {
    async function* streamDecision() {
      yield { choices: [{ delta: { content: '{"assistant_message":"I will inspect ' } }] };
      yield { choices: [{ delta: { content: 'the renderer.","tool_calls":[{"name":"fs.read_file","arguments":{"path":"src/App.tsx"}}],"end_turn":false}' } }] };
    }

    mocks.chatCreate.mockResolvedValue(streamDecision());
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
      supportsToolCalling: false,
      supportsParallelToolCalls: false,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };
    const visibleDeltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Inspect the renderer" }],
      availableTools: [],
      model,
      provider,
      stream: true,
      onTextDelta: async (delta) => { visibleDeltas.push(delta); }
    });

    expect(visibleDeltas.join("")).toBe("I will inspect the renderer.");
    expect(decision).toMatchObject({
      assistantMessage: "I will inspect the renderer.",
      toolCalls: [{ name: "fs.read_file", arguments: { path: "src/App.tsx" } }],
      endTurn: false
    });
  });

  it("captures token usage from the final streaming chunk", async () => {
    async function* streamWithUsage() {
      yield {
        choices: [{
          delta: {
            content: '{"assistant_message":"Done.","tool_calls":[],"end_turn":true,"goal_completed":true}'
          }
        }]
      };
      yield {
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 40,
          total_tokens: 160,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 10 }
        }
      };
    }

    mocks.chatCreate.mockResolvedValue(streamWithUsage());
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
      supportsToolCalling: false,
      supportsParallelToolCalls: false,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Finish" }],
      availableTools: [],
      model,
      provider,
      stream: true
    });

    expect(mocks.chatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true }
      }),
      expect.anything()
    );
    expect(decision.usage).toMatchObject({
      totalTokens: 160,
      inputTokens: 120,
      inputCacheHitTokens: 80,
      outputTokens: 40,
      outputReasoningTokens: 10,
      outputContentTokens: 30
    });
  });

  it("streams a final assistant_message when native tools are available but unused", async () => {
    async function* streamFinalAnswer() {
      yield { choices: [{ delta: { content: '{"assistant_message":"Streaming ' } }] };
      yield { choices: [{ delta: { content: 'works","tool_calls":[],"end_turn":true,"goal_completed":true}' } }] };
    }

    mocks.chatCreate.mockResolvedValue(streamFinalAnswer());
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
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };
    const visibleDeltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return a JSON decision.",
      transcript: [{ role: "user", content: "Reply normally" }],
      availableTools: [{ name: "fs.read_file", description: "Read a file", inputSchema: { type: "object" }, riskLevel: "low" }],
      model,
      provider,
      stream: true,
      onTextDelta: async (delta) => { visibleDeltas.push(delta); }
    });

    expect(visibleDeltas.join("")).toBe("Streaming works");
    expect(decision).toMatchObject({
      assistantMessage: "Streaming works",
      toolCalls: [],
      endTurn: true,
      goalCompleted: true
    });
  });

  it("accumulates native tool-call fragments without streaming their payload", async () => {
    const nativeName = nativeToolName("fs.read_file");
    async function* streamToolCall() {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: nativeName, arguments: '{"path":"src/' } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'App.tsx"}' } }] } }] };
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
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };
    const visibleDeltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use tools when needed.",
      transcript: [{ role: "user", content: "Read the file" }],
      availableTools: [{ name: "fs.read_file", description: "Read a file", inputSchema: { type: "object" }, riskLevel: "low" }],
      model,
      provider,
      stream: true,
      onTextDelta: async (delta) => { visibleDeltas.push(delta); }
    });

    expect(visibleDeltas).toEqual([]);
    expect(decision).toMatchObject({
      toolCalls: [{ id: "call-1", name: "fs.read_file", arguments: { path: "src/App.tsx" } }],
      endTurn: false,
      goalCompleted: false
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

describe("OpenAiCompatibleProvider video generation", () => {
  const provider: ProviderDefinition = {
    id: "company-gateway",
    type: "openai-compatible",
    baseUrl: "https://gateway.example/v1",
    apiKey: "secret"
  };
  const model: ModelProfile = {
    id: "grok-imagine-video-1.5",
    providerId: "company-gateway",
    displayName: "grok-imagine-video-1.5",
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsParallelToolCalls: true,
    supportsJsonOutput: true,
    supportsMultimodalInput: true,
    supportsVideoGeneration: true,
    role: "video",
    supportsReasoningSummary: false,
    defaultTemperature: 0.2,
    defaultMaxOutputTokens: 4096
  };

  it("creates, polls, and downloads an async video generation result", async () => {
    const bytes = new Uint8Array([0, 0, 0, 1, 2, 3]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ request_id: "req-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.endsWith("/videos/req-123")) {
        return new Response(
          JSON.stringify({
            status: "done",
            video: { url: "https://cdn.example/video.mp4", duration: 5 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "https://cdn.example/video.mp4") {
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "video/mp4" }
        });
      }
      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      const adapter = new ProviderFactory().create(provider);
      expect(adapter.generateVideo).toBeTypeOf("function");
      const result = await adapter.generateVideo!({
        model,
        prompt: "a red cube rotating slowly"
      });

      expect(result.mimeType).toBe("video/mp4");
      expect(Array.from(result.data)).toEqual(Array.from(bytes));
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.example/v1/videos/generations");
      const createInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(createInit.body))).toMatchObject({
        model: "grok-imagine-video-1.5",
        prompt: "a red cube rotating slowly",
        duration: 10
      });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("reports generation success with download URL when CDN fetch fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ request_id: "req-456" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.endsWith("/videos/req-456")) {
        return new Response(
          JSON.stringify({
            status: "done",
            video: { url: "https://vidgen.example/video.mp4", duration: 5 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "https://vidgen.example/video.mp4") {
        throw new TypeError("fetch failed");
      }
      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === "function") {
        handler();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      const adapter = new ProviderFactory().create(provider);
      await expect(adapter.generateVideo!({
        model,
        prompt: "a cat dancing"
      })).rejects.toMatchObject({
        code: "VIDEO_DOWNLOAD_FAILED",
        videoUrl: "https://vidgen.example/video.mp4",
        message: expect.stringContaining("视频生成成功，但下载失败")
      });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
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
    expect(prompt).toContain("For every GPA ACT decision, include completed_task_ids");
  });
});

describe("parseProviderTokenUsage", () => {
  it("parses OpenAI-compatible cache and reasoning details", () => {
    expect(parseProviderTokenUsage({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 100 }
    })).toEqual({
      totalTokens: 1500,
      inputTokens: 1200,
      inputCacheHitTokens: 800,
      inputCacheMissTokens: 400,
      inputCacheWriteTokens: 0,
      outputTokens: 300,
      outputReasoningTokens: 100,
      outputContentTokens: 200,
      cacheHitRate: 800 / 1200
    });
  });

  it("parses Anthropic cache read/write tokens", () => {
    expect(parseProviderTokenUsage({
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100
    })).toMatchObject({
      inputTokens: 1000,
      inputCacheHitTokens: 700,
      inputCacheMissTokens: 200,
      inputCacheWriteTokens: 100,
      outputTokens: 50,
      outputContentTokens: 50,
      cacheHitRate: 0.7
    });
  });
});

describe("parseDecisionFromText", () => {
  it("keeps lightweight multimodal intent JSON as assistant text", () => {
    const decision = parseDecisionFromText(
      '{"intent":"image","prompt":"生成一张二次元美女跳舞的图片"}'
    );

    expect(decision.isStructured).toBe(false);
    expect(decision.assistantMessage).toBe(
      '{"intent":"image","prompt":"生成一张二次元美女跳舞的图片"}'
    );
    expect(decision.toolCalls).toEqual([]);
  });

  it("still parses Agent decision envelopes and aliases image_gen", () => {
    const decision = parseDecisionFromText(
      JSON.stringify({
        assistant_message: "generating",
        tool_calls: [{ name: "image_gen", arguments: { prompt: "a cat" } }],
        end_turn: false,
        goal_completed: false
      })
    );

    expect(decision.isStructured).toBe(true);
    expect(decision.assistantMessage).toBe("generating");
    expect(decision.toolCalls[0]?.name).toBe("image.generate");
    expect(decision.toolCalls[0]?.arguments).toEqual({ prompt: "a cat" });
  });

  it("repairs malformed decision envelopes before applying the existing tool checks", () => {
    const decision = parseDecisionFromText(
      "{assistant_message: 'Inspecting files', tool_calls: [{name: 'fs.read_directory', arguments: {path: '.',},},], end_turn: false"
    );

    expect(decision).toMatchObject({
      assistantMessage: "Inspecting files",
      toolCalls: [{ name: "fs.read_directory", arguments: { path: "." } }],
      endTurn: false,
      isStructured: true
    });
  });

  it("selects an Agent decision when a gateway prepends a separate JSON payload", () => {
    const decision = parseDecisionFromText([
      "gateway metadata: {\"request_id\":\"req-123\",\"cached\":false}",
      "{\"assistant_message\":\"Inspecting files\",\"tool_calls\":[{\"name\":\"fs.read_directory\",\"arguments\":{\"path\":\".\"}}],\"end_turn\":false,\"goal_completed\":false}"
    ].join("\n"));

    expect(decision).toMatchObject({
      assistantMessage: "Inspecting files",
      toolCalls: [{ name: "fs.read_directory", arguments: { path: "." } }],
      endTurn: false,
      isStructured: true
    });
  });

  it("repairs tagged JSON and XML tool arguments returned as text", () => {
    const tagged = parseDecisionFromText(
      "<tool_calls>[{name: 'fs.read_file', arguments: '{path: \\\"README.md\\\",}',}]</tool_calls>"
    );
    const xml = parseDecisionFromText(
      "<tool_calls><invoke name=\"fs.read_file\"><parameter name=\"arguments\">{path: 'package.json',}</parameter></invoke></tool_calls>"
    );

    expect(tagged.toolCalls).toMatchObject([{ name: "fs.read_file", arguments: { path: "README.md" } }]);
    expect(xml.toolCalls).toMatchObject([{ name: "fs.read_file", arguments: { path: "package.json" } }]);
  });

  it("promotes standalone request_user_input XML into a validated tool call", () => {
    const decision = parseDecisionFromText([
      "需要确认几个设计选项：",
      '<request_user_input title="宝可梦小游戏：需要确认几个设计选项">',
      '<question id="pokemon_count" label="宝可梦数量" prompt="图鉴里需要多少只宝可梦？" options="6只（精简版）、9只（中等）、12只（丰富版）">',
      "</question>",
      '<question id="battle_style" label="对战风格" prompt="对战交互偏好？" options="纯文本、日志式（简单快速）、带简单动画">',
      "</question>",
      "</request_user_input>",
      "请确认后继续。"
    ].join("\n"));

    expect(decision).toMatchObject({
      isStructured: true,
      endTurn: false,
      toolCalls: [{
        name: "request_user_input",
        arguments: {
          title: "宝可梦小游戏：需要确认几个设计选项",
          questions: [
            {
              id: "pokemon_count",
              label: "宝可梦数量",
              prompt: "图鉴里需要多少只宝可梦？",
              options: [
                { id: "option_1", label: "6只（精简版）", recommended: true },
                { id: "option_2", label: "9只（中等）", recommended: false },
                { id: "option_3", label: "12只（丰富版）", recommended: false }
              ]
            }
          ]
        }
      }]
    });
    expect(decision.assistantMessage).toContain("需要确认几个设计选项");
    expect(decision.assistantMessage).not.toContain("<request_user_input");
  });

  it("leaves standalone request_user_input XML unstructured when no valid options exist", () => {
    const decision = parseDecisionFromText(
      '<request_user_input title="确认"><question id="q1" label="问题" prompt="请选择" options=""></question></request_user_input>'
    );

    expect(decision).toMatchObject({ isStructured: false, toolCalls: [] });
  });

  it("keeps unrepairable text protocols unstructured and prevents tool execution", () => {
    const decision = parseDecisionFromText("<tool_calls>{not valid</tool_calls>");

    expect(decision).toMatchObject({ isStructured: false, toolCalls: [] });
  });
});
