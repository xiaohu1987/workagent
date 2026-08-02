import { useCallback, useEffect, useState } from "react";
import type { PreviewCacheEntry } from "../workspace/file-preview";
import type { ProjectFileEntry } from "../lib/project-files";

type Options = {
  selectedThreadId: string | null;
  onSaved: () => void;
};

export function useProjectFilePreview({ selectedThreadId, onSaved }: Options) {
  const [selectedProjectFileByThread, setSelectedProjectFileByThread] = useState<Record<string, string | null>>({});
  const [filePreviewPath, setFilePreviewPath] = useState<string | null>(null);
  const [projectFilePreviewsByThread, setProjectFilePreviewsByThread] = useState<Record<string, Record<string, PreviewCacheEntry | null>>>({});

  function selectProjectFile(path: string) {
    if (!selectedThreadId) return;
    setSelectedProjectFileByThread((current) => ({ ...current, [selectedThreadId]: path }));
  }

  function openProjectPreview(path: string) {
    if (!selectedThreadId) return;
    selectProjectFile(path);
    setFilePreviewPath(path);
  }

  function closeProjectPreview() {
    setFilePreviewPath(null);
  }

  async function saveProjectPreview(content: string) {
    if (!selectedThreadId || !filePreviewPath) throw new Error("No project file is open.");
    const path = filePreviewPath;
    await window.codexh.writeProjectFile({ threadId: selectedThreadId, path, content });
    setProjectFilePreviewsByThread((current) => ({
      ...current,
      [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [path]: { content, truncated: false, binary: false } }
    }));
    onSaved();
  }

  const reconcileSelectedFile = useCallback((threadId: string, entries: ProjectFileEntry[]) => {
    setSelectedProjectFileByThread((current) => {
      const existingPath = current[threadId]?.replace(/\\/g, "/");
      const stillValid = existingPath && entries.some((entry) => entry.path.replace(/\\/g, "/") === existingPath && entry.kind === "file");
      return { ...current, [threadId]: stillValid ? existingPath : null };
    });
  }, []);

  const clearSelectedFile = useCallback((threadId: string) => {
    setSelectedProjectFileByThread((current) => ({ ...current, [threadId]: null }));
  }, []);

  useEffect(() => {
    if (!selectedThreadId || !filePreviewPath) return;
    let cancelled = false;
    setProjectFilePreviewsByThread((current) => ({ ...current, [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [filePreviewPath]: null } }));
    void window.codexh.readProjectFile({ threadId: selectedThreadId, path: filePreviewPath }).then((file) => {
      if (!cancelled) setProjectFilePreviewsByThread((current) => ({ ...current, [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [filePreviewPath]: { content: file.content, truncated: file.truncated, binary: file.binary } } }));
    }).catch((error: unknown) => {
      if (!cancelled) setProjectFilePreviewsByThread((current) => ({ ...current, [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [filePreviewPath]: { content: error instanceof Error ? error.message : String(error), truncated: false, binary: false } } }));
    });
    return () => { cancelled = true; };
  }, [filePreviewPath, selectedThreadId]);

  return { selectedProjectFileByThread, filePreviewPath, setFilePreviewPath, projectFilePreviewsByThread, selectProjectFile, openProjectPreview, closeProjectPreview, saveProjectPreview, reconcileSelectedFile, clearSelectedFile };
}
