import { useCallback, useEffect, useState } from "react";
import type { PreviewCacheEntry } from "../workspace/file-preview";
import type { ProjectFileEntry } from "../lib/project-files";

type Options = {
  selectedThreadId: string | null;
  onSaved: () => void;
};

export function workspaceFileKey(rootPath: string, relativePath: string): string {
  return JSON.stringify([rootPath, relativePath]);
}

export function parseWorkspaceFileKey(value: string): { rootPath: string; relativePath: string } {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { rootPath: parsed[0], relativePath: parsed[1] };
    }
  } catch {
    // Legacy single-root keys remain relative to the primary root.
  }
  return { rootPath: "", relativePath: value };
}

export function useProjectFilePreview({ selectedThreadId, onSaved }: Options) {
  const [selectedProjectFileByThread, setSelectedProjectFileByThread] = useState<Record<string, string | null>>({});
  const [filePreviewPath, setFilePreviewPath] = useState<string | null>(null);
  const [projectFilePreviewsByThread, setProjectFilePreviewsByThread] = useState<Record<string, Record<string, PreviewCacheEntry | null>>>({});

  function selectProjectFile(rootPath: string, path: string) {
    if (!selectedThreadId) return;
    setSelectedProjectFileByThread((current) => ({ ...current, [selectedThreadId]: workspaceFileKey(rootPath, path) }));
  }

  function openProjectPreview(rootPath: string, path: string) {
    if (!selectedThreadId) return;
    selectProjectFile(rootPath, path);
    setFilePreviewPath(workspaceFileKey(rootPath, path));
  }

  function closeProjectPreview() {
    setFilePreviewPath(null);
  }

  async function saveProjectPreview(content: string) {
    if (!selectedThreadId || !filePreviewPath) throw new Error("No project file is open.");
    const path = filePreviewPath;
    const target = parseWorkspaceFileKey(path);
    await window.codexh.writeProjectFile({ threadId: selectedThreadId, rootPath: target.rootPath || undefined, path: target.relativePath, content });
    setProjectFilePreviewsByThread((current) => ({
      ...current,
      [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [path]: { content, truncated: false, binary: false } }
    }));
    onSaved();
  }

  const reconcileSelectedFile = useCallback((threadId: string, rootPath: string, entries: ProjectFileEntry[]) => {
    setSelectedProjectFileByThread((current) => {
      const existing = current[threadId] ? parseWorkspaceFileKey(current[threadId]!) : null;
      if (!existing || existing.rootPath !== rootPath) return current;
      const existingPath = existing.relativePath.replace(/\\/g, "/");
      const stillValid = entries.some((entry) => entry.path.replace(/\\/g, "/") === existingPath && entry.kind === "file");
      return { ...current, [threadId]: stillValid ? workspaceFileKey(rootPath, existingPath) : null };
    });
  }, []);

  const clearSelectedFile = useCallback((threadId: string, rootPath?: string) => {
    setSelectedProjectFileByThread((current) => {
      if (rootPath && current[threadId] && parseWorkspaceFileKey(current[threadId]!).rootPath !== rootPath) return current;
      return { ...current, [threadId]: null };
    });
  }, []);

  useEffect(() => {
    if (!selectedThreadId || !filePreviewPath) return;
    let cancelled = false;
    setProjectFilePreviewsByThread((current) => ({ ...current, [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [filePreviewPath]: null } }));
    const target = parseWorkspaceFileKey(filePreviewPath);
    void window.codexh.readProjectFile({ threadId: selectedThreadId, rootPath: target.rootPath || undefined, path: target.relativePath }).then((file) => {
      if (!cancelled) setProjectFilePreviewsByThread((current) => ({ ...current, [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [filePreviewPath]: { content: file.content, truncated: file.truncated, binary: file.binary } } }));
    }).catch((error: unknown) => {
      if (!cancelled) setProjectFilePreviewsByThread((current) => ({ ...current, [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [filePreviewPath]: { content: error instanceof Error ? error.message : String(error), truncated: false, binary: false } } }));
    });
    return () => { cancelled = true; };
  }, [filePreviewPath, selectedThreadId]);

  return { selectedProjectFileByThread, filePreviewPath, setFilePreviewPath, projectFilePreviewsByThread, selectProjectFile, openProjectPreview, closeProjectPreview, saveProjectPreview, reconcileSelectedFile, clearSelectedFile };
}
