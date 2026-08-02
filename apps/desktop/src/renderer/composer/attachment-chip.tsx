import { useState } from "react";
import type { ComposerAttachment } from "../lib/conversation-utils";
import { useMotionPresence } from "../motion-presence";
import { IconClose, IconCode, IconFile, IconFolder, IconImage, IconMcp, IconSkills } from "../icons";
import { MessageMediaLightbox, type MessageMediaPreview } from "../markdown";

export function ComposerAttachmentChip({
  attachment,
  removing,
  onRemove
}: {
  attachment: ComposerAttachment;
  removing?: boolean;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState<MessageMediaPreview | null>(null);
  const previewPresence = useMotionPresence(preview);
  const visiblePreview = preview ?? previewPresence.value;
  const detail =
    attachment.kind === "code"
      ? `${attachment.path} · ${attachment.content.split(/\r?\n/).length} 行`
      : attachment.kind === "skill" || attachment.kind === "mcp" || attachment.kind === "database"
        ? attachment.description
        : attachment.kind === "folder"
          ? "文件夹"
          : attachment.kind === "image"
            ? "图片"
            : "文件";
  const icon =
    attachment.kind === "folder" ? <IconFolder />
      : attachment.kind === "code" ? <IconCode />
        : attachment.kind === "image" ? <IconImage />
          : attachment.kind === "skill" ? <IconSkills />
          : attachment.kind === "mcp" || attachment.kind === "database" ? <IconMcp />
            : <IconFile />;

  async function previewImage() {
    if (attachment.kind !== "image") return;
    const source = attachment.previewUrl
      ?? (attachment.path
        ? await window.codexh.previewLocalImage({ absolutePath: attachment.path }).catch(() => null)
        : null);
    if (!source) return;
    setPreview({
      source,
      name: attachment.label,
      kind: "image",
      ...(attachment.path ? { localPath: attachment.path } : {})
    });
  }

  return (
    <div
      className={`composer-attachment-chip ${attachment.kind} ${removing ? "is-removing" : ""}`}
      title={attachment.kind === "code" ? attachment.content : attachment.kind === "skill" || attachment.kind === "mcp" || attachment.kind === "database" ? attachment.description : attachment.path}
    >
      {attachment.kind === "image" ? (
        <button className="composer-attachment-preview" type="button" title={`查看原图：${attachment.label}`} aria-label={`查看原图：${attachment.label}`} onClick={() => void previewImage()}>
          <span className="composer-attachment-icon" aria-hidden="true">{icon}</span>
          {attachment.previewUrl ? <img className="composer-attachment-thumbnail" src={attachment.previewUrl} alt="" /> : null}
          <span className="composer-attachment-copy"><strong><span>{attachment.label}</span></strong><small>{detail}</small></span>
        </button>
      ) : (
        <>
          <span className="composer-attachment-icon" aria-hidden="true">{icon}</span>
          <span className="composer-attachment-copy">
            <strong><span>{attachment.label}</span>{attachment.kind === "skill" ? <em className="composer-attachment-kind">Skill</em> : null}</strong>
            <small>{detail}</small>
          </span>
        </>
      )}
      <button className="composer-attachment-remove" type="button" title="移除" aria-label={`移除 ${attachment.label}`} onClick={onRemove}>
        <IconClose />
      </button>
      {visiblePreview ? <MessageMediaLightbox preview={visiblePreview} motionPhase={previewPresence.phase} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
