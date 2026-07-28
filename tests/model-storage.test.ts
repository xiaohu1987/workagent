import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isConfigurableGptReasoningModel, normalizeResponseTone, resolveModelReasoningEffort, withGptReasoningCapabilities } from "@shared-types";
import type { ModelProfile } from "@shared-types";
import { defaultConfig, loadConfig, saveConfig } from "../apps/desktop/src/main/storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("model configuration storage", () => {
  it("ships selectable Claude and Grok defaults without replacing the current default", () => {
    const config = defaultConfig();

    expect(config.defaultModel).toBe("mock-codexh");
    expect(config.responseTone).toBe("concise");
    expect(config.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anthropic", baseUrl: "https://api.anthropic.com/v1" }),
      expect.objectContaining({ id: "xai", transport: "responses", baseUrl: "https://api.x.ai/v1" })
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
