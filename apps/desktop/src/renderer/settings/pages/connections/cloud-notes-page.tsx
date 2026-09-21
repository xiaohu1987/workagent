import { useEffect, useRef, useState } from "react";
import { IconClose, IconDownload, IconNotebook, IconPlus, IconRefresh } from "../../../icons";
import { useCloudNotes } from "../../../hooks/use-cloud-notes";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

type Props = {
  showNotice: Notice;
};

function formatTime(value: string | null): string {
  if (!value) return "尚未同步";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * 云笔记设置页：
 * 未登录时整页只有一张居中的登录 / 注册卡片（服务器地址固定，不作可编辑项）；
 * 登录成功后整页只剩笔记列表。
 * 列表按修改时间倒序、不分页，每行可编辑、删除、拉取到本地随手记；
 * 列表外的「新增云笔记」按钮弹出写作弹窗，保存即同步。
 */
export function CloudNotesPage({ showNotice }: Props) {
  const state = useCloudNotes(showNotice);
  const loadedRef = useRef(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void state.initialize();
  }, [state]);

  const { status, notes, editor, deleteTarget, busy, message } = state;
  // 登录后页面上要能一眼认出卖家身份：优先显示昵称，其次邮箱。
  const accountName = (status?.displayName ?? "").trim() || status?.email || "";
  const accountInitial = accountName.trim().charAt(0).toUpperCase() || "云";

  if (!status) {
    return (
      <div className="settings-section cloud-notes-page">
        <div className="config-block">
          <p className="cloud-notes-status">正在读取云笔记状态…</p>
        </div>
      </div>
    );
  }

  // 未登录：整页只保留注册 / 登录
  if (!status.loggedIn) {
    const isRegister = authMode === "register";
    return (
      <div className="settings-section cloud-notes-page">
        <section className="cloud-notes-auth-card">
          <span className="cloud-notes-auth-glow" aria-hidden="true" />
          <header className="cloud-notes-auth-hero">
            <span className="cloud-notes-auth-badge" aria-hidden="true">
              <IconNotebook />
            </span>
            <h3>云笔记</h3>
            <p>
              {isRegister
                ? "注册一个账号，之后本地随手记就能随时同步到你的服务器。"
                : "登录你的账号，笔记会在本地与服务器之间保持同步。"}
            </p>
          </header>

          <div className="cloud-notes-auth-tabs" role="tablist" aria-label="登录或注册">
            <button
              className={`cloud-notes-auth-tab${isRegister ? "" : " is-active"}`}
              type="button"
              role="tab"
              aria-selected={!isRegister}
              disabled={busy}
              onClick={() => setAuthMode("login")}
            >
              登录
            </button>
            <button
              className={`cloud-notes-auth-tab${isRegister ? " is-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={isRegister}
              disabled={busy}
              onClick={() => setAuthMode("register")}
            >
              注册
            </button>
          </div>

          <form
            className="cloud-notes-auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void state.submitCredentials(isRegister);
            }}
          >
            <label className="cloud-notes-auth-field">
              <span>邮箱</span>
              <input
                type="email"
                name="email"
                autoComplete="username"
                spellCheck={false}
                placeholder="you@example.com"
                value={state.email}
                onChange={(event) => state.setEmail(event.target.value)}
              />
            </label>
            <label className="cloud-notes-auth-field">
              <span>密码</span>
              <input
                type="password"
                name="password"
                autoComplete={isRegister ? "new-password" : "current-password"}
                placeholder={isRegister ? "设置一个密码" : "登录密码"}
                value={state.password}
                onChange={(event) => state.setPassword(event.target.value)}
              />
            </label>
            {isRegister ? (
              <label className="cloud-notes-auth-field">
                <span>
                  昵称<em className="cloud-notes-auth-optional">可选</em>
                </span>
                <input
                  name="displayName"
                  autoComplete="nickname"
                  placeholder="不填就用邮箱前缀"
                  value={state.displayName}
                  onChange={(event) => state.setDisplayName(event.target.value)}
                />
              </label>
            ) : null}
            <button className="button primary cloud-notes-auth-submit" type="submit" disabled={busy}>
              {busy ? "正在连接…" : isRegister ? "注册并登录" : "登录"}
            </button>
          </form>

          {message ? (
            <p className="cloud-notes-auth-message" role="status">
              {message}
            </p>
          ) : null}

          <footer className="cloud-notes-auth-foot">
            <span className="cloud-notes-auth-dot" aria-hidden="true" />
            <span>服务器 {state.serverUrl}</span>
          </footer>
        </section>
      </div>
    );
  }

  // 已登录：整页只保留笔记列表
  return (
    <div className="settings-section cloud-notes-page">
      <section className="config-block cloud-notes-workspace">
        <header className="cloud-notes-workspace-head">
          <div className="cloud-notes-head">
            <span className="cloud-notes-icon" aria-hidden="true">
              <IconNotebook />
            </span>
            <div>
              <strong>云笔记</strong>
              <span>
                本地 {notes.length} 条 · 待同步 {status.pendingCount} 条 · 最近同步 {formatTime(status.lastSyncedAt)}
              </span>
            </div>
          </div>
          <div className="cloud-notes-action-row">
            <button className="button secondary" type="button" disabled={busy} onClick={() => void state.sync()}>
              <IconRefresh />同步
            </button>
            <button className="button ghost" type="button" disabled={busy} onClick={() => void state.logout()}>
              退出登录
            </button>
          </div>
        </header>

        <div className="cloud-notes-account">
          <span className="cloud-notes-avatar" aria-hidden="true">
            {accountInitial}
          </span>
          <div className="cloud-notes-account-meta">
            <strong>{accountName || "已登录账号"}</strong>
            <span>{(status.displayName ?? "").trim() ? status.email : status.serverUrl}</span>
          </div>
          <span className="cloud-notes-account-tag">已登录</span>
        </div>

        <div className="cloud-notes-list-bar">
          <div>
            <strong>全部笔记（{notes.length}）</strong>
            <span>按修改时间倒序排列，本地保存后立即同步。</span>
          </div>
          <button className="button primary" type="button" disabled={busy} onClick={state.openCreateEditor}>
            <IconPlus />新增云笔记
          </button>
        </div>

        <div className="cloud-notes-note-list">
          {notes.length ? (
            notes.map((note) => (
              <article key={note.id} className="cloud-notes-row">
                <button
                  type="button"
                  className="cloud-notes-row-main"
                  disabled={busy}
                  onClick={() => state.openEditEditor(note)}
                >
                  <strong>{note.title || "未命名"}</strong>
                  <span className="cloud-notes-row-meta">
                    {note.dirty ? <em className="cloud-notes-tag is-pending">待同步</em> : null}
                    {state.links[note.id] ? <em className="cloud-notes-tag is-linked">已关联随手记</em> : null}
                    <time dateTime={note.updatedAt}>{formatTime(note.updatedAt)}</time>
                  </span>
                </button>
                <div className="cloud-notes-row-actions">
                  <button
                    className="button secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => state.openEditEditor(note)}
                  >
                    编辑
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => void state.pullToQuickNote(note.id)}
                  >
                    <IconDownload />拉取到随手记
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => state.requestDelete(note)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="cloud-notes-note-empty">还没有云笔记，点“新增云笔记”写第一条。</p>
          )}
        </div>

        {message ? <p className="cloud-notes-message">{message}</p> : null}
      </section>

      {editor ? (
        <div className="cloud-notes-sheet-overlay" role="presentation">
          <section
            className="cloud-notes-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cloud-notes-sheet-title"
          >
            <header className="cloud-notes-sheet-head">
              <strong id="cloud-notes-sheet-title">{editor.mode === "create" ? "新增云笔记" : "编辑云笔记"}</strong>
              <button
                className="button ghost cloud-notes-sheet-close"
                type="button"
                title="关闭"
                aria-label="关闭"
                onClick={state.closeEditor}
              >
                <IconClose />
              </button>
            </header>
            <label className="settings-field">
              <span>标题</span>
              <input
                value={editor.title}
                placeholder="标题（留空时按正文自动生成）"
                onChange={(event) => state.setEditorTitle(event.target.value)}
              />
            </label>
            <label className="settings-field">
              <span>正文</span>
              <textarea
                rows={12}
                value={editor.content}
                placeholder="写下要同步到云端的笔记…"
                onChange={(event) => state.setEditorContent(event.target.value)}
              />
            </label>
            <footer className="cloud-notes-sheet-foot">
              <span className="cloud-notes-status">保存后立即同步到服务器，已关联的随手记会同时更新。</span>
              <div className="cloud-notes-editor-actions">
                <button className="button ghost" type="button" disabled={editor.saving} onClick={state.closeEditor}>
                  取消
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={editor.saving}
                  onClick={() => void state.saveEditor()}
                >
                  {editor.saving ? "保存并同步中…" : "保存并同步"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="cloud-notes-sheet-overlay" role="presentation">
          <section
            className="cloud-notes-sheet cloud-notes-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cloud-notes-confirm-title"
          >
            <strong id="cloud-notes-confirm-title">删除这条云笔记？</strong>
            <p>“{deleteTarget.title || "未命名"}”会在下次同步时从服务器一并删除，本地随手记不受影响。</p>
            <footer className="cloud-notes-sheet-foot">
              <button className="button ghost" type="button" disabled={busy} onClick={state.cancelDelete}>
                取消
              </button>
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={() => void state.confirmDelete()}
              >
                删除
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
