import { escapeHtml, hljs } from "../markdown";

export type FilePreviewLanguage = {
  id: string | null;
  label: string;
};

export type PreviewCacheEntry = {
  content: string;
  truncated: boolean;
  binary: boolean;
};

const FILE_PREVIEW_LANGUAGES: Record<string, FilePreviewLanguage> = {
  bash: { id: "bash", label: "Shell" }, c: { id: "c", label: "C" }, cc: { id: "cpp", label: "C++" },
  cjs: { id: "javascript", label: "JavaScript" }, cpp: { id: "cpp", label: "C++" }, css: { id: "css", label: "CSS" },
  cs: { id: "csharp", label: "C#" }, csv: { id: null, label: "CSV" }, diff: { id: "diff", label: "Diff" },
  go: { id: "go", label: "Go" }, h: { id: "c", label: "C" }, hpp: { id: "cpp", label: "C++" },
  htm: { id: "xml", label: "HTML" }, html: { id: "xml", label: "HTML" }, java: { id: "java", label: "Java" },
  js: { id: "javascript", label: "JavaScript" }, json: { id: "json", label: "JSON" }, jsonc: { id: "json", label: "JSON" },
  json5: { id: "json", label: "JSON" }, jsx: { id: "javascript", label: "JavaScript" }, mjs: { id: "javascript", label: "JavaScript" },
  md: { id: "markdown", label: "Markdown" }, mts: { id: "typescript", label: "TypeScript" }, php: { id: "php", label: "PHP" },
  py: { id: "python", label: "Python" }, rb: { id: "ruby", label: "Ruby" }, rs: { id: "rust", label: "Rust" },
  scss: { id: "css", label: "SCSS" }, sh: { id: "bash", label: "Shell" }, sql: { id: "sql", label: "SQL" },
  svg: { id: "xml", label: "SVG" }, toml: { id: null, label: "TOML" }, ts: { id: "typescript", label: "TypeScript" },
  tsx: { id: "typescript", label: "TypeScript" }, txt: { id: null, label: "Text" }, xml: { id: "xml", label: "XML" },
  yaml: { id: "yaml", label: "YAML" }, yml: { id: "yaml", label: "YAML" }, zsh: { id: "bash", label: "Shell" }
};

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
  if (!language || !hljs.getLanguage(language)) return source.split("\n").map(escapeHtml);
  return hljs.highlight(source, { language, ignoreIllegals: true }).value.split("\n");
}
