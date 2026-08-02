import type { ReactNode } from "react";
import { IconClose } from "../icons";

type ConfirmationSheetProps = {
  motionPhase?: string;
  titleId: string;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
  role?: "dialog" | "alertdialog";
  confirmVariant?: "danger" | "warm" | "primary";
  bodyClassName?: string;
  sheetClassName?: string;
  children?: ReactNode;
};

export function ConfirmationSheet({
  motionPhase,
  titleId,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  busy = false,
  role = "dialog",
  confirmVariant = "danger",
  bodyClassName = "delete-confirm-body clear-chat-confirm-body",
  sheetClassName = "delete-confirm-sheet clear-chat-confirm-sheet",
  children
}: ConfirmationSheetProps) {
  const confirmClassName = confirmVariant === "danger"
    ? "button clear-chat-danger"
    : `button ${confirmVariant}`;

  return (
    <div className="project-sheet-overlay motion-overlay" data-motion={motionPhase}>
      <div className={`project-sheet confirm-sheet ${sheetClassName}`} role={role} aria-modal="true" aria-labelledby={titleId}>
        <div className="project-sheet-header delete-confirm-header">
          <button className="project-sheet-close" type="button" onClick={onClose} title="关闭" aria-label="关闭" disabled={busy}><IconClose /></button>
        </div>
        <div className={`confirm-sheet-body ${bodyClassName}`}>
          <strong id={titleId}>{title}</strong>
          <p>{description}</p>
          {children}
        </div>
        <div className="project-sheet-actions">
          <button className="button ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className={confirmClassName} type="button" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
