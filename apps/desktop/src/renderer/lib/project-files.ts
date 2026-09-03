import type { GitFileChange, GitSnapshot, ToolCallRecord } from "@shared-types";
import { parseTimelineJson } from "./conversation-utils";

export type ProjectFileEntry = {
  path: string;
  kind: "file" | "directory";
  size?: number;
};

export type ProjectFileTreeNode = {
  path: string;
  name: string;
  kind: "file" | "directory";
  children: ProjectFileTreeNode[];
};

export type FileSnapshot = {
  path: string;
  before: string;
  after: string;
  beforeTruncated: boolean;
  afterTruncated: boolean;
};

export type FileSnapshotDiffLine = {
  kind: "context" | "removed" | "added";
  content: string;
};

export function buildProjectFileTree(files: ProjectFileEntry[]): ProjectFileTreeNode[] {
  const root: ProjectFileTreeNode = { path: "", name: "", kind: "directory", children: [] };

  for (const entry of files) {
    const segments = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let children = root.children;
    let parentPath = "";
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      parentPath = parentPath ? `${parentPath}/${name}` : name;
      const isLeaf = index === segments.length - 1;
      const kind = isLeaf ? entry.kind : "directory";
      let node = children.find((candidate) => candidate.name === name);
      if (!node) {
        node = { path: parentPath, name, kind, children: [] };
        children.push(node);
      } else if (isLeaf) {
        node.kind = kind;
      }
      children = node.children;
    }
  }

  const sortNodes = (nodes: ProjectFileTreeNode[]): ProjectFileTreeNode[] =>
    nodes
      .map((node) => ({ ...node, children: sortNodes(node.children) }))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true });
      });

  return sortNodes(root.children);
}

export function mergeProjectFileEntries(
  current: ProjectFileEntry[],
  incoming: ProjectFileEntry[]
): ProjectFileEntry[] {
  const entriesByPath = new Map<string, ProjectFileEntry>();
  for (const entry of [...current, ...incoming]) {
    const normalized = { ...entry, path: entry.path.replace(/\\/g, "/") };
    const existing = entriesByPath.get(normalized.path);
    if (existing?.kind === "directory" && normalized.kind === "file") continue;
    entriesByPath.set(normalized.path, normalized);
  }
  return [...entriesByPath.values()];
}

export function getProjectRelativeGitFiles(
  snapshot: GitSnapshot | null,
  projectRoot: string
): GitFileChange[] {
  if (snapshot?.available !== true || !snapshot.root?.trim() || !projectRoot.trim()) return [];

  const gitRoot = normalizeAbsolutePath(snapshot.root);
  const normalizedProjectRoot = normalizeAbsolutePath(projectRoot);
  if (!gitRoot || !normalizedProjectRoot) return [];

  const gitRootKey = gitRoot.toLocaleLowerCase();
  const projectRootKey = normalizedProjectRoot.toLocaleLowerCase();
  if (gitRootKey === projectRootKey) {
    return snapshot.files.filter((file) => normalizeRelativeGitPath(file.path) !== null);
  }
  if (!projectRootKey.startsWith(`${gitRootKey}/`)) return [];

  const projectPrefix = normalizedProjectRoot.slice(gitRoot.length + 1);
  const projectPrefixKey = `${projectPrefix.toLocaleLowerCase()}/`;
  return snapshot.files.flatMap((file) => {
    const path = normalizeRelativeGitPath(file.path);
    if (!path || !path.toLocaleLowerCase().startsWith(projectPrefixKey)) return [];

    const projectPath = path.slice(projectPrefix.length + 1);
    if (!projectPath) return [];
    const originalPath = file.originalPath
      ? normalizeRelativeGitPath(file.originalPath)
      : null;
    const projectOriginalPath = originalPath?.toLocaleLowerCase().startsWith(projectPrefixKey)
      ? originalPath.slice(projectPrefix.length + 1)
      : undefined;
    return [{
      ...file,
      path: projectPath,
      ...(projectOriginalPath ? { originalPath: projectOriginalPath } : { originalPath: undefined })
    }];
  });
}

function normalizeAbsolutePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeRelativeGitPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return null;

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/") || null;
}

export function projectFileNodeMatches(node: ProjectFileTreeNode, query: string): boolean {
  if (!query) return true;
  return node.name.toLocaleLowerCase().includes(query) || node.children.some((child) => projectFileNodeMatches(child, query));
}

export function getProjectFileGlyphClass(node: ProjectFileTreeNode): string {
  if (node.kind === "directory") return "folder";
  const extension = node.name.split(".").pop()?.toLocaleLowerCase();
  if (extension === "json") return "json";
  if (extension === "ts" || extension === "tsx" || extension === "js" || extension === "jsx") return "script";
  if (extension === "css" || extension === "scss") return "style";
  if (extension === "md") return "markdown";
  if (node.name.startsWith(".")) return "config";
  return "default";
}

export function resolveProjectFilePath(projectRoot: string, relativePath: string): string {
  if (!projectRoot) {
    return relativePath;
  }
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const root = projectRoot.replace(/[\\/]+$/, "");
  const relative = relativePath.replace(/[\\/]+/g, separator);
  return relative ? `${root}${separator}${relative}` : root;
}

export function buildProjectFolderManifest(node: ProjectFileTreeNode, maximumEntries = 200) {
  const entries: string[] = [];
  let truncated = false;
  const visit = (children: ProjectFileTreeNode[]) => {
    for (const child of children) {
      if (entries.length >= maximumEntries) {
        truncated = true;
        return;
      }
      entries.push(child.kind === "directory" ? `${child.path}/` : child.path);
      if (child.kind === "directory") visit(child.children);
      if (truncated) return;
    }
  };
  visit(node.children);
  return { entries, truncated };
}

export function getLatestFileSnapshot(toolCalls: ToolCallRecord[], selectedPath: string): FileSnapshot | null {
  const normalizedPath = selectedPath.replace(/\\/g, "/");
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (toolCall?.status !== "completed") continue;
    const result = parseTimelineJson(toolCall.resultJson);
    const json = result.json;
    if (!json || typeof json !== "object") continue;
    const snapshots = (json as Record<string, unknown>).snapshots;
    if (!Array.isArray(snapshots)) continue;
    const snapshot = snapshots.find((candidate): candidate is FileSnapshot => {
      if (!candidate || typeof candidate !== "object") return false;
      const value = candidate as Record<string, unknown>;
      return value.path === normalizedPath && typeof value.before === "string" && typeof value.after === "string";
    });
    if (snapshot) {
      return {
        ...snapshot,
        beforeTruncated: snapshot.beforeTruncated === true,
        afterTruncated: snapshot.afterTruncated === true
      };
    }
  }
  return null;
}

export function buildFileSnapshotDiff(before: string, after: string): FileSnapshotDiffLine[] {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const unchangedStart = [
    ...beforeLines.slice(0, prefix).map((content) => ({ kind: "context" as const, content })),
  ];
  const changed = buildChangedSnapshotLines(
    beforeLines.slice(prefix, beforeLines.length - suffix),
    afterLines.slice(prefix, afterLines.length - suffix)
  );
  const unchangedEnd = [
    ...beforeLines.slice(beforeLines.length - suffix).map((content) => ({ kind: "context" as const, content }))
  ];
  return [...unchangedStart, ...changed, ...unchangedEnd];
}

const MAX_SNAPSHOT_MYERS_EDIT_DISTANCE = 1_024;
const MAX_SNAPSHOT_LCS_CELLS = 1_000_000;

function buildChangedSnapshotLines(before: string[], after: string[]): FileSnapshotDiffLine[] {
  if (before.length === 0) return after.map((content) => ({ kind: "added" as const, content }));
  if (after.length === 0) return before.map((content) => ({ kind: "removed" as const, content }));

  // Unique common lines split large files into small, independent edit regions.
  // This keeps multi-hunk snapshots accurate without making the renderer hold a
  // quadratic matrix for an entire source file.
  const anchors = findSnapshotDiffAnchors(before, after);
  if (anchors.length > 0) {
    const lines: FileSnapshotDiffLine[] = [];
    let beforeStart = 0;
    let afterStart = 0;
    for (const anchor of anchors) {
      lines.push(...buildUnanchoredSnapshotLines(
        before.slice(beforeStart, anchor.beforeIndex),
        after.slice(afterStart, anchor.afterIndex)
      ));
      lines.push({ kind: "context", content: before[anchor.beforeIndex] });
      beforeStart = anchor.beforeIndex + 1;
      afterStart = anchor.afterIndex + 1;
    }
    lines.push(...buildUnanchoredSnapshotLines(before.slice(beforeStart), after.slice(afterStart)));
    return lines;
  }

  return buildUnanchoredSnapshotLines(before, after);
}

function buildUnanchoredSnapshotLines(before: string[], after: string[]): FileSnapshotDiffLine[] {
  if (before.length === 0) return after.map((content) => ({ kind: "added" as const, content }));
  if (after.length === 0) return before.map((content) => ({ kind: "removed" as const, content }));
  if (before.length * after.length <= MAX_SNAPSHOT_LCS_CELLS) {
    return buildSnapshotLcsDiff(before, after);
  }
  return buildSnapshotMyersDiff(before, after) ?? [
    ...before.map((content) => ({ kind: "removed" as const, content })),
    ...after.map((content) => ({ kind: "added" as const, content }))
  ];
}

function findSnapshotDiffAnchors(before: string[], after: string[]) {
  const beforeIndices = new Map<string, number>();
  const afterIndices = new Map<string, number>();
  for (let index = 0; index < before.length; index += 1) {
    const line = before[index];
    beforeIndices.set(line, beforeIndices.has(line) ? -1 : index);
  }
  for (let index = 0; index < after.length; index += 1) {
    const line = after[index];
    afterIndices.set(line, afterIndices.has(line) ? -1 : index);
  }
  const candidates = [...beforeIndices.entries()]
    .flatMap(([content, beforeIndex]) => {
      const afterIndex = afterIndices.get(content);
      return beforeIndex >= 0 && afterIndex !== undefined && afterIndex >= 0 ? [{ beforeIndex, afterIndex }] : [];
    })
    .sort((left, right) => left.beforeIndex - right.beforeIndex);
  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  const tailIndices: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const afterIndex = candidates[index].afterIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const midpoint = Math.floor((low + high) / 2);
      if (tails[midpoint] < afterIndex) low = midpoint + 1;
      else high = midpoint;
    }
    if (low > 0) previous[index] = tailIndices[low - 1];
    tails[low] = afterIndex;
    tailIndices[low] = index;
  }
  const anchors: Array<{ beforeIndex: number; afterIndex: number }> = [];
  for (let index = tailIndices.at(-1) ?? -1; index >= 0; index = previous[index]) {
    anchors.push(candidates[index]);
  }
  return anchors.reverse();
}

function buildSnapshotLcsDiff(before: string[], after: string[]): FileSnapshotDiffLine[] {
  const width = after.length + 1;
  const lcs = new Uint32Array((before.length + 1) * width);
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const current = beforeIndex * width + afterIndex;
      lcs[current] = before[beforeIndex] === after[afterIndex]
        ? lcs[current + width + 1] + 1
        : Math.max(lcs[current + width], lcs[current + 1]);
    }
  }
  const lines: FileSnapshotDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length && afterIndex < after.length) {
    if (before[beforeIndex] === after[afterIndex]) {
      lines.push({ kind: "context", content: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (lcs[(beforeIndex + 1) * width + afterIndex] >= lcs[beforeIndex * width + afterIndex + 1]) {
      lines.push({ kind: "removed", content: before[beforeIndex++] });
    } else {
      lines.push({ kind: "added", content: after[afterIndex++] });
    }
  }
  return [
    ...lines,
    ...before.slice(beforeIndex).map((content) => ({ kind: "removed" as const, content })),
    ...after.slice(afterIndex).map((content) => ({ kind: "added" as const, content }))
  ];
}

function buildSnapshotMyersDiff(before: string[], after: string[]): FileSnapshotDiffLine[] | null {
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  const maximumDistance = Math.min(before.length + after.length, MAX_SNAPSHOT_MYERS_EDIT_DISTANCE);
  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let beforeIndex = diagonal === -distance || (diagonal !== distance && right < down)
        ? down
        : right + 1;
      let afterIndex = beforeIndex - diagonal;
      while (beforeIndex < before.length && afterIndex < after.length && before[beforeIndex] === after[afterIndex]) {
        beforeIndex += 1;
        afterIndex += 1;
      }
      next.set(diagonal, beforeIndex);
      if (beforeIndex >= before.length && afterIndex >= after.length) {
        trace.push(next);
        return backtrackSnapshotMyersDiff(before, after, trace);
      }
    }
    trace.push(next);
    frontier = next;
  }
  return null;
}

function backtrackSnapshotMyersDiff(
  before: string[],
  after: string[],
  trace: Array<Map<number, number>>
): FileSnapshotDiffLine[] {
  const lines: FileSnapshotDiffLine[] = [];
  let beforeIndex = before.length;
  let afterIndex = after.length;
  for (let distance = trace.length - 1; distance > 0; distance -= 1) {
    const frontier = trace[distance - 1];
    const diagonal = beforeIndex - afterIndex;
    const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
      ? diagonal + 1
      : diagonal - 1;
    const previousBeforeIndex = frontier.get(previousDiagonal) ?? 0;
    const previousAfterIndex = previousBeforeIndex - previousDiagonal;
    while (beforeIndex > previousBeforeIndex && afterIndex > previousAfterIndex) {
      lines.push({ kind: "context", content: before[--beforeIndex] });
      afterIndex -= 1;
    }
    if (beforeIndex === previousBeforeIndex) {
      lines.push({ kind: "added", content: after[--afterIndex] });
    } else {
      lines.push({ kind: "removed", content: before[--beforeIndex] });
    }
  }
  while (beforeIndex > 0 && afterIndex > 0) {
    lines.push({ kind: "context", content: before[--beforeIndex] });
    afterIndex -= 1;
  }
  while (beforeIndex > 0) lines.push({ kind: "removed", content: before[--beforeIndex] });
  while (afterIndex > 0) lines.push({ kind: "added", content: after[--afterIndex] });
  return lines.reverse();
}

export function buildFileSnapshotDiffPreview(before: string, after: string, maximumLines = 180) {
  const lines = buildFileSnapshotDiff(before, after);
  const changedIndices = lines
    .map((line, index) => line.kind === "context" ? -1 : index)
    .filter((index) => index >= 0);
  const firstChanged = changedIndices[0] ?? 0;
  const lastChanged = changedIndices.at(-1) ?? Math.min(lines.length - 1, 10);
  const start = Math.max(0, firstChanged - 5);
  const end = Math.min(lines.length, lastChanged + 6);
  const selected = lines.slice(start, end).map((line, index) => ({
    ...line,
    lineNumber: start + index + 1,
    omitted: false
  }));
  const boundedMaximum = Math.max(20, maximumLines);
  const visible = selected.length <= boundedMaximum
    ? selected
    : [
        ...selected.slice(0, Math.floor(boundedMaximum / 2)),
        {
          kind: "context" as const,
          content: `... 隐藏 ${selected.length - boundedMaximum} 行变更 ...`,
          lineNumber: null,
          omitted: true
        },
        ...selected.slice(selected.length - Math.ceil(boundedMaximum / 2))
      ];
  return [
    ...(start > 0 ? [{
      kind: "context" as const,
      content: `... 隐藏 ${start} 行未变更内容 ...`,
      lineNumber: null,
      omitted: true
    }] : []),
    ...visible,
    ...(end < lines.length ? [{
      kind: "context" as const,
      content: `... 隐藏 ${lines.length - end} 行未变更内容 ...`,
      lineNumber: null,
      omitted: true
    }] : [])
  ];
}

export function getFileSnapshotDiffCounts(before: string, after: string) {
  return buildFileSnapshotDiff(before, after).reduce(
    (counts, line) => ({
      additions: counts.additions + (line.kind === "added" ? 1 : 0),
      deletions: counts.deletions + (line.kind === "removed" ? 1 : 0)
    }),
    { additions: 0, deletions: 0 }
  );
}

export function getFileSnapshotDiffMarker(kind: FileSnapshotDiffLine["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "-";
  return " ";
}

export type ProjectFileChangeKind = "added" | "modified" | "deleted";

export function getProjectFileChangeKinds(toolCalls: ToolCallRecord[]): Map<string, ProjectFileChangeKind> {
  const changes = new Map<string, ProjectFileChangeKind>();
  for (const toolCall of toolCalls) {
    if (toolCall.status !== "completed") continue;
    const result = parseTimelineJson(toolCall.resultJson);
    const json = result.json;
    if (!json || typeof json !== "object") continue;
    const snapshots = (json as Record<string, unknown>).snapshots;
    if (!Array.isArray(snapshots)) continue;
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const value = snapshot as Record<string, unknown>;
      if (typeof value.path !== "string" || typeof value.before !== "string" || typeof value.after !== "string") continue;
      const path = value.path.replace(/\\/g, "/");
      if (!path) continue;
      if (!value.before && value.after) changes.set(path, "added");
      else if (value.before && !value.after) changes.set(path, "deleted");
      else if (value.before !== value.after) changes.set(path, "modified");
    }
  }
  return changes;
}

export function getGitProjectFileChangeKinds(files: GitFileChange[]): Map<string, ProjectFileChangeKind> {
  const changes = new Map<string, ProjectFileChangeKind>();
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    if (!path) continue;
    if (file.untracked || file.indexStatus === "A" || file.worktreeStatus === "A") {
      changes.set(path, "added");
    } else if (file.indexStatus === "D" || file.worktreeStatus === "D") {
      changes.set(path, "deleted");
    } else {
      changes.set(path, "modified");
    }
  }
  return changes;
}

export function getProjectFileNodeChangeKind(
  node: ProjectFileTreeNode,
  changes: Map<string, ProjectFileChangeKind>
): ProjectFileChangeKind | null {
  const direct = changes.get(node.path);
  if (direct) return direct;
  if (node.kind !== "directory") return null;
  const nested = [...changes.entries()]
    .filter(([path]) => path.startsWith(`${node.path}/`))
    .map(([, change]) => change);
  if (nested.includes("modified")) return "modified";
  if (nested.includes("added")) return "added";
  return nested.includes("deleted") ? "deleted" : null;
}

export function projectFileChangeBadge(change: ProjectFileChangeKind): "A" | "M" | "D" {
  return change === "added" ? "A" : change === "modified" ? "M" : "D";
}

export function projectFileChangeLabel(change: ProjectFileChangeKind): string {
  return change === "added" ? "新增" : change === "modified" ? "已修改" : "已删除";
}
