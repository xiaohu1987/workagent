import { describe, expect, it } from "vitest";
import { getLiveEditWriteTargets } from "../apps/desktop/src/main/live-edit-preview-utils";
import { LiveEditPreviewQueue } from "../apps/desktop/src/main/live-edit-preview-queue";

describe("live edit preview targets", () => {
  it("returns the fs.write_file path", () => {
    expect(getLiveEditWriteTargets({
      toolName: "fs.write_file",
      argumentsJson: JSON.stringify({ filePath: "apps/desktop/src/main/index.ts" })
    })).toEqual(["apps/desktop/src/main/index.ts"]);
  });

  it("returns unique apply_patch targets in patch order", () => {
    expect(getLiveEditWriteTargets({
      toolName: "apply_patch",
      argumentsJson: JSON.stringify({
        patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n@@\n*** Update File: src/a.ts\n*** End Patch"
      })
    })).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns the search_replace target", () => {
    expect(getLiveEditWriteTargets({
      toolName: "search_replace",
      argumentsJson: JSON.stringify({ file_path: "src/app.ts", old_string: "old", new_string: "new" })
    })).toEqual(["src/app.ts"]);
  });

  it("ignores malformed payloads and non-write tools", () => {
    expect(getLiveEditWriteTargets({ toolName: "apply_patch", argumentsJson: "not json" })).toEqual([]);
    expect(getLiveEditWriteTargets({ toolName: "shell.exec", argumentsJson: JSON.stringify({ path: "src/a.ts" }) })).toEqual([]);
  });
});

describe("live edit preview queue", () => {
  it("keeps patch targets in order and closes after their final acknowledgement", () => {
    const queue = new LiveEditPreviewQueue();
    queue.start({ toolCallId: "patch-1", threadId: "thread-1", paths: ["src/a.ts", "src/b.ts"] });
    expect(queue.current?.paths[queue.current.pathIndex]).toBe("src/a.ts");

    expect(queue.acknowledge("patch-1", "src/a.ts")?.pathIndex).toBe(0);
    queue.complete("patch-1");
    expect(queue.acknowledge("patch-1", "src/a.ts")?.paths[1]).toBe("src/b.ts");
    expect(queue.current?.pathIndex).toBe(1);
    expect(queue.acknowledge("patch-1", "src/b.ts")).toBeNull();
    expect(queue.size).toBe(0);
  });

  it("does not let a queued write replace the active write", () => {
    const queue = new LiveEditPreviewQueue();
    queue.start({ toolCallId: "first", threadId: "thread-1", paths: ["src/a.ts"] });
    queue.start({ toolCallId: "second", threadId: "thread-1", paths: ["src/b.ts"] });
    queue.complete("second");
    queue.complete("first");

    expect(queue.acknowledge("first", "src/a.ts")?.toolCallId).toBe("second");
    expect(queue.current?.completed).toBe(true);
  });
});
