import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOkfBundle, extractDocument } from "@knowledge-runtime";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-okf-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildOkfBundle", () => {
  it("creates index.md and concept files from documents", async () => {
    const root = await makeTempDir();
    const sourceFile = path.join(root, "design.md");
    await fs.writeFile(sourceFile, "# Design\n\nThis document describes the API contract.", "utf8");

    const document = await extractDocument(sourceFile);
    const bundleRoot = path.join(root, "bundle");
    const built = await buildOkfBundle({
      bundleRoot,
      knowledgeBaseId: "kb-1",
      importRunId: "import-1",
      documents: [document]
    });

    const indexContent = await fs.readFile(path.join(bundleRoot, "index.md"), "utf8");
    const conceptContent = await fs.readFile(path.join(bundleRoot, built.concepts[0]!.bundleRelativePath), "utf8");

    expect(indexContent).toContain("Knowledge Bundle");
    expect(conceptContent).toContain('okf_version: "0.1"');
    expect(built.concepts[0]?.title).toBe("design");
  });
});
