import path from "node:path";
import { describe, expect, it } from "vitest";
import { isProjectAttachmentPath } from "../apps/desktop/src/main/attachment-path";

describe("isProjectAttachmentPath", () => {
  it("recognizes files within a project directory", () => {
    expect(isProjectAttachmentPath(path.join("D:", "project"), path.join("D:", "project", "src", "app.ts"))).toBe(true);
  });

  it("does not treat files outside the project as project attachments", () => {
    expect(isProjectAttachmentPath(path.join("D:", "project"), path.join("D:", "other-project", "app.ts"))).toBe(false);
    expect(isProjectAttachmentPath(path.join("D:", "project"), path.join("D:", "project-copy", "app.ts"))).toBe(false);
  });

  it("requires both a project root and an absolute file path", () => {
    expect(isProjectAttachmentPath(null, path.join("D:", "project", "app.ts"))).toBe(false);
    expect(isProjectAttachmentPath(path.join("D:", "project"), "src/app.ts")).toBe(false);
  });
});
