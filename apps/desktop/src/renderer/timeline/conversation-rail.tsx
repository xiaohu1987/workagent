import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { MessageRecord, ToolCallRecord } from "@shared-types";
import { collectFileChangesByTurn, getGeneratedFileDescription } from "../lib/conversation-utils";
import type { ConversationTurnItem, FileChangeSummaryItem } from "../lib/conversation-utils";
import { buildFileSnapshotDiff, buildFileSnapshotDiffPreview, getFileSnapshotDiffMarker } from "../lib/project-files";
import { IconChevronDown, IconFileChanges } from "../icons";
import { getFileLeafName } from "../markdown";
import { useMotionPresence } from "../core/motion-presence";
import { renderCodePreviewLine } from "../workspace/file-preview";

export function ComposerTaskChanges({ files }: { files: FileChangeSummaryItem[] }) {
  const [open, setOpen] = useState(false);
  const [diffPreview, setDiffPreview] = useState<{ file: FileChangeSummaryItem; anchor: DOMRect } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const diffPreviewPresence = useMotionPresence(diffPreview, 140);
  const visibleDiffPreview = diffPreview ?? diffPreviewPresence.value;
  const fileChanges = useMemo(
    () => files.map((file) => ({ file, ...getFileChangeLineCounts(file) })),
    [files]
  );
  const additions = fileChanges.reduce((total, file) => total + file.additions, 0);
  const deletions = fileChanges.reduce((total, file) => total + file.deletions, 0);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setDiffPreview(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setDiffPreview(null);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  if (files.length === 0) return null;

  const clearPreviewCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const startDiffPreviewTimer = (file: FileChangeSummaryItem, anchor: DOMRect) => {
    if (!file.snapshot) return;
    clearPreviewCloseTimer();
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setDiffPreview({ file, anchor });
      hoverTimerRef.current = null;
    }, 3_000);
  };
  const scheduleDiffPreviewClose = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    clearPreviewCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setDiffPreview(null);
      closeTimerRef.current = null;
    }, 140);
  };

  return (
    <div ref={rootRef} className="composer-task-changes">
      <button
        type="button"
        className="composer-task-changes-trigger"
        aria-expanded={open}
        title={`本次任务修改 ${files.length} 个文件，新增 ${additions} 行，删除 ${deletions} 行`}
        onClick={() => {
          setOpen((current) => !current);
          setDiffPreview(null);
        }}
      >
        <span className="composer-task-changes-icon" aria-hidden><IconFileChanges /></span>
        <span className="composer-task-changes-label">{files.length} 个文件已更改</span>
        <span className="is-added">+{additions}</span>
        <span className="is-removed">-{deletions}</span>
      </button>
      {open ? (
        <section className="composer-task-changes-popover" aria-label="本次任务修改的文件">
          <div className="composer-task-changes-list">
            {fileChanges.map(({ file, additions: fileAdditions, deletions: fileDeletions }) => (
              <div
                key={file.path}
                className={`composer-task-change-file ${file.snapshot ? "has-diff-preview" : ""}`}
                title={file.snapshot ? `${file.path}；停留 3 秒查看 Diff 快照` : file.path}
                onMouseEnter={(event) => startDiffPreviewTimer(file, event.currentTarget.getBoundingClientRect())}
                onMouseLeave={scheduleDiffPreviewClose}
              >
                <span>{getFileLeafName(file.path)}</span>
                <div>
                  <b>+{fileAdditions}</b>
                  <i>-{fileDeletions}</i>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {visibleDiffPreview?.file.snapshot ? (
        <FileSnapshotDiffPopover
          file={visibleDiffPreview.file}
          anchor={visibleDiffPreview.anchor}
          motionPhase={diffPreviewPresence.phase}
          onMouseEnter={clearPreviewCloseTimer}
          onMouseLeave={scheduleDiffPreviewClose}
        />
      ) : null}
    </div>
  );
}

export function getFileChangeLineCounts(file: FileChangeSummaryItem): { additions: number; deletions: number } {
  if (!file.snapshot || file.snapshot.beforeTruncated || file.snapshot.afterTruncated) {
    return { additions: file.additions, deletions: file.deletions };
  }
  const lines = buildFileSnapshotDiff(file.snapshot.before, file.snapshot.after);
  return {
    additions: lines.filter((line) => line.kind === "added").length,
    deletions: lines.filter((line) => line.kind === "removed").length
  };
}

export function FileChangeSummary({
  files,
  onOpenFolder
}: {
  files: FileChangeSummaryItem[];
  onOpenFolder: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diffPreview, setDiffPreview] = useState<{ file: FileChangeSummaryItem; anchor: DOMRect } | null>(null);
  const diffPreviewPresence = useMotionPresence(diffPreview, 140);
  const visibleDiffPreview = diffPreview ?? diffPreviewPresence.value;
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);
  if (files.length === 0) {
    return null;
  }

  const visibleFiles = expanded ? files : [];

  const clearPreviewCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const startDiffPreviewTimer = (file: FileChangeSummaryItem, anchor: DOMRect) => {
    if (!file.snapshot) return;
    clearPreviewCloseTimer();
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setDiffPreview({ file, anchor });
      hoverTimerRef.current = null;
    }, 3_000);
  };
  const scheduleDiffPreviewClose = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    clearPreviewCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setDiffPreview(null);
      closeTimerRef.current = null;
    }, 140);
  };

  return (
    <>
      <section className="generated-file-list" aria-label="主要改动文件">
        <header
          className="generated-file-list-head"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current);
            setDiffPreview(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setExpanded((current) => !current);
            setDiffPreview(null);
          }}
        >
          <div className="generated-file-list-heading">
            <span className="generated-file-list-icon" aria-hidden="true"><IconFileChanges /></span>
            <h3 className="generated-file-list-title">主要改动文件</h3>
            <span className="generated-file-list-count">{files.length}</span>
          </div>
          <button
            type="button"
            className={`generated-file-list-toggle ${expanded ? "is-expanded" : ""}`}
            aria-expanded={expanded}
            title={expanded ? "收起文件列表" : `展开全部 ${files.length} 个文件`}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((current) => !current);
              setDiffPreview(null);
            }}
          >
            <IconChevronDown />
          </button>
        </header>
        <ul className="generated-file-list-items">
          {visibleFiles.map((file) => (
            <li
              key={file.path}
              className={`generated-file-list-item ${file.snapshot ? "has-diff-preview" : ""}`}
              onMouseEnter={(event) => startDiffPreviewTimer(file, event.currentTarget.getBoundingClientRect())}
              onMouseLeave={scheduleDiffPreviewClose}
            >
              <button
                type="button"
                className="generated-file-path"
                onClick={() => onOpenFolder(file.absolutePath ?? file.path)}
                title={file.snapshot ? "停留 3 秒查看快照 Diff；点击打开所在文件夹" : "打开所在文件夹"}
              >
                {getFileLeafName(file.path)}
              </button>
              <span className="generated-file-sep" aria-hidden="true">—</span>
              <span className="generated-file-desc">{getMainChangedFileDescription(file)}</span>
            </li>
          ))}
        </ul>
      </section>
      {visibleDiffPreview?.file.snapshot ? (
        <FileSnapshotDiffPopover
          file={visibleDiffPreview.file}
          anchor={visibleDiffPreview.anchor}
          motionPhase={diffPreviewPresence.phase}
          onMouseEnter={clearPreviewCloseTimer}
          onMouseLeave={scheduleDiffPreviewClose}
        />
      ) : null}
    </>
  );
}

function FileSnapshotDiffPopover({
  file,
  anchor,
  motionPhase,
  onMouseEnter,
  onMouseLeave
}: {
  file: FileChangeSummaryItem;
  anchor: DOMRect;
  motionPhase?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const snapshot = file.snapshot;
  if (!snapshot) return null;
  const lines = buildFileSnapshotDiffPreview(snapshot.before, snapshot.after);
  const width = Math.min(720, window.innerWidth - 32);
  const left = Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16));
  const placeAbove = anchor.top > Math.min(440, window.innerHeight * 0.56);
  const style: CSSProperties = placeAbove
    ? { left, width, bottom: Math.max(16, window.innerHeight - anchor.top + 8) }
    : { left, width, top: Math.min(window.innerHeight - 180, anchor.bottom + 8) };

  return createPortal(
    <aside
      className="generated-file-diff-popover"
      data-motion={motionPhase}
      aria-label={`${file.path} 快照 Diff`}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <header className="generated-file-diff-head">
        <span title={file.path}>{file.path}</span>
        <div>
          <b>+{file.additions}</b>
          <i>-{file.deletions}</i>
        </div>
      </header>
      <div className="generated-file-diff-code">
        {lines.map((line, index) => (
          <div key={`${file.path}-hover-diff-${index}`} className={`is-${line.kind} ${line.omitted ? "is-omitted" : ""}`}>
            <span className="generated-file-diff-line-number" aria-hidden="true">{line.lineNumber ?? ""}</span>
            <span className="generated-file-diff-marker" aria-hidden="true">{line.omitted ? "" : getFileSnapshotDiffMarker(line.kind)}</span>
            <code>{line.omitted ? line.content : renderCodePreviewLine(line.content, `${file.path}-hover-${index}`)}</code>
          </div>
        ))}
      </div>
      {snapshot.beforeTruncated || snapshot.afterTruncated ? (
        <footer className="generated-file-diff-note">快照内容过长，仅显示已保存的部分。</footer>
      ) : null}
    </aside>,
    document.body
  );
}

function getMainChangedFileDescription(file: FileChangeSummaryItem): string {
  if (file.description) {
    return file.description;
  }
  if (file.action === "created" || file.kind) {
    return getGeneratedFileDescription(file.path, file.kind, undefined, file.action);
  }

  const symbols = file.symbols?.slice(0, 3).map((symbol) => symbol.name).filter(Boolean) ?? [];
  const changeLabel = file.action === "deleted"
    ? "已删除"
    : symbols.length > 0
      ? `修改 ${symbols.join("、")}`
      : "已修改";
  const lineCounts = [
    file.additions > 0 ? `+${file.additions}` : "",
    file.deletions > 0 ? `-${file.deletions}` : ""
  ].filter(Boolean).join(" ");
  return lineCounts ? `${changeLabel}（${lineCounts}）` : changeLabel;
}

export function buildConversationTurnItems(
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[],
  workspaceRoot?: string | null
): ConversationTurnItem[] {
  const filesByTurn = collectFileChangesByTurn(toolCalls, workspaceRoot);

  return messages
    .filter((message) => message.role === "user" && !message.content.startsWith("[internal:"))
    .map((message) => ({
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      files: message.turnRunId ? filesByTurn.get(message.turnRunId) ?? [] : []
    }));
}

export function ConversationTurnRail({ turns }: { turns: ConversationTurnItem[] }) {
  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null);

  if (turns.length === 0) {
    return null;
  }

  const latestTurnId = turns.at(-1)?.id;

  return (
    <nav className="conversation-turn-rail" aria-label="问话轨迹">
      {turns.map((turn) => {
        const preview = getConversationTurnPreview(turn.content);
        const isHovered = hoveredTurnId === turn.id;
        const isLatest = latestTurnId === turn.id;

        return (
          <button
            key={turn.id}
            type="button"
            className={`conversation-turn-marker ${isHovered ? "is-hovered" : ""} ${isLatest ? "is-latest" : ""}`}
            aria-label={`问话：${preview}`}
            onClick={() => document.getElementById(`transcript-message-${turn.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
            onMouseEnter={() => setHoveredTurnId(turn.id)}
            onMouseLeave={() => setHoveredTurnId(null)}
            onFocus={() => setHoveredTurnId(turn.id)}
            onBlur={() => setHoveredTurnId(null)}
          >
            <span className="conversation-turn-marker-line" style={{ width: getConversationTurnMarkerWidth(turn.content) }} />
            <span className="conversation-turn-preview" role="tooltip">
              <span className="conversation-turn-preview-copy">{preview}</span>
              {turn.files.length > 0 ? (
                <span className="conversation-turn-preview-files">
                  {turn.files.slice(0, 3).map((file) => (
                    <span key={file.path} className="conversation-turn-preview-file">
                      {getFileLeafName(file.path)}
                    </span>
                  ))}
                  {turn.files.length > 3 ? <em>+{turn.files.length - 3}</em> : null}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function getConversationTurnPreview(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 119)}...` : normalized || "空白问话";
}

function getConversationTurnMarkerWidth(content: string) {
  const length = content.trim().length;
  return Math.min(28, Math.max(7, 6 + Math.round(Math.sqrt(length) * 2.1)));
}
