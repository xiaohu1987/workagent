/**
 * Shell policy for web/frontend GPA tasks: prefer apply_patch + http-server,
 * block Python used to *generate/write* HTML/JS/CSS, but allow read-only
 * validation / helpers (e.g. `python scripts/validate_game.py`).
 */

export function isWebFrontendTaskText(text: string): boolean {
  return /网页|纯前端|HTML|CSS|JavaScript|\bJS\b|可直接打开|浏览器(?:里|中)?完成|单页应用|\.html\b|\.css\b|\.js\b/i.test(
    text
  );
}

/** Rewrite `python -m http.server [port]` to npx http-server. */
export function rewritePythonHttpServer(command: string): string {
  const match = command.match(
    /\bpython(?:3)?(?:\.exe)?\s+-m\s+http\.server(?:\s+(\d{2,5}))?\b/i
  );
  if (!match) {
    return command;
  }
  const port = match[1] ?? "8000";
  return command.replace(
    /\bpython(?:3)?(?:\.exe)?\s+-m\s+http\.server(?:\s+\d{2,5})?\b/i,
    `npx http-server . -p ${port} -c-1`
  );
}

/** Patterns that indicate Python is being used to scaffold / write frontend assets. */
const PYTHON_WRITE_PATTERNS =
  /write_text|write_bytes|writelines|makedirs|mkdir\b|shutil\.copy|open\s*\([^)]*['"][wa]|Path\([^)]*\)\.(?:write_text|write_bytes|touch)|dump\s*\(|to_csv\s*\(/i;

const PYTHON_SCAFFOLD_SCRIPT_NAMES =
  /\b(?:write_index|gen_index|scaffold|bootstrap_frontend|engine_sim)\.py\b/i;

export function isPythonScaffoldingCommand(command: string): boolean {
  const normalized = command.trim();
  if (!/\bpython(?:3)?(?:\.exe)?\b/i.test(normalized)) {
    return false;
  }
  // Pure http.server is rewritten, not blocked.
  if (/\bpython(?:3)?(?:\.exe)?\s+-m\s+http\.server\b/i.test(normalized)) {
    return false;
  }
  if (/\bpython(?:3)?(?:\.exe)?\s+-c\b[\s\S]*\b(?:http\.server|serve_forever)\b/i.test(normalized)) {
    return false;
  }

  // Inline python -c: only block when the snippet clearly writes frontend files.
  if (/\bpython(?:3)?(?:\.exe)?\s+-c\b/i.test(normalized)) {
    const writesFrontendAsset =
      PYTHON_WRITE_PATTERNS.test(normalized) &&
      /\.html|\.css|\.js|index\.html|style\.css|app\.js/i.test(normalized);
    const hardScaffold =
      /write_index|engine_sim|Path\([^)]*index\.html|open\s*\(\s*['"][^'"]*\.(?:html|css|js)['"]/i.test(
        normalized
      );
    return writesFrontendAsset || hardScaffold;
  }

  // Script invocations: block only known scaffolding script names, not validators.
  if (PYTHON_SCAFFOLD_SCRIPT_NAMES.test(normalized)) {
    return true;
  }

  // `python foo.py` with an inline redirect/write in the same shell line.
  if (
    /\bpython(?:3)?(?:\.exe)?\s+(?:["'][^"']+\.py["']|[^\s]+\.py)\b/i.test(normalized) &&
    PYTHON_WRITE_PATTERNS.test(normalized) &&
    /\.html|\.css|\.js/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

export const WEB_FRONTEND_PYTHON_BLOCK_MESSAGE =
  "网页/前端任务禁止用 Python 生成或改写 HTML/CSS/JS 文件。请使用 apply_patch 或 fs.write_file；本地预览请用 npx http-server（python -m http.server 会自动改写）。只读校验类 Python 脚本仍可执行。";

const WINDOWS_CMD_PATTERNS = [
  /\bdir\s+\/[a-z]*b\b/i,
  /\b(?:copy|move|del|type|where)\s+/i,
  /\bif\s+exist\b/i,
  /\d>\s*nul\b/i,
  /%[a-z_][a-z0-9_]*%/i
];

const WINDOWS_SHELL_FILE_WRITE_PATTERN =
  /\b(?:set-content|add-content|out-file|clear-content|writealltext|writeallbytes|writefile|appendfile)\b/i;

const INLINE_FILE_WRITE_PATTERN =
  /\b(?:python(?:3)?(?:\.exe)?\s+-c|node(?:\.exe)?\s+-e)\b[\s\S]*(?:\bopen\s*\([^)]*['"][wax]|\bwrite_text\b|\bwrite_bytes\b|\bwriteFile\b|\bappendFile\b)/i;

const SHELL_REDIRECT_FILE_WRITE_PATTERN = /\b(?:echo|type)\b[^\r\n]*?(?:>>|>)(?!&)/i;

function quotePowerShellArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Windows desktop agents execute shell.exec through PowerShell. Adapt clearly
 * CMD-specific commands and prevent shell-based file writes that bypass the
 * managed apply_patch delivery path.
 */
export function prepareShellCommandForWindows(command: string, isWindows = process.platform === "win32"): {
  ok: boolean;
  command: string;
  error?: string;
  rewritten?: boolean;
} {
  if (!isWindows) return { ok: true, command };

  const normalized = command.trim();
  if (WINDOWS_SHELL_FILE_WRITE_PATTERN.test(normalized)
    || INLINE_FILE_WRITE_PATTERN.test(normalized)
    || SHELL_REDIRECT_FILE_WRITE_PATTERN.test(normalized)) {
    return {
      ok: false,
      command,
      error: "Windows shell compatibility: shell.exec cannot edit files. Use apply_patch for every file creation or content change; it preserves encoding and supports verified delivery."
    };
  }

  const isExplicitCmd = /^cmd(?:\.exe)?\b/i.test(normalized);
  if (!isExplicitCmd && WINDOWS_CMD_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      ok: true,
      command: `& cmd.exe /d /s /c ${quotePowerShellArgument(command)}`,
      rewritten: true
    };
  }

  return { ok: true, command };
}

export function prepareShellCommandForWebFrontend(command: string): {
  ok: boolean;
  command: string;
  error?: string;
  rewritten?: boolean;
} {
  const rewrittenHttp = rewritePythonHttpServer(command);
  const rewritten = rewrittenHttp !== command;
  if (isPythonScaffoldingCommand(rewrittenHttp)) {
    return {
      ok: false,
      command: rewrittenHttp,
      error: WEB_FRONTEND_PYTHON_BLOCK_MESSAGE,
      rewritten
    };
  }
  return { ok: true, command: rewrittenHttp, rewritten };
}

