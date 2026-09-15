import { createPortal } from "react-dom";
import { IconTrash } from "../icons";

type Props = {
  active: boolean;
  hot: boolean;
  swallowing: boolean;
  label: string;
  detail: string;
  ghostX: number;
  ghostY: number;
  trashRef: { current: HTMLDivElement | null };
};

export function HistoryTrashOverlay({
  active,
  hot,
  swallowing,
  label,
  detail,
  ghostX,
  ghostY,
  trashRef
}: Props) {
  if (typeof document === "undefined" || !active) return null;

  return createPortal(
    <div
      className={`history-trash-overlay ${hot ? "is-hot" : ""} ${swallowing ? "is-swallowing" : ""}`}
      aria-hidden="true"
    >
      <div className="history-trash-wash" />
      <div
        ref={trashRef}
        className={`history-trash-drop ${hot ? "is-hot" : ""} ${swallowing ? "is-swallowing" : ""}`}
      >
        <HistoryTrashCan open={hot || swallowing} />
        <strong>{hot || swallowing ? "松手即可丢进垃圾桶" : "拖到这里删除"}</strong>
        <span>不会立刻删除，松手后会再确认一次</span>
      </div>
      <div
        className={`history-trash-ghost ${swallowing ? "is-swallowing" : ""}`}
        style={{ left: ghostX, top: ghostY }}
      >
        <span className="history-trash-ghost-icon" aria-hidden="true"><IconTrash /></span>
        <span className="history-trash-ghost-copy">
          <span className="history-trash-ghost-label">{label}</span>
          <small>{detail}</small>
        </span>
      </div>
    </div>,
    document.body
  );
}

function HistoryTrashCan({ open }: { open: boolean }) {
  return (
    <svg className={`history-trash-can ${open ? "is-open" : ""}`} viewBox="0 0 96 96" aria-hidden="true">
      <g className="history-trash-lid">
        <rect x="36" y="8" width="24" height="8" rx="3" />
        <rect x="20" y="16" width="56" height="10" rx="4" />
      </g>
      <path className="history-trash-body" d="M26 32h44l-5 50H31L26 32Z" />
      <path className="history-trash-ribs" d="M40 42v28M48 42v28M56 42v28" />
    </svg>
  );
}
