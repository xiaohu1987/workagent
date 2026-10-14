import { useMemo, useState } from "react";
import {
  filterApiCardFavorites,
  removeApiCardFavorite,
  renameApiCardFavorite,
  updateApiCardFavoriteConfig,
  useApiCardFavorites,
  type ApiCardFavorite
} from "../api-card-favorites";
import { IconRename, IconSearch, IconTrash } from "../icons";
import { ApiCardMessage, ApiCardThreadContext } from "../cards/api-card-message";
import {
  ApiFavoritesCardEdit,
  createApiCardEditDraft,
  resolveApiCardEditDraft,
  type ApiCardEditDraft
} from "./api-favorites-card-edit";

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
  onStartEdit: (favorite: ApiCardFavorite) => void;
  onDelete: (favorite: ApiCardFavorite) => void;
};

/** 左栏：搜索框 + 收藏列表；条目左侧是标题与元信息，右侧贴边放编辑与删除图标。 */
function FavoritesSidebar({ favorites, visible, query, selectedId, onQueryChange, onSelect, onStartEdit, onDelete }: FavoritesSidebarProps) {
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
            <div
              key={favorite.id}
              className={`quick-notes-item ${selectedId === favorite.id ? "selected" : ""}`}
              data-method={favorite.config.method.toLowerCase()}
            >
              {/* 行主体负责选中；图标按钮独立成组，避免按钮嵌套按钮。 */}
              <button
                type="button"
                className="api-favorites-item-main"
                onClick={() => onSelect(favorite.id)}
              >
                <strong>{favorite.name}</strong>
                <span className="quick-notes-item-meta">
                  <span className="api-favorites-method">{favorite.config.method}</span>
                  <span className="quick-notes-item-time">{formatFavoriteTime(favorite.createdAt)}</span>
                </span>
              </button>
              <span className="api-favorites-item-actions">
                <button
                  type="button"
                  className="api-favorites-icon-button"
                  title="编辑卡片"
                  aria-label={`编辑 ${favorite.name}`}
                  onClick={() => onStartEdit(favorite)}
                >
                  <IconRename />
                </button>
                <button
                  type="button"
                  className="api-favorites-icon-button is-danger"
                  title="删除收藏"
                  aria-label={`删除 ${favorite.name}`}
                  onClick={() => onDelete(favorite)}
                >
                  <IconTrash />
                </button>
              </span>
            </div>
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
  draft: ApiCardEditDraft | null;
  editError: string | null;
  threadId: string | null;
  onInsert?: (favorite: ApiCardFavorite) => void;
  onEditChange: (patch: Partial<ApiCardEditDraft>) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
};

/** 右栏：选中卡片的信息栏、完整卡片与底部操作，骨架与随手记编辑器一致。 */
function FavoritesDetail({ selected, draft, editError, threadId, onInsert, onEditChange, onSaveEdit, onCancelEdit }: FavoritesDetailProps) {
  if (!selected) {
    return (
      <section className="quick-notes-editor" aria-label="接口卡片详情">
        <div className="quick-notes-empty">从左侧列表选一张收藏，在这里查看详情并直接调用。</div>
      </section>
    );
  }

  /** 草稿只属于选中的那张收藏，切换条目后草稿失效即视为退出编辑。 */
  const editing = draft !== null && draft.id === selected.id;

  return (
    <section className="quick-notes-editor" aria-label="接口卡片详情">
      <div className="quick-notes-markdown-bar" aria-label="接口卡片信息">
        <strong>{selected.config.method}</strong>
        <span>{selected.config.url}</span>
      </div>
      <div className="api-favorites-detail-title">
        <strong className="api-favorites-detail-name" title={selected.name}>
          {selected.name}
        </strong>
        {selected.config.auth ? <span className="api-favorites-chip is-auth">需要授权</span> : null}
        {selected.config.fields.length > 0 ? (
          <span className="api-favorites-chip">{selected.config.fields.length} 个参数</span>
        ) : null}
      </div>
      <div className="api-favorites-card-editor">
        {editing && draft ? (
          <ApiFavoritesCardEdit draft={draft} error={editError} onChange={onEditChange} />
        ) : (
          <ApiCardThreadContext.Provider value={threadId ?? null}>
            <ApiCardMessage key={selected.id} configText={JSON.stringify(selected.config)} />
          </ApiCardThreadContext.Provider>
        )}
      </div>
      <footer className="quick-notes-footer">
        <span className="quick-notes-status">
          {editing ? "改动只保存在收藏里，保存后立即生效。" : `收藏于 ${formatFavoriteTime(selected.createdAt)}`}
        </span>
        <div className="quick-notes-footer-actions">
          {editing ? (
            <>
              <button type="button" className="button secondary" onClick={onCancelEdit}>
                取消
              </button>
              <button type="button" className="button primary" onClick={onSaveEdit}>
                保存
              </button>
            </>
          ) : onInsert ? (
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ApiCardEditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const visible = useMemo(() => filterApiCardFavorites(favorites, query), [favorites, query]);
  const selected = useMemo<ApiCardFavorite | null>(() => {
    if (visible.length === 0) return null;
    return visible.find((favorite) => favorite.id === selectedId) ?? visible[0] ?? null;
  }, [visible, selectedId]);

  function startEdit(favorite: ApiCardFavorite) {
    setDraft(createApiCardEditDraft(favorite));
    setEditError(null);
  }

  function cancelEdit() {
    setDraft(null);
    setEditError(null);
  }

  /** 保存：按草稿重建配置并整体校验，通过后写回名称与配置。 */
  function saveEdit() {
    if (!draft) return;
    const favorite = favorites.find((item) => item.id === draft.id);
    if (!favorite) {
      cancelEdit();
      return;
    }
    const resolved = resolveApiCardEditDraft(favorite, draft);
    if (!resolved.ok) {
      setEditError(resolved.error);
      return;
    }
    if (resolved.name !== favorite.name) renameApiCardFavorite(favorite.id, resolved.name);
    updateApiCardFavoriteConfig(favorite.id, resolved.config);
    cancelEdit();
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
          cancelEdit();
        }}
        onStartEdit={(favorite) => {
          setSelectedId(favorite.id);
          startEdit(favorite);
        }}
        onDelete={(favorite) => {
          removeApiCardFavorite(favorite.id);
          if (draft?.id === favorite.id) cancelEdit();
        }}
      />
      <FavoritesDetail
        selected={selected}
        draft={draft}
        editError={editError}
        threadId={threadId ?? null}
        onInsert={onInsert}
        onEditChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
        onSaveEdit={saveEdit}
        onCancelEdit={cancelEdit}
      />
    </div>
  );
}
