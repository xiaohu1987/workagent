import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useMotionPresence } from "./core/motion-presence";
import { EChartsMessageChart } from "./charts/echarts-message-chart";
import { ApiCardMessage } from "./cards/api-card-message";
import { IconClose, IconCopy, IconEye, IconFolder, IconGlobe } from "./icons";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

export { hljs };

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  "c#": "csharp",
  cs: "csharp",
  csharp: "csharp",
  sh: "bash",
  shell: "bash",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  svg: "xml",
  yml: "yaml",
  md: "markdown"
};

const MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH = 16_000;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

export function getFileLeafName(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function isSafeMarkdownImageSource(source: string): boolean {
  return /^https:\/\//i.test(source) || /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(source);
}

export function normalizeMarkdownImageSource(source: string): string {
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "commons.wikimedia.org") {
      return source;
    }
    const pathname = decodeURIComponent(url.pathname);
    const filePrefix = "/wiki/file:";
    if (!pathname.toLowerCase().startsWith(filePrefix)) {
      return source;
    }
    const fileName = pathname.slice(filePrefix.length);
    if (!fileName) {
      return source;
    }
    return `${url.origin}/wiki/Special:FilePath/${encodeURIComponent(fileName)}`;
  } catch {
    return source;
  }
}

function isAbsoluteLocalPath(source: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(source) || /^\\\\/.test(source);
}

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "structured-ordered-list"; items: Array<{ title: string; paragraphs: string[] }> }
  | { kind: "horizontal-rule" }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "code"; language?: string; content: string }
  | { kind: "echarts"; content: string }
  | { kind: "api-card"; content: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export type MessageMediaPreview = {
  source: string;
  name: string;
  kind: "image" | "video";
  localPath?: string;
  url?: string;
};

export function MessageMediaLightbox({ preview, motionPhase, onClose }: { preview: MessageMediaPreview; motionPhase?: string; onClose: () => void }) {
  return createPortal(
    <div className="message-image-lightbox motion-overlay" data-motion={motionPhase} role="dialog" aria-modal="true" aria-label={preview.name}>
      <div className="message-image-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <div className="message-image-lightbox-head">
          <span title={preview.name}>{preview.name}</span>
          <div>
            {preview.localPath ? (
              <>
                <button type="button" title="打开原图" aria-label="打开原图" onClick={() => void window.codexh.openPath(preview.localPath!)}><IconEye /></button>
                <button type="button" title="打开所在文件夹" aria-label="打开所在文件夹" onClick={() => void window.codexh.openFolder(preview.localPath!)}><IconFolder /></button>
              </>
            ) : null}
            {preview.url ? (
              <button type="button" title="打开网页" aria-label="打开网页" onClick={() => void window.codexh.openExternal(preview.url!)}><IconGlobe /></button>
            ) : null}
            <button type="button" title="关闭" aria-label="关闭" onClick={onClose}><IconClose /></button>
          </div>
        </div>
        {preview.kind === "video" ? (
          <video className="message-video-lightbox-player" src={preview.source} controls autoPlay playsInline />
        ) : (
          <img src={preview.source} alt={preview.name} />
        )}
      </div>
    </div>,
    document.body
  );
}

export async function copyTextToClipboard(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function renderMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /!\[([^\]]*)\]\(([^)]+)\)|`([^`\n]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^*]+)\*/g;
  let cursor = 0;
  let tokenIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(...renderPlainTextReferences(text.slice(cursor, match.index), `${keyPrefix}-text-${tokenIndex}`));
      tokenIndex += 1;
    }

    if (match[1] && match[2]) {
      const source = match[2];
      nodes.push((isSafeMarkdownImageSource(source) || isAbsoluteLocalPath(source))
        ? <MarkdownMessageImage key={`${keyPrefix}-image-${tokenIndex}`} source={normalizeMarkdownImageSource(source)} alt={match[1]} />
        : <span key={`${keyPrefix}-image-${tokenIndex}`}>{match[1] || source}</span>);
    } else if (match[3]) {
      nodes.push(<code key={`${keyPrefix}-code-${tokenIndex}`}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      const linkLabel = match[4];
      const linkTarget = match[5];
      nodes.push(<OpenableMessageReference key={`${keyPrefix}-link-${tokenIndex}`} target={linkTarget} label={linkLabel} />);
    } else if (match[6]) {
      nodes.push(<strong key={`${keyPrefix}-strong-${tokenIndex}`}>{match[6]}</strong>);
    } else if (match[7]) {
      nodes.push(<del key={`${keyPrefix}-delete-${tokenIndex}`}>{match[7]}</del>);
    } else if (match[8]) {
      nodes.push(<em key={`${keyPrefix}-em-${tokenIndex}`}>{match[8]}</em>);
    }

    cursor = tokenPattern.lastIndex;
    tokenIndex += 1;
  }

  if (cursor < text.length) {
    nodes.push(...renderPlainTextReferences(text.slice(cursor), `${keyPrefix}-tail-${tokenIndex}`));
  }

  return nodes;
}

function renderPlainTextReferences(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const referencePattern = /https?:\/\/[^\s<>()]+|[a-zA-Z]:[\\/][^\s<>"|?*]+/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = referencePattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(<span key={`${keyPrefix}-text-${index}`}>{text.slice(cursor, match.index)}</span>);
    const reference = match[0].replace(/[),.;，。；]+$/, "");
    const trailing = match[0].slice(reference.length);
    nodes.push(<OpenableMessageReference key={`${keyPrefix}-reference-${index}`} target={reference} label={reference} />);
    if (trailing) nodes.push(<span key={`${keyPrefix}-trailing-${index}`}>{trailing}</span>);
    cursor = match.index + match[0].length;
    index += 1;
  }
  if (cursor < text.length || nodes.length === 0) nodes.push(<span key={`${keyPrefix}-tail`}>{text.slice(cursor)}</span>);
  return nodes;
}

function OpenableMessageReference({ target, label }: { target: string; label: string }) {
  const localPath = isAbsoluteLocalPath(target);
  return (
    <span className={`message-reference ${localPath ? "local" : ""}`}>
      <a
        href={target}
        className={`markdown-link ${localPath || isFileReferenceLink(target) ? "file" : ""}`}
        title={target}
        onClick={(event) => {
          event.preventDefault();
          if (/^https?:\/\//i.test(target)) void window.codexh.openExternal(target);
          else if (localPath) void window.codexh.openPath(target);
        }}
      >
        {label}
      </a>
      {localPath ? (
        <button type="button" title="打开所在文件夹" aria-label="打开所在文件夹" onClick={() => void window.codexh.openFolder(target)}>
          <IconFolder />
        </button>
      ) : null}
    </span>
  );
}

function MarkdownMessageImage({ source, alt }: { source: string; alt: string }) {
  const isLocal = isAbsoluteLocalPath(source);
  const [previewSource, setPreviewSource] = useState<string | null>(isLocal ? null : source);
  const [previewOpen, setPreviewOpen] = useState(false);
  const lightboxPreview = useMemo<MessageMediaPreview | null>(() => previewSource ? {
    source: previewSource,
    name: alt || getFileLeafName(source),
    kind: "image",
    ...(isLocal ? { localPath: source } : { url: source })
  } : null, [alt, isLocal, previewSource, source]);
  const lightboxPresence = useMotionPresence(previewOpen ? lightboxPreview : null);
  useEffect(() => {
    if (!isLocal) return;
    let cancelled = false;
    void window.codexh.previewLocalImage({ absolutePath: source })
      .then((value) => { if (!cancelled) setPreviewSource(value); })
      .catch(() => { if (!cancelled) setPreviewSource(null); });
    return () => { cancelled = true; };
  }, [isLocal, source]);
  if (!previewSource) return <span>{alt || source}</span>;
  return <>
    <button className="markdown-image-button" type="button" onClick={() => setPreviewOpen(true)} title={`查看原图：${alt || getFileLeafName(source)}`}>
      <img className="markdown-image" src={previewSource} alt={alt} />
    </button>
    {lightboxPresence.value ? (
      <MessageMediaLightbox
        preview={lightboxPresence.value}
        motionPhase={lightboxPresence.phase}
        onClose={() => setPreviewOpen(false)}
      />
    ) : null}
  </>;
}

export function highlightMarkdownCode(content: string, language?: string): string {
  const normalizedLanguage = language?.trim().toLowerCase();
  const resolvedLanguage = normalizedLanguage ? CODE_LANGUAGE_ALIASES[normalizedLanguage] ?? normalizedLanguage : undefined;
  if (resolvedLanguage && hljs.getLanguage(resolvedLanguage)) {
    return hljs.highlight(content, { language: resolvedLanguage, ignoreIllegals: true }).value;
  }
  return escapeHtml(content);
}

export function CopyTextButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function copy() {
    if (await copyTextToClipboard(content)) {
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      return;
    }
    setCopied(false);
  }

  return (
    <button
      type="button"
      className={`copy-text-button ${copied ? "is-copied" : ""}`}
      title={copied ? "已复制" : "复制内容"}
      aria-label={copied ? "已复制" : "复制内容"}
      onClick={() => void copy()}
    >
      <IconCopy />
    </button>
  );
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const blocks: MarkdownBlock[] = [];
  const lines = normalized.split("\n");
  let paragraphLines: string[] = [];
  let listState: { ordered: boolean; items: string[] } | null = null;
  let quoteLines: string[] = [];
  let codeFence: { language?: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ").trim() });
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listState || listState.items.length === 0) {
      listState = null;
      return;
    }
    blocks.push({
      kind: listState.ordered ? "ordered-list" : "unordered-list",
      items: [...listState.items]
    });
    listState = null;
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) {
      return;
    }
    blocks.push({ kind: "blockquote", lines: [...quoteLines] });
    quoteLines = [];
  };

  const flushTextualState = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();

    if (codeFence) {
      if (trimmed.startsWith("```")) {
        const content = codeFence.lines.join("\n");
        const fenceLanguage = codeFence.language?.trim().toLowerCase();
        blocks.push(
          fenceLanguage === "echarts"
            ? { kind: "echarts", content }
            : fenceLanguage === "api-card"
              ? { kind: "api-card", content }
              : { kind: "code", language: codeFence.language, content }
        );
        codeFence = null;
      } else {
        codeFence.lines.push(rawLine);
      }
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushTextualState();
      codeFence = {
        language: trimmed.slice(3).trim() || undefined,
        lines: []
      };
      continue;
    }

    if (!trimmed) {
      flushTextualState();
      continue;
    }

    const nextLine = lines[lineIndex + 1]?.trim();
    if (isMarkdownTableRow(trimmed) && nextLine && isMarkdownTableDivider(nextLine)) {
      flushTextualState();
      const headers = splitMarkdownTableRow(trimmed);
      const rows: string[][] = [];
      lineIndex += 2;
      while (lineIndex < lines.length && isMarkdownTableRow(lines[lineIndex].trim())) {
        rows.push(normalizeMarkdownTableRow(splitMarkdownTableRow(lines[lineIndex].trim()), headers.length));
        lineIndex += 1;
      }
      lineIndex -= 1;
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushTextualState();
      blocks.push({
        kind: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2]
      });
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
      flushTextualState();
      blocks.push({ kind: "horizontal-rule" });
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushQuote();
      if (!listState || listState.ordered) {
        flushList();
        listState = { ordered: false, items: [] };
      }
      listState.items.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      if (!listState || !listState.ordered) {
        flushList();
        listState = { ordered: true, items: [] };
      }
      listState.items.push(orderedMatch[1]);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraphLines.push(trimmed);
  }

  flushTextualState();

  if (codeFence) {
    blocks.push({
      kind: "code",
      language: codeFence.language,
      content: codeFence.lines.join("\n")
    });
  }

  return consolidateLooseOrderedLists(blocks);
}

function consolidateLooseOrderedLists(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const normalized: MarkdownBlock[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const firstBlock = blocks[blockIndex];
    if (firstBlock.kind !== "ordered-list" || firstBlock.items.length !== 1) {
      normalized.push(firstBlock);
      continue;
    }

    const items = [{ title: firstBlock.items[0], paragraphs: [] as string[] }];
    let nextIndex = blockIndex + 1;
    while (nextIndex < blocks.length) {
      const paragraphs: string[] = [];
      while (blocks[nextIndex]?.kind === "paragraph") {
        paragraphs.push((blocks[nextIndex] as Extract<MarkdownBlock, { kind: "paragraph" }>).text);
        nextIndex += 1;
      }

      const nextBlock = blocks[nextIndex];
      if (nextBlock?.kind !== "ordered-list" || nextBlock.items.length !== 1) {
        items[items.length - 1].paragraphs = paragraphs;
        break;
      }

      items[items.length - 1].paragraphs = paragraphs;
      items.push({ title: nextBlock.items[0], paragraphs: [] });
      nextIndex += 1;
    }

    if (items.length === 1) {
      normalized.push(firstBlock);
      continue;
    }

    normalized.push({ kind: "structured-ordered-list", items });
    blockIndex = nextIndex - 1;
  }

  return normalized;
}

function isMarkdownTableRow(line: string): boolean {
  return /^\|?.+\|.+\|?$/.test(line);
}

function isMarkdownTableDivider(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function normalizeMarkdownTableRow(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function isFileReferenceLink(href: string) {
  return /^[a-zA-Z]:[\\/]/.test(href) || href.startsWith("/") || href.startsWith(".\\") || href.startsWith("./");
}

// LRU cache for rendered markdown documents. Rendering a message is pure
// (content -> element): parseMarkdownBlocks plus per-line hljs highlighting
// are the dominant CPU cost when a long conversation mounts. Cached elements
// are immutable descriptions, so sharing them across threads/mounts is safe —
// component state (e.g. CopyTextButton) is scoped by React to each mount
// position, not to the element object.
const MARKDOWN_RENDER_CACHE_LIMIT = 300;
const markdownRenderCache = new Map<string, ReactNode>();

export function renderMarkdownDocument(content: string, keyPrefix: string, className: string) {
  if (!content) {
    return null;
  }
  const cacheKey = `${className}${content}`;
  const cached = markdownRenderCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh recency (LRU).
    markdownRenderCache.delete(cacheKey);
    markdownRenderCache.set(cacheKey, cached);
    return cached;
  }
  // Block keys inside the cached subtree only need to be unique among their
  // siblings, so a fixed prefix is safe for shared cached elements.
  const rendered = renderMarkdownDocumentUncached(content, `mdc-${content.length}`, className);
  markdownRenderCache.set(cacheKey, rendered);
  if (markdownRenderCache.size > MARKDOWN_RENDER_CACHE_LIMIT) {
    const oldestKey = markdownRenderCache.keys().next().value;
    if (oldestKey !== undefined) {
      markdownRenderCache.delete(oldestKey);
    }
  }
  return rendered;
}

function renderMarkdownDocumentUncached(content: string, keyPrefix: string, className: string) {
  const blocks = parseMarkdownBlocks(content);
  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      {blocks.map((block, index) => renderMarkdownBlock(block, `${keyPrefix}-${index}`))}
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, key: string) {
  switch (block.kind) {
    case "heading": {
      const content = renderMarkdownInline(block.text, `${key}-inline`);
      switch (Math.min(6, Math.max(1, block.level))) {
        case 1:
          return <h1 key={key}>{content}</h1>;
        case 2:
          return <h2 key={key}>{content}</h2>;
        case 3:
          return <h3 key={key}>{content}</h3>;
        case 4:
          return <h4 key={key}>{content}</h4>;
        case 5:
          return <h5 key={key}>{content}</h5>;
        default:
          return <h6 key={key}>{content}</h6>;
      }
    }
    case "paragraph":
      return <p key={key}>{renderMarkdownInline(block.text, `${key}-inline`)}</p>;
    case "unordered-list": {
      const taskItems = block.items.map((item) => item.match(/^\[([ xX])\]\s+(.*)$/));
      const isTaskList = taskItems.every((item) => item !== null);
      return (
        <ul key={key} className={isTaskList ? "markdown-task-list" : undefined}>
          {block.items.map((item, index) => {
            const taskItem = taskItems[index];
            return (
              <li key={`${key}-item-${index}`}>
                {taskItem ? (
                  <>
                    <input type="checkbox" checked={taskItem[1].toLowerCase() === "x"} readOnly tabIndex={-1} />
                    {renderMarkdownInline(taskItem[2], `${key}-item-inline-${index}`)}
                  </>
                ) : renderMarkdownInline(item, `${key}-item-inline-${index}`)}
              </li>
            );
          })}
        </ul>
      );
    }
    case "ordered-list":
      return (
        <ol key={key}>
          {block.items.map((item, index) => (
            <li key={`${key}-item-${index}`}>{renderMarkdownInline(item, `${key}-item-inline-${index}`)}</li>
          ))}
        </ol>
      );
    case "structured-ordered-list":
      return (
        <ol key={key} className="markdown-structured-list">
          {block.items.map((item, index) => (
            <li key={`${key}-item-${index}`}>
              <strong>{renderMarkdownInline(item.title, `${key}-item-title-${index}`)}</strong>
              {item.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`${key}-item-${index}-paragraph-${paragraphIndex}`}>
                  {renderMarkdownInline(paragraph, `${key}-item-paragraph-${index}-${paragraphIndex}`)}
                </p>
              ))}
            </li>
          ))}
        </ol>
      );
    case "horizontal-rule":
      return <hr key={key} className="markdown-horizontal-rule" />;
    case "blockquote":
      return (
        <blockquote key={key}>
          {block.lines.map((line, index) => (
            <p key={`${key}-quote-${index}`}>{renderMarkdownInline(line, `${key}-quote-inline-${index}`)}</p>
          ))}
        </blockquote>
      );
    case "code":
      // Auto-detection repeatedly parses every registered language. During the
      // draft-to-final handoff that can stall the renderer for large replies.
      const highlightedLanguage = block.content.length <= MAX_HIGHLIGHTED_CODE_BLOCK_LENGTH
        ? block.language
        : undefined;
      return (
        <div key={key} className="markdown-code-block">
          <CopyTextButton content={block.content} />
          {block.language ? <div className="markdown-code-label">{block.language}</div> : null}
          <div className="markdown-code-scroll" role="region" aria-label={`${block.language ?? "代码"} 代码块`}>
            <ol className="markdown-code-lines">
              {block.content.split("\n").map((line, lineIndex) => (
                <li key={`${key}-line-${lineIndex}`}>
                  <code
                    className="hljs"
                    dangerouslySetInnerHTML={{ __html: highlightMarkdownCode(line, highlightedLanguage) }}
                  />
                </li>
              ))}
            </ol>
          </div>
        </div>
      );
    case "echarts":
      return <EChartsMessageChart key={key} configText={block.content} />;
    case "api-card":
      return <ApiCardMessage key={key} configText={block.content} />;
    case "table":
      return (
        <div key={key} className="markdown-table-wrap">
          <table className="markdown-table">
            <thead>
              <tr>
                {block.headers.map((header, index) => (
                  <th key={`${key}-header-${index}`}>{renderMarkdownInline(header, `${key}-header-${index}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {block.headers.map((_, columnIndex) => (
                    <td key={`${key}-cell-${rowIndex}-${columnIndex}`}>
                      {renderMarkdownInline(row[columnIndex] ?? "", `${key}-cell-${rowIndex}-${columnIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}
