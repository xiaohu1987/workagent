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
});
