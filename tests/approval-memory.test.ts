import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseService } from "../apps/desktop/src/main/storage";

const tempDirs: string[] = [];
const databases: DatabaseService[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-approval-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("approval persistence", () => {
  it("stores approval resolution modes and remembered approvals", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    const approval = db.createApproval({
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolCallId: null,
      projectId: "project-1",
      title: "Run shell command",
      description: "pnpm test",
      scope: "prompt",
      riskLevel: "high",
      approvalKey: "approval-key-1",
      payloadJson: "{\"command\":\"pnpm test\"}",
      status: "pending"
    });

    db.resolveApproval(approval.id, { approved: true, resolutionMode: "remember" });

    const resolved = db.getApproval(approval.id);
    expect(resolved?.status).toBe("approved");
    expect(resolved?.resolutionMode).toBe("remember");
    expect(resolved?.resolvedAt).toBeTruthy();

    db.upsertRememberedApproval({
      projectId: "project-1",
      approvalKey: "approval-key-1",
      title: "Run shell command",
      description: "pnpm test",
      riskLevel: "high",
      payloadJson: "{\"command\":\"pnpm test\"}"
    });

    const remembered = db.findRememberedApproval("project-1", "approval-key-1");
    expect(remembered?.approvalKey).toBe("approval-key-1");
    expect(remembered?.projectId).toBe("project-1");
  });

  it("persists timeout metadata and default prompt answers", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    const approval = db.createApproval({
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolCallId: null,
      projectId: null,
      title: "Write file",
      description: "src/app.ts",
      scope: "prompt",
      riskLevel: "high",
      approvalKey: "approval-key-timeout",
      payloadJson: "{}",
      status: "pending",
      expiresAt: "2026-07-15T12:00:10.000Z"
    });
    db.resolveApproval(approval.id, { approved: false, resolutionSource: "timeout" });

    expect(db.getApproval(approval.id)).toMatchObject({
      status: "denied",
      expiresAt: "2026-07-15T12:00:10.000Z",
      resolutionSource: "timeout"
    });

    const prompt = db.createUserPrompt({
      threadId: "thread-1",
      turnRunId: "turn-1",
      title: "Run browser tests?",
      kind: "generic",
      allowSkip: false,
      questions: [{ id: "browser", label: "Browser", prompt: "Run?", options: [{ id: "run", label: "Run" }] }],
      status: "pending",
      expiresAt: "2026-07-15T12:00:10.000Z",
      defaultAnswers: { browser: "run" }
    });
    db.resolveUserPrompt(prompt.id, { browser: "run" }, "timeout");

    expect(db.getUserPrompt(prompt.id)).toMatchObject({
      expiresAt: "2026-07-15T12:00:10.000Z",
      defaultAnswers: { browser: "run" },
      resolutionSource: "timeout"
    });
  });
});

describe("context compaction persistence", () => {
  it("returns the latest compaction payload for a thread snapshot", async () => {
    const tempDir = await makeTempDir();
    const db = new DatabaseService(path.join(tempDir, "codexh.sqlite"));
    databases.push(db);

    db.addRuntimeEvent({
      type: "agent.context_compacted",
      threadId: "thread-1",
      payload: {
        turnRunId: "turn-1",
        contextWindow: 128_000,
        threshold: 0.9,
        target: 0.6,
        beforeTokens: 349_625,
        afterTokens: 38_287,
        messagesBefore: 21,
        messagesAfter: 9
      },
      createdAt: "2026-07-13T12:22:56.900Z"
    });

    expect(db.getLatestContextCompaction("thread-1")).toMatchObject({
      turnRunId: "turn-1",
      beforeTokens: 349_625,
      afterTokens: 38_287,
      messagesAfter: 9,
      createdAt: "2026-07-13T12:22:56.900Z"
    });
  });
});
