import { useState } from "react";
import type { KnowledgeImportSource, KnowledgeScope } from "@shared-types";
import { getKnowledgeDefaultName, knowledgeSourceKey } from "../core/app-helpers";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

type Options = {
  selectedThreadId: string | null;
  canImportProjectKnowledge: boolean;
  refreshSnapshot: (threadId: string | null) => Promise<void>;
  refreshKnowledgeBases: () => Promise<void>;
  showNotice: Notice;
};

export function useKnowledgeImport({
  selectedThreadId,
  canImportProjectKnowledge,
  refreshSnapshot,
  refreshKnowledgeBases,
  showNotice
}: Options) {
  const [sources, setSources] = useState<KnowledgeImportSource[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [isUrlEditorOpen, setIsUrlEditorOpen] = useState(false);
  const [name, setName] = useState("Imported Knowledge");
  const [scope, setScope] = useState<KnowledgeScope>("global");
  const [isImporting, setIsImporting] = useState(false);

  async function importKnowledge() {
    if (scope === "project" && !canImportProjectKnowledge) return;
    if (sources.length === 0) {
      showNotice("请至少添加一个本地文档、URL 或浏览器页面。");
      return;
    }
    setIsImporting(true);
    try {
      await window.codexh.importKnowledge({
        displayName: name.trim() || "Imported Knowledge",
        scope,
        sources,
        threadId: selectedThreadId ?? undefined
      });
      setSources([]);
      setUrlInput("");
      setName("Imported Knowledge");
      await Promise.all([refreshSnapshot(selectedThreadId), refreshKnowledgeBases()]);
      showNotice("知识库已导入", { tone: "success" });
    } catch (error) {
      showNotice("知识库导入失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsImporting(false);
    }
  }

  async function chooseSources(kind: "files" | "folders") {
    const paths = kind === "files" ? await window.codexh.chooseKnowledgeFiles() : await window.codexh.chooseKnowledgeFolders();
    if (paths.length === 0) return;
    const existing = new Set(sources.map(knowledgeSourceKey));
    const additions = paths
      .filter((sourcePath) => !existing.has(`${kind === "files" ? "file" : "folder"}:${sourcePath.toLowerCase()}`))
      .map((sourcePath) => ({ path: sourcePath, kind: kind === "files" ? "file" : "folder" } satisfies KnowledgeImportSource));
    if (additions.length === 0) return;
    const wasEmpty = sources.length === 0;
    setSources([...sources, ...additions]);
    if (wasEmpty) setName(getKnowledgeDefaultName(additions[0]));
  }

  function removeSource(sourceKey: string) {
    setSources((current) => current.filter((source) => knowledgeSourceKey(source) !== sourceKey));
  }

  function addUrls(): boolean {
    const urls = urlInput.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (urls.length === 0) return false;
    const existing = new Set(sources.map(knowledgeSourceKey));
    const additions: KnowledgeImportSource[] = [];
    for (const value of urls) {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        const source: KnowledgeImportSource = { kind: "url", url: url.toString() };
        if (!existing.has(knowledgeSourceKey(source))) {
          existing.add(knowledgeSourceKey(source));
          additions.push(source);
        }
      } catch {
        showNotice("链接格式无效", { message: `仅支持 http/https：${value}` });
        return false;
      }
    }
    setSources((current) => [...current, ...additions]);
    setUrlInput("");
    if (sources.length === 0 && additions[0]?.kind === "url") setName(new URL(additions[0].url).hostname);
    return true;
  }

  return {
    sources,
    urlInput,
    setUrlInput,
    isUrlEditorOpen,
    setIsUrlEditorOpen,
    name,
    setName,
    scope,
    setScope,
    isImporting,
    importKnowledge,
    chooseSources,
    removeSource,
    addUrls,
    getSourceKey: knowledgeSourceKey
  };
}
