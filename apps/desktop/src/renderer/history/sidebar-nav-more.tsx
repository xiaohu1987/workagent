import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SidebarNavItemId } from "@shared-types";
import { IconApiCard, IconFile, IconNotebook } from "../icons";
import { SIDEBAR_NAV_ITEM_LABELS } from "./sidebar-nav-items";
import "./sidebar-nav-more.css";

/** Rail icons, shared by the rail buttons and the "更多" flyout entries. */
export const SIDEBAR_NAV_ITEM_ICONS: Record<SidebarNavItemId, ReactNode> = {
  quickNotes: <IconNotebook />,
  apiFavorites: <IconApiCard />,
  documentViewer: <IconFile />
};

type SidebarNavMoreProps = {
  items: SidebarNavItemId[];
  activeItemId: SidebarNavItemId | null;
  onSelect: (id: SidebarNavItemId) => void;
};

/**
 * The tucked-away rail entries, kept deliberately quiet: a low-contrast handle
 * instead of a full rail row, because these entries are the ones the user chose
 * to hide. Hovering or focusing the handle slides the flyout out; a small dot
 * marks it only while one of the hidden entries owns the open panel. The flyout
 * is portaled to the body so the scrolling rail cannot clip it.
 */
export function SidebarNavMore({ items, activeItemId, onSelect }: SidebarNavMoreProps) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  function cancelScheduledClose() {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function scheduleClose() {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setAnchor(null);
    }, 160);
  }

  /**
   * The handle is narrow and centred inside a full-width wrapper, so the flyout
   * is anchored to the wrapper: that keeps it just outside the rail instead of
   * on top of the history list.
   */
  function openAtHandle() {
    cancelScheduledClose();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = { left: rect.right + 6, top: rect.top + rect.height / 2 };
    setAnchor((current) => (current && current.left === next.left && current.top === next.top ? current : next));
  }

  useEffect(() => cancelScheduledClose, []);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="sidebar-nav-more" ref={containerRef} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className={`sidebar-nav-more-trigger ${activeItemId ? "is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label="更多"
        title="更多"
        onMouseEnter={openAtHandle}
        onFocus={openAtHandle}
        onClick={() => (anchor ? setAnchor(null) : openAtHandle())}
      >
        <span className="sidebar-nav-more-handle" aria-hidden />
      </button>
      {anchor
        ? createPortal(
            <div
              className="gpa-popover sidebar-nav-more-menu"
              role="menu"
              style={{ left: anchor.left, top: anchor.top }}
              onMouseEnter={cancelScheduledClose}
              onMouseLeave={scheduleClose}
            >
              {items.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`gpa-popover-item ${activeItemId === id ? "is-active" : ""}`}
                  role="menuitem"
                  onClick={() => {
                    cancelScheduledClose();
                    setAnchor(null);
                    onSelect(id);
                  }}
                >
                  <span className="gpa-popover-item-icon" aria-hidden>{SIDEBAR_NAV_ITEM_ICONS[id]}</span>
                  <span className="gpa-popover-item-copy">
                    <span className="gpa-popover-item-title">{SIDEBAR_NAV_ITEM_LABELS[id]}</span>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
