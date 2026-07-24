import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
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

type ActiveCommand = {
  threadId: string;
  child: ChildProcess;
  session: TerminalSession;
};

const MAX_BUFFER_LENGTH = 80_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_COMMAND_IDLE_TIMEOUT_MS = 300_000;

export type TerminalCommandResult = {
  output: string;
  localUrl?: string;
  stalled?: boolean;
  diagnosis?: string;
};

/** Maintains one interactive shell process per task. */
export class TerminalRuntime {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #activeCommands = new Map<string, Set<ActiveCommand>>();

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
              "$OutputEncoding = $utf8; [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8"
          ]
        : ["-i"];
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
    });
    const session: TerminalSession = {
      threadId,
      sessionId,
      child,
      cwd,
      output: "",
      onOutput,
      // PowerShell is configured to output UTF-8 via [Console]::OutputEncoding above.
      // Python gets PYTHONIOENCODING=utf-8 / PYTHONUTF8=1. Both produce UTF-8.
      stdoutDecoder: process.platform === "win32" ? new TextDecoder("utf-8") : null,
      stderrDecoder: process.platform === "win32" ? new TextDecoder("utf-8") : null
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
      if (this.#sessions.get(key) === session) {
        this.#sessions.delete(key);
      }
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
    sessionId = "default",
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    onStalled?: () => Promise<string | null>
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
    // Prepend UTF-8 setup so PowerShell writes UTF-8 to the redirected stdout
    // pipe. Without this, -NoProfile uses the system ANSI code page (GBK on
    // Chinese Windows), which mismatches the UTF-8 decoder and garbles output
    // from both PowerShell and Python.
    const utf8Prefix = process.platform === "win32" && !backgrounded
      ? "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
      : "";
    const shellCommand = backgrounded ? buildBackgroundLaunchCommand(effectiveCommand, cwd) : (utf8Prefix + effectiveCommand);
    const args = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-Command", shellCommand]
      : ["-lc", effectiveCommand];

    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
      });
      const activeCommand: ActiveCommand = { threadId, child, session };
      const activeForThread = this.#activeCommands.get(threadId) ?? new Set<ActiveCommand>();
      activeForThread.add(activeCommand);
      this.#activeCommands.set(threadId, activeForThread);
      const stdoutDecoder = process.platform === "win32" ? new TextDecoder("utf-8") : null;
      const stderrDecoder = process.platform === "win32" ? new TextDecoder("utf-8") : null;
      let stdout = "";
      let stderr = "";
      let localUrl: string | undefined;
      let settled = false;
      let timedOut = false;
      let idleTimeout: ReturnType<typeof setTimeout> | undefined;
      const removeActiveCommand = () => {
        activeForThread.delete(activeCommand);
        if (activeForThread.size === 0) this.#activeCommands.delete(threadId);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (idleTimeout) clearTimeout(idleTimeout);
        removeActiveCommand();
        callback();
      };
      const reportStall = async (reason: "total" | "idle", limitMs: number) => {
        if (settled || timedOut) return;
        timedOut = true;
        const description = reason === "idle" ? "produced no output" : "exceeded its total runtime";
        this.#publish(session, `Command ${description} for ${limitMs}ms. Starting a diagnostic subagent while the command continues.\n`);
        const diagnosis = await onStalled?.().catch((error) =>
          `Diagnostic subagent could not start: ${error instanceof Error ? error.message : String(error)}`
        ) ?? null;
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (idleTimeout) clearTimeout(idleTimeout);
        const output = `${stdout}${stderr}`.trim();
        resolve({
          output: [
            output,
            `Command is still running after ${limitMs}ms.`,
            diagnosis ?? "No diagnostic result was available before the watchdog returned."
          ].filter(Boolean).join("\n\n"),
          localUrl,
          stalled: true,
          diagnosis: diagnosis ?? undefined
        });
      };
      const timeout = onStalled
        ? setTimeout(() => void reportStall("total", timeoutMs), Math.max(1, timeoutMs))
        : undefined;
      const resetIdleTimeout = () => {
        if (!onStalled) return;
        if (idleTimeout) clearTimeout(idleTimeout);
        idleTimeout = setTimeout(
          () => void reportStall("idle", DEFAULT_COMMAND_IDLE_TIMEOUT_MS),
          DEFAULT_COMMAND_IDLE_TIMEOUT_MS
        );
      };

      const reportLocalUrl = (candidate?: string) => {
        if (!candidate || localUrl) {
          return;
        }
        localUrl = candidate;
        onLocalUrl?.(candidate);
      };

      const collect = (chunk: Buffer | string, target: "stdout" | "stderr", decoder: TextDecoder | null) => {
        resetIdleTimeout();
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
      child.on("error", (error) => finish(() => reject(error)));
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

        if (settled) {
          removeActiveCommand();
          return;
        }
        const output = `${stdout}${stderr}`.trim() || (backgrounded ? "Started local server in the background." : "");
        finish(() => {
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
      resetIdleTimeout();
    });
  }

  public cancelCommands(threadId: string, reason = "Command cancelled."): void {
    const activeForThread = this.#activeCommands.get(threadId);
    if (!activeForThread) return;
    for (const active of activeForThread) {
      this.#publish(active.session, `${reason} Stopping its process tree.\n`);
      this.#terminateProcessTree(active.child);
    }
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

  public async close(threadId: string, sessionId?: string): Promise<void> {
    this.cancelCommands(threadId, "Terminal session closed.");
    if (sessionId) {
      const key = this.#sessionKey(threadId, sessionId);
      const session = this.#sessions.get(key);
      if (!session) {
        return;
      }
      await this.#closeSession(key, session);
      return;
    }

    await Promise.all(
      [...this.#sessions.entries()]
        .filter(([, session]) => session.threadId === threadId)
        .map(([key, session]) => this.#closeSession(key, session))
    );
  }

  async #closeSession(key: string, session: TerminalSession): Promise<void> {
    this.#sessions.delete(key);
    if (session.child.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        session.child.off("exit", onExit);
        resolve();
      }, 2_000);
      const onExit = () => {
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      session.child.once("exit", onExit);
      try {
        session.child.kill();
      } catch {
        if (timeout) clearTimeout(timeout);
        session.child.off("exit", onExit);
        resolve();
      }
    });
  }

  #publish(session: TerminalSession, value: string): void {
    const data = redactTerminalSecrets(stripAnsi(value));
    if (!data) {
      return;
    }
    session.output = `${session.output}${data}`.slice(-MAX_BUFFER_LENGTH);
    session.onOutput(data);
  }

  #sessionKey(threadId: string, sessionId: string): string {
    return `${threadId}:${sessionId}`;
  }

  #terminateProcessTree(child: ChildProcess): void {
    if (child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.unref();
      return;
    }
    try {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      forceKill.unref();
    } catch {
      // The child may already have exited between the state check and kill.
    }
  }
}

function shellLabel(): string {
  return process.platform === "win32" ? "Windows PowerShell" : "Shell";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function redactTerminalSecrets(value: string): string {
  return value
    .replace(/((?:"?(?:password|passphrase|api[_-]?key|token|secret)"?)\s*[:=]\s*["']?)([^\s"',;})]+)/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, "$1[REDACTED]$2");
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
