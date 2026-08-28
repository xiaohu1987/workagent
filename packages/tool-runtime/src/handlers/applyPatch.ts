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
  /** Additional authorized roots. Relative patch paths resolve from rootDir. */
  workspaceRoots?: string[];
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
  const planned = await preflightPatch(operations, rootDir, fileSystem, options.expectedVersions, options.workspaceRoots ?? [rootDir]);
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
  expectedVersions?: ApplyPatchOptions["expectedVersions"],
  workspaceRoots: string[] = [rootDir]
): Promise<PlannedFile[]> {
  const planned: PlannedFile[] = [];
  const occupiedPaths = new Set<string>();

  for (const [operationIndex, operation] of operations.entries()) {
    const sourcePath = resolveWorkspacePath(rootDir, operation.file, workspaceRoots);
    const targetPath = operation.type === "update"
      ? resolveWorkspacePath(rootDir, operation.moveTo ?? operation.file, workspaceRoots)
      : sourcePath;
    if (operation.type === "update" && operation.moveTo && workspaceRootForPath(sourcePath, workspaceRoots) !== workspaceRootForPath(targetPath, workspaceRoots)) {
      throw new PatchApplyError("Cross-workspace moves are not supported.", "preflight_failed", operationIndex, [sourcePath, targetPath]);
    }
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
      if (entry.restore !== null && entry.after === entry.before) continue;
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

function resolveWorkspacePath(rootDir: string, targetPath: string, workspaceRoots: string[]): string {
  const root = path.resolve(rootDir);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(root, targetPath);
  if (workspaceRootForPath(resolved, workspaceRoots)) {
    return resolved;
  }
  throw new Error("Patch path is outside the project folder.");
}

function workspaceRootForPath(targetPath: string, workspaceRoots: string[]): string | null {
  const resolved = path.resolve(targetPath);
  for (const candidate of workspaceRoots) {
    const root = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return root;
  }
  return null;
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
  const lineEnding = original.includes("\r\n") ? "\r\n" : "\n";
  const normalizedOriginal = original.replace(/\r\n?/g, "\n");
  let current = normalizedOriginal.split("\n");
  // Preserve trailing newline semantics: split keeps final empty string when file ends with \n
  let additions = 0;
  let deletions = 0;
  let applyMode: PatchApplyMode = "text";

  const language = languageFromPath(filePath);
  let symbols = language ? await extractSymbols(normalizedOriginal, language) : null;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const normalizedHunk = stripDisplayedLineNumbers(hunks[hunkIndex]);
    const nextHunk = hunks[hunkIndex + 1]
      ? stripDisplayedLineNumbers(hunks[hunkIndex + 1])
      : undefined;
    const repairedPair = repairSplitReplacementHunk(current, normalizedHunk, nextHunk);
    const hunk = repairedPair ?? normalizedHunk;
    if (repairedPair) hunkIndex += 1;
    const prepared = prepareHunk(current, hunk, symbols);
    additions += prepared.additions;
    deletions += prepared.deletions;

    if (prepared.location.mode === "ast") {
      applyMode = "ast";
    }
    current = applyLocatedHunk(current, prepared.location);

    // Re-extract symbols after each hunk so later hunks see updated spans
    if (language) {
      symbols = await extractSymbols(current.join("\n"), language);
    }
  }

  return {
    content: current.join(lineEnding),
    additions,
    deletions,
    applyMode: language ? applyMode : "text"
  };
}

function stripDisplayedLineNumbers(hunk: { lines: string[] }): { lines: string[] } {
  return {
    lines: hunk.lines.map((line) => {
      const prefix = line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")
        ? line[0]
        : "";
      const body = prefix ? line.slice(1) : line;
      const match = /^\s*\d+\|(.*)$/.exec(body);
      return match ? `${prefix}${match[1]}` : line;
    })
  };
}

function repairSplitReplacementHunk(
  current: string[],
  beforeHunk: { lines: string[] },
  afterHunk?: { lines: string[] }
): { lines: string[] } | null {
  if (!afterHunk) return null;

  const before = contextOnlyLines(beforeHunk);
  if (!before || findSequenceStarts(current, before).length !== 1) return null;

  const afterContext = contextOnlyLines(afterHunk);
  const afterAdditions = additionsOnlyLines(afterHunk);
  const desired = afterContext ?? (afterAdditions ? mergePartialReplacement(before, afterAdditions) : null);
  if (!desired || sameLines(before, desired)) return null;

  return {
    lines: [
      ...before.map((line) => `-${line}`),
      ...desired.map((line) => `+${line}`)
    ]
  };
}

function contextOnlyLines(hunk: { lines: string[] }): string[] | null {
  if (countHunkEdits(hunk).additions > 0 || countHunkEdits(hunk).deletions > 0) return null;
  if (!hunk.lines.every((line) => line === "" || line.startsWith(" "))) return null;
  return hunk.lines.map((line) => line === "" ? "" : line.slice(1));
}

function additionsOnlyLines(hunk: { lines: string[] }): string[] | null {
  const counts = countHunkEdits(hunk);
  if (counts.additions === 0 || counts.deletions > 0) return null;
  if (!hunk.lines.every((line) => line.startsWith("+"))) return null;
  return hunk.lines.map((line) => line.slice(1));
}

function mergePartialReplacement(before: string[], additions: string[]): string[] | null {
  if (additions.length === before.length) return additions;
  if (additions.length > before.length) return null;

  const desired = [...before];
  const used = new Set<number>();
  for (const addition of additions) {
    const shape = replacementLineShape(addition);
    if (!shape) return null;
    const matches = before
      .map((line, index) => ({ index, line }))
      .filter(({ index, line }) => !used.has(index) && line !== addition && replacementLineShape(line) === shape);
    if (matches.length !== 1) return null;
    desired[matches[0].index] = addition;
    used.add(matches[0].index);
  }
  return desired;
}

function replacementLineShape(line: string): string {
  return line
    .trim()
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "<text>")
    .replace(/#[0-9a-f]{3,8}\b/gi, "<hex>")
    .replace(/-?\d+(?:\.\d+)?/g, "<number>")
    .replace(/\s+/g, " ");
}

function prepareHunk(
  current: string[],
  hunk: { lines: string[] },
  symbols: Awaited<ReturnType<typeof extractSymbols>> | null
): {
  location: ReturnType<typeof locateHunk>;
  additions: number;
  deletions: number;
} {
  const counts = countHunkEdits(hunk);
  const hasExplicitEdits = counts.additions > 0 || counts.deletions > 0;
  const hasRawSourceLine = hunk.lines.some((line) =>
    line.length > 0 && line[0] !== " " && line[0] !== "+" && line[0] !== "-"
  );

  if (!hasExplicitEdits) {
    if (!hasRawSourceLine) {
      throw new Error("Patch hunk contains no additions or removals.");
    }
    return inferRawDesiredFragment(current, hunk.lines);
  }

  if (hasRawSourceLine) {
    // Some OpenAI-compatible models emit source lines without the required
    // one-character diff prefix. Treat the whole surrounding block as raw
    // source and add the context marker before locating it.
    const repaired = {
      lines: hunk.lines.map((line) => line.startsWith("+") || line.startsWith("-") ? line : ` ${line}`)
    };
    try {
      return { location: locateHunk(current, repaired, symbols), ...counts };
    } catch {
      // Mixed canonical/raw output is less common, but retaining already
      // prefixed context makes it recoverable without weakening matching.
      const minimallyRepaired = {
        lines: hunk.lines.map((line) =>
          line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line : ` ${line}`
        )
      };
      return { location: locateHunk(current, minimallyRepaired, symbols), ...counts };
    }
  }

  try {
    return { location: locateHunk(current, hunk, symbols), ...counts };
  } catch (error) {
    const alreadyApplied = locateAlreadyAppliedHunk(current, hunk);
    if (alreadyApplied) {
      return { location: alreadyApplied, additions: 0, deletions: 0 };
    }
    throw error;
  }
}

function locateAlreadyAppliedHunk(
  current: string[],
  hunk: { lines: string[] }
): ReturnType<typeof locateHunk> | null {
  const counts = countHunkEdits(hunk);
  if (counts.additions === 0 || counts.deletions === 0) return null;

  const oldBlock = hunk.lines
    .filter((line) => line.startsWith(" ") || line.startsWith("-"))
    .map((line) => line.slice(1));
  const desiredBlock = hunk.lines
    .filter((line) => line.startsWith(" ") || line.startsWith("+"))
    .map((line) => line.slice(1));
  if (oldBlock.length === 0 || desiredBlock.length === 0 || sameLines(oldBlock, desiredBlock)) return null;
  if (findSequenceStarts(current, oldBlock).length > 0) return null;

  const desiredMatches = findSequenceStarts(current, desiredBlock);
  if (desiredMatches.length !== 1) return null;
  return { start: desiredMatches[0], deleteCount: 0, replacement: [], mode: "text" };
}

function inferRawDesiredFragment(
  current: string[],
  fragment: string[]
): {
  location: ReturnType<typeof locateHunk>;
  additions: number;
  deletions: number;
} {
  if (fragment.length < 3) {
    throw new Error("Patch hunk contains no edits and is too short to infer a safe change.");
  }
  if (findSequenceStarts(current, fragment).length > 0) {
    throw new Error("Patch hunk contains no edits and already matches the target file.");
  }

  const maximumAnchorLength = Math.min(12, fragment.length - 2);
  const candidates = new Map<string, {
    start: number;
    end: number;
    prefixLength: number;
    suffixLength: number;
    score: number;
  }>();

  for (let prefixLength = 1; prefixLength <= maximumAnchorLength; prefixLength += 1) {
    const prefix = fragment.slice(0, prefixLength);
    if (!prefix.some((line) => line.trim())) continue;
    const prefixStarts = findSequenceStarts(current, prefix);

    const maximumSuffixLength = Math.min(12, fragment.length - prefixLength - 1);
    for (let suffixLength = 1; suffixLength <= maximumSuffixLength; suffixLength += 1) {
      const suffix = fragment.slice(fragment.length - suffixLength);
      if (!suffix.some((line) => line.trim())) continue;
      const suffixStarts = findSequenceStarts(current, suffix);

      for (const start of prefixStarts) {
        for (const suffixStart of suffixStarts) {
          if (suffixStart < start + prefixLength) continue;
          const desiredMiddle = fragment.slice(prefixLength, fragment.length - suffixLength);
          const currentMiddle = current.slice(start + prefixLength, suffixStart);
          if (sameLines(desiredMiddle, currentMiddle)) continue;

          const end = suffixStart + suffixLength;
          const key = `${start}:${end}`;
          const score = prefixLength + suffixLength;
          const previous = candidates.get(key);
          if (!previous || score > previous.score) {
            candidates.set(key, { start, end, prefixLength, suffixLength, score });
          }
        }
      }
    }
  }

  const ranked = [...candidates.values()].sort((left, right) => right.score - left.score);
  const bestScore = ranked[0]?.score;
  const best = ranked.filter((candidate) => candidate.score === bestScore);
  if (best.length !== 1) {
    throw new Error(
      best.length === 0
        ? "Patch hunk contains no edits and its surrounding anchors were not found."
        : "Patch hunk contains no edits and its surrounding anchors are ambiguous."
    );
  }

  const match = best[0];
  const desiredMiddleLength = fragment.length - match.prefixLength - match.suffixLength;
  const currentMiddleLength = match.end - match.start - match.prefixLength - match.suffixLength;
  return {
    location: {
      start: match.start,
      deleteCount: match.end - match.start,
      replacement: fragment,
      mode: "text"
    },
    additions: desiredMiddleLength,
    deletions: currentMiddleLength
  };
}

function findSequenceStarts(haystack: string[], needle: string[]): number[] {
  if (needle.length === 0 || needle.length > haystack.length) return [];
  const matches: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((line, offset) => haystack[start + offset] === line)) {
      matches.push(start);
    }
  }
  return matches;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
