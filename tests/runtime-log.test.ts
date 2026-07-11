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
});
