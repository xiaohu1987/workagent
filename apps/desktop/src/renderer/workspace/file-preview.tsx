import { useMotionPresence } from "../core/motion-presence";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconCompose, IconCheck, IconFile, IconSpinner, IconClose } from "../icons";
import { hljs, escapeHtml } from "../markdown";
import { ComposerAttachmentInput } from "../lib/conversation-utils";
import { WorkspaceContextMenu, WorkspaceEmptyState } from "./panels";

export type FilePreviewLanguage = {
  id: string | null;
  label: string;
};

export const FILE_PREVIEW_LANGUAGES: Record<string, FilePreviewLanguage> = {
  bash: { id: "bash", label: "Shell" },
  c: { id: "c", label: "C" },
  cc: { id: "cpp", label: "C++" },
  cjs: { id: "javascript", label: "JavaScript" },
  cpp: { id: "cpp", label: "C++" },
  css: { id: "css", label: "CSS" },
  cs: { id: "csharp", label: "C#" },
  csv: { id: null, label: "CSV" },
  diff: { id: "diff", label: "Diff" },
  go: { id: "go", label: "Go" },
  h: { id: "c", label: "C" },
  hpp: { id: "cpp", label: "C++" },
  htm: { id: "xml", label: "HTML" },
  html: { id: "xml", label: "HTML" },
  java: { id: "java", label: "Java" },
  js: { id: "javascript", label: "JavaScript" },
  json: { id: "json", label: "JSON" },
  jsonc: { id: "json", label: "JSON" },
  json5: { id: "json", label: "JSON" },
  jsx: { id: "javascript", label: "JavaScript" },
  mjs: { id: "javascript", label: "JavaScript" },
  md: { id: "markdown", label: "Markdown" },
  mts: { id: "typescript", label: "TypeScript" },
  php: { id: "php", label: "PHP" },
  py: { id: "python", label: "Python" },
  rb: { id: "ruby", label: "Ruby" },
  rs: { id: "rust", label: "Rust" },
  scss: { id: "css", label: "SCSS" },
  sh: { id: "bash", label: "Shell" },
  sql: { id: "sql", label: "SQL" },
  svg: { id: "xml", label: "SVG" },
  toml: { id: null, label: "TOML" },
  ts: { id: "typescript", label: "TypeScript" },
  tsx: { id: "typescript", label: "TypeScript" },
  txt: { id: null, label: "Text" },
  xml: { id: "xml", label: "XML" },
  yaml: { id: "yaml", label: "YAML" },
  yml: { id: "yaml", label: "YAML" },
  zsh: { id: "bash", label: "Shell" }
};

export type PreviewCacheEntry = {
  content: string;
  truncated: boolean;
  binary: boolean;
};

export function FilePreviewDialog({
  path,
  preview,
  motionPhase,
  onClose,
  onAddAttachment,
  onSave
}: {
  path: string;
  preview: PreviewCacheEntry | null;
  motionPhase: string | undefined;
  onClose: () => void;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
  onSave: (content: string) => Promise<void>;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const editorHighlightRef = useRef<HTMLOListElement | null>(null);
  const contextMenuPresence = useMotionPresence(contextMenu, 140);
  const visibleContextMenu = contextMenu ?? contextMenuPresence.value;
  const fileName = path.split(/[\\/]/).pop() || path;
  const language = useMemo(() => getFilePreviewLanguage(path), [path]);
  const canEdit = Boolean(preview && !preview.truncated && !preview.binary);
  const isDirty = preview ? draft !== preview.content : false;
  const highlightedLines = useMemo(
    () => highlightFilePreview(canEdit ? draft : preview?.content ?? "", language.id),
    [canEdit, draft, language.id, preview?.content]
  );

  useEffect(() => {
    setDraft(preview?.content ?? "");
    setSaveError(null);
    setContextMenu(null);
  }, [path, preview?.content]);

  async function saveFile() {
    if (!canEdit || !isDirty || isSaving) {
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }

  function openSelectionContextMenu(event: React.MouseEvent, selection: string) {
    const trimmed = selection.trim();
    if (!trimmed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      selection: trimmed
    });
  }

  return (
    <div
      className="file-preview-lightbox motion-overlay"
      data-motion={motionPhase}
      role="dialog"
      aria-modal="true"
      aria-label={path}
    >
      <div className="file-preview-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <header className="file-preview-lightbox-head" title={path}>
          <IconFile />
          <div className="file-preview-lightbox-title">
            <strong>{fileName}</strong>
            <span>{path}</span>
          </div>
          <span className="file-preview-language" title={language.label}>{language.label}</span>
          <div className="file-preview-lightbox-actions">
            {canEdit ? (
              <button
                type="button"
                className="file-preview-save-button"
                onClick={() => void saveFile()}
                disabled={!isDirty || isSaving}
                title="保存文件"
              >
                <IconCheck />
                <span>{isSaving ? "保存中..." : "保存"}</span>
              </button>
            ) : null}
            <button className="file-preview-close-button" type="button" onClick={onClose} title="关闭" aria-label="关闭">
              <IconClose />
            </button>
          </div>
        </header>
        {preview ? (
          <>
            {canEdit ? (
              <div className="file-preview-editor-shell">
                <ol ref={editorHighlightRef} className="project-preview-code file-preview-lightbox-code file-preview-editor-highlight" aria-hidden="true">
                  {highlightedLines.map((line, index) => (
                    <li key={`${path}-editor-line-${index}`}>
                      <code dangerouslySetInnerHTML={{ __html: line || " " }} />
                    </li>
                  ))}
                </ol>
                <textarea
                  className="file-preview-editor"
                  value={draft}
                  wrap="off"
                  onChange={(event) => setDraft(event.target.value)}
                  onScroll={(event) => {
                    if (!editorHighlightRef.current) return;
                    editorHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                    editorHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Tab") return;
                    event.preventDefault();
                    const target = event.currentTarget;
                    const start = target.selectionStart;
                    const end = target.selectionEnd;
                    const nextDraft = `${draft.slice(0, start)}  ${draft.slice(end)}`;
                    setDraft(nextDraft);
                    requestAnimationFrame(() => {
                      target.selectionStart = start + 2;
                      target.selectionEnd = start + 2;
                    });
                  }}
                  onContextMenu={(event) => {
                    const target = event.currentTarget;
                    openSelectionContextMenu(event, draft.slice(target.selectionStart, target.selectionEnd));
                  }}
                  aria-label={`${path} 内容`}
                  spellCheck={false}
                />
              </div>
            ) : (
              <ol
                className="project-preview-code file-preview-lightbox-code"
                aria-label={`${path} 代码内容`}
                onContextMenu={(event) => {
                  openSelectionContextMenu(event, window.getSelection()?.toString() ?? "");
                }}
              >
                {preview.content.split(/\r?\n/).map((line, index) => (
                  <li key={`${path}-line-${index}`}>
                    <code dangerouslySetInnerHTML={{ __html: highlightedLines[index] || " " }} />
                  </li>
                ))}
              </ol>
            )}
            {preview.truncated ? <div className="project-preview-note">文件内容过长，仅显示前 512 KB。</div> : null}
            {preview.binary ? <div className="project-preview-note">二进制文件无法直接编辑。</div> : null}
            {saveError ? <div className="project-preview-note project-preview-note-error">保存失败：{saveError}</div> : null}
            {visibleContextMenu ? (
              <WorkspaceContextMenu
                x={visibleContextMenu.x}
                y={visibleContextMenu.y}
                motionPhase={contextMenuPresence.phase}
                onClose={() => setContextMenu(null)}
                actions={[
                  {
                    id: "add-selection-to-chat",
                    label: "添加到聊天",
                    icon: <IconCompose />,
                    onSelect: () => onAddAttachment({
                      kind: "code",
                      path,
                      content: visibleContextMenu.selection,
                      label: "已选代码段",
                      intent: "reference"
                    })
                  }
                ]}
              />
            ) : null}
          </>
        ) : (
          <div className="file-preview-lightbox-loading">
            <WorkspaceEmptyState icon={<IconSpinner />} title="读取中" message="正在读取文件..." />
          </div>
        )}
      </div>
    </div>
  );
}

export function renderCodePreviewLine(line: string, keyPrefix: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const tokenPattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(\/\/.*$|#.*$)|\b(true|false|null|undefined|const|let|var|function|return|import|from|export|type|interface|async|await|if|else)\b|\b(-?\d+(?:\.\d+)?)\b/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(line)) !== null) {
    if (match.index > cursor) {
      tokens.push(<span key={`${keyPrefix}-text-${index}`}>{line.slice(cursor, match.index)}</span>);
      index += 1;
    }
    const className = match[1]
      ? "code-preview-key"
      : match[2]
        ? "code-preview-string"
        : match[3]
          ? "code-preview-comment"
          : match[4]
            ? "code-preview-keyword"
            : "code-preview-number";
    tokens.push(<span key={`${keyPrefix}-token-${index}`} className={className}>{match[0]}</span>);
    cursor = tokenPattern.lastIndex;
    index += 1;
  }

  if (cursor < line.length) {
    tokens.push(<span key={`${keyPrefix}-tail-${index}`}>{line.slice(cursor)}</span>);
  }

  return tokens;
}

export function getFilePreviewLanguage(path: string): FilePreviewLanguage {
  const fileName = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (fileName === "dockerfile") return { id: "bash", label: "Dockerfile" };
  if (fileName === "makefile") return { id: "bash", label: "Makefile" };
  if (fileName.startsWith(".env")) return { id: "bash", label: "Env" };
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return FILE_PREVIEW_LANGUAGES[extension] ?? { id: null, label: "Text" };
}

export function highlightFilePreview(content: string, language: string | null): string[] {
  const source = content.replace(/\r\n?/g, "\n");
  if (!language || !hljs.getLanguage(language)) {
    return source.split("\n").map(escapeHtml);
  }
  return hljs.highlight(source, { language, ignoreIllegals: true }).value.split("\n");
}
