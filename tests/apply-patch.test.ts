import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCodexPatch } from "../packages/tool-runtime/src/handlers/applyPatch";
import {
  astDiffSources,
  diffEntities,
  extractSymbolsHeuristic,
  locateHunk
} from "../packages/tool-runtime/src/ast";

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

    const result = await applyCodexPatch(
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
    expect(result.touched).toHaveLength(2);
    expect(result.changes).toHaveLength(2);
  });

  it("rejects patch paths outside the selected project folder", async () => {
    const root = await makeTempDir();

    await expect(
      applyCodexPatch(
        `*** Begin Patch
*** Add File: ../outside.txt
+blocked
*** End Patch
`,
        root
      )
    ).rejects.toThrow("outside the project folder");
  });

  it("uses symbol context to patch the correct duplicate function body", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "dup.ts");
    await fs.writeFile(
      filePath,
      [
        "function alpha() {",
        "  return 1;",
        "}",
        "",
        "function beta() {",
        "  return 1;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await applyCodexPatch(
      `*** Begin Patch
*** Update File: dup.ts
@@
 function beta() {
-  return 1;
+  return 2;
 }
*** End Patch
`,
      root
    );

    const updated = await fs.readFile(filePath, "utf8");
    expect(updated).toContain("function alpha() {\n  return 1;\n}");
    expect(updated).toContain("function beta() {\n  return 2;\n}");
    expect(result.changes[0]?.symbols?.some((symbol) => symbol.name === "beta")).toBe(true);
  });

  it("throws on ambiguous hunks instead of appending to EOF", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "ambig.ts");
    await fs.writeFile(
      filePath,
      [
        "function alpha() {",
        "  return 1;",
        "}",
        "",
        "function beta() {",
        "  return 1;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(
      applyCodexPatch(
        `*** Begin Patch
*** Update File: ambig.ts
@@
-  return 1;
+  return 9;
*** End Patch
`,
        root
      )
    ).rejects.toThrow(/Ambiguous|not found/i);
  });

  it("still patches unsupported extensions with strict text matching", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "notes.md");
    await fs.writeFile(filePath, "title\nbody\n", "utf8");

    const result = await applyCodexPatch(
      `*** Begin Patch
*** Update File: notes.md
@@
 body
+footer
*** End Patch
`,
      root
    );

    expect(await fs.readFile(filePath, "utf8")).toBe("title\nbody\nfooter\n");
    expect(result.changes[0]?.applyMode).toBe("text");
  });
});

describe("ast locate and diff", () => {
  it("locates unique text blocks and rejects ambiguity", () => {
    const lines = ["a", "b", "a", "c"];
    expect(() =>
      locateHunk(lines, { lines: ["-a", "+z"] }, null)
    ).toThrow(/Ambiguous/);

    const located = locateHunk(lines, { lines: [" a", "-b", "+B"] }, null);
    expect(located.start).toBe(0);
    expect(located.replacement).toEqual(["a", "B"]);
  });

  it("diffs typescript entities via heuristic extractor", async () => {
    const before = "export function greet() { return 'hi'; }\n";
    const after = "export function greet() { return 'hello'; }\nexport function wave() { return 'yo'; }\n";
    const result = await astDiffSources(before, after, "src/app.ts");
    expect(result.language).toBe("typescript");
    expect(result.entities.some((entity) => entity.name === "greet" && entity.change === "modified")).toBe(true);
    expect(result.entities.some((entity) => entity.name === "wave" && entity.change === "added")).toBe(true);
  });

  it("extracts python and go symbols", () => {
    const py = extractSymbolsHeuristic("class Foo:\n  def bar(self):\n    return 1\n", "python");
    expect(py.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Foo", "bar"]));

    const go = extractSymbolsHeuristic("func Main() {}\ntype Server struct {}\n", "go");
    expect(go.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Main", "Server"]));
  });

  it("detects renames by identical body hash", () => {
    const left = extractSymbolsHeuristic("function oldName() { return 1; }\n", "javascript");
    const right = extractSymbolsHeuristic("function newName() { return 1; }\n", "javascript");
    const changes = diffEntities(left, right);
    expect(changes.some((change) => change.change === "renamed" && change.previousName === "oldName")).toBe(true);
  });
});
