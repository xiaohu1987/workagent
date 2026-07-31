import { useEffect } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconPlus, IconClose } from "../icons";

export type ResizePane = "sidebar" | "right-workspace";

export type WorkspaceContextMenuAction = {
  id: string;
  label: string;
  icon: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
};

export function PanelResizeHandle({
  pane,
  active,
  onPointerDown
}: {
  pane: ResizePane;
  active: boolean;
  onPointerDown: () => void;
}) {
  return (
    <div
      className={`panel-resize-handle ${pane} ${active ? "is-active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={pane === "sidebar" ? "调整侧边栏宽度" : "调整右侧工作区宽度"}
      onPointerDown={(event) => {
        event.preventDefault();
        onPointerDown();
      }}
    />
  );
}

export function WorkspaceAccordionSection({
  active,
  id,
  label,
  badge,
  icon,
  children,
  onClick
}: {
  active: boolean;
  id: string;
  label: string;
  badge?: number;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  const contentId = `right-workspace-${id}`;

  return (
    <section className={`right-workspace-accordion-section ${active ? "active" : ""}`}>
      <button
        type="button"
        className="right-workspace-tab"
        aria-expanded={active}
        aria-controls={contentId}
        onClick={onClick}
      >
        {icon}
        <span className="right-workspace-tab-label">{label}</span>
        {badge ? <span className="right-workspace-tab-badge">{badge > 99 ? "99+" : badge}</span> : null}
        <span className="right-workspace-tab-chevron" aria-hidden="true"><IconChevronDown /></span>
      </button>
      <div id={contentId} className="right-workspace-accordion-content" aria-hidden={!active} inert={!active}>
        {children}
      </div>
    </section>
  );
}

export function WorkspaceSubtabStrip({
  items,
  addLabel,
  onAdd
}: {
  items: Array<{
    id: string;
    label: string;
    title?: string;
    active: boolean;
    icon: ReactNode;
    onClick: () => void;
    onClose?: () => void;
  }>;
  addLabel?: string;
  onAdd?: () => void;
}) {
  return (
    <div className="workspace-subtab-strip" role="tablist">
      {items.map((item) => (
        <div key={item.id} className={`workspace-subtab ${item.active ? "active" : ""}`} title={item.title}>
          <button
            type="button"
            className="workspace-subtab-main"
            role="tab"
            aria-selected={item.active}
            onClick={item.onClick}
          >
            <span className="workspace-subtab-icon" aria-hidden="true">{item.icon}</span>
            <span className="workspace-subtab-label">{item.label}</span>
          </button>
          {item.onClose ? (
            <button
              type="button"
              className="workspace-subtab-close"
              aria-label={`关闭 ${item.label}`}
              title={`关闭 ${item.label}`}
              onClick={(event) => {
                event.stopPropagation();
                item.onClose?.();
              }}
            >
              <IconClose />
            </button>
          ) : null}
        </div>
      ))}
      {onAdd ? (
        <button type="button" className="workspace-subtab-add" title={addLabel} aria-label={addLabel} onClick={onAdd}>
          <IconPlus />
        </button>
      ) : null}
    </div>
  );
}

export function WorkspaceContextMenu({
  x,
  y,
  actions,
  motionPhase,
  onClose
}: {
  x: number;
  y: number;
  actions: WorkspaceContextMenuAction[];
  motionPhase?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    // Defer so the opening right-click's pointerdown does not instantly dismiss the menu.
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", close);
    }, 0);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 188);
  const top = Math.min(y, window.innerHeight - Math.max(54, actions.length * 38 + 12));

  return createPortal(
    <div
      className="workspace-context-menu"
      data-motion={motionPhase}
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          onClick={() => {
            action.onSelect();
            onClose();
          }}
        >
          <span aria-hidden="true">{action.icon}</span>
          {action.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

export function WorkspaceEmptyState({ icon, title, message }: { icon: ReactNode; title: string; message: string }) {
  return (
    <div className="right-workspace-empty-state">
      <span aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}
