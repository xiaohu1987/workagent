import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCodexPatch } from "../packages/tool-runtime/src/handlers/applyPatch";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-patch-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("applyCodexPatch", () => {
  it("adds and updates files using codex patch grammar", async () => {
    const root = await makeTempDir();
    const original = path.join(root, "note.txt");
    await fs.writeFile(original, "hello\nworld\n", "utf8");

    await applyCodexPatch(
      `*** Begin Patch
*** Update File: note.txt
@@
 world
+patched
*** Add File: nested/new.txt
+new file
*** End Patch
`,
      root
    );

    const updated = await fs.readFile(original, "utf8");
    const added = await fs.readFile(path.join(root, "nested", "new.txt"), "utf8");

    expect(updated).toContain("patched");
    expect(added).toBe("new file\n");
  });
});
