import type { KnowledgeImportSource, MessageRecord, ThreadRecord } from "@shared-types";
import type { FileChangeAction } from "../lib/conversation-utils";
import { getFileLeafName } from "../markdown";

export function formatFileChangeAction(action: FileChangeAction): string {
  switch (action) {
    case "created": return "已生成";
    case "deleted": return "已删除";
    default: return "已编辑";
  }
}

export function getFileChangeActionClass(action: FileChangeAction): string {
  switch (action) {
    case "created": return "is-created";
    case "deleted": return "is-deleted";
    default: return "is-modified";
  }
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片预览。"));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("无法读取图片预览。"));
    reader.readAsDataURL(file);
  });
}

export function getKnowledgeDefaultName(source: KnowledgeImportSource): string {
  if (source.kind === "url" || source.kind === "browser") return new URL(source.url).hostname;
  const leaf = getFileLeafName(source.path.replace(/[\\/]+$/, "")) || source.path;
  if (source.kind === "folder") return leaf;
  const extensionIndex = leaf.lastIndexOf(".");
  return extensionIndex > 0 ? leaf.slice(0, extensionIndex) : leaf;
}

export function knowledgeSourceKey(source: KnowledgeImportSource): string {
  if (source.kind === "url") return `url:${source.url.toLowerCase()}`;
  if (source.kind === "browser") return `browser:${source.threadId}:${source.tabId}`;
  return `${source.kind}:${source.path.toLowerCase()}`;
}

export function getFileParentPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "./" : normalized.slice(0, index + 1);
}

export function formatUpdatePhase(phase?: string): string {
  switch (phase) {
    case "checking": return "正在检查";
    case "up-to-date": return "已是最新";
    case "available": return "发现新版本";
    case "downloading": return "正在下载";
    case "downloaded": return "已验证，可安装";
    case "installing": return "正在安装";
    case "error": return "更新失败";
    default: return "等待检查";
  }
}

export type GpaTaskProgress = { taskId: string; taskTitle: string };

export function getGpaTaskProgress(message: MessageRecord): GpaTaskProgress | null {
  if (message.role !== "assistant" || !message.metadataJson) return null;
  try {
    const metadata = JSON.parse(message.metadataJson) as {
      displayKind?: unknown;
      taskId?: unknown;
      taskTitle?: unknown;
      status?: unknown;
    };
    if (metadata.displayKind !== "gpa-task-progress" || metadata.status !== "completed" || typeof metadata.taskId !== "string" || typeof metadata.taskTitle !== "string") return null;
    return { taskId: metadata.taskId, taskTitle: metadata.taskTitle };
  } catch {
    return null;
  }
}

export function formatUpdateDownloadSize(receivedBytes?: number, totalBytes?: number): string {
  const received = formatByteSize(receivedBytes ?? 0);
  return totalBytes && totalBytes > 0 ? `${received} / ${formatByteSize(totalBytes)}` : `${received} 已下载`;
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return formatByteSize(bytes);
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getSidebarUpdateReminder(phase?: string): string | null {
  if (phase === "available") return "有更新";
  if (phase === "downloading") return "下载中";
  if (phase === "downloaded") return "可安装";
  return null;
}

export function getWorkspaceLabel(thread: ThreadRecord | null): string {
  const target = thread?.cwd?.trim();
  if (!target) return "workagent";
  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "workagent";
}
