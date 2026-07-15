import fs from "node:fs/promises";
import path from "node:path";

export class RuntimeLogWriter {
  #tail: Promise<void> = Promise.resolve();

  public constructor(private readonly logsDir: string) {}

  public append(kind: string, payload: Record<string, unknown>, threadId?: string): Promise<void> {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), kind, threadId, payload: redactSecrets(payload) })}\n`;
    const targets = [path.join(this.logsDir, "runtime.jsonl")];
    if (threadId) {
      targets.push(path.join(this.logsDir, "sessions", `${safeFileName(threadId)}.jsonl`));
    }

    this.#tail = this.#tail
      .then(async () => {
        await fs.mkdir(path.join(this.logsDir, "sessions"), { recursive: true });
        await Promise.all(targets.map((target) => fs.appendFile(target, line, "utf8")));
      })
      .catch((error) => {
        console.error("[runtime-log] Failed to append log entry", error);
      });
    return this.#tail;
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
