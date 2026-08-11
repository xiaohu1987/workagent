import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeLogEntry, RuntimeLogPage } from "@shared-types";

const DEFAULT_GLOBAL_LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_LOG_LIMIT_BYTES = 2 * 1024 * 1024;

export interface RuntimeLogLimits {
  globalBytes: number;
  sessionBytes: number;
}

export interface RuntimeLogStats {
  bytes: number;
  fileCount: number;
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
    const entry: RuntimeLogEntry = {
      timestamp: new Date().toISOString(),
      kind,
      threadId,
      payload: redactRuntimeLogPayload(payload)
    };
    const line = `${JSON.stringify(entry)}\n`;
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

  public async readSessionPage(threadId: string, limit = 300): Promise<RuntimeLogPage> {
    await this.#tail;
    const filePath = path.join(this.logsDir, "sessions", `${safeFileName(threadId)}.jsonl`);
    const raw = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (!raw.trim()) return { entries: [], total: 0, hasMore: false };
    const entries = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<RuntimeLogEntry>;
          if (
            typeof parsed.timestamp !== "string" ||
            typeof parsed.kind !== "string" ||
            !parsed.payload ||
            typeof parsed.payload !== "object" ||
            Array.isArray(parsed.payload)
          ) {
            return [];
          }
          return [{
            timestamp: parsed.timestamp,
            kind: parsed.kind,
            threadId: typeof parsed.threadId === "string" ? parsed.threadId : undefined,
            payload: parsed.payload as Record<string, unknown>
          }];
        } catch {
          return [];
        }
      });
    const normalizedLimit = Math.max(1, Math.floor(limit));
    return {
      entries: entries.slice(-normalizedLimit),
      total: entries.length,
      hasMore: entries.length > normalizedLimit
    };
  }

  public async readSession(threadId: string, limit = 300): Promise<RuntimeLogEntry[]> {
    return (await this.readSessionPage(threadId, limit)).entries;
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

  public getStats(): Promise<RuntimeLogStats> {
    const operation = this.#tail.then(() => summarizeDirectory(this.logsDir));
    this.#tail = operation.then(
      () => undefined,
      (error) => console.error("[runtime-log] Failed to inspect log files", error)
    );
    return operation;
  }

  public clear(): Promise<RuntimeLogStats> {
    const operation = this.#tail.then(async () => {
      const stats = await summarizeDirectory(this.logsDir);
      const entries = await fs.readdir(this.logsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      await Promise.all(entries.map((entry) =>
        fs.rm(path.join(this.logsDir, entry.name), { recursive: true, force: true })
      ));
      await fs.mkdir(path.join(this.logsDir, "sessions"), { recursive: true });
      return stats;
    });
    this.#tail = operation.then(
      () => undefined,
      (error) => console.error("[runtime-log] Failed to clear log files", error)
    );
    return operation;
  }
}

async function summarizeDirectory(directory: string): Promise<RuntimeLogStats> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const totals = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return summarizeDirectory(target);
    if (!entry.isFile()) return { bytes: 0, fileCount: 0 };
    const stats = await fs.stat(target);
    return { bytes: stats.size, fileCount: 1 };
  }));
  return totals.reduce<RuntimeLogStats>(
    (summary, current) => ({
      bytes: summary.bytes + current.bytes,
      fileCount: summary.fileCount + current.fileCount
    }),
    { bytes: 0, fileCount: 0 }
  );
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

export function redactRuntimeLogPayload(value: unknown): Record<string, unknown> {
  const redacted = redactSecrets(value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : { value: redacted };
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
