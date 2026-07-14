import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeConcept } from "@shared-types";
import type { ExtractedDocument } from "./extractors";

export interface BuildOkfBundleOptions {
  bundleRoot: string;
  knowledgeBaseId: string;
  importRunId: string;
  documents: ExtractedDocument[];
  now?: Date;
}

export interface OkfBuildResult {
  concepts: KnowledgeConcept[];
  indexPath: string;
  bundleRoot: string;
}

export async function buildOkfBundle(options: BuildOkfBundleOptions): Promise<OkfBuildResult> {
  const now = (options.now ?? new Date()).toISOString();
  await fs.mkdir(options.bundleRoot, { recursive: true });
  await fs.mkdir(path.join(options.bundleRoot, "references"), { recursive: true });
  await fs.mkdir(path.join(options.bundleRoot, "source_docs"), { recursive: true });

  const concepts: KnowledgeConcept[] = [];

  for (const [index, document] of options.documents.entries()) {
    const conceptId = `${options.knowledgeBaseId}-concept-${index + 1}`;
    const fileStem = `${safeFileStem(document.title) || "document"}-${index + 1}`;
    const sourceRelativePath = path.join("source_docs", `${fileStem}.md`);
    const sourceDocumentPath = path.join(options.bundleRoot, sourceRelativePath);
    const bundleRelativePath = path.join("references", `${fileStem}.md`);
    const conceptPath = path.join(options.bundleRoot, bundleRelativePath);
    const description = summarize(document.body);
    const concept = {
      id: conceptId,
      knowledgeBaseId: options.knowledgeBaseId,
      sourceDocumentId: `${options.importRunId}-source-${index + 1}`,
      type: "Reference",
      title: document.title,
      description,
      tags: inferTags(document.sourcePath, document.body),
      sourcePath: document.sourcePath,
      bundleRelativePath,
      body: document.body,
      createdAt: now
    } satisfies KnowledgeConcept;

    const frontmatter = [
      "---",
      "type: Reference",
      `title: ${yamlEscape(concept.title)}`,
      `description: ${yamlEscape(concept.description)}`,
      `tags: [${concept.tags.map((tag) => yamlEscape(tag)).join(", ")}]`,
      `timestamp: ${now}`,
      `source_path: ${yamlEscape(concept.sourcePath)}`,
      `local_markdown_path: ${yamlEscape(sourceRelativePath.replace(/\\/g, "/"))}`,
      `source_hash: ${document.sourceHash}`,
      `import_run_id: ${options.importRunId}`,
      'okf_version: "0.1"',
      "---",
      "",
      concept.body,
      ""
    ].join("\n");

    const sourceMarkdown = [
      "---",
      `title: ${yamlEscape(document.title)}`,
      `source_path: ${yamlEscape(document.sourcePath)}`,
      `source_hash: ${document.sourceHash}`,
      `import_run_id: ${options.importRunId}`,
      'format: "downloaded-markdown"',
      "---",
      "",
      document.body,
      ""
    ].join("\n");

    await fs.writeFile(sourceDocumentPath, sourceMarkdown, "utf8");
    await fs.writeFile(conceptPath, frontmatter, "utf8");
    concepts.push(concept);
  }

  const indexPath = path.join(options.bundleRoot, "index.md");
  const indexBody = [
    "# Knowledge Bundle",
    "",
    ...concepts.map(
      (concept) => `- [${concept.title}](${concept.bundleRelativePath.replace(/\\/g, "/")}) - ${concept.description}`
    ),
    ""
  ].join("\n");
  await fs.writeFile(indexPath, indexBody, "utf8");

  return {
    concepts,
    indexPath,
    bundleRoot: options.bundleRoot
  };
}

function summarize(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 160) || "Imported reference";
}

function inferTags(sourcePath: string, body: string): string[] {
  const extension = path.extname(sourcePath).replace(/^\./, "");
  const tags = new Set<string>([extension || "text"]);

  if (/api|interface|endpoint/i.test(body)) {
    tags.add("api");
  }
  if (/spec|requirement|design/i.test(body)) {
    tags.add("spec");
  }
  if (/runbook|playbook|operation/i.test(body)) {
    tags.add("playbook");
  }

  return [...tags];
}

function safeFileStem(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function yamlEscape(value: string): string {
  return JSON.stringify(value);
}
