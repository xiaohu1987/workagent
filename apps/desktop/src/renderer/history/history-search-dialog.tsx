import type { Dispatch, SetStateAction } from "react";
import { IconClose, IconSearch } from "../icons";
import type { HistorySearchResult } from "../core/app-types";

type Props = {
  motionPhase: string;
  selectedThreadId: string | null;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  results: HistorySearchResult[];
  loading: boolean;
  onClose: () => void;
  onOpenThread: (threadId: string) => Promise<void>;
  formatRelativeTime: (value: string) => string;
};

export function HistorySearchDialog({ motionPhase, selectedThreadId, query, setQuery, results, loading, onClose, onOpenThread, formatRelativeTime }: Props) {
  return (
    <div className="history-search-overlay motion-overlay" data-motion={motionPhase}>
      <section className="history-search-dialog" role="dialog" aria-modal="true" aria-label="搜索历史对话">
        <div className="history-search-header"><strong>搜索历史对话</strong><button className="history-search-close" type="button" onClick={onClose} title="关闭"><IconClose /></button></div>
        <div className="history-search-input-wrap"><IconSearch /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，搜索标题和历史消息" /></div>
        <div className="history-search-hint">双击结果即可快速打开该对话</div>
        <div className="history-search-results">
          {loading ? <div className="history-search-empty">正在搜索...</div> : null}
          {!loading && results.length === 0 ? <div className="history-search-empty">没有匹配的历史对话</div> : null}
          {!loading ? results.map((result) => (
            <button key={result.thread.id} className={`history-search-result ${result.thread.id === selectedThreadId ? "is-current" : ""}`} type="button" onDoubleClick={() => { onClose(); void onOpenThread(result.thread.id); }}>
              <span className="history-search-result-title">{result.thread.title}</span>
              <span className="history-search-result-meta">{result.thread.mode === "project" ? "项目对话" : "普通对话"} · {formatRelativeTime(result.thread.updatedAt)}</span>
              {result.snippet ? <span className="history-search-result-snippet">{result.snippet}</span> : null}
            </button>
          )) : null}
        </div>
      </section>
    </div>
  );
}
