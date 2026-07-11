import fs from "node:fs/promises";
import path from "node:path";

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

export async function applyCodexPatch(patchText: string, rootDir: string): Promise<string[]> {
  const operations = parsePatch(patchText);
  const touched: string[] = [];

  for (const operation of operations) {
    if (operation.type === "add") {
      const filePath = resolveWorkspacePath(rootDir, operation.file);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, operation.content, "utf8");
      touched.push(filePath);
      continue;
    }

    if (operation.type === "delete") {
      const filePath = resolveWorkspacePath(rootDir, operation.file);
      await fs.rm(filePath, { recursive: true, force: true });
      touched.push(filePath);
      continue;
    }

    const sourcePath = resolveWorkspacePath(rootDir, operation.file);
    const nextPath = resolveWorkspacePath(rootDir, operation.moveTo ?? operation.file);
    const current = await fs.readFile(sourcePath, "utf8");
    const updated = applyHunks(current, operation.hunks);
    await fs.mkdir(path.dirname(nextPath), { recursive: true });
    await fs.writeFile(nextPath, updated, "utf8");
    if (operation.moveTo && nextPath !== sourcePath) {
      await fs.rm(sourcePath, { force: true });
    }
    touched.push(nextPath);
  }

  return touched;
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

function applyHunks(
  original: string,
  hunks: Array<{
    lines: string[];
  }>
): string {
  let current = original.split("\n");

  for (const hunk of hunks) {
    const contextLines = hunk.lines.filter((line) => line.startsWith(" ")).map((line) => line.slice(1));
    const removalLines = hunk.lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
    const additionLines = hunk.lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
    const anchor = contextLines[0] ?? removalLines[0];
    let anchorIndex = anchor ? current.findIndex((line) => line === anchor) : current.length;
    if (anchorIndex === -1) {
      anchorIndex = current.length;
    }

    if (removalLines.length > 0) {
      const removalStart = anchor ? current.findIndex((line) => line === anchor) : current.length;
      if (removalStart >= 0) {
        current.splice(removalStart, removalLines.length, ...additionLines);
      }
    } else {
      current.splice(anchorIndex + (anchor ? 1 : 0), 0, ...additionLines);
    }
  }

  return current.join("\n");
}
