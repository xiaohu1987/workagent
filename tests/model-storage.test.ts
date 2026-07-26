import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "../apps/desktop/src/main/storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("model configuration storage", () => {
  it("ships selectable Claude and Grok defaults without replacing the current default", () => {
    const config = defaultConfig();

    expect(config.defaultModel).toBe("mock-codexh");
    expect(config.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anthropic", baseUrl: "https://api.anthropic.com/v1" }),
      expect.objectContaining({ id: "xai", transport: "responses", baseUrl: "https://api.x.ai/v1" })
    ]));
    expect(config.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claude-sonnet-4-20250514", providerId: "anthropic", defaultReasoningEffort: "medium" }),
      expect.objectContaining({ id: "grok-4-0709", providerId: "xai", defaultReasoningEffort: "high" })
    ]));
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

  it("adds newly shipped defaults to an existing config without replacing user entries", async () => {
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

    expect(loaded.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anthropic", baseUrl: "https://proxy.example/anthropic" }),
      expect.objectContaining({ id: "xai", transport: "responses" })
    ]));
    expect(loaded.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "grok-4-0709", providerId: "xai" })
    ]));
  });
});
