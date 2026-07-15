import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVersionGreater, UpdateService } from "../apps/desktop/src/main/update-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("update version comparison", () => {
  it("recognizes a newer semantic version", () => {
    expect(isVersionGreater("1.1.3", "1.0.0")).toBe(true);
    expect(isVersionGreater("1.0.1", "1.0.0")).toBe(true);
  });

  it("does not offer equal or older versions", () => {
    expect(isVersionGreater("1.0.0", "1.0.0")).toBe(false);
    expect(isVersionGreater("0.9.9", "1.0.0")).toBe(false);
  });

  it("handles prerelease versions without treating them as newer than a stable release", () => {
    expect(isVersionGreater("1.1.0-beta.1", "1.1.0")).toBe(false);
    expect(isVersionGreater("1.1.0", "1.1.0-beta.1")).toBe(true);
  });

  it("rejects an HTML response instead of saving it as an installer", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-update-test-"));
    temporaryDirectories.push(cacheDir);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version_code: "1.0.1",
        download_url: "http://updates.example.test/CodeXH-Setup.exe"
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("<html>not an installer</html>", {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "31" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const updates = new UpdateService({
      currentVersion: "1.0.0",
      isPackaged: true,
      cacheDir,
      executablePath: "C:\\Program Files\\CodeXH\\CodeXH.exe",
      getRunningTaskCount: () => 0,
      log: async () => undefined,
      emit: () => undefined,
      quit: () => undefined
    });

    await updates.check();
    const result = await updates.download(true);

    expect(result).toMatchObject({
      phase: "error",
      error: expect.stringContaining("网页而不是 Windows 安装包")
    });
    await expect(fs.readdir(path.join(cacheDir, "updates"))).resolves.toEqual([]);
  });
});
