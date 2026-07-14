import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rewritePythonHttpServer } from "@tool-runtime";

type TerminalSession = {
  threadId: string;
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  output: string;
  onOutput: (data: string) => void;
  stdoutDecoder: TextDecoder | null;
  stderrDecoder: TextDecoder | null;
};

const MAX_BUFFER_LENGTH = 80_000;

export type TerminalCommandResult = {
  output: string;
  localUrl?: string;
};

/** Maintains one interactive shell process per task. */
export class TerminalRuntime {
  readonly #sessions = new Map<string, TerminalSession>();

  public open(threadId: string, cwd: string, onOutput: (data: string) => void, sessionId = "default") {
    const key = this.#sessionKey(threadId, sessionId);
    const existing = this.#sessions.get(key);
    if (existing && !existing.child.killed) {
      existing.onOutput = onOutput;
      return { cwd: existing.cwd, shell: shellLabel(), output: existing.output };
    }

    const command = process.platform === "win32" ? "powershell.exe" : "sh";
    const args =
      process.platform === "win32"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-Command",
            "$utf8 = [System.Text.UTF8Encoding]::new($false); " +
              "$OutputEncoding = $utf8; [Console]::InputEncoding = $utf8"
          ]
        : ["-i"];
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const session: TerminalSession = {
      threadId,
      sessionId,
      child,
      cwd,
      output: "",
      onOutput,
      // Windows PowerShell writes redirected host output using the active ANSI code page.
      stdoutDecoder: process.platform === "win32" ? new TextDecoder("gb18030") : null,
      stderrDecoder: process.platform === "win32" ? new TextDecoder("gb18030") : null
    };
    this.#sessions.set(key, session);

    const append = (chunk: Buffer | string, decoder?: TextDecoder | null) => {
      const value = Buffer.isBuffer(chunk) && decoder ? decoder.decode(chunk, { stream: true }) : String(chunk);
      this.#publish(session, value);
    };
    child.stdout.on("data", (chunk) => append(chunk, session.stdoutDecoder));
    child.stderr.on("data", (chunk) => append(chunk, session.stderrDecoder));
    child.on("error", (error) => append(`\nTerminal error: ${error.message}\n`));
    child.on("exit", (code) => {
      this.#sessions.delete(key);
      const trailing = `${session.stdoutDecoder?.decode() ?? ""}${session.stderrDecoder?.decode() ?? ""}`;
      if (trailing) {
        append(trailing);
      }
      append(`\nTerminal exited${code === null ? "" : ` (${code})`}\n`);
    });

    return { cwd, shell: shellLabel(), output: session.output };
  }

  /** Runs a system tool command and mirrors its command line and output into the task terminal. */
  public execute(
    threadId: string,
    cwd: string,
    command: string,
    onOutput: (data: string) => void,
    onLocalUrl?: (url: string) => void,
    sessionId = "default"
  ): Promise<TerminalCommandResult> {
    const key = this.#sessionKey(threadId, sessionId);
    this.#sessions.get(key) ?? this.open(threadId, cwd, onOutput, sessionId);
    const session = this.#sessions.get(key);
    if (!session) {
      return Promise.reject(new Error("Terminal is not available."));
    }
    session.onOutput = onOutput;

    const effectiveCommand =
      redirectStaticHtmlLaunch(command) ??
      (() => {
        const rewritten = rewritePythonHttpServer(command);
        return rewritten !== command ? rewritten : command;
      })();
    const redirectedStaticFileLaunch = effectiveCommand !== command && Boolean(redirectStaticHtmlLaunch(command));
    const redirectedPythonHttpServer =
      effectiveCommand !== command && !redirectedStaticFileLaunch;
    this.#publish(session, `PS ${cwd}> ${effectiveCommand}\n`);
    if (redirectedStaticFileLaunch) {
      this.#publish(session, "Redirected static file launch to a local HTTP server.\n");
    } else if (redirectedPythonHttpServer) {
      this.#publish(session, "Redirected python -m http.server to npx http-server.\n");
    }
    const executable = process.platform === "win32" ? "powershell.exe" : "sh";
    const backgrounded = process.platform === "win32" && isLocalServerCommand(effectiveCommand);
    const args = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-Command", backgrounded ? buildBackgroundLaunchCommand(effectiveCommand, cwd) : effectiveCommand]
      : ["-lc", effectiveCommand];

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdoutDecoder = process.platform === "win32" ? new TextDecoder("gb18030") : null;
      const stderrDecoder = process.platform === "win32" ? new TextDecoder("gb18030") : null;
      let stdout = "";
      let stderr = "";
      let localUrl: string | undefined;

      const reportLocalUrl = (candidate?: string) => {
        if (!candidate || localUrl) {
          return;
        }
        localUrl = candidate;
        onLocalUrl?.(candidate);
      };

      const collect = (chunk: Buffer | string, target: "stdout" | "stderr", decoder: TextDecoder | null) => {
        const value = Buffer.isBuffer(chunk) && decoder ? decoder.decode(chunk, { stream: true }) : String(chunk);
        const data = stripAnsi(value);
        if (target === "stdout") {
          stdout += data;
        } else {
          stderr += data;
        }
        this.#publish(session, value);
        reportLocalUrl(findLocalServerUrl(`${stdout}${stderr}`));
      };

      child.stdout.on("data", (chunk) => collect(chunk, "stdout", stdoutDecoder));
      child.stderr.on("data", (chunk) => collect(chunk, "stderr", stderrDecoder));
      child.on("error", reject);
      child.on("close", (code) => {
        const stdoutTail = stdoutDecoder?.decode() ?? "";
        const stderrTail = stderrDecoder?.decode() ?? "";
        if (stdoutTail) {
          stdout += stripAnsi(stdoutTail);
          this.#publish(session, stdoutTail);
        }
        if (stderrTail) {
          stderr += stripAnsi(stderrTail);
          this.#publish(session, stderrTail);
        }

        const output = `${stdout}${stderr}`.trim() || (backgrounded ? "Started local server in the background." : "");
        if (code === 0) {
          reportLocalUrl(findLocalServerUrl(output) ?? inferLocalServerUrl(effectiveCommand));
          if (backgrounded) {
            this.#publish(session, "Started local server in the background.\n");
          }
          resolve({ output, localUrl });
          return;
        }
        reject(new Error(output || `Command failed with code ${code}`));
      });
    });
  }

  public write(
    threadId: string,
    cwd: string,
    input: string,
    onOutput: (data: string) => void,
    sessionId = "default"
  ): void {
    const key = this.#sessionKey(threadId, sessionId);
    this.#sessions.get(key) ?? this.open(threadId, cwd, onOutput, sessionId);
    const active = this.#sessions.get(key);
    if (!active || active.child.killed) {
      throw new Error("Terminal is not available.");
    }
    active.onOutput = onOutput;
    active.child.stdin.write(`${input}\n`);
  }

  public close(threadId: string, sessionId?: string): void {
    if (sessionId) {
      const key = this.#sessionKey(threadId, sessionId);
      const session = this.#sessions.get(key);
      if (!session) {
        return;
      }
      session.child.kill();
      this.#sessions.delete(key);
      return;
    }

    for (const [key, session] of this.#sessions.entries()) {
      if (session.threadId !== threadId) {
        continue;
      }
      session.child.kill();
      this.#sessions.delete(key);
    }
  }

  #publish(session: TerminalSession, value: string): void {
    const data = stripAnsi(value);
    if (!data) {
      return;
    }
    session.output = `${session.output}${data}`.slice(-MAX_BUFFER_LENGTH);
    session.onOutput(data);
  }

  #sessionKey(threadId: string, sessionId: string): string {
    return `${threadId}:${sessionId}`;
  }
}

function shellLabel(): string {
  return process.platform === "win32" ? "Windows PowerShell" : "Shell";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function findLocalServerUrl(value: string): string | undefined {
  const match = value.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{2,5})?(?:\/[^\s'"\])}]*)?/i);
  return match?.[0];
}

function inferLocalServerUrl(command: string): string | undefined {
  const port = command.match(/(?:--port|-p|http\.server)\s+(\d{2,5})\b/i)?.[1]
    ?? command.match(/\b(?:tcpserver|httpserver)\s*\(\s*\(\s*['\"](?:127\.0\.0\.1|localhost|::1)['\"]\s*,\s*(\d{2,5})\b/i)?.[1];
  return port ? `http://127.0.0.1:${port}` : undefined;
}

export function isLocalServerCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (normalized.includes("start-process") || /(?:^|\s)(?:start|nohup)\s/.test(normalized)) {
    return false;
  }
  const knownServer = /\b(?:http-server|vite|webpack-dev-server|next\s+dev|npm\s+run\s+dev|pnpm\s+dev|yarn\s+dev|python(?:3)?\s+-m\s+http\.server)\b/.test(normalized);
  const inlinePythonServer = /\bpython(?:3)?(?:\.exe)?\s+-c\b[\s\S]*\b(?:http\.server|socketserver|tcpserver|httpserver|serve_forever)\b/.test(normalized);
  return knownServer || inlinePythonServer;
}

export function buildBackgroundLaunchCommand(command: string, cwd: string): string {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const escapedCwd = cwd.replace(/'/g, "''");
  return [
    "Start-Process",
    "-FilePath 'powershell.exe'",
    "-ArgumentList '-NoLogo','-NoProfile','-EncodedCommand','" + encoded + "'",
    "-WorkingDirectory '" + escapedCwd + "'",
    "-WindowStyle Hidden"
  ].join(" ");
}

export function redirectStaticHtmlLaunch(command: string): string | undefined {
  const opensHtmlFile = /\b(?:start-process|start)\b[\s\S]*?\.html(?:[\s'"\)]|$)/i.test(command);
  return opensHtmlFile ? "npx http-server . -p 8000 -c-1" : undefined;
}
