import { describe, expect, it } from "vitest";
import { resolveAttachmentMaxBytes } from "../apps/desktop/src/main/attachment-limits";

describe("resolveAttachmentMaxBytes", () => {
  it("keeps image attachments at the inline base64 cap", () => {
    expect(resolveAttachmentMaxBytes("image")).toBe(10 * 1024 * 1024);
  });

  it("allows video and document attachments up to 100 MB", () => {
    expect(resolveAttachmentMaxBytes("video")).toBe(100 * 1024 * 1024);
    expect(resolveAttachmentMaxBytes("file")).toBe(100 * 1024 * 1024);
  });
});
