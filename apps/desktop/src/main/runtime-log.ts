import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_GLOBAL_LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_LOG_LIMIT_BYTES = 2 * 1024 * 1024;

export interface RuntimeLogLimits {
  globalBytes: number;
  sessionBytes: number;
}

export class RuntimeLogWriter {
  #tail: Promise<void> = Promise.resolve();
  readonly #limits: RuntimeLogLimits;

  public constructor(logsDir: string, limits: Partial<RuntimeLogLimits> = {}) {
    this.logsDir = logsDir;
    this.#limits = {
      globalBytes: limits.globalBytes ?? DEFAULT_GLOBAL_LOG_LIMIT_BYTES,
      sessionBytes: limits.sessionBytes ?? DEFAULT_SESSION_LOG_LIMIT_BYTES
    };
  }

  private readonly logsDir: string;

  public append(kind: string, payload: Record<string, unknown>, threadId?: string): Promise<void> {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), kind, threadId, payload: redactSecrets(payload) })}\n`;
    const targets = [path.join(this.logsDir, "runtime.jsonl")];
    if (threadId) {
      targets.push(path.join(this.logsDir, "sessions", `${safeFileName(threadId)}.jsonl`));
    }

    this.#tail = this.#tail
      .then(async () => {
        await fs.mkdir(path.join(this.logsDir, "sessions"), { recursive: true });
        await Promise.all(targets.map(async (target) => {
          await fs.appendFile(target, line, "utf8");
          await trimJsonlFile(target, target.includes(`${path.sep}sessions${path.sep}`)
            ? this.#limits.sessionBytes
            : this.#limits.globalBytes);
        }));
      })
      .catch((error) => {
        console.error("[runtime-log] Failed to append log entry", error);
      });
    return this.#tail;
  }

  public prune(): Promise<void> {
    this.#tail = this.#tail
      .then(async () => {
        await trimJsonlFile(path.join(this.logsDir, "runtime.jsonl"), this.#limits.globalBytes);
        const sessionsDir = path.join(this.logsDir, "sessions");
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        await Promise.all(entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => trimJsonlFile(path.join(sessionsDir, entry.name), this.#limits.sessionBytes)));
      })
      .catch((error) => {
        console.error("[runtime-log] Failed to prune log files", error);
      });
    return this.#tail;
  }
}

async function trimJsonlFile(filePath: string, maximumBytes: number): Promise<void> {
  const stats = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return;
  if (stats.size <= maximumBytes) return;

  const bytesToRead = Math.min(maximumBytes, stats.size);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stats.size - bytesToRead);
    const firstNewline = buffer.indexOf(0x0a);
    // Preserve a single oversized record rather than corrupting its JSON payload.
    if (firstNewline !== -1) {
      await fs.writeFile(filePath, buffer.subarray(firstNewline + 1));
    }
  } finally {
    await handle.close();
  }
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /token|authorization|secret|password|code_verifier|access_token|refresh_token/i.test(key) ? "[redacted]" : redactSecrets(child)
    ]));
  }
  if (typeof value === "string") {
    return value.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
  }
  return value;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
