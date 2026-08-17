import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectDirectoryEntries } from "../apps/desktop/src/main/project-files";

describe("project directory listing", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    ));
  });

  it("loads only one directory level and keeps every root folder visible", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-project-files-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "api", "nested"), { recursive: true });
    await fs.mkdir(path.join(root, "web"));
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "api", "nested", "deep.ts"), "deep");
    await fs.writeFile(path.join(root, "api", "index.ts"), "api");

    expect(await listProjectDirectoryEntries(root)).toEqual([
      { path: "api", kind: "directory" },
      { path: "web", kind: "directory" }
    ]);
    expect(await listProjectDirectoryEntries(root, "api")).toEqual([
      { path: "api/index.ts", kind: "file" },
      { path: "api/nested", kind: "directory" }
    ]);
  });

  it("rejects directory traversal outside the project root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-project-files-"));
    temporaryDirectories.push(root);
    await expect(listProjectDirectoryEntries(root, "../outside")).rejects.toThrow(
      "outside the project folder"
    );
  });
});
