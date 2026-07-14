import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import JSZip from "jszip";

export interface ExtractedDocument {
  title: string;
  body: string;
  sourcePath: string;
  sourceHash: string;
  mimeHint: string;
}

export async function extractDocument(sourcePath: string): Promise<ExtractedDocument> {
  const raw = await fs.readFile(sourcePath);
  return extractDocumentBuffer(raw, sourcePath);
}

export async function extractDocumentBuffer(
  raw: Buffer,
  sourcePath: string,
  options: { mimeHint?: string; title?: string; extension?: string } = {}
): Promise<ExtractedDocument> {
  const sourceFilePath = /^https?:\/\//i.test(sourcePath) ? new URL(sourcePath).pathname : sourcePath;
  const extension = (options.extension || path.extname(sourceFilePath)).toLowerCase();
  const sourceHash = createHash("sha256").update(raw).digest("hex");

  let body = "";
  let mimeHint = "text/plain";

  switch (extension) {
    case ".md":
    case ".txt":
      body = raw.toString("utf8");
      break;
    case ".json":
      body = JSON.stringify(JSON.parse(raw.toString("utf8")), null, 2);
      mimeHint = "application/json";
      break;
    case ".html":
    case ".htm": {
      body = extractHtmlReadableText(raw.toString("utf8"));
      mimeHint = "text/html";
      break;
    }
    case ".csv": {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(raw, { type: "buffer" });
      body = workbook.SheetNames.map((name) => {
        const worksheet = workbook.Sheets[name];
        return `# ${name}\n${XLSX.utils.sheet_to_csv(worksheet)}`;
      }).join("\n\n");
      mimeHint = "text/csv";
      break;
    }
    case ".xlsx":
    case ".xls": {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(raw, { type: "buffer" });
      body = workbook.SheetNames.map((name) => {
        const worksheet = workbook.Sheets[name];
        return `# ${name}\n${XLSX.utils.sheet_to_csv(worksheet)}`;
      }).join("\n\n");
      mimeHint = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      break;
    }
    case ".docx": {
      const { default: mammoth } = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: raw });
      body = result.value;
      mimeHint = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      break;
    }
    case ".pdf": {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: raw });
      const result = await parser.getText();
      body = result.text;
      mimeHint = "application/pdf";
      break;
    }
    case ".pptx": {
      body = await extractPptxText(raw);
      mimeHint = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      break;
    }
    default:
      body = raw.toString("utf8");
      break;
  }

  return {
    title: options.title?.trim() || path.basename(sourceFilePath, extension),
    body: body.trim(),
    sourcePath,
    sourceHash,
    mimeHint: options.mimeHint || mimeHint
  };
}

export function extractHtmlReadableText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, svg").remove();

  $("table").each((_index, table) => {
    const rows = $(table).find("tr").toArray().map((row) =>
      $(row).find("th, td").toArray().map((cell) =>
        $(cell).text().replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")
      )
    ).filter((row) => row.length > 0);
    if (rows.length === 0) {
      $(table).remove();
      return;
    }
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    const markdown = [
      `| ${normalized[0].join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`)
    ].join("\n");
    $(table).replaceWith(`\n\n${markdown}\n\n`);
  });

  $("br").replaceWith("\n");
  $("h1, h2, h3, h4, h5, h6, p, div, section, article, header, footer, main, aside, li, pre, blockquote")
    .each((_index, element) => {
      $(element).before("\n\n");
      $(element).after("\n\n");
    });

  return $("body").text()
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((file) => file.startsWith("ppt/slides/slide") && file.endsWith(".xml"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const slides: string[] = [];
  for (const file of slideFiles) {
    const xml = await zip.file(file)?.async("string");
    if (!xml) {
      continue;
    }

    const texts = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map((match) => decodeXml(match[1]));
    slides.push(texts.join("\n"));
  }

  return slides.join("\n\n");
}

function decodeXml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
