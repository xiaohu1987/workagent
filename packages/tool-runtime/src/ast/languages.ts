export type AstLanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "c_sharp"
  | "rust"
  | "c"
  | "cpp"
  | "kotlin"
  | "php"
  | "ruby";

const EXTENSION_LANGUAGE_MAP: Record<string, AstLanguageId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".go": "go",
  ".java": "java",
  ".cs": "c_sharp",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".php": "php",
  ".rb": "ruby"
};

const LANGUAGE_WASM_MAP: Record<AstLanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c_sharp: "tree-sitter-c_sharp.wasm",
  rust: "tree-sitter-rust.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  php: "tree-sitter-php.wasm",
  ruby: "tree-sitter-ruby.wasm"
};

export function languageFromPath(filePath: string): AstLanguageId | null {
  const lower = filePath.toLowerCase().replace(/\\/g, "/");
  const base = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return EXTENSION_LANGUAGE_MAP[base.slice(dot)] ?? null;
}

export function wasmFileForLanguage(language: AstLanguageId): string {
  return LANGUAGE_WASM_MAP[language];
}

export function isAstSupportedPath(filePath: string): boolean {
  return languageFromPath(filePath) !== null;
}
