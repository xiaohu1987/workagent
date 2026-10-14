import { getDocumentFileName, type DocumentViewKind } from "./document-viewer-utils";

/** 文件换行风格；保存时按原风格回写，避免整文件换行被改写。 */
export type DocumentLineEnding = "lf" | "crlf";

/** 编辑器缩进宽度：代码 2 空格，文档与纯文本 4 空格，与主流编辑器一致。 */
const CODE_INDENT_SIZE = 2;
const TEXT_INDENT_SIZE = 4;

/** 取页签标题；与侧栏一致地只显示文件名。 */
export function getDocumentTabTitle(path: string): string {
  return getDocumentFileName(path);
}

/** 探测换行风格：出现 CRLF 即按 Windows 风格保存；纯 LF 或无换行时按 LF。 */
export function detectLineEnding(content: string): DocumentLineEnding {
  return content.includes("\r\n") ? "crlf" : "lf";
}

/** 按指定风格统一换行；先归一化再统一，避免写回混合换行。 */
export function applyLineEnding(content: string, ending: DocumentLineEnding): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  return ending === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

/** 行数统计：空文件算 1 行，与编辑器 gutter 的行号数量保持一致。 */
export function countDocumentLines(content: string): number {
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

/** 内容是否与磁盘上读到的版本不同，用来驱动页签的未保存标记。 */
export function isDocumentDirty(content: string, savedContent: string): boolean {
  return content !== savedContent;
}

/** Markdown 与文本类按 4 空格缩进，代码文件按 2 空格。 */
export function getDocumentIndentSize(kind: DocumentViewKind): number {
  return kind === "code" ? CODE_INDENT_SIZE : TEXT_INDENT_SIZE;
}

/** 可编辑性：能读成文本就能改；二进制文件保持只读。 */
export function isDocumentEditable(binary: boolean): boolean {
  return !binary;
}

export type DocumentSelectionPosition = {
  line: number;
  column: number;
};

/** 把光标偏移换算成行列号，供状态栏显示。 */
export function getDocumentSelectionPosition(
  content: string,
  offset: number
): DocumentSelectionPosition {
  const bounded = Math.max(0, Math.min(offset, content.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < bounded; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: bounded - lineStart + 1 };
}

/** 取选区覆盖的整行字符范围，用于整行缩进。 */
function getLineRange(content: string, start: number, end: number): { from: number; to: number } {
  const from = content.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextBreak = content.indexOf("\n", end);
  const to = nextBreak === -1 ? content.length : nextBreak;
  return { from, to };
}

export type DocumentIndentResult = {
  content: string;
  selectionStart: number;
  selectionEnd: number;
};

/** 去掉行首一格缩进，返回实际去掉的字符数与剩余内容。 */
function stripLeadingIndent(line: string, indentSize: number): { line: string; removed: number } {
  const match = /^( {1,8}|\t)/.exec(line);
  if (!match) {
    return { line, removed: 0 };
  }
  const removed = match[0] === "\t" ? 1 : Math.min(match[0].length, indentSize);
  return { line: line.slice(removed), removed };
}

/**
 * 对选区覆盖的整行做缩进或反缩进（Tab / Shift+Tab 的语义），
 * 返回新的内容与选区，便于调用方一次性回写 textarea。
 */
export function indentDocumentSelection(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  indentSize: number,
  outdent: boolean
): DocumentIndentResult {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.min(content.length, Math.max(selectionStart, selectionEnd));
  const { from, to } = getLineRange(content, start, end);
  const block = content.slice(from, to);
  const pad = " ".repeat(Math.max(1, indentSize));
  const lines = block.split("\n");
  const nextLines: string[] = [];
  let firstRemoved = 0;
  let lastRemoved = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!outdent) {
      nextLines.push(pad + line);
      continue;
    }
    const stripped = stripLeadingIndent(line, pad.length);
    if (index === 0) firstRemoved = stripped.removed;
    if (index === lines.length - 1) lastRemoved = stripped.removed;
    nextLines.push(stripped.line);
  }

  const nextBlock = nextLines.join("\n");
  return {
    content: content.slice(0, from) + nextBlock + content.slice(to),
    selectionStart: outdent ? Math.max(from, start - Math.min(firstRemoved, start - from)) : start + pad.length,
    selectionEnd: outdent
      ? Math.max(from + nextBlock.length, end - Math.min(lastRemoved, Math.max(0, to - end)))
      : end + pad.length * lines.length
  };
}

/** 在光标处插入缩进：多行选区走整行缩进，单点或单行选区走插入空格。 */
export function insertDocumentIndent(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  indentSize: number
): DocumentIndentResult {
  if (selectionStart !== selectionEnd && content.slice(selectionStart, selectionEnd).includes("\n")) {
    return indentDocumentSelection(content, selectionStart, selectionEnd, indentSize, false);
  }
  const pad = " ".repeat(Math.max(1, indentSize));
  if (selectionStart !== selectionEnd) {
    return {
      content: content.slice(0, selectionStart) + pad + content.slice(selectionEnd),
      selectionStart: selectionStart + pad.length,
      selectionEnd: selectionStart + pad.length
    };
  }
  return {
    content: content.slice(0, selectionStart) + pad + content.slice(selectionStart),
    selectionStart: selectionStart + pad.length,
    selectionEnd: selectionStart + pad.length
  };
}
