import { useState } from "react";
import type { KnowledgeBaseSummary, KnowledgeDocumentRecord } from "@shared-types";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useKnowledgeBases(
  selectedThreadId: string | null,
  refreshSnapshot: (threadId: string | null) => Promise<void>,
  showNotice: Notice
) {
  const [bases, setBases] = useState<KnowledgeBaseSummary[]>([]);
  const [documents, setDocuments] = useState<Record<string, KnowledgeDocumentRecord[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refreshBases(options?: { notify?: boolean }) {
    try {
      const next = (await window.codexh.listKnowledgeBases()) as KnowledgeBaseSummary[];
      setBases(next);
      if (options?.notify) {
        showNotice("知识库列表已刷新", {
          tone: "success",
          message: next.length ? `当前共 ${next.length} 个知识库` : "当前没有知识库"
        });
      }
    } catch (error) {
      showNotice("加载知识库失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function openFolder(knowledgeBase: Pick<KnowledgeBaseSummary, "displayName" | "bundleRoot" | "bundleExists">) {
    if (!knowledgeBase.bundleExists || !knowledgeBase.bundleRoot) {
      showNotice("未找到本地知识库文件夹", { message: knowledgeBase.displayName });
      return;
    }
    const error = await window.codexh.openFolder(knowledgeBase.bundleRoot);
    if (error) {
      showNotice("无法打开知识库文件夹", { message: error });
    }
  }

  async function toggleDocuments(knowledgeBaseId: string) {
    if (documents[knowledgeBaseId]) {
      setDocuments((current) => {
        const next = { ...current };
        delete next[knowledgeBaseId];
        return next;
      });
      return;
    }
    try {
      const nextDocuments = await window.codexh.listKnowledgeDocuments(knowledgeBaseId) as KnowledgeDocumentRecord[];
      setDocuments((current) => ({ ...current, [knowledgeBaseId]: nextDocuments }));
    } catch (error) {
      showNotice("读取文档列表失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function refreshBase(knowledgeBaseId: string) {
    setBusyId(knowledgeBaseId);
    try {
      await window.codexh.refreshKnowledgeBase(knowledgeBaseId);
      setDocuments((current) => {
        const next = { ...current };
        delete next[knowledgeBaseId];
        return next;
      });
      await refreshBases();
      showNotice("知识库索引已刷新", { tone: "success" });
    } catch (error) {
      showNotice("刷新知识库失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteBase(knowledgeBaseId: string) {
    setBusyId(knowledgeBaseId);
    try {
      await window.codexh.deleteKnowledgeBase(knowledgeBaseId);
      setDocuments((current) => {
        const next = { ...current };
        delete next[knowledgeBaseId];
        return next;
      });
      await Promise.all([refreshBases(), refreshSnapshot(selectedThreadId)]);
      showNotice("知识库已删除", { tone: "success" });
    } catch (error) {
      showNotice("删除知识库失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyId(null);
    }
  }

  return { bases, documents, busyId, refreshBases, toggleDocuments, refreshBase, deleteBase, openFolder };
}
