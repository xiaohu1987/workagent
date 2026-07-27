import type { MessageAttachment } from "@shared-types";

export interface EditableMessageMetadata {
  attachments: MessageAttachment[];
  displayContent?: string;
}

export function parseEditableMessageMetadata(metadataJson: string | null): EditableMessageMetadata {
  if (!metadataJson) return { attachments: [] };

  try {
    const metadata = JSON.parse(metadataJson) as Record<string, unknown>;
    const attachments = Array.isArray(metadata.attachments) && metadata.attachments.every(isMessageAttachment)
      ? metadata.attachments
      : [];
    return {
      attachments,
      ...(typeof metadata.displayContent === "string" ? { displayContent: metadata.displayContent } : {})
    };
  } catch {
    return { attachments: [] };
  }
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  return typeof attachment.id === "string"
    && (attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "file")
    && typeof attachment.name === "string"
    && typeof attachment.mimeType === "string"
    && typeof attachment.absolutePath === "string"
    && typeof attachment.sizeBytes === "number"
    && Number.isFinite(attachment.sizeBytes)
    && (attachment.width === undefined || (typeof attachment.width === "number" && Number.isFinite(attachment.width)))
    && (attachment.height === undefined || (typeof attachment.height === "number" && Number.isFinite(attachment.height)))
    && (attachment.source === "user" || attachment.source === "generated");
}
