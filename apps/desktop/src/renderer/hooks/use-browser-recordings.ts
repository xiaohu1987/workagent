import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BrowserRecording,
  BrowserRecordingFamily,
  BrowserRecordingSession,
  DetectedBrowser
} from "@shared-types";

const idleSession: BrowserRecordingSession = {
  mode: "idle", operation: null, recordingId: null, recordingName: null, browser: null,
  stepCount: 0, currentStep: 0, totalSteps: 0, error: null, failedActionId: null, missingFileKey: null
};

export function useBrowserRecordings(showNotice: (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void, threadId: string | null) {
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>([]);
  const [recordings, setRecordings] = useState<BrowserRecording[]>([]);
  const [session, setSession] = useState<BrowserRecordingSession>(idleSession);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [script, setScript] = useState("");
  const [document, setDocument] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextBrowsers, nextRecordings, nextSession] = await Promise.all([
      window.codexh.detectRecordingBrowsers(),
      window.codexh.listBrowserRecordings(),
      window.codexh.getBrowserRecordingState()
    ]);
    setBrowsers(nextBrowsers);
    setRecordings(nextRecordings);
    setSession(nextSession);
    setSelectedId((current) => current && nextRecordings.some((item) => item.id === current)
      ? current
      : nextRecordings[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refresh().catch((nextError) => setError(errorMessage(nextError))).finally(() => setLoading(false));
    return window.codexh.onBrowserRecordingState((nextSession) => {
      setSession(nextSession);
      if (nextSession.llmStatus === "candidate" || nextSession.llmStatus === "error") void refresh();
      if (nextSession.mode === "completed") {
        if (nextSession.recordingId) setSelectedId(nextSession.recordingId);
        void refresh();
      }
    });
  }, [refresh]);

  useEffect(() => {
    const selected = recordings.find((item) => item.id === selectedId);
    if (!selected || selected.status === "recording" || selected.status === "invalid") {
      setScript("");
      setDocument("");
      return;
    }
    let cancelled = false;
    void Promise.all([
      window.codexh.readBrowserRecordingScript(selected.id),
      window.codexh.readBrowserRecordingDocument(selected.id)
    ]).then(([nextScript, nextDocument]) => {
      if (!cancelled) { setScript(nextScript); setDocument(nextDocument); }
    }).catch(() => { if (!cancelled) { setScript(""); setDocument(""); } });
    return () => { cancelled = true; };
  }, [selectedId, recordings]);

  const run = useCallback(async (operation: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      if (success) showNotice(success, { tone: "success" });
      await refresh();
      return true;
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      showNotice("浏览器录制操作失败", { tone: "warning", message });
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, showNotice]);

  return {
    browsers,
    threadId,
    recordings,
    session,
    selectedId,
    selected: useMemo(() => recordings.find((item) => item.id === selectedId) ?? null, [recordings, selectedId]),
    script,
    document,
    loading,
    busy,
    error,
    setSelectedId,
    refresh,
    start: (input: { browser: BrowserRecordingFamily; name?: string; startUrl?: string; startUrls?: string[] }) => threadId
      ? run(() => window.codexh.startBrowserRecording({ ...input, threadId }))
      : Promise.resolve(false),
    play: (id: string) => threadId
      ? run(() => window.codexh.playBrowserRecording({ recordingId: id, threadId }))
      : Promise.resolve(false),
    applyLlmCandidate: (id: string) => run(() => window.codexh.applyBrowserRecordingLlmCandidate(id), "已采用 LLM 修复候选"),
    discardLlmCandidate: (id: string) => run(() => window.codexh.discardBrowserRecordingLlmCandidate(id), "已放弃 LLM 修复候选"),
    enhance: (id: string) => threadId
      ? run(() => window.codexh.enhanceBrowserRecording({ recordingId: id, threadId }), "已开始 LLM 完善")
      : Promise.resolve(false),
    rename: (id: string, name: string) => run(() => window.codexh.renameBrowserRecording({ recordingId: id, name }), "录制已重命名"),
    remove: (id: string) => run(() => window.codexh.deleteBrowserRecording(id), "录制已移入回收站"),
    openDirectory: (id: string) => run(() => window.codexh.openBrowserRecordingDirectory(id)),
    copyScript: async (recordingId?: string) => {
      const value = recordingId ? await window.codexh.readBrowserRecordingScript(recordingId) : script;
      await navigator.clipboard.writeText(value);
      showNotice("脚本已复制", { tone: "success" });
    },
    copyDocument: async (recordingId?: string) => {
      const value = recordingId ? await window.codexh.readBrowserRecordingDocument(recordingId) : document;
      await navigator.clipboard.writeText(value);
      showNotice("操作文档已复制", { tone: "success" });
    }
  };
}

export type BrowserRecordingsController = ReturnType<typeof useBrowserRecordings>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
