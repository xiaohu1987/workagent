import { createElement, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { RuntimeThreadSnapshot } from "@shared-types";
import { IconChevronDown, IconClose, IconGlobe } from "../icons";
import { WorkspaceEmptyState } from "./panels";

type BrowserTab = RuntimeThreadSnapshot["browserTabs"][number];

export function getBrowserTabLabel(tab: Pick<BrowserTab, "title" | "url">): string {
  return tab.title.trim() || tab.url;
}

type BrowserWebviewElement = HTMLElement & {
  getWebContentsId: () => number;
};

const browserWebviewRegistrars = new Map<string, () => boolean>();

function browserWebviewRegistrarKey(threadId: string, tabId: string): string {
  return `${threadId}:${tabId}`;
}

export function reregisterBrowserWebviews(threadId: string, tabId?: string): void {
  if (tabId) {
    browserWebviewRegistrars.get(browserWebviewRegistrarKey(threadId, tabId))?.();
    return;
  }
  for (const [key, register] of browserWebviewRegistrars) {
    if (key.startsWith(`${threadId}:`)) {
      register();
    }
  }
}

export const BrowserWorkspace = memo(function BrowserWorkspace({
  tabs,
  threadId,
  onCloseTab,
  visible
}: {
  tabs: RuntimeThreadSnapshot["browserTabs"];
  threadId: string | null;
  onCloseTab: (tabId: string) => void;
  visible: boolean;
}) {
  const [isPicking, setIsPicking] = useState(false);
  const [menuShift, setMenuShift] = useState(0);
  const activeTab = tabs.find((tab) => tab.isActive) ?? tabs[0];
  if (!activeTab || !threadId) {
    return visible ? <WorkspaceEmptyState icon={<IconGlobe />} title="打开网页" message="任务打开的网页会显示在这里" /> : null;
  }

  return (
    <section
      className={`browser-workspace ${visible ? "is-visible" : "is-background"} ${isPicking ? "is-picking" : ""}`}
      style={{ "--browser-tab-menu-shift": `${isPicking ? menuShift : 0}px` } as CSSProperties}
      aria-label="浏览器"
    >
      <BrowserTabSwitcher
        tabs={tabs}
        activeTab={activeTab}
        threadId={threadId}
        isOpen={isPicking}
        onOpenChange={setIsPicking}
        onMenuShiftChange={setMenuShift}
        onCloseTab={onCloseTab}
      />
      <div className="browser-location" title={activeTab.url}>{activeTab.url}</div>
      <div className="browser-page-stack">
        {tabs.filter((tab) => visible || tab.id === activeTab.id).map((tab) => (
          <BrowserTabWebview
            key={tab.id}
            tab={tab}
            threadId={threadId}
            visible={visible && tab.id === activeTab.id}
          />
        ))}
      </div>
    </section>
  );
});

function BrowserTabSwitcher({
  tabs,
  activeTab,
  threadId,
  isOpen,
  onOpenChange,
  onMenuShiftChange,
  onCloseTab
}: {
  tabs: BrowserTab[];
  activeTab: BrowserTab;
  threadId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onMenuShiftChange: (shift: number) => void;
  onCloseTab: (tabId: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onOpenChange(false);
  }, [onOpenChange, threadId]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onOpenChange]);

  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current || !fieldRef.current) {
      onMenuShiftChange(0);
      return;
    }
    const menuBox = menuRef.current.getBoundingClientRect();
    const fieldBox = fieldRef.current.getBoundingClientRect();
    const workspace = fieldRef.current.closest(".browser-workspace");
    const location = workspace?.querySelector(".browser-location");
    const locationBottom = location?.getBoundingClientRect().bottom ?? fieldBox.bottom;
    onMenuShiftChange(Math.max(0, Math.ceil(menuBox.bottom - locationBottom + 6)));
  }, [isOpen, onMenuShiftChange, tabs.length]);

  return (
    <div ref={rootRef} className={`browser-tab-switcher ${isOpen ? "is-open" : ""}`}>
      <div ref={fieldRef} className="browser-tab-switcher-field">
        <button
          type="button"
          className="browser-tab-switcher-trigger"
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label="选择网页"
          title={activeTab.url}
          onClick={() => onOpenChange(!isOpen)}
        >
          <span className="browser-tab-switcher-icon" aria-hidden><IconGlobe /></span>
          <span className="browser-tab-switcher-copy">
            <strong>{getBrowserTabLabel(activeTab)}</strong>
            <small>{tabs.length} 个网页</small>
          </span>
          <span className="browser-tab-switcher-chevron" aria-hidden><IconChevronDown /></span>
        </button>
        {isOpen ? (
          <div ref={menuRef} className="browser-tab-switcher-menu" role="listbox" aria-label="已打开的网页">
            {tabs.map((tab) => {
              const label = getBrowserTabLabel(tab);
              const selected = tab.id === activeTab.id;
              return (
                <div key={tab.id} className={`browser-tab-switcher-option ${selected ? "is-selected" : ""}`}>
                  <button
                    type="button"
                    className="browser-tab-switcher-option-main"
                    role="option"
                    aria-selected={selected}
                    title={tab.url}
                    onClick={() => {
                      if (!selected) void window.codexh.focusBrowserTab({ threadId, tabId: tab.id });
                      onOpenChange(false);
                    }}
                  >
                    <span className="browser-tab-switcher-icon" aria-hidden><IconGlobe /></span>
                    <span className="browser-tab-switcher-copy">
                      <strong>{label}</strong>
                      <small>{tab.url}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="browser-tab-switcher-option-close"
                    aria-label={`关闭 ${label}`}
                    title={`关闭 ${label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    <IconClose />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="browser-tab-switcher-close"
        aria-label={`关闭 ${getBrowserTabLabel(activeTab)}`}
        title="关闭当前网页"
        onClick={() => onCloseTab(activeTab.id)}
      >
        <IconClose />
      </button>
    </div>
  );
}

function BrowserTabWebview({
  tab,
  threadId,
  visible
}: {
  tab: RuntimeThreadSnapshot["browserTabs"][number];
  threadId: string;
  visible: boolean;
}) {
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const bindWebview = useCallback((view: BrowserWebviewElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    webviewRef.current = view;
    if (!view) return;

    const sync = () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
      }
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null;
        void window.codexh.syncBrowserWebContents({ threadId, tabId: tab.id }).catch(() => undefined);
      }, 180);
    };
    const register = () => {
      let webContentsId: number;
      try {
        webContentsId = view.getWebContentsId();
      } catch {
        return false;
      }
      if (!Number.isFinite(webContentsId) || webContentsId <= 0) {
        return false;
      }
      void window.codexh.registerBrowserWebContents({ threadId, tabId: tab.id, webContentsId })
        .then(sync)
        .catch((error) => {
          console.warn("[browser] registerBrowserWebContents failed", {
            threadId,
            tabId: tab.id,
            webContentsId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      return true;
    };

    view.addEventListener("dom-ready", register);
    view.addEventListener("did-attach", register);
    view.addEventListener("did-navigate", sync);
    view.addEventListener("did-navigate-in-page", sync);
    view.addEventListener("page-title-updated", sync);
    register();
    const registrarKey = browserWebviewRegistrarKey(threadId, tab.id);
    browserWebviewRegistrars.set(registrarKey, register);

    const poll = window.setInterval(() => {
      if (register()) {
        window.clearInterval(poll);
      }
    }, 200);
    const pollTimeout = window.setTimeout(() => window.clearInterval(poll), 20_000);

    cleanupRef.current = () => {
      browserWebviewRegistrars.delete(registrarKey);
      window.clearInterval(poll);
      window.clearTimeout(pollTimeout);
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      view.removeEventListener("dom-ready", register);
      view.removeEventListener("did-attach", register);
      view.removeEventListener("did-navigate", sync);
      view.removeEventListener("did-navigate-in-page", sync);
      view.removeEventListener("page-title-updated", sync);
    };
  }, [tab.id, threadId]);

  useEffect(() => () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  return (
    <div className={`browser-page-host ${visible ? "is-visible" : "is-background"}`}>
      {createElement("webview", {
        ref: bindWebview,
        className: "browser-frame",
        src: tab.url,
        webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes,backgroundThrottling=yes,spellcheck=no",
        title: tab.title || "任务浏览器"
      })}
    </div>
  );
}

