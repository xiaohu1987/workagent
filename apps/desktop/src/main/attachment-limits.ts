import type { MessageAttachment } from "@shared-types";

/**
 * Per-kind attachment import limits. Images are inlined into provider requests as base64,
 * so they keep the tighter cap; videos and other files only carry a path or an on-disk
 * copy, so they just need a sanity limit.
 */
const ATTACHMENT_MAX_BYTES: Record<MessageAttachment["kind"], number> = {
  image: 10 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  file: 100 * 1024 * 1024
};

/** Returns the maximum import size in bytes for one attachment kind. */
export function resolveAttachmentMaxBytes(kind: MessageAttachment["kind"]): number {
  return ATTACHMENT_MAX_BYTES[kind];
}
