import { describe, expect, it } from "vitest";
import {
  createToolCallFingerprint,
  getAddedPatchFiles,
  getToolCallTaskKey,
  MAX_REPEATED_TASK_FAILURES,
  parseGpaState
} from "@agent-runtime";

describe("createToolCallFingerprint", () => {
  it("stops only after five consecutive failures of the same tool task", () => {
    expect(MAX_REPEATED_TASK_FAILURES).toBe(5);
  });

  it("treats equivalent tool arguments as the same call", () => {
    expect(createToolCallFingerprint("read", { path: ".", depth: 1 })).toBe(
      createToolCallFingerprint("read", { depth: 1, path: "." })
    );
  });

  it("keeps different tools and arguments distinct", () => {
    const fingerprint = createToolCallFingerprint("read", { path: "." });

    expect(fingerprint).not.toBe(createToolCallFingerprint("read", { path: "src" }));
    expect(fingerprint).not.toBe(createToolCallFingerprint("read_file", { path: "." }));
  });

  it("groups patch retries by their target file instead of patch text", () => {
    const firstAttempt = "*** Begin Patch\n*** Add File: css/style.css\nbody {}\n*** End Patch";
    const retry = "*** Begin Patch\n*** Add File: css/style.css\n+body {}\n*** End Patch";

    expect(getToolCallTaskKey("apply_patch", { patch: firstAttempt })).toBe(
      getToolCallTaskKey("apply_patch", { patch: retry })
    );
  });

  it("identifies files created by an Add File patch", () => {
    expect(
      getAddedPatchFiles({
        patch: "*** Begin Patch\n*** Add File: js/renderer.js\n+export {}\n*** Add File: css/game.css\n+.game {}\n*** End Patch"
      })
    ).toEqual(["js/renderer.js", "css/game.css"]);
  });
});

describe("GPA access state", () => {
  it("persists full access independently from the GPA stage", () => {
    expect(
      parseGpaState(
        JSON.stringify({
          stage: "off",
          fullAccess: true,
          awaitingConfirmation: null,
          planTasks: [],
          updatedAt: "2026-01-01T00:00:00.000Z"
        })
      )
    ).toMatchObject({ stage: "off", fullAccess: true });
  });

  it("defaults full access to disabled for existing tasks", () => {
    expect(parseGpaState(null).fullAccess).toBe(false);
  });
});
