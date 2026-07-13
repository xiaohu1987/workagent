import fs from "node:fs/promises";
import path from "node:path";
import {
  applyLocatedHunk,
  astDiffSources,
  countHunkEdits,
  extractSymbols,
  languageFromPath,
  locateHunk,
  type EntityChange
} from "../ast";

type PatchOperation =
  | {
      type: "add";
      file: string;
      content: string;
    }
  | {
      type: "delete";
      file: string;
    }
  | {
      type: "update";
      file: string;
      moveTo?: string;
      hunks: Array<{
        lines: string[];
      }>;
    };

export type PatchApplyMode = "ast" | "text";

export interface PatchFileChange {
  path: string;
  action: "add" | "update" | "delete";
  symbols?: Array<{ name: string; kind: string; change: EntityChange["change"] }>;
  additions: number;
  deletions: number;
  applyMode: PatchApplyMode;
}

export interface ApplyPatchResult {
  touched: string[];
  changes: PatchFileChange[];
}

export async function applyCodexPatch(patchText: string, rootDir: string): Promise<ApplyPatchResult> {
  const operations = parsePatch(patchText);
  const touched: string[] = [];
  const changes: PatchFileChange[] = [];

  for (const operation of operations) {
    if (operation.type === "add") {
      const filePath = resolveWorkspacePath(rootDir, operation.file);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, operation.content, "utf8");
      touched.push(filePath);
      const language = languageFromPath(operation.file);
      let symbols: PatchFileChange["symbols"];
      if (language) {
        const extracted = await extractSymbols(operation.content, language);
        symbols = extracted.map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          change: "added" as const
        }));
      }
      changes.push({
        path: operation.file,
        action: "add",
        symbols,
        additions: operation.content.split("\n").filter((line) => line.length > 0).length,
        deletions: 0,
        applyMode: language ? "ast" : "text"
      });
      continue;
    }

    if (operation.type === "delete") {
      const filePath = resolveWorkspacePath(rootDir, operation.file);
      let symbols: PatchFileChange["symbols"];
      const language = languageFromPath(operation.file);
      try {
        const previous = await fs.readFile(filePath, "utf8");
        if (language) {
          const extracted = await extractSymbols(previous, language);
          symbols = extracted.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            change: "removed" as const
          }));
        }
      } catch {
        // file may already be missing
      }
      await fs.rm(filePath, { recursive: true, force: true });
      touched.push(filePath);
      changes.push({
        path: operation.file,
        action: "delete",
        symbols,
        additions: 0,
        deletions: 0,
        applyMode: language ? "ast" : "text"
      });
      continue;
    }

    const sourcePath = resolveWorkspacePath(rootDir, operation.file);
    const nextPath = resolveWorkspacePath(rootDir, operation.moveTo ?? operation.file);
    const current = await fs.readFile(sourcePath, "utf8");
    const applied = await applyHunks(current, operation.hunks, operation.file);
    await fs.mkdir(path.dirname(nextPath), { recursive: true });
    await fs.writeFile(nextPath, applied.content, "utf8");
    if (operation.moveTo && nextPath !== sourcePath) {
      await fs.rm(sourcePath, { force: true });
    }
    touched.push(nextPath);

    const entityDiff = await astDiffSources(current, applied.content, operation.file);
    changes.push({
      path: operation.moveTo ?? operation.file,
      action: "update",
      symbols: entityDiff.entities.map((entity) => ({
        name: entity.name,
        kind: entity.kind,
        change: entity.change
      })),
      additions: applied.additions,
      deletions: applied.deletions,
      applyMode: applied.applyMode
    });
  }

  return { touched, changes };
}

function resolveWorkspacePath(rootDir: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    throw new Error("Patch paths must be relative to the project folder.");
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error("Patch path is outside the project folder.");
}

function parsePatch(patchText: string): PatchOperation[] {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch");
  }

  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }
    if (line === "*** End Patch") {
      break;
    }
    if (line.startsWith("*** Add File: ")) {
      const file = line.slice("*** Add File: ".length);
      index += 1;
      const content: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const raw = lines[index];
        if (!raw.startsWith("+")) {
          throw new Error(`Added file ${file} contains a non-add line.`);
        }
        content.push(raw.slice(1));
        index += 1;
      }
      operations.push({ type: "add", file, content: content.join("\n") + "\n" });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", file: line.slice("*** Delete File: ".length) });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const file = line.slice("*** Update File: ".length);
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index].slice("*** Move to: ".length);
        index += 1;
      }
      const hunks: Array<{ lines: string[] }> = [];
      let currentHunk: string[] = [];
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const hunkLine = lines[index];
        if (hunkLine.startsWith("@@")) {
          if (currentHunk.length > 0) {
            hunks.push({ lines: currentHunk });
          }
          currentHunk = [];
        } else {
          currentHunk.push(hunkLine);
        }
        index += 1;
      }
      if (currentHunk.length > 0) {
        hunks.push({ lines: currentHunk });
      }
      operations.push({ type: "update", file, moveTo, hunks });
      continue;
    }

    throw new Error(`Unsupported patch line: ${line}`);
  }

  return operations;
}

async function applyHunks(
  original: string,
  hunks: Array<{ lines: string[] }>,
  filePath: string
): Promise<{ content: string; additions: number; deletions: number; applyMode: PatchApplyMode }> {
  let current = original.split("\n");
  // Preserve trailing newline semantics: split keeps final empty string when file ends with \n
  let additions = 0;
  let deletions = 0;
  let applyMode: PatchApplyMode = "text";

  const language = languageFromPath(filePath);
  let symbols = language ? await extractSymbols(original, language) : null;

  for (const hunk of hunks) {
    const counts = countHunkEdits(hunk);
    additions += counts.additions;
    deletions += counts.deletions;

    const location = locateHunk(current, hunk, symbols);
    if (location.mode === "ast") {
      applyMode = "ast";
    }
    current = applyLocatedHunk(current, location);

    // Re-extract symbols after each hunk so later hunks see updated spans
    if (language) {
      symbols = await extractSymbols(current.join("\n"), language);
    }
  }

  return {
    content: current.join("\n"),
    additions,
    deletions,
    applyMode: language ? applyMode : "text"
  };
}
