import { useMemo, useState } from "react";
import {
  filterApiCardFavorites,
  removeApiCardFavorite,
  renameApiCardFavorite,
  useApiCardFavorites,
  type ApiCardFavorite
} from "../api-card-favorites";
import { IconSearch } from "../icons";
import { ApiCardMessage, ApiCardThreadContext } from "../cards/api-card-message";

function formatFavoriteTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type FavoritesSidebarProps = {
  favorites: ApiCardFavorite[];
  visible: ApiCardFavorite[];
  query: string;
  selectedId: string | null;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
};

/** 左栏：搜索框 + 收藏列表；条目结构与随手记一致（标题 + 元信息行）。 */
function FavoritesSidebar({ favorites, visible, query, selectedId, onQueryChange, onSelect }: FavoritesSidebarProps) {
  return (
    <aside className="quick-notes-list">
      <div className="quick-notes-list-header">
        <span>收藏</span>
        <span className="quick-notes-header-status">{favorites.length} 张卡片</span>
      </div>
      <span className="api-favorites-search-wrap">
        <span className="api-favorites-search-icon" aria-hidden="true">
          <IconSearch />
        </span>
        <input
          className="form-input api-favorites-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索名称或调用 URL"
          aria-label="搜索收藏卡片"
        />
      </span>
      {visible.length ? (
        <div className="quick-notes-items" aria-label="接口卡片收藏列表">
          {visible.map((favorite) => (
            <button
              key={favorite.id}
              type="button"
              className={`quick-notes-item ${selectedId === favorite.id ? "selected" : ""}`}
              data-method={favorite.config.method.toLowerCase()}
              onClick={() => onSelect(favorite.id)}
            >
              <strong>{favorite.name}</strong>
              <span className="quick-notes-item-meta">
                <span className="api-favorites-method">{favorite.config.method}</span>
                <span className="quick-notes-item-time">{formatFavoriteTime(favorite.createdAt)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="quick-notes-empty">
          {favorites.length ? "没有匹配的收藏，换个名称或 URL 关键词试试。" : "在聊天中的 API 卡片右上角点击星标即可收藏。"}
        </div>
      )}
      <p className="api-favorites-hint">点击条目查看详情，收藏的卡片可以直接填参调用。</p>
    </aside>
  );
}

type FavoritesDetailProps = {
  selected: ApiCardFavorite | null;
  editorOpen: boolean;
  editingId: string | null;
  editingName: string;
  threadId: string | null;
  onInsert?: (favorite: ApiCardFavorite) => void;
  onToggleEditor: () => void;
  onCollapseEditor: () => void;
  onStartRename: (favorite: ApiCardFavorite) => void;
  onEditingNameChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
};

/** 右栏：选中卡片的信息栏、完整卡片与底部操作，骨架与随手记编辑器一致。 */
function FavoritesDetail({ selected, editorOpen, editingId, editingName, threadId, onInsert, onToggleEditor, onCollapseEditor, onStartRename, onEditingNameChange, onCommitRename, onCancelRename }: FavoritesDetailProps) {
  if (!selected) {
    return (
      <section className="quick-notes-editor" aria-label="接口卡片详情">
        <div className="quick-notes-empty">从左侧列表选一张收藏，在这里查看详情并直接调用。</div>
      </section>
    );
  }

  return (
    <section className="quick-notes-editor" aria-label="接口卡片详情">
      <div className="quick-notes-markdown-bar" aria-label="接口卡片信息">
        <strong>{selected.config.method}</strong>
        <span>{selected.config.url}</span>
      </div>
      <div className="api-favorites-detail-title">
        {editingId === selected.id ? (
          <input
            className="form-input api-favorites-rename-input"
            value={editingName}
            autoFocus
            onChange={(event) => onEditingNameChange(event.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommitRename();
              if (event.key === "Escape") onCancelRename();
            }}
          />
        ) : (
          <strong
            className="api-favorites-detail-name"
            title="双击重命名"
            onDoubleClick={() => onStartRename(selected)}
          >
            {selected.name}
          </strong>
        )}
        {selected.config.auth ? <span className="api-favorites-chip is-auth">需要授权</span> : null}
        {selected.config.fields.length > 0 ? (
          <span className="api-favorites-chip">{selected.config.fields.length} 个参数</span>
        ) : null}
      </div>
      {editorOpen ? (
        <div className="api-favorites-card-editor">
          <ApiCardThreadContext.Provider value={threadId ?? null}>
            <ApiCardMessage
              configText={JSON.stringify(selected.config)}
              onCollapsedChange={(collapsed) => {
                if (collapsed) onCollapseEditor();
              }}
            />
          </ApiCardThreadContext.Provider>
        </div>
      ) : null}
      <footer className="quick-notes-footer">
        <span className="quick-notes-status">收藏于 {formatFavoriteTime(selected.createdAt)}</span>
        <div className="quick-notes-footer-actions">
          <button type="button" className="button secondary" onClick={onToggleEditor}>
            {editorOpen ? "收起卡片" : "展开卡片"}
          </button>
          <button type="button" className="button secondary" onClick={() => onStartRename(selected)}>
            重命名
          </button>
          <button type="button" className="button secondary" onClick={() => removeApiCardFavorite(selected.id)}>
            删除
          </button>
          {onInsert ? (
            <button type="button" className="button primary" onClick={() => onInsert(selected)}>
              发送到聊天
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

export function ApiCardFavoritesPanel({
  onInsert,
  threadId
}: {
  /** 点击"发送到聊天"：把 api-card 块插入聊天输入框 */
  onInsert?: (favorite: ApiCardFavorite) => void;
  threadId?: string | null;
}) {
  const favorites = useApiCardFavorites();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(true);

  const visible = useMemo(() => filterApiCardFavorites(favorites, query), [favorites, query]);
  const selected = useMemo<ApiCardFavorite | null>(() => {
    if (visible.length === 0) return null;
    return visible.find((favorite) => favorite.id === selectedId) ?? visible[0] ?? null;
  }, [visible, selectedId]);

  function commitRename() {
    if (editingId) renameApiCardFavorite(editingId, editingName);
    setEditingId(null);
    setEditingName("");
  }

  return (
    <div className="quick-notes-layout">
      <FavoritesSidebar
        favorites={favorites}
        visible={visible}
        query={query}
        selectedId={selected?.id ?? null}
        onQueryChange={setQuery}
        onSelect={(id) => {
          setSelectedId(id);
          setEditorOpen(true);
        }}
      />
      <FavoritesDetail
        selected={selected}
        editorOpen={editorOpen}
        editingId={editingId}
        editingName={editingName}
        threadId={threadId ?? null}
        onInsert={onInsert}
        onToggleEditor={() => setEditorOpen((current) => !current)}
        onCollapseEditor={() => setEditorOpen(false)}
        onStartRename={(favorite) => {
          setEditingId(favorite.id);
          setEditingName(favorite.name);
        }}
        onEditingNameChange={setEditingName}
        onCommitRename={commitRename}
        onCancelRename={() => {
          setEditingId(null);
          setEditingName("");
        }}
      />
    </div>
  );
}
