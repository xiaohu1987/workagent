import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeLogEntry, RuntimeLogPage } from "@shared-types";
import { ConversationLogWorkspace } from "../workspace/conversation-log-workspace";
import "../styles.css";
import "./conversation-log-window.css";

type ConversationLogWindowEvent =
  | ({ kind: "history"; threadId: string } & RuntimeLogPage)
  | { kind: "entry"; entry: RuntimeLogEntry };

function ConversationLogWindowApp() {
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("threadId"));
  const [visibleLimit, setVisibleLimit] = useState(300);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const visibleLimitRef = useRef(visibleLimit);
  const entriesRef = useRef(entries);
  visibleLimitRef.current = visibleLimit;
  entriesRef.current = entries;

  const loadPage = useCallback((targetThreadId: string | null, limit: number) => {
    if (!targetThreadId) {
      setEntries([]);
      setTotal(0);
      setHasMore(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.codexh.getThreadRuntimeLogs(targetThreadId, limit)
      .then((next) => {
        setEntries(next.entries);
        setTotal(next.total);
        setHasMore(next.hasMore);
      })
      .catch(() => {
        setEntries([]);
        setTotal(0);
        setHasMore(false);
      })
      .finally(() => setLoading(false));
  }, []);

  const refresh = useCallback(() => {
    loadPage(threadId, visibleLimit);
  }, [loadPage, threadId, visibleLimit]);

  const loadMore = useCallback(() => {
    const nextLimit = visibleLimit + 300;
    setVisibleLimit(nextLimit);
    loadPage(threadId, nextLimit);
  }, [loadPage, threadId, visibleLimit]);

  useEffect(() => {
    const dispose = window.codexh.onConversationLogWindowEvent((event) => {
      const typed = event as ConversationLogWindowEvent;
      if (typed.kind === "history") {
        setThreadId(typed.threadId);
        setVisibleLimit(300);
        setEntries(typed.entries);
        setTotal(typed.total);
        setHasMore(typed.hasMore);
        setLoading(false);
        return;
      }
      const duplicate = entriesRef.current.some((entry) =>
          entry.timestamp === typed.entry.timestamp &&
          entry.kind === typed.entry.kind &&
          entry.threadId === typed.entry.threadId
        );
      if (!duplicate) {
        const nextEntries = [...entriesRef.current, typed.entry].slice(-visibleLimitRef.current);
        entriesRef.current = nextEntries;
        setEntries(nextEntries);
        setTotal((current) => current + 1);
        setHasMore((current) => current || nextEntries.length >= visibleLimitRef.current);
      }
      setLoading(false);
    });
    window.codexh.markConversationLogWindowReady();
    loadPage(threadId, 300);
    return dispose;
  }, [loadPage, threadId]);

  return (
    <ConversationLogWorkspace
      entries={entries}
      loading={loading}
      onRefresh={refresh}
      total={total}
      hasMore={hasMore}
      onLoadMore={loadMore}
      onClose={() => void window.codexh.closeConversationLogWindow()}
      variant="window"
    />
  );
}

createRoot(document.getElementById("root")!).render(<ConversationLogWindowApp />);
