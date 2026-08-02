import { useEffect, useState } from "react";
import type { HistorySearchResult } from "../core/app-types";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

export function useHistorySearch(showNotice: Notice) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HistorySearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void window.codexh.searchThreads(query).then((nextResults) => {
        if (!cancelled) setResults(nextResults as HistorySearchResult[]);
      }).catch((error) => {
        if (!cancelled) showNotice("搜索历史对话失败", { message: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 100);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  function open() {
    setQuery("");
    setResults([]);
    setIsOpen(true);
  }

  return { isOpen, setIsOpen, query, setQuery, results, setResults, loading, open };
}
