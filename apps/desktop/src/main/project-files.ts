import fs from "node:fs/promises";
import path from "node:path";

export type ProjectFileEntry = {
  path: string;
  kind: "file" | "directory";
  size?: number;
};

const IGNORED_PROJECT_ENTRIES = new Set([".git", "node_modules", ".next", "dist", "build"]);

export async function listProjectDirectoryEntries(
  root: string,
  relativeDirectory = ""
): Promise<ProjectFileEntry[]> {
  const resolvedRoot = path.resolve(root);
  const directory = resolveProjectDirectoryPath(resolvedRoot, relativeDirectory);
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) {
    throw new Error("The selected project entry is not a directory.");
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: ProjectFileEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (IGNORED_PROJECT_ENTRIES.has(entry.name) || entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(resolvedRoot, absolutePath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      files.push({ path: relativePath, kind: "directory" });
    } else if (entry.isFile()) {
      files.push({ path: relativePath, kind: "file" });
    }
  }
  return files;
}

function resolveProjectDirectoryPath(root: string, relativeDirectory: string): string {
  if (!relativeDirectory) return root;
  if (path.isAbsolute(relativeDirectory)) {
    throw new Error("Project directory paths must be relative to the project folder.");
  }

  const resolved = path.resolve(root, relativeDirectory);
  const relative = path.relative(root, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Project directory path is outside the project folder.");
  }
  return resolved;
}
