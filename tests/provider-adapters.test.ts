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

import { applyProviderRequestLimits, buildDecisionSystemPrompt, extractVisibleStreamText, imageGenerationProtocolForModel, isBareToolInvocationText, nativeToolName, parseDecisionFromText, parseNativeToolArguments, parseProviderTokenUsage, providerSupportsMediaGeneration, ProviderFactory, ProviderRequestLimitError, ProviderStreamIncompleteError, resolveModelCompat, resolveProviderRequestLimits, stripThinkBlocks, stripThinkBlocksFromStream, surfaceThinkBlocksInStream, TOOL_ARGS_INVALID_KEY, TOOL_ARGS_TRUNCATED_KEY } from "@provider-adapters";

describe("native tool names", () => {
  it("uses a stable provider-safe name without punctuation collisions", () => {
    expect(nativeToolName("fs.read_directory")).toBe(nativeToolName("fs.read_directory"));
    expect(nativeToolName("mcp.server.tool")).not.toBe(nativeToolName("mcp_server_tool"));
    expect(nativeToolName("mcp.server.tool")).toMatch(/^tool_[a-f0-9]{24}$/);
  });

  it("recognizes a bare tool name as an unexecuted invocation", () => {
    expect(isBareToolInvocationText("fs.read_directory")).toBe(true);
    expect(isBareToolInvocationText("apply_patch")).toBe(true);
    expect(isBareToolInvocationText("The project is complete.")).toBe(false);
  });

  it("can force the JSON tool protocol for native-tool-compatible gateways", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        assistant_message: "Inspecting the workspace.",
        tool_calls: [{ name: "fs.read_directory", arguments: { path: "." } }],
        end_turn: false,
        goal_completed: false
      }) } }]
    });
    const provider: ProviderDefinition = { id: "gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "tool-model", providerId: "gateway", displayName: "Tool model", contextWindow: 8_192,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
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
      forceTextToolProtocol: true
    });

    expect(mocks.chatCreate.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect(mocks.chatCreate.mock.calls[0]?.[0]).toMatchObject({ response_format: { type: "json_object" } });
    expect(decision.toolCalls).toMatchObject([{ name: "fs.read_directory", arguments: { path: "." } }]);
  });
});

describe("provider transport limits", () => {
  const deepseekModel = { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" };

  it("uses compatibility defaults independently from the model token window", () => {
    expect(resolveProviderRequestLimits(
      { id: "provider", type: "openai-compatible" },
      deepseekModel
    )).toEqual({ maxRequestBytes: 128 * 1024, maxTools: 50 });
    expect(resolveProviderRequestLimits(
      { id: "provider", type: "openai-compatible" },
      { id: "kimi-k3", displayName: "Kimi K3" }
    )).toEqual({ maxRequestBytes: 0, maxTools: 50 });
  });

  it("allows a compacted DeepSeek request slightly above the legacy 120 KiB default", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{ role: "user", content: "x".repeat(120 * 1024) }],
      stream: true,
      stream_options: { include_usage: true }
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");

    expect(requestBytes).toBeGreaterThan(120 * 1024);
    expect(requestBytes).toBeLessThan(128 * 1024);

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible" },
      deepseekModel
    );

    expect(Buffer.byteLength(JSON.stringify(limited), "utf8")).toBe(requestBytes);
  });

  it("honors custom tool limits and treats zero as unlimited", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{ role: "user", content: "current request" }],
      tools: Array.from({ length: 4 }, (_, index) => ({ name: `tool-${index}` }))
    };

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes: 0, maxTools: 2 },
      deepseekModel
    );
    const unlimited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes: 0, maxTools: 0 },
      deepseekModel
    );

    expect(limited.tools).toHaveLength(2);
    expect(unlimited.tools).toHaveLength(4);
  });

  it("counts final stream fields and removes optional transport metadata before retrying", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{ role: "user", content: "CURRENT_REQUEST_MUST_STAY" }],
      stream: true,
      stream_options: { include_usage: true }
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes: requestBytes - 1, maxTools: 0 },
      deepseekModel
    );
    expect(Buffer.byteLength(JSON.stringify(limited), "utf8")).toBeLessThanOrEqual(requestBytes - 1);
    expect(limited).not.toHaveProperty("stream_options");
    expect(request.messages[0]?.content).toBe("CURRENT_REQUEST_MUST_STAY");
  });

  it("compacts tool descriptions to absorb a small final-byte overage", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{ role: "user", content: "CURRENT_REQUEST_MUST_STAY" }],
      tools: [{
        type: "function",
        function: {
          name: "large_tool",
          description: `Useful tool details ${"x".repeat(1_000)}`,
          parameters: { type: "object", properties: { query: { type: "string" } } }
        }
      }]
    };
    const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    const maxRequestBytes = requestBytes - 35;

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes, maxTools: 0 },
      deepseekModel
    );

    expect(Buffer.byteLength(JSON.stringify(limited), "utf8")).toBeLessThanOrEqual(maxRequestBytes);
    expect(limited.tools).toHaveLength(1);
    expect(JSON.stringify(limited)).toContain("CURRENT_REQUEST_MUST_STAY");
    expect(JSON.stringify(limited)).toContain("large_tool");
    expect(JSON.stringify(limited)).toContain('"query"');
  });

  it("reduces the tool list only after descriptions cannot satisfy the byte limit", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{ role: "user", content: "CURRENT_REQUEST_MUST_STAY" }],
      tools: Array.from({ length: 3 }, (_, index) => ({
        type: "function",
        function: {
          name: `tool_${index}`,
          parameters: { type: "object", properties: { value: { type: "string" } } }
        }
      }))
    };
    const oneToolRequest = { ...request, tools: request.tools.slice(0, 1) };
    const maxRequestBytes = Buffer.byteLength(JSON.stringify(oneToolRequest), "utf8");

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes, maxTools: 0 },
      deepseekModel
    );

    expect(limited.tools).toHaveLength(1);
    expect(JSON.stringify(limited)).toContain("CURRENT_REQUEST_MUST_STAY");
    expect(JSON.stringify(limited)).toContain("tool_0");
  });

  it("removes tool-only request options when the byte budget cannot retain any tool", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{ role: "user", content: "CURRENT_REQUEST_MUST_STAY" }],
      tools: [{
        type: "function",
        function: {
          name: "large_structural_tool",
          parameters: {
            type: "object",
            properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index}`, { type: "string" }]))
          }
        }
      }],
      parallel_tool_calls: true,
      tool_choice: "auto"
    };
    const requestWithoutTools = {
      model: request.model,
      messages: request.messages
    };
    const maxRequestBytes = Buffer.byteLength(JSON.stringify(requestWithoutTools), "utf8");

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes, maxTools: 0 },
      deepseekModel
    );

    expect(limited).toEqual(requestWithoutTools);
  });

  it("keeps transport headroom and compacts a recent rejected completion candidate", () => {
    const maxRequestBytes = 120 * 1024;
    const targetRequestBytes = maxRequestBytes - 4 * 1024;
    const request = {
      model: deepseekModel.id,
      messages: [
        { role: "system", content: "S".repeat(114_000) },
        { role: "user", content: "ORIGINAL_USER_REQUEST_MUST_STAY" },
        { role: "assistant", content: `REJECTED_CANDIDATE ${"c".repeat(8_000)}` },
        { role: "user", content: `[Internal completion audit result] ${"g".repeat(1_308)}` }
      ],
      stream: true
    };
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeGreaterThan(maxRequestBytes);

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes: 120 * 1024 },
      deepseekModel
    );
    const serialized = JSON.stringify(limited);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(targetRequestBytes);
    expect(serialized).toContain("ORIGINAL_USER_REQUEST_MUST_STAY");
    expect(serialized).toContain("[Internal completion audit result]");
    expect(serialized).not.toContain("REJECTED_CANDIDATE");
    expect(serialized).toContain("Earlier assistant progress omitted");
  });

  it("shrinks recent tool evidence when a tool-free request exceeds the hard limit by 45 bytes", () => {
    const maxRequestBytes = 120 * 1024;
    const targetRequestBytes = maxRequestBytes - 4 * 1024;
    const messages = [
      { role: "system", content: "" },
      { role: "user", content: "CURRENT_REQUEST_MUST_STAY" },
      { role: "tool", tool_call_id: "read-1", content: `FIRST_EVIDENCE_START\n${"a".repeat(5_000)}\nFIRST_EVIDENCE_END` },
      { role: "tool", tool_call_id: "read-2", content: `LATEST_EVIDENCE_START\n${"b".repeat(5_000)}\nLATEST_EVIDENCE_END` }
    ];
    const request = {
      model: deepseekModel.id,
      messages,
      stream: true
    };
    const bytesWithoutSystemPadding = Buffer.byteLength(JSON.stringify(request), "utf8");
    messages[0]!.content = "S".repeat(maxRequestBytes + 45 - bytesWithoutSystemPadding);
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBe(maxRequestBytes + 45);

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes: 120 * 1024 },
      deepseekModel
    );
    const serialized = JSON.stringify(limited);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(targetRequestBytes);
    expect(serialized).toContain("CURRENT_REQUEST_MUST_STAY");
    expect(serialized).toContain("LATEST_EVIDENCE_START");
    expect(serialized).toContain("LATEST_EVIDENCE_END");
    expect(serialized).toContain("Recent tool output shortened");
    expect(limited).not.toHaveProperty("tools");
  });

  it("compacts regenerated system context when no historical message can be removed", () => {
    const maxRequestBytes = 120 * 1024;
    const targetRequestBytes = maxRequestBytes - 4 * 1024;
    const request = {
      model: deepseekModel.id,
      messages: [
        { role: "system", content: `SAFETY_RULES_MUST_STAY\n${"s".repeat(138_000)}\nSYSTEM_TAIL_MUST_STAY` },
        { role: "user", content: "CURRENT_REQUEST_MUST_STAY" }
      ],
      stream: true
    };

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes: 120 * 1024 },
      deepseekModel
    );
    const serialized = JSON.stringify(limited);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(targetRequestBytes);
    expect(serialized).toContain("CURRENT_REQUEST_MUST_STAY");
    expect(serialized).toContain("SAFETY_RULES_MUST_STAY");
    expect(serialized).toContain("SYSTEM_TAIL_MUST_STAY");
    expect(serialized).toContain("Supplementary system context shortened");
  });

  it("drops optional transport fields when a request is only slightly over the hard limit", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{ role: "user", content: "CURRENT_REQUEST_MUST_STAY" }],
      stream: true,
      stream_options: { include_usage: true },
      parallel_tool_calls: true,
      tool_choice: "auto"
    };
    const requiredRequest = {
      model: request.model,
      messages: request.messages,
      stream: request.stream
    };
    const maxRequestBytes = Buffer.byteLength(JSON.stringify(requiredRequest), "utf8");

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes },
      deepseekModel
    );

    expect(Buffer.byteLength(JSON.stringify(limited), "utf8")).toBeLessThanOrEqual(maxRequestBytes);
    expect(limited).not.toHaveProperty("stream_options");
    expect(limited).not.toHaveProperty("parallel_tool_calls");
    expect(limited).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(limited)).toContain("CURRENT_REQUEST_MUST_STAY");
  });

  it("drops a large internal compaction summary before preserving the current request", () => {
    const maxRequestBytes = 120 * 1024;
    const targetRequestBytes = maxRequestBytes - 4 * 1024;
    const request = {
      model: deepseekModel.id,
      messages: [
        { role: "system", content: "SYSTEM_RULES_MUST_STAY" },
        {
          role: "user",
          content: `[Internal context compaction summary. Preserve task goals.]\n${"history ".repeat(22_000)}`
        },
        { role: "user", content: "CURRENT_REQUEST_MUST_STAY" },
        { role: "tool", tool_call_id: "schema-1", content: "schema ".repeat(15_000) }
      ],
      stream: true
    };

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible" },
      deepseekModel
    );
    const serialized = JSON.stringify(limited);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(targetRequestBytes);
    expect(serialized).toContain("CURRENT_REQUEST_MUST_STAY");
    expect(serialized).toContain("SYSTEM_RULES_MUST_STAY");
    expect(serialized).toContain("Earlier internal context summary omitted");
    expect(serialized).not.toContain("history history history");
  });

  it("drops low-priority skill catalog entries before explicit skills or project instructions", () => {
    const request = {
      model: deepseekModel.id,
      messages: [{
        role: "system",
        content: [
          "SAFETY_RULES",
          "## Available Skills",
          `- skill_id: normal; name: normal; priority: normal; description: ${"x".repeat(20_000)};`,
          "- skill_id: selected; name: selected; priority: selected; description: required;",
          "## Project Instructions",
          "PROJECT_RULES_MUST_STAY"
        ].join("\n")
      }, { role: "user", content: "CURRENT_REQUEST_MUST_STAY" }]
    };

    const limited = applyProviderRequestLimits(
      request,
      { id: "provider", type: "openai-compatible", maxRequestBytes: 4_096, maxTools: 0 },
      deepseekModel
    );
    const system = String((limited.messages as Array<{ content: string }>)[0]?.content);

    expect(system).not.toContain("skill_id: normal");
    expect(system).toContain("skill_id: selected");
    expect(system).toContain("PROJECT_RULES_MUST_STAY");
    expect(String((limited.messages as Array<{ content: string }>)[1]?.content)).toBe("CURRENT_REQUEST_MUST_STAY");
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

  it("keeps Chinese replies stable for Qwen and DeepSeek after English tool context", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "cn-gateway", type: "openai-compatible", apiKey: "secret" };

    for (const modelId of ["qwen-plus", "deepseek-chat"]) {
      await new ProviderFactory().create(provider).runTurn({
        systemPrompt: "Complete the requested task.",
        transcript: [
          { role: "user", content: "请继续处理刚才的问题" },
          { role: "tool", content: "English tool output" },
          { role: "user", content: "continue" }
        ],
        availableTools: [],
        model: {
          id: modelId,
          providerId: provider.id,
          displayName: modelId,
          contextWindow: 128_000,
          supportsStreaming: false,
          supportsToolCalling: true,
          supportsParallelToolCalls: true,
          supportsJsonOutput: true,
          supportsMultimodalInput: false,
          supportsReasoningSummary: false
        },
        provider
      });

      expect(mocks.chatCreate.mock.calls.at(-1)?.[0].messages[0].content).toContain("[Chinese output compatibility]");
    }
  });

  it("routes kimi/moonshot model ids to the kimi compat shell", () => {
    expect(resolveModelCompat({ id: "kimi-k2-0711-preview", displayName: "Kimi K2" }).id).toBe("kimi");
    expect(resolveModelCompat({ id: "moonshot-v1-8k", displayName: "Moonshot v1" }).id).toBe("kimi");
    expect(resolveModelCompat({ id: "kimi-thinking-preview", displayName: "" }).id).toBe("kimi");
    expect(resolveModelCompat({ id: "my-custom-model", displayName: "" }).id).toBe("gpt");
  });

  it("routes custom model ids through a DeepSeek provider identity", () => {
    expect(resolveModelCompat(
      { id: "custom-v4-flash", displayName: "Reasoning model" },
      { id: "deepseek-provider", baseUrl: "https://api.deepseek.com/v1" }
    ).id).toBe("deepseek");
  });

  it("bypasses the optional completion audit only for Kimi K3", () => {
    expect(resolveModelCompat({ id: "kimi-k3", displayName: "Kimi K3" })
      .shouldBypassStandardCompletionAudit({ id: "kimi-k3", displayName: "Kimi K3" }))
      .toBe(true);
    expect(resolveModelCompat({ id: "kimi-k2-0711-preview", displayName: "Kimi K2" })
      .shouldBypassStandardCompletionAudit({ id: "kimi-k2-0711-preview", displayName: "Kimi K2" }))
      .toBe(false);
    expect(resolveModelCompat({ id: "gpt-5", displayName: "GPT-5" })
      .shouldBypassStandardCompletionAudit({ id: "gpt-5", displayName: "GPT-5" }))
      .toBe(false);
  });

  it("bypasses the optional completion audit for DeepSeek after deterministic validation", () => {
    const compat = resolveModelCompat({ id: "deepseek-v4-flash-0731", displayName: "DeepSeek V4 Flash" });
    expect(compat.shouldBypassStandardCompletionAudit({
      id: "deepseek-v4-flash-0731",
      displayName: "DeepSeek V4 Flash"
    })).toBe(true);
    expect(resolveModelCompat({ id: "deepseek-chat", displayName: "DeepSeek Chat" })
      .shouldBypassStandardCompletionAudit({ id: "deepseek-chat", displayName: "DeepSeek Chat" }))
      .toBe(false);
  });

  it("strips sampling params and raises the max_tokens floor for Kimi thinking models", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [],
      model: {
        id: "kimi-thinking-preview",
        providerId: provider.id,
        displayName: "Kimi Thinking",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: false,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: true,
        defaultTemperature: 0.6,
        defaultMaxOutputTokens: 4096
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // Thinking models reject sampling fields and response_format (HTTP 400);
    // the compat strips them before dispatch.
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
    expect(request).not.toHaveProperty("response_format");
    // Small output caps are raised to 8192 to avoid mid-stream truncation.
    expect(request.max_tokens).toBe(8192);
  });

  it("strips parallel_tool_calls and clamps temperature for non-thinking Kimi models", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [{
        name: "fs.read_directory",
        description: "List a directory.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        riskLevel: "low"
      }],
      model: {
        id: "kimi-k2-0711-preview",
        providerId: provider.id,
        displayName: "Kimi K2",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false,
        defaultTemperature: 1.6,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // Moonshot's schema has no parallel_tool_calls field; sending it (even
    // false) fails validation with "400 Invalid request parameters".
    expect(request).toHaveProperty("tools");
    expect(request).not.toHaveProperty("parallel_tool_calls");
    // Moonshot only accepts temperature within [0, 1]; out-of-range profile
    // defaults are clamped instead of failing the turn with HTTP 400.
    expect(request.temperature).toBe(1);
    expect(request.max_tokens).toBe(8192);
  });

  it("keeps in-range temperature for non-thinking Kimi models", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [],
      model: {
        id: "kimi-k2-0711-preview",
        providerId: provider.id,
        displayName: "Kimi K2",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false,
        defaultTemperature: 0.6,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(request.temperature).toBe(0.6);
  });

  it("caps the tools array at 50 for Kimi models", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };
    const manyTools = Array.from({ length: 55 }, (_, index) => ({
      name: `fs.tool_${index}`,
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      riskLevel: "low" as const
    }));

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: manyTools,
      model: {
        id: "kimi-k3",
        providerId: provider.id,
        displayName: "Kimi K3",
        contextWindow: 500_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // The gateway rejects more than 50 tools with "400 Invalid request
    // parameters" (code 11133); the compat truncates the tail instead.
    expect(Array.isArray(request.tools)).toBe(true);
    expect((request.tools as unknown[]).length).toBe(50);
  });

  it("caps the tools array at 50 for DeepSeek-compatible gateways", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const manyTools = Array.from({ length: 65 }, (_, index) => ({
      name: `fs.tool_${index}`,
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      riskLevel: "low" as const
    }));

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: manyTools,
      model: {
        id: "deepseek-v4-flash-0731",
        providerId: provider.id,
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1_000_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Array.isArray(request.tools)).toBe(true);
    expect((request.tools as unknown[]).length).toBe(50);
  });

  it("keeps normal sampling available when DeepSeek V4 thinking is disabled", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [],
      reasoningEffort: "none",
      model: {
        id: "deepseek-v4-flash-0731",
        providerId: provider.id,
        displayName: "DeepSeek V4 Flash",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: false,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 4096
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      temperature: 0.2,
      max_tokens: 8192,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" }
    });
    expect(request).not.toHaveProperty("reasoning_effort");
  });

  it("uses provider-enforced JSON when DeepSeek V4 recovers from native tools", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"继续执行","tool_calls":[],"end_turn":false,"goal_completed":false}' } }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return the next Agent decision.",
      transcript: [{ role: "user", content: "Continue the task." }],
      availableTools: [{
        name: "fs.read_directory",
        description: "List files",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        riskLevel: "low"
      }],
      forceTextToolProtocol: true,
      reasoningEffort: "high",
      model: {
        id: "deepseek-v4-flash-0731",
        providerId: provider.id,
        displayName: "DeepSeek V4 Flash",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 4096
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      thinking: { type: "disabled" },
      response_format: { type: "json_object" }
    });
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("reasoning_effort");
  });

  it("compacts oversized DeepSeek relay requests without dropping recent tool context", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const manyTools = Array.from({ length: 50 }, (_, index) => ({
      name: `fs.tool_${index}`,
      description: "Read a file ".repeat(20),
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      riskLevel: "low" as const
    }));

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: [
        "System rule. ".repeat(3_000),
        "## Previous Turn Context Capsules",
        "OLD_DUPLICATED_CAPSULE ".repeat(2_000),
        "## Follow-up Source Continuity",
        "SOURCE_LOCK_PAYLOAD ".repeat(500)
      ].join("\n\n"),
      transcript: [
        { role: "assistant", content: "Old skill output. ".repeat(3_000) },
        { role: "assistant", content: "Old progress. ".repeat(3_000) },
        { role: "user", content: "Continue the task." },
        { role: "assistant", content: "Recent progress." },
        { role: "tool", content: "Recent tool output", toolCallId: "call-1" }
      ],
      availableTools: manyTools,
      model: {
        id: "deepseek-v4-flash-0731",
        providerId: provider.id,
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1_000_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(120 * 1024);
    expect(messages.some((message) => message.content === "Recent tool output")).toBe(true);
    expect(messages.some((message) => String(message.content).includes("Earlier assistant progress omitted"))).toBe(true);
    expect(String(messages[0]?.content)).not.toContain("OLD_DUPLICATED_CAPSULE");
    expect(String(messages[0]?.content)).toContain("SOURCE_LOCK_PAYLOAD");
  });

  it("reports the final serialized request after applying provider limits", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const onRequestMeasured = vi.fn();
    const provider: ProviderDefinition = {
      id: "measured-gateway",
      type: "openai-compatible",
      apiKey: "secret",
      maxRequestBytes: 0,
      maxTools: 2
    };
    const model: ModelProfile = {
      id: "measured-model",
      providerId: provider.id,
      displayName: "Measured model",
      contextWindow: 500_000,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false,
      defaultTemperature: 0.2,
      defaultMaxOutputTokens: 8_192
    };
    const availableTools = Array.from({ length: 3 }, (_, index) => ({
      name: `fs.tool_${index}`,
      description: "Read data",
      inputSchema: { type: "object", properties: {} },
      riskLevel: "low" as const
    }));

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the task.",
      transcript: [{ role: "user", content: "Run it." }],
      availableTools,
      model,
      provider,
      onRequestMeasured
    });

    const finalRequest = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(finalRequest.tools).toHaveLength(2);
    expect(onRequestMeasured).toHaveBeenCalledWith({
      requestBytes: Buffer.byteLength(JSON.stringify(finalRequest), "utf8"),
      maxRequestBytes: 0,
      targetRequestBytes: 0,
      maxTools: 2,
      toolCount: 2
    });
  });

  it("repairs interrupted tool-call pairing and null assistant content for Kimi", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [
        { role: "user", content: "找文件" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "fs.read_directory", arguments: { path: "C:\\" } }] },
        // Streamed commentary recorded between the tool_calls message and its
        // result; the gateway rejects this interleaving (code 11133).
        { role: "assistant", content: "我来执行工具。" },
        { role: "tool", content: "fs.read_directory\nfile.txt", toolCallId: "call-1" }
      ],
      availableTools: [],
      model: {
        id: "kimi-k3",
        providerId: provider.id,
        displayName: "Kimi K3",
        contextWindow: 500_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    // [0] is the system message prepended by the provider.
    expect(messages[1]).toMatchObject({ role: "user", content: "找文件" });
    expect(messages[2].role).toBe("assistant");
    // null content is rejected by the gateway; it must become "".
    expect(messages[2].content).toBe("");
    expect(Array.isArray(messages[2].tool_calls)).toBe(true);
    // The tool result must immediately follow its tool_calls message.
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    // Commentary moves after the tool block.
    expect(messages[4]).toMatchObject({ role: "assistant", content: "我来执行工具。" });
  });

  it("coalesces consecutive Kimi assistant progress messages", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [
        { role: "assistant", content: "first progress" },
        { role: "assistant", content: "second progress" },
        { role: "assistant", content: "third progress" },
        { role: "user", content: "continue" },
        { role: "assistant", content: "final progress" }
      ],
      availableTools: [],
      model: {
        id: "kimi-k3",
        providerId: provider.id,
        displayName: "Kimi K3",
        contextWindow: 500_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["system", "assistant", "user", "assistant"]);
    expect(messages[1].content).toBe("first progress\n\nsecond progress\n\nthird progress");
  });

  it("synthesizes placeholder results for tool calls whose results were lost", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [
        { role: "user", content: "找文件" },
        // Turn was interrupted before the tool result was recorded.
        { role: "assistant", content: "", toolCalls: [{ id: "call-lost", name: "fs.read_directory", arguments: { path: "C:\\" } }] },
        { role: "user", content: "继续" }
      ],
      availableTools: [],
      model: {
        id: "kimi-k3",
        providerId: provider.id,
        displayName: "Kimi K3",
        contextWindow: 500_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    // An unfulfilled tool_calls message is rejected by the gateway; a
    // placeholder result is synthesized immediately after it.
    expect(messages[2].role).toBe("assistant");
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call-lost" });
    expect(String(messages[3].content)).toContain("unavailable");
    expect(messages[4]).toMatchObject({ role: "user", content: "继续" });
  });

  it("demotes orphan tool results to user messages for Kimi", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [
        { role: "user", content: "找文件" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "fs.read_directory", arguments: { path: "C:\\" } }] },
        { role: "tool", content: "本轮结果", toolCallId: "call-1" },
        // Result from an earlier interrupted turn; its tool_calls message is
        // gone, so as a bare tool message it fails gateway validation.
        { role: "tool", content: "上一轮的孤儿结果", toolCallId: "call-orphan" }
      ],
      availableTools: [],
      model: {
        id: "kimi-k3",
        providerId: provider.id,
        displayName: "Kimi K3",
        contextWindow: 500_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true,
        defaultTemperature: 0.2,
        defaultMaxOutputTokens: 8192
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    // The valid pair stays intact…
    expect(messages[2].role).toBe("assistant");
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    // …and the orphan is demoted to a user message that preserves its content.
    expect(messages[4].role).toBe("user");
    expect(String(messages[4].content)).toContain("call-orphan");
    expect(String(messages[4].content)).toContain("上一轮的孤儿结果");
  });

  it("enriches provider API errors with request diagnostics", async () => {
    const apiError = Object.assign(new Error("400 Invalid request parameters"), {
      status: 400,
      error: { code: 11133, param: null, type: "invalid_request_error" }
    });
    mocks.chatCreate.mockRejectedValue(apiError);
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await expect(
      new ProviderFactory().create(provider).runTurn({
        systemPrompt: "Complete the requested task.",
        transcript: [{ role: "user", content: "Hello" }],
        availableTools: [{
          name: "fs.read_directory",
          description: "List a directory.",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          riskLevel: "low"
        }],
        model: {
          id: "kimi-k3",
          providerId: provider.id,
          displayName: "Kimi K3",
          contextWindow: 500_000,
          supportsStreaming: false,
          supportsToolCalling: true,
          supportsParallelToolCalls: false,
          supportsJsonOutput: true,
          supportsMultimodalInput: true,
          supportsReasoningSummary: true,
          defaultTemperature: 0.2,
          defaultMaxOutputTokens: 8192
        },
        provider
      })
    ).rejects.toThrow(/400 Invalid request parameters \[provider-request model=kimi-k3 tools=1 messages=2\(system,user\) bytes=\d+ upstream\(code=11133 type=invalid_request_error\) dump=/);
  });

  it("reports provider request size as UTF-8 bytes", async () => {
    const apiError = Object.assign(new Error("500 status code (no body)"), { status: 500 });
    mocks.chatCreate.mockRejectedValue(apiError);
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };

    await expect(
      new ProviderFactory().create(provider).runTurn({
        systemPrompt: "处理中文上下文。",
        transcript: [{ role: "user", content: "总结刚才的代码。" }],
        availableTools: [],
        model: {
          id: "deepseek-v4-flash-0731",
          providerId: provider.id,
          displayName: "DeepSeek V4 Flash",
          contextWindow: 500_000,
          supportsStreaming: false,
          supportsToolCalling: true,
          supportsParallelToolCalls: false,
          supportsJsonOutput: true,
          supportsMultimodalInput: false,
          supportsReasoningSummary: false,
          defaultTemperature: 0.2,
          defaultMaxOutputTokens: 8192
        },
        provider
      })
    ).rejects.toThrow(apiError);

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const expectedBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    expect(apiError.message).toContain(`bytes=${expectedBytes}`);
    expect(expectedBytes).toBeGreaterThan(JSON.stringify(request).length);
  });

  it("keeps Kimi k2 non-envelope stream content visible", () => {
    const compat = resolveModelCompat({ id: "kimi-k2-0711-preview", displayName: "Kimi K2" });
    // Native-tool-call mode: content is natural language / code, not a decision
    // envelope, so buffers starting with `{` must stream through verbatim.
    expect(compat.extractVisibleStreamText('{"key": "value"}')).toBe('{"key": "value"}');
    expect(compat.extractVisibleStreamText("```json\n{\"a\":1}\n```")).toBe("```json\n{\"a\":1}\n```");
    // A real decision envelope still routes through the GPT envelope extractor.
    const envelope = '{"assistant_message":"你好","tool_calls":[],"end_turn":true}';
    expect(compat.extractVisibleStreamText(envelope)).toBe("你好");
  });

  it("hides complete and partial internal tool markers from DeepSeek stream text", () => {
    const compat = resolveModelCompat({ id: "deepseek-chat", displayName: "DeepSeek Chat" });

    expect(compat.extractVisibleStreamText("read complete [Exec")).toBe("read complete");
    expect(compat.extractVisibleStreamText("read complete [Executed tools: fs.read_file]")).toBe("read complete");
  });

  it("keeps Chinese replies stable for Kimi after English tool context", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "moonshot-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [
        { role: "user", content: "请继续处理刚才的问题" },
        { role: "tool", content: "English tool output" },
        { role: "user", content: "continue" }
      ],
      availableTools: [],
      model: {
        id: "kimi-k2-0711-preview",
        providerId: provider.id,
        displayName: "Kimi K2",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(mocks.chatCreate.mock.calls.at(-1)?.[0].messages[0].content).toContain("[Chinese output compatibility]");
  });

  it("routes hunyuan model ids to the hunyuan compat shell", () => {
    expect(resolveModelCompat({ id: "hy3", displayName: "hy3" }).id).toBe("hunyuan");
    expect(resolveModelCompat({ id: "hunyuan-turbos", displayName: "Hunyuan TurboS" }).id).toBe("hunyuan");
    expect(resolveModelCompat({ id: "hunyuan-lite", displayName: "" }).id).toBe("hunyuan");
    expect(resolveModelCompat({ id: "custom-01", displayName: "混元3" }).id).toBe("hunyuan");
    expect(resolveModelCompat({ id: "my-custom-model", displayName: "" }).id).toBe("gpt");
  });

  it("keeps Chinese replies stable for Hunyuan after English tool context", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "codespaces-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [
        { role: "user", content: "请继续处理刚才的问题" },
        { role: "tool", content: "English tool output" },
        { role: "user", content: "continue" }
      ],
      availableTools: [],
      model: {
        id: "hy3",
        providerId: provider.id,
        displayName: "hy3",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(mocks.chatCreate.mock.calls.at(-1)?.[0].messages[0].content).toContain("[Chinese output compatibility]");
  });

  it("does not force Chinese on Hunyuan when the user asks for English", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"Done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "codespaces-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "用英文回答：这个文件是做什么的？" }],
      availableTools: [],
      model: {
        id: "hy3",
        providerId: provider.id,
        displayName: "hy3",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(mocks.chatCreate.mock.calls.at(-1)?.[0].messages[0].content).not.toContain("[Chinese output compatibility]");
  });

  it("routes agnes model ids to the agnes compat shell", () => {
    expect(resolveModelCompat({ id: "agnes-2.0-flash", displayName: "Agnes 2.0 Flash" }).id).toBe("agnes");
    expect(resolveModelCompat({ id: "agnes-image-2.1-flash", displayName: "" }).id).toBe("agnes");
    expect(resolveModelCompat({ id: "agnes-video-v2.0", displayName: "" }).id).toBe("agnes");
  });

  it("injects chat_template_kwargs thinking and raises max_tokens for Agnes when effort is set", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "agnes-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [],
      reasoningEffort: "high",
      model: {
        id: "agnes-2.0-flash",
        providerId: provider.id,
        displayName: "Agnes 2.0 Flash",
        contextWindow: 256_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true,
        defaultMaxOutputTokens: 4096
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // Thinking mode is enabled via the Agnes chat_template_kwargs extension.
    expect(request.chat_template_kwargs).toEqual({ enable_thinking: true });
    // Small output caps are raised to 8192 to avoid mid-stream truncation.
    expect(request.max_tokens).toBe(8192);
  });

  it("leaves Agnes thinking mode off when no reasoning effort is set", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "agnes-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [],
      model: {
        id: "agnes-2.0-flash",
        providerId: provider.id,
        displayName: "Agnes 2.0 Flash",
        contextWindow: 256_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(request).not.toHaveProperty("chat_template_kwargs");
  });

  it("routes Agnes image generation without a top-level response_format", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      created: 1_755_000_000,
      model: "agnes-image-2.1-flash",
      data: [{ b64_json: Buffer.from("agnes-image").toString("base64") }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "agnes-gateway", type: "openai-compatible", baseUrl: "https://apihub.agnes-ai.com/v1", apiKey: "secret"
    });
    const result = await adapter.generateImage!({
      model: {
        id: "agnes-image-2.1-flash", providerId: "agnes-gateway", displayName: "Agnes Image 2.1", contextWindow: 128_000,
        supportsStreaming: false, supportsToolCalling: false, supportsParallelToolCalls: false, supportsJsonOutput: false,
        supportsMultimodalInput: true, supportsReasoningSummary: false
      },
      prompt: "a panda riding a bicycle"
    });

    expect(fetchMock).toHaveBeenCalledWith("https://apihub.agnes-ai.com/v1/images/generations", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    // The Agnes gateway rejects a top-level response_format (HTTP 400); base64
    // output is requested via return_base64 and size uses the tier value.
    expect(body).toEqual({ model: "agnes-image-2.1-flash", prompt: "a panda riding a bicycle", size: "1K", return_base64: true });
    expect(body).not.toHaveProperty("response_format");
    expect(result).toMatchObject({ protocol: "agnes-images", responseModel: "agnes-image-2.1-flash" });
  });

  it("creates, polls and downloads an Agnes async video generation result", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/videos") ) {
        return new Response(JSON.stringify({ id: "task_123", task_id: "task_123", video_id: "vid_123", status: "queued" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.endsWith("/videos/task_123")) {
        return new Response(
          JSON.stringify({ status: "completed", progress: 100, metadata: { url: "https://cdn.agnes-ai.com/video.mp4" } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "https://cdn.agnes-ai.com/video.mp4") {
        return new Response(bytes, { status: 200, headers: { "Content-Type": "video/mp4" } });
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
      const adapter = new ProviderFactory().create({
        id: "agnes-gateway", type: "openai-compatible", baseUrl: "https://apihub.agnes-ai.com/v1", apiKey: "secret"
      });
      const result = await adapter.generateVideo!({
        model: {
          id: "agnes-video-v2.0", providerId: "agnes-gateway", displayName: "Agnes Video v2.0", contextWindow: 128_000,
          supportsStreaming: false, supportsToolCalling: false, supportsParallelToolCalls: false, supportsJsonOutput: false,
          supportsMultimodalInput: false, supportsVideoGeneration: true, role: "video", supportsReasoningSummary: false
        },
        prompt: "waves crashing on a beach"
      });

      expect(Array.from(result.data)).toEqual(Array.from(bytes));
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://apihub.agnes-ai.com/v1/videos");
      const createInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      // Documented standard settings: 121 frames @ 24fps with the 8n+1 rule.
      expect(JSON.parse(String(createInit.body))).toEqual({
        model: "agnes-video-v2.0",
        prompt: "waves crashing on a beach",
        width: 1152,
        height: 768,
        num_frames: 121,
        frame_rate: 24
      });
      // Polls the legacy GET /v1/videos/{task_id} endpoint and resolves the
      // final MP4 URL from the metadata.url branch.
      expect(fetchMock.mock.calls[1]?.[0]).toBe("https://apihub.agnes-ai.com/v1/videos/task_123");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("routes gemini/imagen model ids to the gemini compat shell", () => {
    expect(resolveModelCompat({ id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }).id).toBe("gemini");
    expect(resolveModelCompat({ id: "gemini-2.5-flash-image", displayName: "" }).id).toBe("gemini");
    expect(resolveModelCompat({ id: "imagen-3.0-generate-002", displayName: "" }).id).toBe("gemini");
  });

  it("passes reasoning_effort through for Gemini and raises the max_tokens floor", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"已完成","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "google-gateway", type: "openai-compatible", apiKey: "secret" };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Complete the requested task.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [],
      reasoningEffort: "high",
      model: {
        id: "gemini-2.5-flash",
        providerId: provider.id,
        displayName: "Gemini 2.5 Flash",
        contextWindow: 1_000_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: true,
        supportsReasoningSummary: true,
        defaultMaxOutputTokens: 4096
      },
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // The GPT baseline only injects reasoning_effort for GPT reasoning models;
    // the Gemini shell must pass it through explicitly.
    expect(request.reasoning_effort).toBe("high");
    // Small output caps are raised to 8192 to avoid mid-stream truncation.
    expect(request.max_tokens).toBe(8192);
  });

  it("maps xhigh to high and keeps none for Gemini thinking control", () => {
    const compat = resolveModelCompat({ id: "gemini-2.5-flash", displayName: "" });
    const ctx = (reasoningEffort?: string) => ({
      model: { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
      input: { reasoningEffort, transcript: [{ role: "user", content: "hi" }] }
    });
    const base = { model: "gemini-2.5-flash", messages: [] };
    expect(compat.normalizeRequestParams(ctx("xhigh") as never, { ...base })).toMatchObject({ reasoning_effort: "high" });
    expect(compat.normalizeRequestParams(ctx("none") as never, { ...base })).toMatchObject({ reasoning_effort: "none" });
    expect(compat.normalizeRequestParams(ctx("minimal") as never, { ...base })).toMatchObject({ reasoning_effort: "minimal" });
    expect(compat.normalizeRequestParams(ctx(undefined) as never, { ...base })).not.toHaveProperty("reasoning_effort");
  });

  it("generates Gemini images via the documented images/generations parameter set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      created: 1_755_000_000,
      model: "gemini-2.5-flash-image",
      data: [{ b64_json: Buffer.from("gemini-image").toString("base64") }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "google-gateway", type: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "secret"
    });
    const result = await adapter.generateImage!({
      model: {
        id: "gemini-2.5-flash-image", providerId: "google-gateway", displayName: "Gemini 2.5 Flash Image", contextWindow: 128_000,
        supportsStreaming: false, supportsToolCalling: false, supportsParallelToolCalls: false, supportsJsonOutput: false,
        supportsMultimodalInput: true, supportsReasoningSummary: false
      },
      prompt: "a lighthouse at dawn"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/images/generations",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    // Documented parameter set only: prompt/model/n/response_format — no size.
    expect(body).toEqual({ model: "gemini-2.5-flash-image", prompt: "a lighthouse at dawn", n: 1, response_format: "b64_json" });
    expect(result).toMatchObject({ protocol: "gemini-images", responseModel: "gemini-2.5-flash-image" });
    expect(Buffer.from(result.data).toString()).toBe("gemini-image");
  });

  it("fails loudly when a chat-only Gemini model is used for image generation", async () => {
    const fetchMock = vi.fn();
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "google-gateway", type: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "secret"
    });

    await expect(adapter.generateImage!({
      model: {
        id: "gemini-2.5-pro", providerId: "google-gateway", displayName: "Gemini 2.5 Pro", contextWindow: 1_000_000,
        supportsStreaming: true, supportsToolCalling: true, supportsParallelToolCalls: true, supportsJsonOutput: true,
        supportsMultimodalInput: true, supportsReasoningSummary: true
      },
      prompt: "a cat"
    })).rejects.toThrow("不是图片生成模型");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("reasoning <think> block compatibility", () => {
    it("strips think blocks before parsing decisions", () => {
      // Reasoning-style models wrap or precede the envelope with a think block.
      const decision = parseDecisionFromText(
        '<think>The user wants an image. I should call the tool.</think>{"assistant_message":"好的，正在生成","tool_calls":[],"end_turn":true,"goal_completed":true}'
      );
      expect(decision.assistantMessage).toBe("好的，正在生成");
      expect(decision.isStructured).toBe(true);

      // Plain-text reply preceded by reasoning.
      const plain = parseDecisionFromText("<think>hmm</think>这是正文回复。");
      expect(plain.assistantMessage).toBe("这是正文回复。");

      // Only reasoning, no reply (token limit hit): no leaked think markup.
      const onlyThink = parseDecisionFromText("<think>The user is asking me to generate a picture...");
      expect(onlyThink.assistantMessage).not.toContain("<think>");
      expect(onlyThink.assistantMessage).not.toContain("generate a picture");
    });

    it("surfaces think blocks in the visible stream draft", () => {
      // Thinking in progress: the partial reasoning streams into the draft.
      expect(extractVisibleStreamText("<think>Let me think")).toBe("Let me think");
      // Closed think block followed by plain reply: reasoning + reply stream.
      expect(extractVisibleStreamText("<think>done</think>你好，这是回复")).toBe("done你好，这是回复");
      // Closed think block followed by a decision envelope: reasoning + decoded message.
      expect(extractVisibleStreamText('<think>done</think>{"assistant_message":"好","tool_calls":[]}')).toBe("done\n\n好");
      // No think content: untouched.
      expect(extractVisibleStreamText("普通正文")).toBe("普通正文");
    });

    it("surfaces think blocks in pass-through stream text in compat shells", () => {
      for (const id of ["deepseek-chat", "kimi-k2-0711-preview", "agnes-2.0-flash"]) {
        const compat = resolveModelCompat({ id, displayName: "" });
        // Pass-through branch (no envelope) shows the think process, tags hidden.
        expect(compat.extractVisibleStreamText("<think>reasoning</think>正文内容")).toBe("reasoning正文内容");
        expect(compat.extractVisibleStreamText("<think>still thinking")).toBe("still thinking");
      }
    });

    it("does not treat nested assistant_message JSON as a decision envelope", () => {
      const compat = resolveModelCompat({ id: "deepseek-chat", displayName: "" });
      const content = '{"metadata":{"assistant_message":"a data field"},"value":1}';
      expect(compat.extractVisibleStreamText(content)).toBe(content);
    });

    it("surfaceThinkBlocksInStream hides tags and holds back partial tag fragments", () => {
      // Partial close tag must not leak raw markup into the draft.
      expect(surfaceThinkBlocksInStream("<think>reason</thi")).toBe("reason");
      // A fragment that can still grow into a think tag is held back.
      expect(surfaceThinkBlocksInStream("abc<thi")).toBe("abc");
      expect(surfaceThinkBlocksInStream("abc<")).toBe("abc");
      // Unrelated markup passes through untouched.
      expect(surfaceThinkBlocksInStream("abc<div")).toBe("abc<div");
      // Multiple blocks: both bodies surface with the reply in between.
      expect(surfaceThinkBlocksInStream("<think>a</think>mid<think>b</think>tail")).toBe("amidbtail");
      // Hash-suffixed relay variants behave the same.
      expect(surfaceThinkBlocksInStream("<think:6124c78e>推理</think:6124c78e>正文")).toBe("推理正文");
    });

    it("hunyuan releases the visible stream after hash-suffixed think blocks", () => {
      const compat = resolveModelCompat({ id: "hy3", displayName: "hy3" });
      // Regression: <think:hash> never matched the literal <think> pattern, so
      // the envelope extractor suppressed the buffer forever — the turn looked
      // stuck in "thinking" and no reply ever appeared.
      expect(compat.id).toBe("hunyuan");
      expect(compat.extractVisibleStreamText("<think:6124c78e>正在推理")).toBe("正在推理");
      expect(compat.extractVisibleStreamText('<think:6124c78e>推理完毕</think:6124c78e>{"assistant_message":"查到了","tool_calls":[]}')).toBe("推理完毕\n\n查到了");
      const decision = parseDecisionFromText(
        '<think:6124c78e>The user asked about a large file.</think:6124c78e>{"assistant_message":"这个文件是 NVIDIA 的着色器缓存。","tool_calls":[],"end_turn":true,"goal_completed":true}'
      );
      expect(decision.assistantMessage).toBe("这个文件是 NVIDIA 的着色器缓存。");
      expect(decision.isStructured).toBe(true);
    });

    it("keeps reasoning-only DeepSeek replies private and retryable", () => {
      const compat = resolveModelCompat({ id: "deepseek-v4-flash", displayName: "" });
      // The model ended the turn with an empty assistant_message and no tool
      // calls while the whole reply sat in reasoning_content. Do not expose
      // that private reasoning as a final answer.
      const decision = compat.normalizeDecision(
        {
          toolCalls: [],
          endTurn: true,
          goalCompleted: false,
          isStructured: true,
          reasoningSummary: "### T1: 搭建页面骨架\n\n验收标准：页面可打开运行。"
        },
        {} as never
      );
      expect(decision.assistantMessage).toBeUndefined();
      expect(decision.endTurn).toBe(false);
      expect(decision.goalCompleted).toBe(false);
      expect(decision.isStructured).toBe(false);
    });

    it("recovers DSML tool calls from reasoning_content after visible preamble text", () => {
      const compat = resolveModelCompat({ id: "deepseek-v4-flash", displayName: "" });
      const decision = compat.normalizeDecision(
        {
          assistantMessage: "我先读取目标文件。",
          toolCalls: [],
          endTurn: true,
          goalCompleted: true,
          isStructured: true,
          reasoningSummary: [
            "<｜DSML｜tool_calls>",
            '<｜DSML｜invoke name="fs.read_file">',
            '<｜DSML｜parameter name="path" string="true">src/app.ts</｜DSML｜parameter>',
            "</｜DSML｜invoke>",
            "</｜DSML｜tool_calls>"
          ].join("\n")
        },
        { input: { availableTools: [{ name: "fs.read_file", description: "Read a file.", inputSchema: { type: "object" }, riskLevel: "low" }] } } as never
      );

      expect(decision).toMatchObject({
        assistantMessage: "我先读取目标文件。",
        toolCalls: [{ name: "fs.read_file", arguments: { path: "src/app.ts" } }],
        endTurn: false,
        goalCompleted: false
      });
    });

    it("deepseek compat recovers DSML tool calls misplaced in reasoning_content", () => {
      const compat = resolveModelCompat({ id: "deepseek-v4-flash", displayName: "" });
      const tool = {
        name: "fs.read_file",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        riskLevel: "low" as const
      };
      const decision = compat.normalizeDecision(
        {
          assistantMessage: undefined,
          toolCalls: [],
          endTurn: true,
          goalCompleted: false,
          isStructured: true,
          reasoningSummary: [
            "<｜DSML｜tool_calls>",
            '<｜DSML｜invoke name="fs.read_file">',
            '<｜DSML｜parameter name="path" string="true">src/app.ts</｜DSML｜parameter>',
            "</｜DSML｜invoke>",
            "</｜DSML｜tool_calls>"
          ].join("\n")
        },
        { input: { availableTools: [tool] } } as never
      );

      expect(decision).toMatchObject({
        toolCalls: [{ name: "fs.read_file", arguments: { path: "src/app.ts" } }],
        assistantMessage: undefined,
        endTurn: false,
        goalCompleted: false,
        isStructured: true
      });
    });

    it("deepseek compat converts a truly empty end-of-turn into a retryable decision", () => {
      const compat = resolveModelCompat({ id: "deepseek-v4-flash", displayName: "" });
      const decision = compat.normalizeDecision(
        {
          assistantMessage: "   ",
          toolCalls: [],
          endTurn: true,
          goalCompleted: true,
          isStructured: true
        },
        {} as never
      );
      // No visible text and no reasoning: keep the turn open and mark the
      // decision unstructured so the runtime re-samples with a correction.
      expect(decision.assistantMessage).toBeUndefined();
      expect(decision.endTurn).toBe(false);
      expect(decision.goalCompleted).toBe(false);
      expect(decision.isStructured).toBe(false);
    });

    it("deepseek compat promotes a terminal substantive reply to completed", () => {
      const compat = resolveModelCompat({ id: "deepseek-v4-flash", displayName: "" });
      const withMessage = compat.normalizeDecision(
        {
          assistantMessage: "正常回复",
          toolCalls: [],
          endTurn: true,
          goalCompleted: false,
          isStructured: true,
          reasoningSummary: "一些推理"
        },
        {} as never
      );
      expect(withMessage.assistantMessage).toBe("正常回复");
      expect(withMessage.goalCompleted).toBe(true);

      const withToolCalls = compat.normalizeDecision(
        {
          toolCalls: [{ id: "call-1", name: "fs.read_directory", arguments: { path: "." } }],
          endTurn: false,
          goalCompleted: false,
          isStructured: true,
          reasoningSummary: "一些推理"
        },
        {} as never
      );
      expect(withToolCalls.assistantMessage).toBeUndefined();
      expect(withToolCalls.toolCalls).toHaveLength(1);
    });

    it("other shells do not inherit the deepseek empty-reply recovery", () => {
      const compat = resolveModelCompat({ id: "gpt-5.2", displayName: "" });
      const empty = {
        toolCalls: [] as never[],
        endTurn: true,
        goalCompleted: false,
        isStructured: true,
        reasoningSummary: "推理内容"
      };
      expect(compat.normalizeDecision(empty, {} as never)).toEqual(empty);
    });

    it("stripThinkBlocks handles closed and unterminated blocks", () => {
      expect(stripThinkBlocks("<think>a</think>tail")).toBe("tail");
      expect(stripThinkBlocks("pre<think>a</think>tail")).toBe("pretail");
      expect(stripThinkBlocks("<think>unterminated")).toBe("");
      expect(stripThinkBlocks("no think here")).toBe("no think here");
      expect(stripThinkBlocksFromStream("<think>in progress")).toBe("");
      expect(stripThinkBlocksFromStream("visible<think>in progress")).toBe("visible");
    });

    it("stripThinkBlocks handles hash-suffixed think tags (Hunyuan relays)", () => {
      // Hunyuan gateways wrap reasoning in <think:hash>…</think:hash>; the
      // literal <think> pattern never closes those, which leaked tags into
      // output and suppressed the visible stream indefinitely.
      expect(stripThinkBlocks("<think:6124c78e>reasoning</think:6124c78e>tail")).toBe("tail");
      expect(stripThinkBlocks("pre<think:6124c78e>reasoning</think:6124c78e>tail")).toBe("pretail");
      expect(stripThinkBlocks("<think:6124c78e>unterminated")).toBe("");
      expect(stripThinkBlocks("<think:6124c78e>a</think:6124c78e>{\"assistant_message\":\"好\"}")).toBe("{\"assistant_message\":\"好\"}");
      // while the block is open, nothing is visible; once closed, the remainder surfaces
      expect(stripThinkBlocksFromStream("<think:6124c78e>in progress")).toBe("");
      expect(stripThinkBlocksFromStream("<think:6124c78e>done</think:6124c78e>你好")).toBe("你好");
      expect(extractVisibleStreamText("<think:6124c78e>still thinking")).toBe("still thinking");
      expect(extractVisibleStreamText("<think:6124c78e>done</think:6124c78e>你好，这是回复")).toBe("done你好，这是回复");
      expect(extractVisibleStreamText('<think:6124c78e>done</think:6124c78e>{"assistant_message":"好","tool_calls":[]}')).toBe("done\n\n好");
      // lookalike tags must not be treated as think blocks
      expect(stripThinkBlocks("<thinking>not a think block</thinking>")).toBe("<thinking>not a think block</thinking>");
    });
  });

  it("does not override an explicit non-Chinese language request for Qwen", async () => {
    mocks.chatCreate.mockResolvedValue({ choices: [{ message: { content: "OK" } }] });
    const provider: ProviderDefinition = { id: "qwen-gateway", type: "openai-compatible", apiKey: "secret" };
    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Answer the user.",
      transcript: [{ role: "user", content: "请用英文回答" }],
      availableTools: [],
      model: {
        id: "qwen-plus",
        providerId: provider.id,
        displayName: "Qwen Plus",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: false,
        supportsParallelToolCalls: false,
        supportsJsonOutput: false,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(mocks.chatCreate.mock.calls.at(-1)?.[0].messages[0].content).not.toContain("[Chinese output compatibility]");
  });

  it("normalizes Qwen's path/content apply_patch calls using a verified file path", async () => {
    const verifiedPath = "E:\\repo\\src\\Product.Domain\\Domain\\Service\\Common\\TokenService.cs";
    const guessedPath = "E:\\repo\\src\\Product.Domain\\Domain\\Domain\\Service\\Common\\TokenService.cs";
    mocks.chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "qwen-write",
            type: "function",
            function: {
              name: nativeToolName("apply_patch"),
              arguments: JSON.stringify({ path: guessedPath, content: "updated source" })
            }
          }]
        }
      }]
    });
    const provider: ProviderDefinition = { id: "qwen-gateway", type: "openai-compatible", apiKey: "secret" };
    const availableTools = [
      {
        name: "apply_patch",
        description: "Apply a patch.",
        inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
        riskLevel: "medium" as const
      },
      {
        name: "fs.write_file",
        description: "Write a file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"]
        },
        riskLevel: "medium" as const
      }
    ];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the tools.",
      transcript: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "verified-read", name: "fs.read_file", arguments: { path: verifiedPath } }]
        },
        {
          role: "tool",
          content: "fs.read_file\nsource",
          toolCallId: "verified-read",
          toolResultOk: true
        },
        { role: "user", content: "Update it." }
      ],
      availableTools,
      model: {
        id: "qwen-plus",
        providerId: provider.id,
        displayName: "Qwen Plus",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(mocks.chatCreate.mock.calls[0]?.[0].messages[0].content).toContain("[Qwen file-tool compatibility]");
    expect(decision.toolCalls).toEqual([{
      id: "qwen-write",
      name: "fs.write_file",
      arguments: { path: verifiedPath, content: "updated source" }
    }]);
  });

  it("corrects an existing-file path inside a Qwen update patch", async () => {
    const verifiedPath = "src/Product.Domain/Domain/Service/Common/TokenService.cs";
    const guessedPath = "src/Product.Domain/Domain/Domain/Service/Common/TokenService.cs";
    mocks.chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "qwen-patch",
            type: "function",
            function: {
              name: nativeToolName("apply_patch"),
              arguments: JSON.stringify({
                patch: `*** Begin Patch\n*** Update File: ${guessedPath}\n@@\n-old\n+new\n*** End Patch`
              })
            }
          }]
        }
      }]
    });
    const provider: ProviderDefinition = { id: "qwen-gateway", type: "openai-compatible", apiKey: "secret" };
    const patchTool = {
      name: "apply_patch",
      description: "Apply a patch.",
      inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
      riskLevel: "medium" as const
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the tools.",
      transcript: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "verified-read", name: "fs.read_file", arguments: { path: verifiedPath } }]
        },
        {
          role: "tool",
          content: "fs.read_file\nsource",
          toolCallId: "verified-read",
          toolResultOk: true
        }
      ],
      availableTools: [patchTool],
      model: {
        id: "qwen-plus",
        providerId: provider.id,
        displayName: "Qwen Plus",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(decision.toolCalls[0]).toMatchObject({
      id: "qwen-patch",
      name: "apply_patch"
    });
    expect(decision.toolCalls[0]?.arguments.patch).toContain(`*** Update File: ${verifiedPath}`);
    expect(decision.toolCalls[0]?.arguments.patch).not.toContain(guessedPath);
  });

  it("corrects Qwen file paths in streamed native calls", async () => {
    const verifiedPath = "E:\\repo\\src\\Product.Domain\\Domain\\Service\\Common\\TokenService.cs";
    const guessedPath = "E:\\repo\\src\\Product\\Domain\\Service\\Common\\TokenService.cs";
    async function* streamToolCall() {
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "qwen-read",
              function: {
                name: nativeToolName("fs.read_file"),
                arguments: JSON.stringify({ path: guessedPath })
              }
            }]
          }
        }]
      };
      yield { choices: [{ finish_reason: "tool_calls", delta: {} }] };
    }
    mocks.chatCreate.mockResolvedValue(streamToolCall());
    const provider: ProviderDefinition = { id: "qwen-gateway", type: "openai-compatible", apiKey: "secret" };
    const fileTool = {
      name: "fs.read_file",
      description: "Read a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      riskLevel: "low" as const
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the tools.",
      transcript: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "verified-read", name: "fs.read_file", arguments: { path: verifiedPath } }]
        },
        {
          role: "tool",
          content: "fs.read_file\nsource",
          toolCallId: "verified-read",
          toolResultOk: true
        }
      ],
      availableTools: [fileTool],
      model: {
        id: "qwen-plus",
        providerId: provider.id,
        displayName: "Qwen Plus",
        contextWindow: 128_000,
        supportsStreaming: true,
        supportsToolCalling: true,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider,
      stream: true
    });

    expect(decision.toolCalls).toMatchObject([{
      id: "qwen-read",
      name: "fs.read_file",
      arguments: { path: verifiedPath }
    }]);
  });

  it("does not redirect a distinct Qwen path that only shares a file name", async () => {
    const verifiedPath = "E:\\repo\\src\\v1\\config.ts";
    const requestedPath = "E:\\repo\\src\\v2\\config.ts";
    mocks.chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "qwen-read-v2",
            type: "function",
            function: {
              name: nativeToolName("fs.read_file"),
              arguments: JSON.stringify({ path: requestedPath })
            }
          }]
        }
      }]
    });
    const provider: ProviderDefinition = { id: "qwen-gateway", type: "openai-compatible", apiKey: "secret" };
    const fileTool = {
      name: "fs.read_file",
      description: "Read a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      riskLevel: "low" as const
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the tools.",
      transcript: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "verified-v1", name: "fs.read_file", arguments: { path: verifiedPath } }]
        },
        {
          role: "tool",
          content: "fs.read_file\nsource",
          toolCallId: "verified-v1",
          toolResultOk: true
        }
      ],
      availableTools: [fileTool],
      model: {
        id: "qwen-plus",
        providerId: provider.id,
        displayName: "Qwen Plus",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(decision.toolCalls).toMatchObject([{
      id: "qwen-read-v2",
      name: "fs.read_file",
      arguments: { path: requestedPath }
    }]);
  });

  it("leaves GPT file tool arguments unchanged", async () => {
    const guessedPath = "E:\\repo\\src\\Product.Domain\\Domain\\Domain\\Service\\Common\\TokenService.cs";
    mocks.chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "gpt-write",
            type: "function",
            function: {
              name: nativeToolName("apply_patch"),
              arguments: JSON.stringify({ path: guessedPath, content: "updated source" })
            }
          }]
        }
      }]
    });
    const provider: ProviderDefinition = { id: "gpt-gateway", type: "openai-compatible", apiKey: "secret" };
    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the tools.",
      transcript: [{ role: "user", content: "Update it." }],
      availableTools: [{
        name: "apply_patch",
        description: "Apply a patch.",
        inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] },
        riskLevel: "medium"
      }],
      model: {
        id: "gpt-5.6-terra",
        providerId: provider.id,
        displayName: "GPT 5.6 Terra",
        contextWindow: 128_000,
        supportsStreaming: false,
        supportsToolCalling: true,
        supportsParallelToolCalls: false,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      provider
    });

    expect(mocks.chatCreate.mock.calls[0]?.[0].messages[0].content).not.toContain("[Qwen file-tool compatibility]");
    expect(decision.toolCalls).toEqual([{
      id: "gpt-write",
      name: "apply_patch",
      arguments: { path: guessedPath, content: "updated source" }
    }]);
  });

  it("sends the selected reasoning_effort for GPT-5.4+ Chat Completions only", async () => {
    mocks.chatCreate.mockResolvedValue({ choices: [{ message: { content: "Done." }, finish_reason: "stop" }] });
    const provider: ProviderDefinition = { id: "gateway", type: "openai-compatible", apiKey: "secret" };
    const baseModel: ModelProfile = {
      id: "gpt-5.6-terra", providerId: provider.id, displayName: "GPT 5.6 Terra", contextWindow: 500_000,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
      supportsJsonOutput: true, supportsMultimodalInput: true, supportsReasoningSummary: true, role: "reasoning"
    };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Answer.", transcript: [{ role: "user", content: "Hello" }], availableTools: [],
      model: baseModel, provider, reasoningEffort: "xhigh", stream: false
    });
    expect(mocks.chatCreate.mock.calls.at(-1)?.[0]).toMatchObject({ reasoning_effort: "xhigh" });

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Answer.", transcript: [{ role: "user", content: "Hello" }], availableTools: [],
      model: { ...baseModel, id: "gpt-4.1-mini" }, provider, reasoningEffort: "xhigh", stream: false
    });
    expect(mocks.chatCreate.mock.calls.at(-1)?.[0]).not.toHaveProperty("reasoning_effort");
  });

  it("uses Grok's plain-text completion-audit compatibility protocol", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "APPROVED" } }]
    });
    const provider: ProviderDefinition = { id: "grok-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "grok-4.5-latest", providerId: "grok-gateway", displayName: "Grok 4.5 Latest", contextWindow: 128_000,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
      supportsJsonOutput: true, supportsMultimodalInput: false, supportsReasoningSummary: true
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "You are a completion auditor for a desktop agent. Return a JSON decision.",
      transcript: [{ role: "user", content: "Audit the candidate." }],
      availableTools: [],
      model,
      provider,
      stream: false
    });

    const request = mocks.chatCreate.mock.calls[0]?.[0];
    expect(request).not.toHaveProperty("response_format");
    expect(request.messages[0].content).toContain("Grok completion-audit compatibility");
    expect(decision).toMatchObject({
      assistantMessage: "APPROVED",
      toolCalls: [],
      endTurn: true,
      goalCompleted: true,
      isStructured: true
    });
  });

  it("falls back to deterministic completion validation when Grok omits an audit verdict", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "I reviewed the candidate." } }]
    });
    const provider: ProviderDefinition = { id: "grok-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "grok-4.5-latest", providerId: "grok-gateway", displayName: "Grok 4.5 Latest", contextWindow: 128_000,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
      supportsJsonOutput: true, supportsMultimodalInput: false, supportsReasoningSummary: true
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "You are a completion auditor for a desktop agent. Return a JSON decision.",
      transcript: [{ role: "user", content: "Audit the candidate." }],
      availableTools: [],
      model,
      provider,
      stream: false
    });

    expect(decision).toMatchObject({
      assistantMessage: "APPROVED",
      endTurn: true,
      goalCompleted: true,
      isStructured: true
    });
    expect(decision.reasoningSummary).toContain("deterministic completion validation");
  });

  it("uses the same Grok completion-audit compatibility when the gateway speaks Anthropic", async () => {
    mocks.anthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I reviewed the candidate." }]
    });
    const provider: ProviderDefinition = { id: "grok-anthropic-gateway", type: "anthropic", apiKey: "secret" };
    const model: ModelProfile = {
      id: "grok-4.5-latest", providerId: provider.id, displayName: "Grok 4.5 Latest", contextWindow: 128_000,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
      supportsJsonOutput: true, supportsMultimodalInput: false, supportsReasoningSummary: true
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "You are a completion auditor for a desktop agent. Return a JSON decision.",
      transcript: [{ role: "user", content: "Audit the candidate." }],
      availableTools: [],
      model,
      provider,
      stream: false
    });

    expect(mocks.anthropicCreate.mock.calls[0]?.[0].system).toContain("Grok completion-audit compatibility");
    expect(decision).toMatchObject({
      assistantMessage: "APPROVED",
      endTurn: true,
      goalCompleted: true,
      isStructured: true
    });
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

  it("keeps the default URL response for Grok images (b64_json breaks gateway relays with 502)", async () => {
    // response_format: "b64_json" makes OpenAI-compatible relays proxy a large
    // inline-base64 body and commonly fails with HTTP 502. The compat must
    // keep the default URL response and download bytes in a second hop.
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/images/generations")) {
        return new Response(JSON.stringify({
          data: [{ url: "https://img.x.ai/tmp/cat.jpg" }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://img.x.ai/tmp/cat.jpg") {
        return new Response(bytes, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      }
      return new Response("not found", { status: 404 });
    });
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "xai", type: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKey: "secret"
    });
    const result = await adapter.generateImage!({
      model: {
        id: "grok-imagine-image-quality", providerId: "xai", displayName: "Grok Imagine", contextWindow: 128_000,
        supportsStreaming: false, supportsToolCalling: false, supportsParallelToolCalls: false, supportsJsonOutput: false,
        supportsMultimodalInput: true, supportsReasoningSummary: false
      },
      prompt: "a red panda"
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).not.toHaveProperty("response_format");
    // Second hop downloads the bytes from the temporary URL.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Array.from(result.data)).toEqual(Array.from(bytes));
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("fails loudly when a non-image Grok model is used for image generation", async () => {
    const fetchMock = vi.fn();
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "xai", type: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKey: "secret"
    });

    // grok-4 is a chat model; delegating it to the OpenAI SDK images path
    // would let gateways silently remap the request to another vendor's
    // image model. The compat must refuse instead.
    await expect(adapter.generateImage!({
      model: {
        id: "grok-4", providerId: "xai", displayName: "Grok 4", contextWindow: 128_000,
        supportsStreaming: true, supportsToolCalling: true, supportsParallelToolCalls: true, supportsJsonOutput: true,
        supportsMultimodalInput: true, supportsReasoningSummary: true
      },
      prompt: "a cat"
    })).rejects.toThrow("不是图片生成模型");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a URL-shaped image result field as a download URL, not base64", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/images/generations")) {
        return new Response(JSON.stringify({ result: "https://cdn.example/image.png" }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }
      if (url === "https://cdn.example/image.png") {
        return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      return new Response("not found", { status: 404 });
    });
    const adapter = new ProviderFactory({ fetch: fetchMock }).create({
      id: "gateway", type: "openai-compatible", baseUrl: "https://gateway.example/v1", apiKey: "secret"
    });
    const result = await adapter.generateImage!({
      model: {
        id: "grok-imagine-image", providerId: "gateway", displayName: "Grok Imagine Image", contextWindow: 128_000,
        supportsStreaming: false, supportsToolCalling: false, supportsParallelToolCalls: false, supportsJsonOutput: false,
        supportsMultimodalInput: true, supportsReasoningSummary: false
      },
      prompt: "a dog"
    });

    // The URL in `result` must be downloaded, not base64-decoded into garbage.
    expect(Array.from(result.data)).toEqual(Array.from(bytes));
    expect(result.mimeType).toBe("image/png");
  });

  it("recognizes image model families from their configured model names", () => {
    expect(imageGenerationProtocolForModel({ id: "gpt-image-2", displayName: "GPT Image 2" })).toBe("gpt-image-api");
    expect(imageGenerationProtocolForModel({ id: "gpt-5.6", displayName: "GPT-5.6" })).toBe("gpt-responses");
    expect(imageGenerationProtocolForModel({ id: "grok-imagine-image", displayName: "Grok Imagine Image" })).toBe("grok-images");
  });

  it("flags which provider protocols implement media generation", () => {
    for (const type of ["openai-compatible", "openrouter", "ollama", "vllm", "gateway"]) {
      expect(providerSupportsMediaGeneration(type)).toBe(true);
    }
    for (const type of ["anthropic", "gemini", "mock", "unknown-protocol"]) {
      expect(providerSupportsMediaGeneration(type)).toBe(false);
    }
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
        // deepseek compat raises max_tokens floor to 8192 to prevent
        // mid-stream truncation (finish_reason: length) that breaks long
        // replies and apply_patch arguments.
        max_tokens: 8192,
        thinking: { type: "enabled" }
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

  it("emits provider request and response traces when diagnostics are enabled", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "done" } }]
    });
    const traces: Array<{ phase: string; payload: Record<string, unknown> }> = [];
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-chat",
      providerId: provider.id,
      displayName: "DeepSeek Chat",
      contextWindow: 8_192,
      supportsStreaming: false,
      supportsToolCalling: false,
      supportsParallelToolCalls: false,
      supportsJsonOutput: false,
      supportsMultimodalInput: false,
      supportsReasoningSummary: false
    };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Answer.",
      transcript: [{ role: "user", content: "Hello" }],
      availableTools: [],
      model,
      provider,
      onProviderTrace: async (trace) => {
        traces.push(trace);
      }
    });

    expect(traces.map((trace) => trace.phase)).toEqual(["request", "response"]);
    expect(traces[0]?.payload).toHaveProperty("request");
    expect(traces[1]?.payload).toHaveProperty("response");
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

  it("does not mark a bare native tool name as a completed turn", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "fs.read_directory" } }]
    });
    const provider: ProviderDefinition = { id: "gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "tool-model", providerId: "gateway", displayName: "Tool model", contextWindow: 8_192,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
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
      provider
    });

    expect(decision).toMatchObject({
      assistantMessage: "fs.read_directory",
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false,
      requestTextToolProtocol: true
    });
  });

  it("rejects malformed JSON-looking text from a native-tool model and requests a protocol reset", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "```json\nthis is definitely not a JSON object\n```" } }]
    });
    const provider: ProviderDefinition = { id: "gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-chat", providerId: "gateway", displayName: "DeepSeek Chat", contextWindow: 8_192,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
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
      provider
    });

    expect(decision).toMatchObject({
      assistantMessage: undefined,
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false,
      requestTextToolProtocol: true
    });
  });

  it("rejects protocol-error meta text instead of accepting it as the current task answer", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "当前模型已返回可执行的 Agent 决策。The response was not a valid JSON decision envelope." } }]
    });
    const provider: ProviderDefinition = { id: "gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-chat", providerId: "gateway", displayName: "DeepSeek Chat", contextWindow: 8_192,
      supportsStreaming: false, supportsToolCalling: true, supportsParallelToolCalls: true,
      supportsJsonOutput: true, supportsMultimodalInput: false, supportsReasoningSummary: false
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the function tool.",
      transcript: [{ role: "user", content: "Continue the current task." }],
      availableTools: [{
        name: "fs.read_directory",
        description: "List a directory.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        riskLevel: "low"
      }],
      model,
      provider
    });

    expect(decision).toMatchObject({
      assistantMessage: undefined,
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: false,
      requestTextToolProtocol: true
    });
  });

  it("parses DeepSeek DSML tool calls returned in the content field", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{
        message: {
          content: [
            "我先读取目标文件。",
            "<｜DSML｜tool_calls>",
            '<｜DSML｜invoke name="fs.read_file">',
            '<｜DSML｜parameter name="path" string="true">src/&amp;app.ts</｜DSML｜parameter>',
            '<｜DSML｜parameter name="line" string="false">3</｜DSML｜parameter>',
            "</｜DSML｜invoke>",
            "</｜DSML｜tool_calls>"
          ].join("\n")
        }
      }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-v4-flash",
      providerId: provider.id,
      displayName: "DeepSeek V4 Flash",
      contextWindow: 128_000,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: true
    };

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the provided tool.",
      transcript: [{ role: "user", content: "读取文件" }],
      availableTools: [{
        name: "fs.read_file",
        description: "Read a file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, line: { type: "number" } },
          required: ["path"]
        },
        riskLevel: "low"
      }],
      model,
      provider
    });

    expect(decision).toMatchObject({
      assistantMessage: "我先读取目标文件。",
      toolCalls: [{
        name: "fs.read_file",
        arguments: { path: "src/&app.ts", line: 3 }
      }],
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    });
  });

  it("keeps DeepSeek tool results contiguous when recovery notes were interleaved", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-v4-flash-0731",
      providerId: provider.id,
      displayName: "DeepSeek V4 Flash",
      contextWindow: 128_000,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: true
    };
    const calls = ["call-0", "call-1", "call-2"];

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the provided tools.",
      transcript: [
        { role: "user", content: "Collect the pages." },
        {
          role: "assistant",
          content: "",
          reasoningContent: "I will collect the pages.",
          toolCalls: calls.map((id, index) => ({
            id,
            name: "web_search.open_page",
            arguments: { url: `https://example.com/${index}` }
          }))
        },
        { role: "tool", content: "page 0", toolCallId: "call-0" },
        { role: "user", content: "The first result was already available; continue." },
        { role: "tool", content: "page 1", toolCallId: "call-1" },
        { role: "user", content: "Do not repeat the second page." },
        { role: "tool", content: "page 2", toolCallId: "call-2" },
        { role: "user", content: "Return the result when the batch is complete." }
      ],
      availableTools: [{
        name: "web_search.open_page",
        description: "Open a page.",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        riskLevel: "low"
      }],
      model,
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.tool_calls);
    const toolMessages = messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(calls);
    expect(messages.slice(assistantIndex + 1, assistantIndex + 4).map((message) => message.role)).toEqual([
      "tool", "tool", "tool"
    ]);
    expect(messages.slice(assistantIndex + 4).every((message) => message.role === "user")).toBe(true);
  });

  it("parses the legacy DeepSeek function_calls container and encoded argument JSON", () => {
    const decision = parseDecisionFromText([
      "<｜DSML｜function_calls>",
      '<｜DSML｜invoke name="fs.read_file">',
      '<｜DSML｜parameter name="arguments" string="false">{&quot;path&quot;: &quot;src/app.ts&quot;, &quot;line&quot;: 4}</｜DSML｜parameter>',
      "</｜DSML｜invoke>",
      "</｜DSML｜function_calls>"
    ].join("\n"));

    expect(decision).toMatchObject({
      assistantMessage: undefined,
      toolCalls: [{
        name: "fs.read_file",
        arguments: { path: "src/app.ts", line: 4 }
      }],
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    });
  });

  it("echoes DeepSeek reasoning_content on subsequent native tool turns", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "done" } }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-reasoner",
      providerId: provider.id,
      displayName: "DeepSeek Reasoner",
      contextWindow: 128_000,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: false,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: true
    };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Continue with the tool result.",
      transcript: [
        { role: "user", content: "读取文件" },
        {
          role: "assistant",
          content: "",
          reasoningContent: "我需要先读取文件。",
          toolCalls: [{ id: "call-1", name: "fs.read_file", arguments: { path: "src/app.ts" } }]
        },
        {
          role: "tool",
          content: "fs.read_file\nfile content",
          toolCallId: "call-1",
          toolResultOk: true
        }
      ],
      availableTools: [{
        name: "fs.read_file",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        riskLevel: "low"
      }],
      model,
      provider
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const messages = request.messages as Array<Record<string, unknown>>;
    expect(messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      content: "",
      reasoning_content: "我需要先读取文件。",
      tool_calls: expect.any(Array)
    }));
  });

  it("enables DeepSeek V4 thinking and preserves an empty reasoning field for tool history", async () => {
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "done" } }]
    });
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-v4-flash-0731",
      providerId: provider.id,
      displayName: "DeepSeek V4 Flash",
      contextWindow: 128_000,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: true
    };

    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Continue with the tool result.",
      transcript: [
        { role: "user", content: "读取文件" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "fs.read_file", arguments: { path: "src/app.ts" } }]
        },
        {
          role: "tool",
          content: "fs.read_file\nfile content",
          toolCallId: "call-1",
          toolResultOk: true
        }
      ],
      availableTools: [{
        name: "fs.read_file",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        riskLevel: "low"
      }],
      model,
      provider,
      reasoningEffort: "xhigh"
    });

    const request = mocks.chatCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(request.thinking).toEqual({ type: "enabled" });
    expect(request.reasoning_effort).toBe("max");
    expect(request.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      content: "",
      reasoning_content: "",
      tool_calls: expect.any(Array)
    }));
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
            finish_reason: "stop",
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
      yield { choices: [{ finish_reason: "stop", delta: { content: 'the renderer.","tool_calls":[{"name":"fs.read_file","arguments":{"path":"src/App.tsx"}}],"end_turn":false}' } }] };
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
          finish_reason: "stop",
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

  it("rejects a stream that ends without a provider completion signal", async () => {
    async function* incompleteStream() {
      yield {
        choices: [{
          delta: {
            content: '{"assistant_message":"This must not be treated as complete.","tool_calls":[],"end_turn":true,"goal_completed":true}'
          }
        }]
      };
    }

    mocks.chatCreate.mockResolvedValue(incompleteStream());
    const provider: ProviderDefinition = { id: "company-gateway", type: "openai-compatible", apiKey: "secret" };
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

    await expect(new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON only.",
      transcript: [{ role: "user", content: "Finish" }],
      availableTools: [],
      model,
      provider,
      stream: true
    })).rejects.toBeInstanceOf(ProviderStreamIncompleteError);
  });

  it("treats DeepSeek insufficient_system_resource as an interrupted stream", async () => {
    async function* resourceLimitedStream() {
      yield {
        choices: [{
          finish_reason: "insufficient_system_resource",
          delta: { content: "partial" }
        }]
      };
    }

    mocks.chatCreate.mockResolvedValue(resourceLimitedStream());
    const provider: ProviderDefinition = { id: "deepseek-gateway", type: "openai-compatible", apiKey: "secret" };
    const model: ModelProfile = {
      id: "deepseek-v4-flash",
      providerId: provider.id,
      displayName: "DeepSeek V4 Flash",
      contextWindow: 128_000,
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsParallelToolCalls: false,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      supportsReasoningSummary: true
    };

    await expect(new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Answer.",
      transcript: [{ role: "user", content: "Finish" }],
      availableTools: [],
      model,
      provider,
      stream: true
    })).rejects.toThrow(/insufficient system resources/i);
  });

  it("streams a final assistant_message when native tools are available but unused", async () => {
    async function* streamFinalAnswer() {
      yield { choices: [{ delta: { content: '{"assistant_message":"Streaming ' } }] };
      yield { choices: [{ finish_reason: "stop", delta: { content: 'works","tool_calls":[],"end_turn":true,"goal_completed":true}' } }] };
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
      yield { choices: [{ finish_reason: "tool_calls", delta: { tool_calls: [{ index: 0, function: { arguments: 'App.tsx"}' } }] } }] };
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
    const preparingToolCalls: Array<{ name: string; argumentsJson?: string }> = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use tools when needed.",
      transcript: [{ role: "user", content: "Read the file" }],
      availableTools: [{ name: "fs.read_file", description: "Read a file", inputSchema: { type: "object" }, riskLevel: "low" }],
      model,
      provider,
      stream: true,
      onTextDelta: async (delta) => { visibleDeltas.push(delta); },
      onToolCallPreparing: async (toolCall) => { preparingToolCalls.push(toolCall); }
    });

    expect(visibleDeltas).toEqual([]);
    expect(preparingToolCalls).toEqual([{ name: "fs.read_file", argumentsJson: '{"path":"src/' }]);
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
    const adapter = new ProviderFactory().create(provider);

    expect(mocks.anthropicConstructor).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "secret",
      authToken: null
    }));

    const decision = await adapter.runTurn({
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

  it("streams Anthropic text and accumulates a tool_use JSON input", async () => {
    async function* events() {
      yield { type: "message_start", message: { usage: { input_tokens: 9 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "thinking" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspecting." } };
      yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "stream-call", name: nativeToolName(tool.name), input: {} } };
      yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":".' } };
      yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"}' } };
      yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } };
      yield { type: "message_stop" };
    }
    mocks.anthropicCreate.mockResolvedValue(events());
    const provider: ProviderDefinition = { id: "provider", type: "anthropic", apiKey: "secret" };
    const deltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use the function.", transcript: [{ role: "user", content: "Inspect." }],
      availableTools: [tool], model: { ...model, supportsStreaming: true }, provider, stream: true,
      onTextDelta: (delta) => { deltas.push(delta); }
    });

    expect(deltas).toEqual([]);
    expect(decision).toMatchObject({
      toolCalls: [{ id: "stream-call", name: tool.name, arguments: { path: "." } }],
      reasoningSummary: "Inspecting.",
      outputTokens: 6
    });
  });

  it("streams only visible Anthropic text and rejects max_tokens completion", async () => {
    async function* textEvents() {
      yield { type: "message_start", message: { usage: { input_tokens: 2 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } };
      yield { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 3 } };
      yield { type: "message_stop" };
    }
    mocks.anthropicCreate.mockResolvedValue(textEvents());
    const provider: ProviderDefinition = { id: "provider", type: "anthropic", apiKey: "secret" };
    const deltas: string[] = [];

    await expect(new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Answer.", transcript: [{ role: "user", content: "Hello" }], availableTools: [],
      model: { ...model, supportsStreaming: true }, provider, stream: true,
      onTextDelta: (delta) => { deltas.push(delta); }
    })).rejects.toBeInstanceOf(ProviderStreamIncompleteError);
    expect(deltas).toEqual(["Hello"]);
  });

  it("decodes only assistant_message from an Anthropic JSON decision stream", async () => {
    async function* events() {
      yield { type: "message_start", message: { usage: { input_tokens: 2 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"assistant_message":"Draft ' } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'summary","tool_calls":[],"end_turn":true,"goal_completed":true}' } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } };
      yield { type: "message_stop" };
    }
    mocks.anthropicCreate.mockResolvedValue(events());
    const provider: ProviderDefinition = { id: "provider", type: "anthropic", apiKey: "secret" };
    const deltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON.", transcript: [{ role: "user", content: "Summarize." }], availableTools: [],
      model: { ...model, supportsStreaming: true }, provider, stream: true,
      onTextDelta: (delta) => { deltas.push(delta); }
    });

    expect(deltas.join("")).toBe("Draft summary");
    expect(decision).toMatchObject({ assistantMessage: "Draft summary", endTurn: true, goalCompleted: true });
  });

  it("maps the Anthropic parallel tool setting and parses Responses function calls", async () => {
    mocks.anthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "Done." }], usage: { output_tokens: 1 } });
    const anthropicProvider: ProviderDefinition = { id: "provider", type: "anthropic", apiKey: "secret" };
    await new ProviderFactory().create(anthropicProvider).runTurn({
      systemPrompt: "Use tools.", transcript: [{ role: "user", content: "Inspect." }], availableTools: [tool], model, provider: anthropicProvider
    });
    expect(mocks.anthropicCreate.mock.calls.at(-1)?.[0]).toMatchObject({
      tool_choice: { type: "auto", disable_parallel_tool_use: true }
    });

    mocks.responsesCreate.mockResolvedValue({
      status: "completed",
      output: [{ type: "function_call", call_id: "response-call", name: nativeToolName(tool.name), arguments: '{"path":"."}' }],
      usage: { input_tokens: 4, output_tokens: 5 }
    });
    const responsesProvider: ProviderDefinition = {
      id: "xai", type: "openai-compatible", transport: "responses", apiKey: "secret"
    };
    const decision = await new ProviderFactory().create(responsesProvider).runTurn({
      systemPrompt: "Use tools.", transcript: [{ role: "user", content: "Inspect." }], availableTools: [tool], model: {
        ...model, providerId: "xai", supportsParallelToolCalls: true
      }, provider: responsesProvider
    });
    expect(mocks.responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
      parallel_tool_calls: true,
      tools: [expect.objectContaining({ name: nativeToolName(tool.name) })]
    }), { signal: undefined });
    expect(decision).toMatchObject({ toolCalls: [{ id: "response-call", name: tool.name, arguments: { path: "." } }] });
  });

  it("sends the selected GPT reasoning effort through the Responses request", async () => {
    mocks.responsesCreate.mockResolvedValue({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] });
    const provider: ProviderDefinition = {
      id: "openai", type: "openai-compatible", transport: "responses", apiKey: "secret"
    };
    await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Answer.", transcript: [{ role: "user", content: "Hello" }], availableTools: [],
      model: { ...model, id: "gpt-5.6-terra", providerId: provider.id, role: "reasoning" },
      provider, reasoningEffort: "high", stream: false
    });

    expect(mocks.responsesCreate.mock.calls.at(-1)?.[0]).toMatchObject({
      reasoning: { effort: "high", summary: "concise" }
    });
  });

  it("streams Responses text and function arguments without exposing tool JSON", async () => {
    async function* events() {
      yield { type: "response.output_text.delta", delta: "Inspecting" };
      yield {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "item-1", type: "function_call", call_id: "response-stream-call", name: nativeToolName(tool.name), arguments: "" }
      };
      yield { type: "response.function_call_arguments.delta", output_index: 1, item_id: "item-1", delta: '{"path":".' };
      yield { type: "response.function_call_arguments.delta", output_index: 1, item_id: "item-1", delta: '"}' };
      yield { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 6 } } };
    }
    mocks.responsesCreate.mockResolvedValue(events());
    const provider: ProviderDefinition = { id: "xai", type: "openai-compatible", transport: "responses", apiKey: "secret" };
    const deltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Use tools.", transcript: [{ role: "user", content: "Inspect." }], availableTools: [tool],
      model: { ...model, providerId: "xai", supportsStreaming: true }, provider, stream: true,
      onTextDelta: (delta) => { deltas.push(delta); }
    });

    expect(deltas).toEqual(["Inspecting"]);
    expect(decision).toMatchObject({
      assistantMessage: "Inspecting",
      toolCalls: [{ id: "response-stream-call", name: tool.name, arguments: { path: "." } }],
      outputTokens: 6
    });
  });

  it("decodes only assistant_message from a Responses JSON decision stream", async () => {
    async function* events() {
      yield { type: "response.output_text.delta", delta: '{"assistant_message":"Draft ' };
      yield { type: "response.output_text.delta", delta: 'summary","tool_calls":[],"end_turn":true,"goal_completed":true}' };
      yield { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 8 } } };
    }
    mocks.responsesCreate.mockResolvedValue(events());
    const provider: ProviderDefinition = { id: "openai", type: "openai-compatible", transport: "responses", apiKey: "secret" };
    const deltas: string[] = [];

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Return JSON.", transcript: [{ role: "user", content: "Summarize." }], availableTools: [],
      model: { ...model, providerId: provider.id, supportsStreaming: true }, provider, stream: true,
      onTextDelta: (delta) => { deltas.push(delta); }
    });

    expect(deltas.join("")).toBe("Draft summary");
    expect(decision).toMatchObject({ assistantMessage: "Draft summary", endTurn: true, goalCompleted: true });
  });

  it("falls back to Chat Completions only when the Responses endpoint is unsupported", async () => {
    mocks.responsesCreate.mockRejectedValue({ status: 404 });
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"assistant_message":"Done","tool_calls":[],"end_turn":true,"goal_completed":true}' } }]
    });
    const provider: ProviderDefinition = { id: "xai", type: "openai-compatible", transport: "responses", apiKey: "secret" };
    const responseCallCount = mocks.responsesCreate.mock.calls.length;
    const chatCallCount = mocks.chatCreate.mock.calls.length;

    const decision = await new ProviderFactory().create(provider).runTurn({
      systemPrompt: "Finish.", transcript: [{ role: "user", content: "Hello" }], availableTools: [],
      model: { ...model, providerId: "xai" }, provider
    });

    expect(mocks.responsesCreate).toHaveBeenCalledTimes(responseCallCount + 1);
    expect(mocks.chatCreate).toHaveBeenCalledTimes(chatCallCount + 1);
    expect(decision).toMatchObject({ assistantMessage: "Done", endTurn: true });
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
    expect(prompt).toContain("*** Update File: relative/path.ext");
    expect(prompt).toContain("Every update hunk line must start with a space, -, or +");
    expect(prompt).toContain("fs.read_directory");
    expect(prompt).toContain("Do not repeat it");
    expect(prompt).toContain("goal_completed");
    expect(prompt).toContain("shell.exec");
    expect(prompt).toContain("For every GPA ACT decision, include completed_task_ids");
    expect(prompt).toContain("Every non-final response with tool calls must include one short, natural conversational sentence");
    expect(prompt).toContain("Do not expose tool names, Skill IDs, internal hashes, raw commands, file paths, call counts");
    expect(prompt).toContain("choose the format that makes the information easiest to scan");
    expect(prompt).toContain("Do not force information into a table");
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
          questions: expect.arrayContaining([
            expect.objectContaining({
              id: "pokemon_count",
              label: "宝可梦数量",
              prompt: "图鉴里需要多少只宝可梦？",
              options: [
                { id: "option_1", label: "6只（精简版）", recommended: true },
                { id: "option_2", label: "9只（中等）", recommended: false },
                { id: "option_3", label: "12只（丰富版）", recommended: false }
              ]
            })
          ])
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

  it("parses request_user_input with JSON content inside XML tags (DeepSeek format)", () => {
    const decision = parseDecisionFromText([
      '<request_user_input> { "title": "语音变更 + 攻治减半方案确认", "questions": [',
      '  { "id": "voice_strategy", "label": "语音变更策略", "prompt": "你希望如何更换语音源？", "options": [',
      '    { "id": "reweight", "label": "调整评分权重", "description": "降低当前音色分数", "recommended": true },',
      '    { "id": "force_voice", "label": "强制指定特定语音", "description": "写死一个 voiceURI" }',
      '  ] },',
      '  { "id": "half_scope", "label": "减半效果的技能范围", "prompt": "「提醒后攻治减半」应覆盖哪些技能类型？", "options": [',
      '    { "id": "all", "label": "所有技能" },',
      '    { "id": "attack_heal", "label": "仅攻击和治疗", "recommended": true },',
      '    { "id": "attack_only", "label": "仅攻击类技能" }',
      '  ] }',
      '] } </request_user_input>'
    ].join("\n"));

    expect(decision).toMatchObject({
      isStructured: true,
      endTurn: false,
      toolCalls: [{
        name: "request_user_input",
        arguments: {
          title: "语音变更 + 攻治减半方案确认",
          questions: [
            {
              id: "voice_strategy",
              label: "语音变更策略",
              prompt: "你希望如何更换语音源？",
              options: [
                { id: "reweight", label: "调整评分权重", recommended: true },
                { id: "force_voice", label: "强制指定特定语音", recommended: false }
              ]
            },
            {
              id: "half_scope",
              label: "减半效果的技能范围",
              prompt: "「提醒后攻治减半」应覆盖哪些技能类型？",
              options: [
                { id: "all", label: "所有技能", recommended: false },
                { id: "attack_heal", label: "仅攻击和治疗", recommended: true },
                { id: "attack_only", label: "仅攻击类技能", recommended: false }
              ]
            }
          ]
        }
      }]
    });
    expect(decision.assistantMessage ?? "").not.toContain("<request_user_input");
  });

  it("parses request_user_input with JSON content using string options", () => {
    const decision = parseDecisionFromText(
      '<request_user_input>{"title":"测试","questions":[{"id":"q1","label":"问题","prompt":"选哪个？","options":["选项A","选项B"]}]}</request_user_input>'
    );

    expect(decision).toMatchObject({
      isStructured: true,
      toolCalls: [{
        name: "request_user_input",
        arguments: {
          title: "测试",
          questions: [{
            id: "q1",
            label: "问题",
            prompt: "选哪个？",
            options: [
              { id: "option_1", label: "选项A", recommended: true },
              { id: "option_2", label: "选项B", recommended: false }
            ]
          }]
        }
      }]
    });
  });

  it("keeps unrepairable text protocols unstructured and prevents tool execution", () => {
    const decision = parseDecisionFromText("<tool_calls>{not valid</tool_calls>");

    expect(decision).toMatchObject({ isStructured: false, toolCalls: [] });
  });
});

describe("parseNativeToolArguments JSON repair", () => {
  it("parses well-formed JSON normally", () => {
    expect(parseNativeToolArguments('{"patch":"hello"}')).toEqual({ patch: "hello" });
  });

  it("returns empty object for empty input", () => {
    expect(parseNativeToolArguments("")).toEqual({});
    expect(parseNativeToolArguments("   ")).toEqual({});
  });

  it("repairs literal newlines inside string values (DeepSeek apply_patch)", () => {
    // DeepSeek sometimes emits raw newlines inside JSON string values
    // instead of \n escape sequences, e.g. for apply_patch arguments.
    const raw = '{"patch": "*** Begin Patch\n*** Update File: app.ts\n@@\n-old\n+new\n*** End Patch"}';
    const parsed = parseNativeToolArguments(raw);
    expect(parsed).toEqual({
      patch: "*** Begin Patch\n*** Update File: app.ts\n@@\n-old\n+new\n*** End Patch"
    });
    expect(TOOL_ARGS_TRUNCATED_KEY in parsed).toBe(false);
  });

  it("repairs literal tabs inside string values", () => {
    const raw = '{"code": "if\t(true)\t{return}"}';
    expect(parseNativeToolArguments(raw)).toEqual({ code: "if\t(true)\t{return}" });
  });

  it("repairs literal carriage returns inside string values", () => {
    const raw = '{"text": "line1\r\nline2"}';
    expect(parseNativeToolArguments(raw)).toEqual({ text: "line1\r\nline2" });
  });

  it("preserves already-escaped sequences in repaired JSON", () => {
    const raw = '{"patch": "*** Begin Patch\\n*** End Patch"}';
    expect(parseNativeToolArguments(raw)).toEqual({ patch: "*** Begin Patch\n*** End Patch" });
  });

  it("returns truncation marker for genuinely truncated JSON", () => {
    const raw = '{"patch": "*** Begin Patch\n*** Update File: app.ts\n@@\n-old\n+new';  // no closing
    const parsed = parseNativeToolArguments(raw);
    expect(TOOL_ARGS_TRUNCATED_KEY in parsed).toBe(true);
  });

  it("returns an invalid marker for balanced but malformed JSON", () => {
    const parsed = parseNativeToolArguments('{"path":}');
    expect(TOOL_ARGS_INVALID_KEY in parsed).toBe(true);
    expect(TOOL_ARGS_TRUNCATED_KEY in parsed).toBe(false);
  });

  it("handles mixed escaped and literal newlines", () => {
    // First line uses \n escape, second has literal newline
    const raw = '{"patch": "line1\\nline2\nline3"}';
    const parsed = parseNativeToolArguments(raw);
    expect(parsed).toEqual({ patch: "line1\nline2\nline3" });
  });
});
