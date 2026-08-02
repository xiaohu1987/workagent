import type { Dispatch, SetStateAction } from "react";
import { IconClose, IconKnowledge, IconPlus } from "../icons";

type QuickNote = { id: string; title: string; content: string; updatedAt: string };
type NoteMenu = { x: number; y: number; note: Pick<QuickNote, "id" | "title" | "content"> } | null;
type DeleteConfirm = { id: string; title: string } | null;

type Props = {
  motionPhase: string;
  notes: QuickNote[];
  selectedId: string | null;
  title: string;
  content: string;
  saving: boolean;
  status: string;
  renamingId: string | null;
  renameDraft: string;
  visibleMenu: NoteMenu;
  menuMotionPhase: string;
  visibleDeleteConfirm: DeleteConfirm;
  deleteMotionPhase: string;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  onClose: () => void;
  onCreate: () => void;
  onSelect: (note: QuickNote) => void;
  onOpenMenu: (menu: Exclude<NoteMenu, null>) => void;
  onCloseMenu: () => void;
  onRequestDelete: (target: Exclude<DeleteConfirm, null>) => void;
  onCloseDeleteConfirm: () => void;
  onRename: (note: Pick<QuickNote, "id" | "content">) => Promise<void>;
  onContentChange: (content: string) => void;
  onSave: () => Promise<void>;
  onDelete: (target: Exclude<DeleteConfirm, null>) => Promise<void>;
};

export function QuickNotesSheet({ notes, selectedId, content, saving, status, renamingId, setRenamingId, renameDraft, setRenameDraft, visibleMenu, menuMotionPhase, visibleDeleteConfirm, deleteMotionPhase, motionPhase, onClose, onCreate, onSelect, onOpenMenu, onCloseMenu, onRequestDelete, onCloseDeleteConfirm, onRename, onContentChange, onSave, onDelete }: Props) {
  return (
    <div className="project-sheet-overlay quick-notes-overlay motion-overlay" data-motion={motionPhase}>
      <section className="project-sheet quick-notes-sheet" role="dialog" aria-modal="true" aria-labelledby="quick-notes-title">
        <header className="project-sheet-header"><div className="quick-notes-header-title"><span className="quick-notes-header-icon" aria-hidden="true"><IconKnowledge /></span><strong id="quick-notes-title">随手记</strong><span className="quick-notes-header-scope">全局知识库</span></div><button className="project-sheet-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}><IconClose /></button></header>
        <div className="quick-notes-layout">
          <aside className="quick-notes-list">
            <div className="quick-notes-list-header"><span>笔记</span><button type="button" title="新建笔记" aria-label="新建笔记" className="quick-notes-add" onClick={onCreate}><IconPlus /></button></div>
            {notes.length ? <div className="quick-notes-items">{notes.map((note) => <button key={note.id} type="button" className={`quick-notes-item ${note.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(note)} onContextMenu={(event) => { event.preventDefault(); onOpenMenu({ x: event.clientX, y: event.clientY, note }); }}>
              {renamingId === note.id ? <input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => void onRename(note)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setRenamingId(null); }} /> : <strong>{note.title}</strong>}
              <span>{new Date(note.updatedAt).toLocaleString()}</span>
            </button>)}</div> : <div className="quick-notes-empty">新建一条笔记，记录随时浮现的想法。</div>}
          </aside>
          <div className="quick-notes-editor"><div className="quick-notes-markdown-bar" aria-label="文档编辑器"><strong>文档</strong><span>富文本编辑 · 右键插入内容</span></div><textarea className="quick-notes-content-input quick-notes-plain-editor" value={content} onChange={(event) => onContentChange(event.target.value)} placeholder="在这里开始写作..." spellCheck={false} /><footer className="quick-notes-footer"><span className={`quick-notes-status ${status.includes("已同步") ? "is-synced" : ""}`}>{status}</span><button type="button" className="button primary" disabled={saving} onClick={() => void onSave()}>{saving ? "保存中..." : "保存"}</button></footer></div>
        </div>
        {visibleMenu ? <div className="quick-notes-list-context-menu" data-motion={menuMotionPhase} style={{ left: visibleMenu.x, top: visibleMenu.y }} onMouseLeave={onCloseMenu}><button type="button" onClick={() => { setRenamingId(visibleMenu.note.id); setRenameDraft(visibleMenu.note.title); onCloseMenu(); }}>重命名</button><button type="button" className="danger" onClick={() => { onRequestDelete({ id: visibleMenu.note.id, title: visibleMenu.note.title }); onCloseMenu(); }}>删除</button></div> : null}
        {visibleDeleteConfirm ? <div className="quick-notes-confirm-overlay motion-overlay" data-motion={deleteMotionPhase}><section className="quick-notes-confirm-dialog" role="alertdialog" aria-modal="true"><strong>删除随手记？</strong><p>“{visibleDeleteConfirm.title}”及其对应的全局知识库内容将被删除。</p><footer><button type="button" onClick={onCloseDeleteConfirm}>取消</button><button type="button" className="danger" onClick={() => void onDelete(visibleDeleteConfirm)}>删除</button></footer></section></div> : null}
      </section>
    </div>
  );
}
