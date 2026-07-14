import { describe, expect, it } from "vitest";
import {
  formatGpaPlanMarkdown,
  gpaPlanHasIncompleteTasks,
  parseGpaPlanMarkdown
} from "@agent-runtime";

describe("GPA plan abandoned status", () => {
  it("does not treat abandoned plans as incomplete", () => {
    const markdown = formatGpaPlanMarkdown({
      status: "abandoned",
      threadId: "thread-1",
      tasks: [{ id: "T1", title: "left undone", done: false }],
      body: "old plan"
    });
    const parsed = parseGpaPlanMarkdown(markdown);
    expect(parsed?.status).toBe("abandoned");
    expect(gpaPlanHasIncompleteTasks(parsed)).toBe(false);
  });
});
