import { useRef, useState } from "react";

export type QuickNote = { id: string; title: string; content: string; updatedAt: string };
export type QuickNoteListMenu = { x: number; y: number; note: Pick<QuickNote, "id" | "title" | "content"> } | null;
export type QuickNoteDeleteConfirm = { id: string; title: string } | null;

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useQuickNotes(showNotice: Notice) {
  const [isOpen, setIsOpen] = useState(false);
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("尚未保存");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [listMenu, setListMenu] = useState<QuickNoteListMenu>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<QuickNoteDeleteConfirm>(null);
  const contentRef = useRef("");

  async function open() {
    setIsOpen(true);
    try {
      const nextNotes = await window.codexh.listQuickNotes();
      setNotes(nextNotes);
      const first = nextNotes[0];
      setSelectedId(first?.id ?? null);
      setTitle(first?.title ?? "");
      setContent(first?.content ?? "");
      contentRef.current = first?.content ?? "";
      setStatus(first ? "已同步至全局知识库" : "新建笔记后保存至全局知识库");
    } catch (error) {
      showNotice("无法读取随手记", { message: error instanceof Error ? error.message : "请稍后重试。" });
    }
  }

  function select(note: Pick<QuickNote, "id" | "title" | "content">) {
    setSelectedId(note.id);
    setTitle(note.title);
    setContent(note.content);
    contentRef.current = note.content;
    setStatus("已同步至全局知识库");
  }

  function create() {
    setSelectedId(null);
    setTitle("");
    setContent("");
    contentRef.current = "";
    setStatus("尚未保存");
  }

  function changeContent(nextContent: string) {
    contentRef.current = nextContent;
    setContent(nextContent);
    setStatus("尚未保存");
  }

  async function save() {
    const nextContent = contentRef.current;
    if (!nextContent.trim()) {
      setStatus("请先填写笔记内容");
      return;
    }
    setSaving(true);
    setStatus("正在同步至全局知识库...");
    try {
      const note = await window.codexh.saveQuickNote({ id: selectedId ?? undefined, title, content: nextContent });
      setNotes(await window.codexh.listQuickNotes());
      setSelectedId(note.id);
      setTitle(note.title);
      setContent(note.content);
      contentRef.current = note.content;
      setStatus("已同步至全局知识库");
      showNotice("随手记已保存", { tone: "success", message: "已同步至全局知识库。" });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  async function rename(note: Pick<QuickNote, "id" | "content">) {
    const nextTitle = renameDraft.trim();
    if (!nextTitle) return;
    try {
      const saved = await window.codexh.saveQuickNote({ id: note.id, title: nextTitle, content: note.content });
      setNotes(await window.codexh.listQuickNotes());
      if (selectedId === saved.id) {
        setTitle(saved.title);
        setStatus("标题已更新并同步至全局知识库");
      }
      setRenamingId(null);
    } catch (error) {
      showNotice("重命名失败", { message: error instanceof Error ? error.message : "请稍后重试。" });
    }
  }

  async function remove(note: Pick<QuickNote, "id">) {
    setDeleteConfirm(null);
    await window.codexh.deleteQuickNote(note.id);
    const nextNotes = await window.codexh.listQuickNotes();
    setNotes(nextNotes);
    const next = nextNotes[0];
    setSelectedId(next?.id ?? null);
    setTitle(next?.title ?? "");
    setContent(next?.content ?? "");
    contentRef.current = next?.content ?? "";
    setListMenu(null);
    setStatus(next ? "已同步至全局知识库" : "新建笔记后保存至全局知识库");
    showNotice("随手记已删除", { tone: "success" });
  }

  return {
    isOpen, setIsOpen, notes, selectedId, title, content, saving, status,
    renamingId, setRenamingId, renameDraft, setRenameDraft,
    listMenu, setListMenu, deleteConfirm, setDeleteConfirm,
    open, select, create, changeContent, save, rename, remove
  };
}
