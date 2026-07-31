import { useMemo, useState } from "react";
import {
  filterApiCardFavorites,
  removeApiCardFavorite,
  renameApiCardFavorite,
  useApiCardFavorites,
  type ApiCardFavorite
} from "../api-card-favorites";

function formatFavoriteTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ApiCardFavoritesPanel({
  onInsert
}: {
  /** 点击"发送到聊天":把 api-card 块插入聊天输入框 */
  onInsert?: (favorite: ApiCardFavorite) => void;
}) {
  const favorites = useApiCardFavorites();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const visible = useMemo(() => filterApiCardFavorites(favorites, query), [favorites, query]);

  function commitRename() {
    if (editingId) renameApiCardFavorite(editingId, editingName);
    setEditingId(null);
    setEditingName("");
  }

  return (
    <div className="config-block api-favorites-panel">
      <div className="section-copy">
        <strong>接口卡片收藏</strong>
        <span>收藏聊天中的 API 卡片;点击输入框左侧 + 的接口卡片即可搜索并唤出,直接填参调用。</span>
      </div>
      <div className="api-favorites-toolbar">
        <input
          className="form-input api-favorites-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按名称或调用 URL 搜索"
          aria-label="搜索收藏卡片"
        />
        <span className="memory-count-pill">{favorites.length} 张卡片</span>
      </div>
      <div className="api-favorites-list" aria-label="接口卡片收藏列表">
        {visible.map((favorite) => (
          <article key={favorite.id} className="api-favorites-card">
            <div className="api-favorites-card-head">
              <span className={`api-card-method is-${favorite.config.method.toLowerCase()}`}>
                {favorite.config.method}
              </span>
              <div className="api-favorites-card-copy">
                {editingId === favorite.id ? (
                  <input
                    className="form-input api-favorites-rename-input"
                    value={editingName}
                    autoFocus
                    onChange={(event) => setEditingName(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename();
                      if (event.key === "Escape") {
                        setEditingId(null);
                        setEditingName("");
                      }
                    }}
                  />
                ) : (
                  <strong
                    className="api-favorites-card-name"
                    title="双击重命名"
                    onDoubleClick={() => {
                      setEditingId(favorite.id);
                      setEditingName(favorite.name);
                    }}
                  >
                    {favorite.name}
                  </strong>
                )}
                <span className="api-favorites-card-url" title={favorite.config.url}>
                  {favorite.config.url}
                </span>
                <span className="api-favorites-card-meta">
                  收藏于 {formatFavoriteTime(favorite.createdAt)}
                  {favorite.config.auth ? " · 需要授权" : ""}
                  {favorite.config.fields.length > 0 ? ` · ${favorite.config.fields.length} 个参数` : ""}
                </span>
              </div>
              <div className="api-favorites-card-actions">
                {onInsert ? (
                  <button
                    className="button ghost"
                    type="button"
                    title="把卡片发送到当前聊天输入框"
                    onClick={() => onInsert(favorite)}
                  >
                    <span>发送到聊天</span>
                  </button>
                ) : null}
                <button
                  className="button ghost"
                  type="button"
                  title="重命名"
                  onClick={() => {
                    setEditingId(favorite.id);
                    setEditingName(favorite.name);
                  }}
                >
                  <span>重命名</span>
                </button>
                <button
                  className="button ghost danger-icon-button"
                  type="button"
                  title="删除收藏"
                  onClick={() => removeApiCardFavorite(favorite.id)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m3 0v12a2 2 0 01-2 2H8a2 2 0 01-2-2V7" />
                  </svg>
                </button>
              </div>
            </div>
          </article>
        ))}
        {favorites.length === 0 ? (
          <div className="memory-empty-state">
            <strong>还没有收藏的卡片</strong>
            <p>在聊天中的 API 卡片右上角点击星标即可收藏。</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="memory-empty-state">
            <strong>没有匹配的收藏</strong>
            <p>换个名称或 URL 关键词试试。</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
