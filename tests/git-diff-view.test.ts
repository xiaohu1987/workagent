import { describe, expect, it } from "vitest";
import { buildSideBySideDiffRows } from "../apps/desktop/src/renderer/workspace/git-changes";
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

function hunk(lines: GitHunk["lines"]): GitHunk {
  return { id: "test-hunk", header: "@@ -1,3 +1,2 @@", lines };
}
