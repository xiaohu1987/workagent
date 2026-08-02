import { createElement, useCallback, useEffect, useRef } from "react";
import type { RuntimeThreadSnapshot } from "@shared-types";
import { IconGlobe } from "../icons";
import { WorkspaceEmptyState, WorkspaceSubtabStrip } from "./panels";
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

export function BrowserWorkspace({
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
  const activeTab = tabs.find((tab) => tab.isActive) ?? tabs[0];
  if (!activeTab || !threadId) {
    return visible ? <WorkspaceEmptyState icon={<IconGlobe />} title="打开网页" message="任务打开的网页会显示在这里" /> : null;
  }

  return (
    <section className={`browser-workspace ${visible ? "is-visible" : "is-background"}`} aria-label="浏览器">
      <WorkspaceSubtabStrip
        items={tabs.map((tab) => ({
          id: tab.id,
          label: tab.title || tab.url,
          title: tab.url,
          active: tab.id === activeTab.id,
          icon: <IconGlobe />,
          onClick: () => void window.codexh.focusBrowserTab({ threadId, tabId: tab.id }),
          onClose: () => onCloseTab(tab.id)
        }))}
      />
      <div className="browser-location" title={activeTab.url}>{activeTab.url}</div>
      <div className="browser-page-stack">
        {tabs.map((tab) => (
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
        webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
        title: tab.title || "任务浏览器"
      })}
    </div>
  );
}

