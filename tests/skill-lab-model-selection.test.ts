import { describe, expect, it } from "vitest";
import type { AppConfig } from "@shared-types";
import { resolveSkillLabModel } from "../apps/desktop/src/main/skill-lab";

function makeConfig(): AppConfig {
  return {
    defaultProvider: "primary",
    defaultModel: "default-model",
    providers: [
      { id: "primary", name: "Primary", type: "openai-compatible" },
      { id: "lab", name: "Lab Provider", type: "anthropic" }
    ],
    models: [
      {
        id: "default-model",
        providerId: "primary",
        displayName: "Default model",
        role: "reasoning",
        contextWindow: 128_000,
        supportsStreaming: true,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      },
      {
        id: "custom-model",
        providerId: "lab",
        displayName: "Custom model",
        role: "reasoning",
        contextWindow: 128_000,
        supportsStreaming: true,
        supportsToolCalling: true,
        supportsParallelToolCalls: true,
        supportsJsonOutput: true,
        supportsMultimodalInput: false,
        supportsReasoningSummary: false
      }
    ],
    routing: {},
    multimodal: {
      image: { enabled: true },
      video: { enabled: true },
      input: { enabled: true }
    },
    desktop: { theme: "system", approvals: "prompt", inAppBrowser: true },
    multiAgent: { enabled: false, maxAgents: 1, maxDepth: 1 },
    selfImprovement: { enabled: false, memoryEnabled: false, maxMemories: 100 },
    timeouts: {
      modelDecisionMs: 90_000,
      recoveryModelDecisionMs: 20_000,
      modelTimeoutRetries: 5,
      toolExecutionMs: 120_000,
      multimodalIntentClassifyMs: 20_000,
      modelTestMs: 30_000,
      videoGenerationMs: 600_000,
      videoPollIntervalMs: 5_000
    },
    mcpServers: [],
    databaseConnections: []
  };
}

describe("skill lab model selection", () => {
  it("uses the model selected for the lab run", () => {
    const selection = resolveSkillLabModel(makeConfig(), "lab", "custom-model");
    expect(selection.provider.id).toBe("lab");
    expect(selection.model.id).toBe("custom-model");
  });

  it("uses the configured default when no model is supplied", () => {
    const selection = resolveSkillLabModel(makeConfig());
    expect(selection.provider.id).toBe("primary");
    expect(selection.model.id).toBe("default-model");
  });

  it("rejects a model that does not belong to the selected provider", () => {
    expect(() => resolveSkillLabModel(makeConfig(), "primary", "custom-model"))
      .toThrow("所选实验模型不存在");
  });

  it("rejects models that cannot call tools", () => {
    const config = makeConfig();
    config.models[1].supportsToolCalling = false;
    expect(() => resolveSkillLabModel(config, "lab", "custom-model"))
      .toThrow("未启用工具调用");
  });
});
