import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8")
  },
  shell: { openExternal: vi.fn() }
}));

import { McpCredentialStore } from "../apps/desktop/src/main/mcp-oauth";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function createStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const encoded = value.toString("utf8");
      if (!encoded.startsWith("cipher:")) throw new Error("decryption failed");
      return encoded.slice("cipher:".length);
    }
  };
}

async function createCredentialFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-credentials-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "credentials.json");
}

describe("McpCredentialStore", () => {
  it("persists a database password for a newly created store instance", async () => {
    const filePath = await createCredentialFile();
    const secureStorage = createStorage();
    const firstRun = new McpCredentialStore(filePath, secureStorage);

    await firstRun.write("database:reporting", "correct horse battery staple");

    const restarted = new McpCredentialStore(filePath, secureStorage);
    await expect(restarted.read<string>("database:reporting")).resolves.toBe("correct horse battery staple");
    await expect(restarted.has("database:reporting")).resolves.toBe(true);
  });

  it("does not show an undecryptable credential as saved", async () => {
    const filePath = await createCredentialFile();
    await fs.writeFile(filePath, JSON.stringify({
      "database:reporting": Buffer.from("not-a-valid-cipher", "utf8").toString("base64")
    }), "utf8");
    const credentials = new McpCredentialStore(filePath, createStorage());

    await expect(credentials.has("database:reporting")).resolves.toBe(false);
    await expect(credentials.read("database:reporting")).rejects.toThrow("cannot be decrypted");
  });

  it("serializes overlapping writes so one credential cannot erase another", async () => {
    const filePath = await createCredentialFile();
    const credentials = new McpCredentialStore(filePath, createStorage());

    await Promise.all([
      credentials.write("database:first", "first"),
      credentials.write("database:second", "second")
    ]);

    const restarted = new McpCredentialStore(filePath, createStorage());
    await expect(restarted.read<string>("database:first")).resolves.toBe("first");
    await expect(restarted.read<string>("database:second")).resolves.toBe("second");
  });
});
