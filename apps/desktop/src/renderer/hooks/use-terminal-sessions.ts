import { useEffect, useRef, useState } from "react";
import type { TerminalWorkspaceTab } from "../workspace/terminal-workspace";

export type TerminalSessionState = {
  output: string;
  cwd: string;
  shell: string;
};

export function useTerminalSessions(selectedThreadId: string | null) {
  const [tabsByThread, setTabsByThread] = useState<Record<string, TerminalWorkspaceTab[]>>({});
  const [activeTabByThread, setActiveTabByThread] = useState<Record<string, string>>({});
  const [inputsByThread, setInputsByThread] = useState<Record<string, Record<string, string>>>({});
  const [sessionsByThread, setSessionsByThread] = useState<Record<string, Record<string, TerminalSessionState>>>({});
  const outputFramesRef = useRef<Record<string, { data: string; frame: number }>>({});

  useEffect(() => () => {
    for (const pending of Object.values(outputFramesRef.current)) window.cancelAnimationFrame(pending.frame);
  }, []);

  const tabs = selectedThreadId ? tabsByThread[selectedThreadId] ?? [] : [];
  const activeSessionId = selectedThreadId ? activeTabByThread[selectedThreadId] ?? tabs[0]?.id ?? null : null;
  const activeSession = selectedThreadId && activeSessionId ? sessionsByThread[selectedThreadId]?.[activeSessionId] ?? null : null;
  const input = selectedThreadId && activeSessionId ? inputsByThread[selectedThreadId]?.[activeSessionId] ?? "" : "";

  const ensureTab = (threadId: string, sessionId = "default") => {
    setTabsByThread((current) => current[threadId]?.some((tab) => tab.id === sessionId) ? current : {
      ...current,
      [threadId]: [...(current[threadId] ?? []), { id: sessionId, title: sessionId === "default" ? "终端" : `终端 ${(current[threadId]?.length ?? 0) + 1}` }]
    });
    setActiveTabByThread((current) => current[threadId] ? current : { ...current, [threadId]: sessionId });
  };

  const setInput = (value: string) => {
    if (!selectedThreadId || !activeSessionId) return;
    setInputsByThread((current) => ({ ...current, [selectedThreadId]: { ...(current[selectedThreadId] ?? {}), [activeSessionId]: value } }));
  };

  const selectTab = (sessionId: string) => {
    if (selectedThreadId) setActiveTabByThread((current) => ({ ...current, [selectedThreadId]: sessionId }));
  };

  const addTab = () => {
    if (!selectedThreadId) return;
    const id = globalThis.crypto.randomUUID();
    setTabsByThread((current) => ({ ...current, [selectedThreadId]: [...(current[selectedThreadId] ?? []), { id, title: `终端 ${(current[selectedThreadId]?.length ?? 0) + 1}` }] }));
    setActiveTabByThread((current) => ({ ...current, [selectedThreadId]: id }));
  };

  const closeTab = (sessionId: string) => {
    if (!selectedThreadId) return;
    const remaining = tabs.filter((tab) => tab.id !== sessionId);
    setTabsByThread((current) => ({ ...current, [selectedThreadId]: remaining }));
    setActiveTabByThread((current) => ({ ...current, [selectedThreadId]: remaining.at(-1)?.id ?? "" }));
    setInputsByThread((current) => { const next = { ...(current[selectedThreadId] ?? {}) }; delete next[sessionId]; return { ...current, [selectedThreadId]: next }; });
    setSessionsByThread((current) => { const next = { ...(current[selectedThreadId] ?? {}) }; delete next[sessionId]; return { ...current, [selectedThreadId]: next }; });
    void window.codexh.closeTerminal({ threadId: selectedThreadId, sessionId });
  };

  const queueOutput = (threadId: string, sessionId: string, data: string) => {
    const key = `${threadId}:${sessionId}`;
    const pending = outputFramesRef.current[key];
    if (pending) { pending.data = `${pending.data}${data}`.slice(-80_000); return; }
    outputFramesRef.current[key] = { data: data.slice(-80_000), frame: window.requestAnimationFrame(() => {
      const buffered = outputFramesRef.current[key];
      delete outputFramesRef.current[key];
      if (!buffered) return;
      setSessionsByThread((current) => {
        const session = current[threadId]?.[sessionId];
        return { ...current, [threadId]: { ...(current[threadId] ?? {}), [sessionId]: { output: `${session?.output ?? ""}${buffered.data}`.slice(-80_000), cwd: session?.cwd ?? "", shell: session?.shell ?? "PowerShell" } } };
      });
    }) };
  };

  const updateSession = (threadId: string, sessionId: string, updater: (current: TerminalSessionState | null) => TerminalSessionState) => {
    setSessionsByThread((current) => ({
      ...current,
      [threadId]: { ...(current[threadId] ?? {}), [sessionId]: updater(current[threadId]?.[sessionId] ?? null) }
    }));
  };

  const clearThread = (threadId: string) => {
    setTabsByThread((current) => { const next = { ...current }; delete next[threadId]; return next; });
    setActiveTabByThread((current) => { const next = { ...current }; delete next[threadId]; return next; });
    setInputsByThread((current) => { const next = { ...current }; delete next[threadId]; return next; });
    setSessionsByThread((current) => { const next = { ...current }; delete next[threadId]; return next; });
  };

  return { tabs, activeSessionId, activeSession, input, ensureTab, setInput, selectTab, addTab, closeTab, queueOutput, updateSession, clearThread };
}
