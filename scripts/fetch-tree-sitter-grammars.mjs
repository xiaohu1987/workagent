import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets", "tree-sitter-grammars");

const GRAMMARS = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-c_sharp.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-c.wasm",
  "tree-sitter-cpp.wasm",
  "tree-sitter-kotlin.wasm",
  "tree-sitter-php.wasm",
  "tree-sitter-ruby.wasm"
];

const WASM_BASE = "https://unpkg.com/tree-sitter-wasms@0.1.13/out";
const CORE_WASM_CANDIDATES = [
  "https://unpkg.com/web-tree-sitter@0.25.10/tree-sitter.wasm",
  "https://cdn.jsdelivr.net/npm/web-tree-sitter@0.25.10/tree-sitter.wasm"
];

async function download(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(targetPath));
}

async function ensureFile(url, targetPath, label) {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.size > 0) {
      console.log(`skip ${label}`);
      return;
    }
  } catch {
    // missing
  }
  console.log(`download ${label}`);
  await download(url, targetPath);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  let coreOk = false;
  for (const url of CORE_WASM_CANDIDATES) {
    try {
      await ensureFile(url, path.join(outDir, "tree-sitter.wasm"), "tree-sitter.wasm");
      coreOk = true;
      break;
    } catch (error) {
      console.warn(String(error));
    }
  }
  if (!coreOk) {
    throw new Error("Unable to download tree-sitter.wasm");
  }

  for (const fileName of GRAMMARS) {
    await ensureFile(`${WASM_BASE}/${fileName}`, path.join(outDir, fileName), fileName);
  }

  console.log(`Grammars ready in ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
