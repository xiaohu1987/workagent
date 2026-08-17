import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isConfigurableGptReasoningModel, normalizeResponseTone, resolveModelReasoningEffort, withGptReasoningCapabilities } from "@shared-types";
import type { ModelProfile } from "@shared-types";
import { defaultConfig, loadConfig, saveConfig } from "../apps/desktop/src/main/storage";
import { PROVIDER_TEMPLATE_OPTIONS, buildConfigToSave, createEmptyProvider, hasProviderTestEndpoint, normalizeDraftConfig, providerTemplatePatch, resolveSelectionFromConfig } from "../apps/desktop/src/renderer/lib/config-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("model configuration storage", () => {
  it("clears legacy protocol fields when switching to the DeepSeek template", () => {
    expect(providerTemplatePatch("deepseek")).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      apiFormat: "openai_responses",
      compatibilityProfile: "deepseek",
      transport: undefined,
      deepseekProtocol: undefined
    });
  });

  it("never clears the provider URL when switching to a template without a fixed endpoint", () => {
    const baseProvider = {
      id: "gateway",
      type: "openai-compatible" as const,
      baseUrl: "https://gateway.example/v1"
    };

    for (const template of ["openai_compatible", "gemini"] as const) {
      const patch = providerTemplatePatch(template);
      expect(patch).not.toHaveProperty("baseUrl");
      expect({ ...baseProvider, ...patch }.baseUrl).toBe(baseProvider.baseUrl);
    }
  });

  it("uses OpenAI compatible for new providers and does not expose a custom template", () => {
    expect(createEmptyProvider([])).toMatchObject({
      type: "openai-compatible",
      providerTemplate: "openai_compatible",
      apiFormat: "auto"
    });
    expect(PROVIDER_TEMPLATE_OPTIONS.map((option) => option.value)).not.toContain("custom");
  });

  it("does not allow testing a real provider without a base URL", () => {
    expect(hasProviderTestEndpoint({ id: "gateway", type: "openai-compatible", baseUrl: "  " })).toBe(false);
    expect(hasProviderTestEndpoint({ id: "gateway", type: "openai-compatible", baseUrl: "https://gateway.example/v1" })).toBe(true);
    expect(hasProviderTestEndpoint({ id: "mock", type: "mock" })).toBe(true);
  });

  it("invalidates model protocol and Agent verification when provider connection settings change", () => {
    const source = defaultConfig();
    const draft = structuredClone(source);
    const model = draft.models.find((entry) => entry.providerId === "openai")!;
    model.verifiedApiFormats = ["openai_responses"];
    model.preferredApiFormat = "openai_responses";
    model.apiFormatCheckedAt = new Date().toISOString();
    model.agentCapability = "verified";
    model.agentCapabilityCheckedAt = new Date().toISOString();
    draft.providers.find((entry) => entry.id === "openai")!.baseUrl = "https://gateway.example/v1";

    const saved = buildConfigToSave(draft, source, {});
    expect(saved.models.find((entry) => entry.providerId === "openai")).not.toMatchObject({
      preferredApiFormat: expect.any(String),
      apiFormatCheckedAt: expect.any(String),
      agentCapability: expect.any(String),
      agentCapabilityCheckedAt: expect.any(String)
    });
  });

  it("resolves a new thread to the configured default provider and model", () => {
    const config = defaultConfig();
    config.defaultProvider = "anthropic";
    config.defaultModel = "claude-sonnet-4-20250514";

    expect(resolveSelectionFromConfig(config)).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514"
    });
    expect(resolveSelectionFromConfig(config, "mock", "mock-codexh")).toEqual({
      providerId: "mock",
      modelId: "mock-codexh"
    });
  });

  it("preserves a deliberately cleared default multimodal input model", () => {
    const config = defaultConfig();
    const recognizableModel = config.models.find((model) => model.supportsMultimodalInput);
    expect(recognizableModel).toBeDefined();

    delete config.multimodal.input.defaultProviderId;
    delete config.multimodal.input.defaultModelId;

    const normalized = normalizeDraftConfig(config);

    expect(normalized.multimodal.input).toEqual({ enabled: true });
  });

  it("ships selectable Claude and Grok defaults without replacing the current default", () => {
    const config = defaultConfig();

    expect(config.defaultModel).toBe("mock-codexh");
    expect(config.responseTone).toBe("concise");
    expect(config.desktop.liveEditPreview).toBe(false);
    expect(config.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anthropic", baseUrl: "https://api.anthropic.com/v1" }),
      expect.objectContaining({ id: "xai", apiFormat: "openai_responses", baseUrl: "https://api.x.ai/v1" })
    ]));
    expect(config.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claude-sonnet-4-20250514", providerId: "anthropic", defaultReasoningEffort: "medium" }),
      expect.objectContaining({ id: "grok-4-0709", providerId: "xai", defaultReasoningEffort: "high" })
    ]));
  });

  it("persists the selected response tone", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tone-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    const config = defaultConfig();
    config.responseTone = "friendly";

    await saveConfig(configFile, config);
    const loaded = await loadConfig(configFile);

    expect(loaded.responseTone).toBe("friendly");
  });

  it("keeps hidden provider transport overrides compatible with existing configs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-provider-limits-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    const config = defaultConfig();
    const provider = config.providers.find((entry) => entry.id === "openai")!;
    provider.maxRequestBytes = 196_608;
    provider.maxTools = 64;

    await saveConfig(configFile, config);
    const loaded = await loadConfig(configFile);

    expect(loaded.providers.find((entry) => entry.id === "openai")).toMatchObject({
      maxRequestBytes: 196_608,
      maxTools: 64
    });
  });

  it("persists the DeepSeek compatibility profile independently from the API format", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-deepseek-protocol-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    const config = defaultConfig();
    const provider = config.providers.find((entry) => entry.id === "openai")!;
    provider.compatibilityProfile = "deepseek";
    provider.apiFormat = "openai_chat";

    await saveConfig(configFile, config);
    const loaded = await loadConfig(configFile);

    expect(loaded.providers.find((entry) => entry.id === "openai")).toMatchObject({
      compatibilityProfile: "deepseek",
      apiFormat: "openai_chat"
    });
  });

  it("migrates legacy custom transports to auto and removes legacy fields", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-provider-format-migration-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    await fs.writeFile(configFile, [
      'defaultModel = "deepseek-v4-pro-0813"',
      'defaultProvider = "provider-10"',
      '[providers.provider-10]',
      'type = "openai-compatible"',
      'providerTemplate = "custom"',
      'transport = "responses"',
      'deepseekProtocol = "native"',
      'baseUrl = "https://gateway.example/v1"',
      '[models.deepseek-v4-pro-0813]',
      'providerId = "provider-10"',
      'displayName = "DeepSeek V4 Pro 0813"',
      'contextWindow = 128000',
      'supportsStreaming = true',
      'supportsToolCalling = true',
      'supportsParallelToolCalls = true',
      'supportsJsonOutput = true',
      'supportsMultimodalInput = false',
      'supportsReasoningSummary = true'
    ].join("\n"), "utf8");

    const loaded = await loadConfig(configFile);
    expect(loaded.providers[0]).toMatchObject({
      providerTemplate: "openai_compatible",
      apiFormat: "auto",
      compatibilityProfile: "deepseek"
    });
    expect(loaded.providers[0]).not.toHaveProperty("transport");
    expect(loaded.providers[0]).not.toHaveProperty("deepseekProtocol");
    expect(loaded.models[0]?.preferredApiFormat).toBe("openai_responses");
    const migratedText = await fs.readFile(configFile, "utf8");
    expect(migratedText).not.toContain("transport =");
    expect(migratedText).not.toContain("deepseekProtocol");
    expect(migratedText).not.toContain('providerTemplate = "custom"');
  });

  it("removes legacy timeout settings while loading the configuration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-autonomous-runtime-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    await fs.writeFile(configFile, [
      'defaultModel = "mock-codexh"',
      'defaultProvider = "mock"',
      'responseTone = "concise"',
      'reasoningEffort = "medium"',
      '[timeouts]',
      'modelDecisionMs = 1000',
      'toolExecutionMs = 1000'
    ].join("\n"), "utf8");

    await loadConfig(configFile);

    expect(await fs.readFile(configFile, "utf8")).not.toContain("[timeouts]");
  });

  it("defaults legacy configs to medium GPT reasoning effort and persists later selections", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-reasoning-effort-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    await fs.writeFile(configFile, [
      'defaultModel = "mock-codexh"',
      'defaultProvider = "mock"',
      '[desktop]',
      'theme = "system"',
      'approvals = "prompt"',
      'inAppBrowser = true'
    ].join("\n"), "utf8");

    const legacy = await loadConfig(configFile);
    expect(legacy.reasoningEffort).toBe("medium");
    expect(await fs.readFile(configFile, "utf8")).toContain('reasoningEffort = "medium"');

    legacy.reasoningEffort = "xhigh";
    await saveConfig(configFile, legacy);
    expect((await loadConfig(configFile)).reasoningEffort).toBe("xhigh");
  });

  it("recognizes GPT-5.4+ reasoning models and leaves other model defaults unchanged", () => {
    const base: ModelProfile = {
      id: "gpt-5.6-terra",
      providerId: "gateway",
      displayName: "GPT 5.6 Terra",
      contextWindow: 500_000,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: true,
      supportsReasoningSummary: true,
      role: "reasoning" as const
    };
    const configured = withGptReasoningCapabilities(base);

    expect(isConfigurableGptReasoningModel({ ...base, id: "gpt-5.4" })).toBe(true);
    expect(isConfigurableGptReasoningModel(configured)).toBe(true);
    expect(configured.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(configured.defaultReasoningEffort).toBe("medium");
    expect(resolveModelReasoningEffort(configured, "xhigh")).toBe("xhigh");
    expect(isConfigurableGptReasoningModel({ ...base, id: "gpt-4.1-mini" })).toBe(false);
    expect(isConfigurableGptReasoningModel({ ...base, id: "grok-4.5" })).toBe(false);
    expect(isConfigurableGptReasoningModel({ ...base, id: "claude-opus-4-5" })).toBe(false);
    expect(isConfigurableGptReasoningModel({ ...base, role: "image" })).toBe(false);
    expect(resolveModelReasoningEffort({ ...base, id: "claude-opus-4-5", defaultReasoningEffort: "high" }, "low")).toBe("high");
  });

  it("migrates legacy response tones to a supported option", () => {
    expect(normalizeResponseTone("standard")).toBe("concise");
    expect(normalizeResponseTone("cute_lolita")).toBe("friendly");
    expect(normalizeResponseTone("mature_lady")).toBe("friendly");
  });

  it("keeps same-named models from different providers", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-models-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    const config = defaultConfig();
    const sourceModel = config.models.find((model) => model.providerId === "openai");
    expect(sourceModel).toBeDefined();

    config.models.push({ ...sourceModel!, providerId: "anthropic" });
    await saveConfig(configFile, config);

    const loaded = await loadConfig(configFile);
    expect(loaded.models.filter((model) => model.id === sourceModel!.id)).toEqual([
      expect.objectContaining({ providerId: "openai" }),
      expect.objectContaining({ providerId: "anthropic" })
    ]);
  });

  it("preserves deleted built-in providers and models", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-model-migration-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "config.toml");
    const config = defaultConfig();
    config.providers = config.providers.filter((provider) => provider.id === "mock" || provider.id === "anthropic");
    config.models = config.models.filter((model) => model.providerId === "mock" || model.providerId === "anthropic");
    const anthropic = config.providers.find((provider) => provider.id === "anthropic")!;
    anthropic.baseUrl = "https://proxy.example/anthropic";
    await saveConfig(configFile, config);

    const loaded = await loadConfig(configFile);

    expect(loaded.providers).toEqual([
      expect.objectContaining({ id: "mock" }),
      expect.objectContaining({ id: "anthropic", baseUrl: "https://proxy.example/anthropic" })
    ]);
    expect(loaded.models.map((model) => model.providerId)).toEqual(
      expect.arrayContaining(["mock", "anthropic"])
    );
    expect(loaded.providers.some((provider) => provider.id === "xai")).toBe(false);
    expect(loaded.models.some((model) => model.providerId === "xai")).toBe(false);
  });
});
