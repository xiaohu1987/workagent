import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOkfBundle, extractDocument, extractDocumentBuffer, extractHtmlReadableText } from "@knowledge-runtime";

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
    const sourceMarkdown = await fs.readFile(path.join(bundleRoot, "source_docs", "design-1.md"), "utf8");

    expect(indexContent).toContain("Knowledge Bundle");
    expect(conceptContent).toContain('okf_version: "0.1"');
    expect(conceptContent).toContain('local_markdown_path: "source_docs/design-1.md"');
    expect(sourceMarkdown).toContain('format: "downloaded-markdown"');
    expect(sourceMarkdown).toContain("This document describes the API contract.");
    expect(built.concepts[0]?.title).toBe("design");
  });

  it("extracts a remote HTML document while preserving its URL source", async () => {
    const document = await extractDocumentBuffer(
      Buffer.from("<html><head><title>Ignored</title></head><body><h1>Remote guide</h1><p>Readable body text.</p></body></html>"),
      "https://docs.example.com/guides/start.html?source=kb",
      { title: "Start guide", mimeHint: "text/html" }
    );

    expect(document.title).toBe("Start guide");
    expect(document.sourcePath).toBe("https://docs.example.com/guides/start.html?source=kb");
    expect(document.body).toContain("Remote guide");
    expect(document.mimeHint).toBe("text/html");
  });

  it("keeps HTML tables and preformatted Markdown on separate lines", () => {
    const body = extractHtmlReadableText([
      "<h1>Plan</h1>",
      "<table><tr><th>ID</th><th>Task</th></tr><tr><td>T1</td><td>Build</td></tr></table>",
      "<pre>| ID | Task |\n| --- | --- |\n| T2 | Test |</pre>"
    ].join(""));

    expect(body).toContain("| ID | Task |\n| --- | --- |\n| T1 | Build |");
    expect(body).toContain("| T2 | Test |");
  });

  it("uses the provided MIME-derived extension when a remote URL has no file suffix", async () => {
    const document = await extractDocumentBuffer(
      Buffer.from('{"service":"knowledge","enabled":true}'),
      "https://files.example.com/download?id=42",
      { mimeHint: "application/json", extension: ".json" }
    );

    expect(document.body).toContain('"service": "knowledge"');
    expect(document.mimeHint).toBe("application/json");
  });
});
