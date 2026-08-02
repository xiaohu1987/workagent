import { useEffect, useMemo, useRef, useState } from "react";
import { getFilePreviewLanguage, highlightFilePreview, type PreviewCacheEntry } from "../workspace/file-preview-utils";
import "./live-edit-preview.css";

type PreviewEvent =
  | { kind: "show"; toolCallId: string; threadId: string; path: string; completed: boolean }
  | { kind: "complete"; toolCallId: string };

type ActivePreview = {
  toolCallId: string;
  threadId: string;
  path: string;
  completed: boolean;
};

const POLL_INTERVAL_MS = 320;
const COMPLETION_HOLD_MS = 600;

export function LiveEditPreviewApp() {
  const [active, setActive] = useState<ActivePreview | null>(null);
  const [preview, setPreview] = useState<PreviewCacheEntry | null>(null);
  const activeRef = useRef<ActivePreview | null>(null);

  useEffect(() => {
    const dispose = window.codexh.onLiveEditPreviewEvent((event) => {
      if (event.kind === "show") {
        const next = { toolCallId: event.toolCallId, threadId: event.threadId, path: event.path, completed: event.completed };
        activeRef.current = next;
        setActive(next);
        setPreview(null);
        return;
      }
      if (event.kind === "complete" && activeRef.current?.toolCallId === event.toolCallId) {
        const next = { ...activeRef.current, completed: true };
        activeRef.current = next;
        setActive(next);
      }
    });
    void window.codexh.markLiveEditPreviewReady();
    return dispose;
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let completionTimer: number | null = null;

    const load = async () => {
      try {
        const file = await window.codexh.readProjectFile({ threadId: active.threadId, path: active.path });
        if (!cancelled) setPreview({ content: file.content, truncated: file.truncated, binary: file.binary });
      } catch (error) {
        if (!cancelled) setPreview({ content: error instanceof Error ? error.message : String(error), truncated: false, binary: false });
      }
    };

    void load();
    const pollTimer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    if (active.completed) {
      window.clearInterval(pollTimer);
      void load().finally(() => {
        if (!cancelled) {
          completionTimer = window.setTimeout(() => {
            if (!cancelled) void window.codexh.acknowledgeLiveEditPreviewPath({ toolCallId: active.toolCallId, path: active.path });
          }, COMPLETION_HOLD_MS);
        }
      });
    }

    return () => {
      cancelled = true;
      window.clearInterval(pollTimer);
      if (completionTimer !== null) window.clearTimeout(completionTimer);
    };
  }, [active]);

  const language = useMemo(() => active ? getFilePreviewLanguage(active.path) : null, [active]);
  const lines = useMemo(
    () => highlightFilePreview(preview?.content ?? "", language?.id ?? null),
    [language?.id, preview?.content]
  );
  const fileName = active?.path.split(/[\\/]/).pop() ?? "";

  return (
    <main className="live-edit-preview" aria-label="代码编辑预览">
      <header className="live-edit-preview-header" title={active?.path ?? ""}>
        <div className="live-edit-preview-title">
          <span className="live-edit-preview-status" aria-hidden="true" />
          <strong>{fileName || "等待代码编辑"}</strong>
        </div>
        {language ? <span className="live-edit-preview-language">{language.label}</span> : null}
        {active ? <span className="live-edit-preview-state">{active.completed ? "已写入" : "正在编辑"}</span> : null}
        {active ? <p>{active.path}</p> : null}
      </header>
      <section className="live-edit-preview-code-wrap" aria-live="polite">
        {!active || !preview ? <div className="live-edit-preview-loading">正在读取文件...</div> : (
          <>
            <ol className="live-edit-preview-code">
              {preview.content.split(/\r?\n/).map((line, index) => (
                <li key={`${active.toolCallId}-${active.path}-${index}`}><code dangerouslySetInnerHTML={{ __html: lines[index] || " " }} /></li>
              ))}
            </ol>
            {preview.truncated ? <div className="live-edit-preview-note">文件过长，仅显示前 512 KB。</div> : null}
            {preview.binary ? <div className="live-edit-preview-note">二进制文件无法直接预览。</div> : null}
          </>
        )}
      </section>
    </main>
  );
}
