import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeLogWriter } from "../apps/desktop/src/main/runtime-log";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-runtime-log-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("RuntimeLogWriter", () => {
  it("appends global and per-thread JSONL records", async () => {
    const logsDir = await makeTempDir();
    const writer = new RuntimeLogWriter(logsDir);

    await writer.append("tool.execution_error", { toolName: "apply_patch", error: "invalid patch" }, "thread-1");

    const globalLine = await fs.readFile(path.join(logsDir, "runtime.jsonl"), "utf8");
    const threadLine = await fs.readFile(path.join(logsDir, "sessions", "thread-1.jsonl"), "utf8");
    expect(JSON.parse(globalLine)).toMatchObject({ kind: "tool.execution_error", threadId: "thread-1" });
    expect(JSON.parse(threadLine)).toMatchObject({ payload: { toolName: "apply_patch" } });
  });

  it("retains the newest complete records within the configured size limits", async () => {
    const logsDir = await makeTempDir();
    const writer = new RuntimeLogWriter(logsDir, { globalBytes: 1024, sessionBytes: 1024 });

    for (let index = 0; index < 10; index += 1) {
      await writer.append("runtime.event", { index, content: "x".repeat(300) }, "thread-1");
    }

    const globalRecords = (await fs.readFile(path.join(logsDir, "runtime.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const sessionRecords = (await fs.readFile(path.join(logsDir, "sessions", "thread-1.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(globalRecords.at(-1)).toMatchObject({ payload: { index: 9 } });
    expect(sessionRecords.at(-1)).toMatchObject({ payload: { index: 9 } });
    expect((await fs.stat(path.join(logsDir, "runtime.jsonl"))).size).toBeLessThanOrEqual(1024);
    expect((await fs.stat(path.join(logsDir, "sessions", "thread-1.jsonl"))).size).toBeLessThanOrEqual(1024);
  });

  it("prunes existing global and session logs after startup", async () => {
    const logsDir = await makeTempDir();
    const sessionsDir = path.join(logsDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const records = Array.from({ length: 10 }, (_, index) => JSON.stringify({ index, content: "x".repeat(300) })).join("\n") + "\n";
    await fs.writeFile(path.join(logsDir, "runtime.jsonl"), records, "utf8");
    await fs.writeFile(path.join(sessionsDir, "thread-1.jsonl"), records, "utf8");

    const writer = new RuntimeLogWriter(logsDir, { globalBytes: 1024, sessionBytes: 1024 });
    await writer.prune();

    const sessionRecords = (await fs.readFile(path.join(sessionsDir, "thread-1.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(sessionRecords.at(-1)).toMatchObject({ index: 9 });
    expect((await fs.stat(path.join(logsDir, "runtime.jsonl"))).size).toBeLessThanOrEqual(1024);
    expect((await fs.stat(path.join(sessionsDir, "thread-1.jsonl"))).size).toBeLessThanOrEqual(1024);
  });
});
