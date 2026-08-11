import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeLogEntry } from "@shared-types";
import { IconClose, IconRefresh, IconTerminal } from "../icons";

export function ConversationLogWorkspace({
  entries,
  loading,
  onRefresh,
  onClose,
  variant = "window",
  total = entries.length,
  hasMore = false,
  onLoadMore
}: {
  entries: RuntimeLogEntry[];
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
  variant?: "floating" | "window";
  total?: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
}) {
  const [query, setQuery] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = useMemo(() => {
    if (!normalizedQuery) return entries;
    return entries.filter((entry) =>
      `${entry.kind} ${JSON.stringify(entry.payload)}`.toLowerCase().includes(normalizedQuery)
    );
  }, [entries, normalizedQuery]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !stickToBottomRef.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [visibleEntries.length]);

  return (
    <aside className={`conversation-log-${variant}-panel`} aria-label="对话日志窗口">
      <section className="conversation-log-workspace" aria-label="对话日志">
      <header className="conversation-log-toolbar">
        <div className="conversation-log-heading">
          <IconTerminal />
          <div>
            <strong>LLM 实时日志</strong>
            <span>{loading ? "正在读取历史日志..." : `${entries.length} / ${total} 条记录 · 实时更新`}</span>
          </div>
        </div>
        <div className="conversation-log-toolbar-actions">
          <button type="button" className="conversation-log-refresh" onClick={onRefresh} disabled={loading} title="刷新日志" aria-label="刷新日志">
            <IconRefresh />
          </button>
          <button type="button" className="conversation-log-close" onClick={onClose} title="收起日志" aria-label="收起日志">
            <IconClose />
          </button>
        </div>
      </header>
      <label className="conversation-log-filter">
        <span>筛选</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索日志类型、模型、错误或内容..."
          aria-label="筛选对话日志"
          spellCheck={false}
        />
      </label>
      {hasMore && onLoadMore ? (
        <button
          type="button"
          className="conversation-log-load-more"
          onClick={onLoadMore}
          disabled={loading}
        >
          {loading ? "正在加载更早日志..." : "查看更多 · 再加载 300 条"}
        </button>
      ) : null}
      <div
        ref={viewportRef}
        className="conversation-log-list"
        onScroll={(event) => {
          const target = event.currentTarget;
          stickToBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 56;
        }}
      >
        {!loading && visibleEntries.length === 0 ? (
          <div className="conversation-log-empty">
            <IconTerminal />
            <strong>{entries.length === 0 ? "暂无当前对话日志" : "没有匹配的日志"}</strong>
            <span>{entries.length === 0 ? "发送消息后，模型请求、工具调用和错误会实时显示在这里。" : "换一个关键词继续搜索。"}</span>
          </div>
        ) : null}
        {visibleEntries.map((entry, index) => {
          const isError = /error|failed|rejected|exhausted|limit/i.test(entry.kind);
          const payload = JSON.stringify(entry.payload, null, 2);
          return (
            <details
              key={`${entry.timestamp}-${entry.kind}-${index}`}
              className={`conversation-log-entry ${isError ? "is-error" : ""}`}
              open={index === visibleEntries.length - 1}
            >
              <summary>
                <span className="conversation-log-entry-time">{formatLogTime(entry.timestamp)}</span>
                <strong>{formatLogKind(entry.kind)}</strong>
                {entry.threadId ? <code>{entry.threadId.slice(0, 8)}</code> : null}
              </summary>
              <pre>{payload}</pre>
            </details>
          );
        })}
      </div>
      </section>
    </aside>
  );
}

function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString([], { hour12: false });
}

function formatLogKind(kind: string): string {
  return kind.replace(/[._-]+/g, " · ");
}
