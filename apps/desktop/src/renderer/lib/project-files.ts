import type { ToolCallRecord } from "@shared-types";
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
  return [
    ...beforeLines.slice(0, prefix).map((content) => ({ kind: "context" as const, content })),
    ...beforeLines.slice(prefix, beforeLines.length - suffix).map((content) => ({ kind: "removed" as const, content })),
    ...afterLines.slice(prefix, afterLines.length - suffix).map((content) => ({ kind: "added" as const, content })),
    ...beforeLines.slice(beforeLines.length - suffix).map((content) => ({ kind: "context" as const, content }))
  ];
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
