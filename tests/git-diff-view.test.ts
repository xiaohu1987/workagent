import { describe, expect, it } from "vitest";
import { buildSideBySideDiffRows, runOneClickGitCommit } from "../apps/desktop/src/renderer/workspace/git-changes";
import type { GitHunk } from "../packages/shared-types/src";

describe("buildSideBySideDiffRows", () => {
  it("shows context on both sides and aligns replacement runs", () => {
    const rows = buildSideBySideDiffRows(hunk([
      { kind: "context", content: "same", oldLine: 1, newLine: 1 },
      { kind: "removed", content: "old one", oldLine: 2, newLine: null },
      { kind: "removed", content: "old two", oldLine: 3, newLine: null },
      { kind: "added", content: "new one", oldLine: null, newLine: 2 }
    ]));

    expect(rows).toEqual([
      { oldLine: 1, oldContent: "same", oldKind: "context", newLine: 1, newContent: "same", newKind: "context" },
      { oldLine: 2, oldContent: "old one", oldKind: "removed", newLine: 2, newContent: "new one", newKind: "added" },
      { oldLine: 3, oldContent: "old two", oldKind: "removed", newLine: null, newContent: "", newKind: "empty" }
    ]);
  });

  it("uses an empty opposite cell for added-only and removed-only runs", () => {
    const addedRows = buildSideBySideDiffRows(hunk([
      { kind: "added", content: "new", oldLine: null, newLine: 4 }
    ]));
    const removedRows = buildSideBySideDiffRows(hunk([
      { kind: "removed", content: "old", oldLine: 7, newLine: null }
    ]));

    expect(addedRows[0]).toMatchObject({ oldLine: null, oldKind: "empty", newLine: 4, newKind: "added" });
    expect(removedRows[0]).toMatchObject({ oldLine: 7, oldKind: "removed", newLine: null, newKind: "empty" });
  });
});

describe("runOneClickGitCommit", () => {
  it("stages, commits, pushes, and reports completion in order", async () => {
    const calls: string[] = [];
    const progress: number[] = [];
    const onCommitted = () => calls.push("clear-message");

    const result = await runOneClickGitCommit({
      hasUnstagedFiles: true,
      stageAll: async () => actionResult("staged", calls),
      commit: async () => actionResult("committed", calls),
      push: async () => actionResult("pushed", calls),
      onProgress: (value) => progress.push(value.percent),
      onCommitted
    });

    expect(result).toMatchObject({ ok: true, message: "已提交并推送" });
    expect(calls).toEqual(["staged", "committed", "clear-message", "pushed"]);
    expect(progress).toEqual([12, 45, 76, 100]);
  });

  it("stops when staging fails and does not clear the commit message", async () => {
    const calls: string[] = [];
    const onCommitted = () => calls.push("clear-message");

    const result = await runOneClickGitCommit({
      hasUnstagedFiles: true,
      stageAll: async () => actionResult("stage-failed", calls, false),
      commit: async () => actionResult("committed", calls),
      push: async () => actionResult("pushed", calls),
      onProgress: () => undefined,
      onCommitted
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["stage-failed"]);
  });

  it("clears the message after a successful commit even when pushing fails", async () => {
    const calls: string[] = [];
    const progress: string[] = [];

    const result = await runOneClickGitCommit({
      hasUnstagedFiles: false,
      stageAll: async () => actionResult("staged", calls),
      commit: async () => actionResult("committed", calls),
      push: async () => actionResult("push-failed", calls, false),
      onProgress: (value) => progress.push(`${value.state}:${value.percent}`),
      onCommitted: () => calls.push("clear-message")
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["committed", "clear-message", "push-failed"]);
    expect(progress).toEqual(["running:45", "running:76", "error:76"]);
  });
});

function hunk(lines: GitHunk["lines"]): GitHunk {
  return { id: "test-hunk", header: "@@ -1,3 +1,2 @@", lines };
}

function actionResult(message: string, calls: string[], ok = true) {
  calls.push(message);
  return {
    ok,
    message,
    snapshot: {
      available: true,
      ahead: 0,
      behind: 0,
      branches: ["main"],
      canCreatePullRequest: false,
      files: []
    }
  };
}
