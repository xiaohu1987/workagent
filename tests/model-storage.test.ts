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
});
