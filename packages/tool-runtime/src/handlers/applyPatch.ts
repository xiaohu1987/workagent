import { createHash, randomUUID } from "node:crypto";
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
  transaction: {
    committed: true;
    files: Array<{
      path: string;
      beforeSha256: string | null;
      afterSha256: string | null;
    }>;
  };
  snapshots: Array<{
    path: string;
    before: string;
    after: string;
    beforeTruncated: boolean;
    afterTruncated: boolean;
  }>;
}

export interface ApplyPatchOptions {
  /** File versions recorded by the current Agent turn after a successful read. */
  expectedVersions?: ReadonlyMap<string, string> | Record<string, string>;
  /** Test seam for deterministic commit and rollback failure coverage. */
  fileSystem?: PatchFileSystem;
}

export interface PatchFileSystem {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  writeFile(filePath: string, content: string, encoding: "utf8"): Promise<void>;
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

export class PatchApplyError extends Error {
  public constructor(
    message: string,
    public readonly code: "preflight_failed" | "version_conflict" | "commit_failed",
    public readonly operationIndex?: number,
    public readonly affectedPaths: string[] = [],
    public readonly rollbackSucceeded?: boolean
  ) {
    super(message);
    this.name = "PatchApplyError";
  }
}

type PlannedFile = {
  path: string;
  displayPath: string;
  /** Original bytes at this physical path, used only for rollback and version metadata. */
  restore: string | null;
  before: string | null;
  after: string | null;
  action: PatchFileChange["action"];
  change: PatchFileChange;
};

const NODE_FILE_SYSTEM: PatchFileSystem = {
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  writeFile: (filePath, content, encoding) => fs.writeFile(filePath, content, encoding),
  mkdir: (directory, options) => fs.mkdir(directory, options),
  rm: (filePath, options) => fs.rm(filePath, options),
  rename: (source, destination) => fs.rename(source, destination)
};

export async function applyCodexPatch(
  patchText: string,
  rootDir: string,
  options: ApplyPatchOptions = {}
): Promise<ApplyPatchResult> {
  const operations = parsePatch(patchText);
  const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
  const planned = await preflightPatch(operations, rootDir, fileSystem, options.expectedVersions);
  await commitPatch(planned, fileSystem);

  return {
    touched: planned.map((entry) => entry.path),
    changes: planned.map((entry) => entry.change),
    transaction: {
      committed: true,
      files: planned.map((entry) => ({
        path: entry.displayPath,
        beforeSha256: entry.restore === null ? null : sha256(entry.restore),
        afterSha256: entry.after === null ? null : sha256(entry.after)
      }))
    },
    snapshots: planned.map((entry) => createSnapshot(entry.displayPath, entry.before ?? "", entry.after ?? ""))
  };
}

async function preflightPatch(
  operations: PatchOperation[],
  rootDir: string,
  fileSystem: PatchFileSystem,
  expectedVersions?: ApplyPatchOptions["expectedVersions"]
): Promise<PlannedFile[]> {
  const planned: PlannedFile[] = [];
  const occupiedPaths = new Set<string>();

  for (const [operationIndex, operation] of operations.entries()) {
    const sourcePath = resolveWorkspacePath(rootDir, operation.file);
    const targetPath = operation.type === "update"
      ? resolveWorkspacePath(rootDir, operation.moveTo ?? operation.file)
      : sourcePath;
    const claimed = new Set([sourcePath, targetPath]);
    if ([...claimed].some((candidate) => occupiedPaths.has(candidate))) {
      throw new PatchApplyError(
        `Patch operation ${operationIndex + 1} conflicts with another operation targeting ${operation.file}.`,
        "preflight_failed",
        operationIndex,
        [...claimed]
      );
    }
    for (const candidate of claimed) occupiedPaths.add(candidate);

    if (operation.type === "add") {
      if (await fileExists(sourcePath, fileSystem)) {
        throw new PatchApplyError(`Cannot add ${operation.file}: the file already exists.`, "preflight_failed", operationIndex, [sourcePath]);
      }
      const language = languageFromPath(operation.file);
      const symbols = language
        ? (await extractSymbols(operation.content, language)).map((symbol) => ({ name: symbol.name, kind: symbol.kind, change: "added" as const }))
        : undefined;
      planned.push({
        path: sourcePath,
        displayPath: normalizeDisplayPath(operation.file),
        restore: null,
        before: null,
        after: operation.content,
        action: "add",
        change: {
          path: normalizeDisplayPath(operation.file), action: "add", symbols,
          additions: operation.content.split("\n").filter(Boolean).length, deletions: 0,
          applyMode: language ? "ast" : "text"
        }
      });
      continue;
    }

    let before: string;
    try {
      before = await fileSystem.readFile(sourcePath, "utf8");
    } catch {
      throw new PatchApplyError(`Cannot ${operation.type} ${operation.file}: the file does not exist or is unreadable.`, "preflight_failed", operationIndex, [sourcePath]);
    }
    assertExpectedVersion(sourcePath, operation.file, before, expectedVersions, operationIndex);

    if (operation.type === "delete") {
      const language = languageFromPath(operation.file);
      const symbols = language
        ? (await extractSymbols(before, language)).map((symbol) => ({ name: symbol.name, kind: symbol.kind, change: "removed" as const }))
        : undefined;
      planned.push({
        path: sourcePath,
        displayPath: normalizeDisplayPath(operation.file),
        restore: before,
        before,
        after: null,
        action: "delete",
        change: { path: normalizeDisplayPath(operation.file), action: "delete", symbols, additions: 0, deletions: 0, applyMode: language ? "ast" : "text" }
      });
      continue;
    }

    if (targetPath !== sourcePath && await fileExists(targetPath, fileSystem)) {
      throw new PatchApplyError(`Cannot move ${operation.file}: destination ${operation.moveTo} already exists.`, "preflight_failed", operationIndex, [sourcePath, targetPath]);
    }
    const applied = await applyHunks(before, operation.hunks, operation.file);
    const entityDiff = await astDiffSources(before, applied.content, operation.file);
    planned.push({
      path: targetPath,
      displayPath: normalizeDisplayPath(operation.moveTo ?? operation.file),
      restore: targetPath === sourcePath ? before : null,
      before,
      after: applied.content,
      action: "update",
      change: {
        path: normalizeDisplayPath(operation.moveTo ?? operation.file), action: "update",
        symbols: entityDiff.entities.map((entity) => ({ name: entity.name, kind: entity.kind, change: entity.change })),
        additions: applied.additions, deletions: applied.deletions, applyMode: applied.applyMode
      }
    });
    if (targetPath !== sourcePath) {
      planned.push({
        path: sourcePath,
        displayPath: normalizeDisplayPath(operation.file),
        restore: before,
        before,
        after: null,
        action: "delete",
        change: { path: normalizeDisplayPath(operation.file), action: "delete", additions: 0, deletions: 0, applyMode: languageFromPath(operation.file) ? "ast" : "text" }
      });
    }
  }
  return planned;
}

async function commitPatch(planned: PlannedFile[], fileSystem: PatchFileSystem): Promise<void> {
  const staged = new Map<string, string>();
  try {
    for (const entry of planned) {
      if (entry.after === null) continue;
      await fileSystem.mkdir(path.dirname(entry.path), { recursive: true });
      const temporary = `${entry.path}.codexh-${randomUUID()}.tmp`;
      await fileSystem.writeFile(temporary, entry.after, "utf8");
      staged.set(entry.path, temporary);
    }

    for (const entry of planned) {
      const temporary = staged.get(entry.path);
      if (temporary) await fileSystem.rename(temporary, entry.path);
      if (entry.after === null) await fileSystem.rm(entry.path, { force: true });
    }
  } catch (error) {
    const rollbackSucceeded = await rollbackPatch(planned, fileSystem);
    throw new PatchApplyError(
      `Patch commit failed: ${error instanceof Error ? error.message : String(error)}. ${rollbackSucceeded ? "All prior files were restored." : "Rollback could not restore every file."}`,
      "commit_failed",
      undefined,
      planned.map((entry) => entry.path),
      rollbackSucceeded
    );
  } finally {
    await Promise.all([...staged.values()].map((temporary) => fileSystem.rm(temporary, { force: true }).catch(() => undefined)));
  }
}

async function rollbackPatch(planned: PlannedFile[], fileSystem: PatchFileSystem): Promise<boolean> {
  let succeeded = true;
  for (const entry of [...planned].reverse()) {
    try {
      if (entry.restore === null) {
        await fileSystem.rm(entry.path, { force: true });
      } else {
        await fileSystem.mkdir(path.dirname(entry.path), { recursive: true });
        await fileSystem.writeFile(entry.path, entry.restore, "utf8");
      }
    } catch {
      succeeded = false;
    }
  }
  return succeeded;
}

async function fileExists(filePath: string, fileSystem: PatchFileSystem): Promise<boolean> {
  try {
    await fileSystem.readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

function assertExpectedVersion(
  absolutePath: string,
  displayPath: string,
  content: string,
  expectedVersions: ApplyPatchOptions["expectedVersions"],
  operationIndex: number
): void {
  const expected = expectedVersions && typeof (expectedVersions as ReadonlyMap<string, string>).get === "function"
    ? (expectedVersions as ReadonlyMap<string, string>).get(absolutePath) ?? (expectedVersions as ReadonlyMap<string, string>).get(displayPath)
    : expectedVersions
      ? (expectedVersions as Record<string, string>)[absolutePath] ?? (expectedVersions as Record<string, string>)[displayPath]
      : undefined;
  if (expected && expected !== sha256(content)) {
    throw new PatchApplyError(
      `File version conflict for ${displayPath}. Re-read the file before applying a new patch.`,
      "version_conflict",
      operationIndex,
      [absolutePath]
    );
  }
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const SNAPSHOT_TEXT_LIMIT = 512_000;

function createSnapshot(path: string, before: string, after: string): ApplyPatchResult["snapshots"][number] {
  return {
    path: path.replace(/\\/g, "/"),
    before: before.slice(0, SNAPSHOT_TEXT_LIMIT),
    after: after.slice(0, SNAPSHOT_TEXT_LIMIT),
    beforeTruncated: before.length > SNAPSHOT_TEXT_LIMIT,
    afterTruncated: after.length > SNAPSHOT_TEXT_LIMIT
  };
}

function resolveWorkspacePath(rootDir: string, targetPath: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(root, targetPath);
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
