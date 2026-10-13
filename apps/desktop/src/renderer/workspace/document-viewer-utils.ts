import { getFilePreviewLanguage, listFilePreviewExtensions } from "./file-preview-utils";

/** 「查看文档」的展示方式：渲染后的效果，或原始源码。 */
export type DocumentViewMode = "rendered" | "source";

/** 按后缀名区分的文档类型，决定能否渲染以及用哪种预览。 */
export type DocumentViewKind = "markdown" | "html" | "code" | "text";

const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdx"];
const HTML_EXTENSIONS = ["html", "htm"];

/**
 * 文件对话框用的后缀清单：代码与文档后缀沿用 file-preview 的既有映射，
 * 再补上那份映射里没有列出的 Markdown 变体。
 */
export const DOCUMENT_CHOOSE_EXTENSIONS: string[] = [
  ...new Set([...listFilePreviewExtensions(), ...MARKDOWN_EXTENSIONS, ...HTML_EXTENSIONS])
].sort();

/** 取文件名本身，用于面板标题；无法解析时回退整条路径。 */
export function getDocumentFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 取小写后缀名（不含点），没有后缀时返回空串。 */
export function getDocumentExtension(path: string): string {
  const fileName = getDocumentFileName(path).toLowerCase();
  return fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
}

/**
 * 拖入的文件是否属于「查看文档」能处理的类型：与文件对话框共用同一份后缀清单，
 * 目录和 docx / 图片之类一律忽略，不让它们进页签变成一条条打开失败。
 */
export function isSupportedDocumentPath(path: string): boolean {
  return DOCUMENT_CHOOSE_EXTENSIONS.includes(getDocumentExtension(path));
}
/** 按后缀名判定文档类型；能高亮的代码文件归为 code，其余归为 text。 */
export function resolveDocumentViewKind(path: string): DocumentViewKind {
  const extension = getDocumentExtension(path);
  if (MARKDOWN_EXTENSIONS.includes(extension)) return "markdown";
  if (HTML_EXTENSIONS.includes(extension)) return "html";
  return getFilePreviewLanguage(path).id ? "code" : "text";
}

/** 可切换的展示方式：Markdown/HTML 支持预览与源码互切，其它只有源码。 */
export function getDocumentViewModes(kind: DocumentViewKind): DocumentViewMode[] {
  return kind === "markdown" || kind === "html" ? ["rendered", "source"] : ["source"];
}

/** 默认展示方式：Markdown/HTML 默认看渲染效果，代码与文本默认看源码。 */
export function getDefaultDocumentViewMode(kind: DocumentViewKind): DocumentViewMode {
  return getDocumentViewModes(kind)[0] ?? "source";
}

export function getDocumentViewKindLabel(kind: DocumentViewKind): string {
  if (kind === "markdown") return "Markdown 文档";
  if (kind === "html") return "HTML 页面";
  if (kind === "code") return "代码文件";
  return "文本文件";
}

export function getDocumentViewModeLabel(mode: DocumentViewMode): string {
  return mode === "rendered" ? "预览" : "源码";
}

/** 新建空白页的标题前缀：未保存前不占磁盘路径，靠序号彼此区分。 */
export const UNTITLED_DOCUMENT_TITLE_PREFIX = "未命名";

/** 新建空白页的标题，例如「未命名 1」。 */
export function getUntitledDocumentTitle(sequence: number): string {
  return `${UNTITLED_DOCUMENT_TITLE_PREFIX} ${sequence}`;
}

/** 在已占用的标题里挑一个不重名的未命名标题，多次新建不会出现同名页签。 */
export function getNextUntitledDocumentTitle(takenTitles: string[]): string {
  const taken = new Set(takenTitles);
  let index = 1;
  while (taken.has(getUntitledDocumentTitle(index))) {
    index += 1;
  }
  return getUntitledDocumentTitle(index);
}

/** 空白页另存为时的默认文件名：空白页按纯文本起手，默认存成 .txt。 */
export function getUntitledDocumentSuggestedFileName(title: string): string {
  return `${title}.txt`;
}

/** 时间戳容差：不同文件系统给的 mtime 粒度不同，1ms 以内视为同一次写入。 */
const DOCUMENT_SOURCE_MTIME_TOLERANCE_MS = 1;

/**
 * 磁盘上的源文件是否已经和打开时的基线不同。
 * 任一侧拿不到时间戳（文件已删除、读不到权限）都按「无法判断」返回 false，
 * 不把读不到的情况也报成一次更新提醒。
 */
export function hasDocumentSourceChanged(
  baseMtimeMs: number | null,
  currentMtimeMs: number | null
): boolean {
  if (baseMtimeMs === null || currentMtimeMs === null) return false;
  return Math.abs(currentMtimeMs - baseMtimeMs) > DOCUMENT_SOURCE_MTIME_TOLERANCE_MS;
}

/** 更新提醒的文案：一份文档点名，多份文档给数量，两种情况都只占一行。 */
export function describeDocumentSourceUpdate(titles: string[]): string {
  if (titles.length === 0) return "";
  if (titles.length === 1) return `「${titles[0]}」的源文件已在磁盘上更新`;
  return `「${titles[0]}」等 ${titles.length} 份文档的源文件已在磁盘上更新`;
}
