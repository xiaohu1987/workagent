import { describe, expect, it } from "vitest";
import type { AppConfig } from "@shared-types";
import {
  describeSkillLabFailure,
  isSkillLabAbortError,
  isSkillLabOutputLimitError,
  resolveSkillLabModel,
  SKILL_LAB_MAX_CONSECUTIVE_REMEDIATION_FAILURES,
  SKILL_LAB_MODEL_CALL_ATTEMPTS,
  SKILL_LAB_MODEL_CALL_TIMEOUT_MS
} from "../apps/desktop/src/main/skill-lab";

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
    desktop: { theme: "system", approvals: "prompt", inAppBrowser: true, liveEditPreview: true },
    multiAgent: { enabled: false, maxAgents: 1, maxDepth: 1 },
    selfImprovement: { enabled: false, memoryEnabled: false, maxMemories: 100 },
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

  it("recognizes provider aborts as recoverable skill lab failures", () => {
    const error = new Error("Request was aborted.");
    error.name = "APIUserAbortError";
    expect(isSkillLabAbortError(error)).toBe(true);
  });

  it("replaces a raw provider abort message with actionable guidance", () => {
    expect(describeSkillLabFailure(new Error("Request was aborted.")))
      .toContain("含 2 次自动重试");
    expect(SKILL_LAB_MODEL_CALL_TIMEOUT_MS).toBe(300_000);
    expect(SKILL_LAB_MAX_CONSECUTIVE_REMEDIATION_FAILURES).toBe(3);
    expect(SKILL_LAB_MODEL_CALL_ATTEMPTS).toBe(3);
  });

  it("treats a provider output limit as recoverable and explains it clearly", () => {
    const error = new Error("Provider stream terminated because the response reached its output limit.");
    error.name = "ProviderStreamIncompleteError";
    expect(isSkillLabOutputLimitError(error)).toBe(true);
    expect(describeSkillLabFailure(error)).toContain("输出上限");
  });
});
