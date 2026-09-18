import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import type { BrowserOpenMode, BrowserTabRecord } from "@shared-types";

export interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  html: string;
  fetchedAt: string;
}

export type PageLoader = (target: string) => Promise<PageSnapshot>;

interface BrowserTabSession {
  record: BrowserTabRecord;
  history: PageSnapshot[];
  historyIndex: number;
  lastUsedAt: string;
}

export const MAX_BROWSER_TABS_PER_THREAD = 5;
export const MAX_BROWSER_TAB_HISTORY = 12;
export const MAX_BROWSER_PAGE_HTML_CHARS = 400_000;
export const MAX_BROWSER_PAGE_TEXT_CHARS = 80_000;

export interface BrowserTabEvictionCandidate {
  id: string;
  isActive: boolean;
  lastUsedAt: string;
  createdAt: string;
  index: number;
}

export function compactBrowserPageSnapshot(page: PageSnapshot, keepHtml = true): PageSnapshot {
  const text = page.text.length > MAX_BROWSER_PAGE_TEXT_CHARS
    ? page.text.slice(0, MAX_BROWSER_PAGE_TEXT_CHARS)
    : page.text;
  const html = !keepHtml
    ? ""
    : page.html.length > MAX_BROWSER_PAGE_HTML_CHARS
      ? page.html.slice(0, MAX_BROWSER_PAGE_HTML_CHARS)
      : page.html;
  if (text === page.text && html === page.html) return page;
  return { ...page, text, html };
}

export function retainBrowserTabHistory<T extends { history: PageSnapshot[]; historyIndex: number }>(
  session: T,
  limit = MAX_BROWSER_TAB_HISTORY
): T {
  const cap = Math.max(1, limit);
  if (session.history.length > cap) {
    const overflow = session.history.length - cap;
    session.history = session.history.slice(overflow);
    session.historyIndex = Math.max(0, session.historyIndex - overflow);
  }
  session.history = session.history.map((page, index) =>
    compactBrowserPageSnapshot(page, Math.abs(index - session.historyIndex) <= 1)
  );
  return session;
}

export function selectUnusedBrowserTabsToClose(
  tabs: BrowserTabEvictionCandidate[],
  keepIds: Iterable<string>,
  limit: number
): string[] {
  const overflow = tabs.length - limit;
  if (overflow <= 0) return [];

  const protectedIds = new Set(keepIds);
  return [...tabs]
    .filter((tab) => !protectedIds.has(tab.id))
    .sort((left, right) => {
      if (left.isActive !== right.isActive) return left.isActive ? 1 : -1;
      const used = left.lastUsedAt.localeCompare(right.lastUsedAt);
      if (used !== 0) return used;
      const created = left.createdAt.localeCompare(right.createdAt);
      if (created !== 0) return created;
      return right.index - left.index;
    })
    .slice(0, overflow)
    .map((tab) => tab.id);
}

export function resolveBrowserOpenPreferences(
  defaultOpenMode: BrowserOpenMode,
  silentBrowserOpen: boolean,
  requestedOpenMode?: BrowserOpenMode
): { browserOpenMode: BrowserOpenMode; silentBrowserOpen: boolean } {
  return {
    browserOpenMode: requestedOpenMode ?? defaultOpenMode,
    silentBrowserOpen
  };
}

export function browserTabOriginKey(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "about:") {
      return `about:${parsed.pathname || "blank"}`;
    }
    // data: URLs are opaque payloads; only exact URL reuse is safe.
    if (parsed.protocol === "data:") {
      return url;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

export function isBrowserErrorPageUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "chrome-error:";
  } catch {
    return false;
  }
}

export const DEFAULT_BROWSER_PAGE_LOAD_TIMEOUT_MS = 20_000;

export class BrowserPageLoadTimeoutError extends Error {
  public constructor(readonly timeoutMs: number) {
    super(`Web page loading timed out after ${timeoutMs}ms.`);
    this.name = "BrowserPageLoadTimeoutError";
  }
}

export function waitForBrowserPageOperation<T>(
  operation: Promise<T>,
  timeoutMs = DEFAULT_BROWSER_PAGE_LOAD_TIMEOUT_MS,
  onTimeout?: () => void
): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new BrowserPageLoadTimeoutError(timeoutMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new BrowserPageLoadTimeoutError(timeoutMs));
    }, timeoutMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class BrowserRuntime {
  readonly #tabsByThread = new Map<string, BrowserTabSession[]>();
  #usageClock = 0;

  public constructor(private readonly pageLoader: PageLoader = loadPage) {}

  public async openTab(
    threadId: string,
    target: string
  ): Promise<{ tab: BrowserTabRecord; page: PageSnapshot; reused: boolean; closedTabs: BrowserTabRecord[] }> {
    const tabs = this.#tabsByThread.get(threadId) ?? [];
    const provisionalOrigin = browserTabOriginKey(target);
    const reusable = tabs.find((session) =>
      browserTabOriginKey(session.record.url) === provisionalOrigin
    );
    if (reusable) {
      const navigated = await this.navigate(threadId, reusable.record.id, target);
      return { ...navigated, reused: true, closedTabs: [] };
    }

    const page = await this.pageLoader(target);
    const now = new Date().toISOString();
    const loadedOrigin = browserTabOriginKey(page.url);
    const reuseAfterLoad = tabs.find((session) =>
      browserTabOriginKey(session.record.url) === loadedOrigin
    );
    if (reuseAfterLoad) {
      const navigated = await this.navigate(threadId, reuseAfterLoad.record.id, target);
      return { ...navigated, reused: true, closedTabs: [] };
    }

    const tab: BrowserTabRecord = {
      id: randomUUID(),
      threadId,
      title: page.title,
      url: page.url,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };
    const session: BrowserTabSession = {
      record: tab,
      history: [page],
      historyIndex: 0,
      lastUsedAt: now
    };
    retainBrowserTabHistory(session);
    this.markTabUsed(session, now);

    for (const existing of tabs) {
      existing.record.isActive = false;
    }
    tabs.unshift(session);

    const evictedIds = new Set(selectUnusedBrowserTabsToClose(
      tabs.map((item, index) => ({
        id: item.record.id,
        isActive: item.record.isActive,
        lastUsedAt: item.lastUsedAt,
        createdAt: item.record.createdAt,
        index
      })),
      [tab.id],
      MAX_BROWSER_TABS_PER_THREAD
    ));
    const closedTabs: BrowserTabRecord[] = [];
    if (evictedIds.size > 0) {
      const remaining: BrowserTabSession[] = [];
      for (const item of tabs) {
        if (evictedIds.has(item.record.id)) {
          closedTabs.push({ ...item.record });
          continue;
        }
        remaining.push(item);
      }
      tabs.splice(0, tabs.length, ...remaining);
    }

    this.#tabsByThread.set(threadId, tabs);
    return { tab, page, reused: false, closedTabs };
  }

  public async navigate(threadId: string, tabId: string, target: string): Promise<{ tab: BrowserTabRecord; page: PageSnapshot }> {
    const session = this.requireTab(threadId, tabId);
    const page = await this.pageLoader(target);
    session.history = session.history.slice(0, session.historyIndex + 1);
    session.history.push(page);
    session.historyIndex = session.history.length - 1;
    retainBrowserTabHistory(session);
    session.record.title = page.title;
    session.record.url = page.url;
    this.markTabUsed(session);
    this.focusTab(threadId, tabId);
    return { tab: session.record, page: session.history[session.historyIndex]! };
  }

  public async reload(threadId: string, tabId: string): Promise<{ tab: BrowserTabRecord; page: PageSnapshot }> {
    const session = this.requireTab(threadId, tabId);
    const current = session.history[session.historyIndex];
    if (!current) {
      throw new Error(`Browser tab ${tabId} has no history.`);
    }
    const reloaded = await this.pageLoader(current.url);
    session.history[session.historyIndex] = reloaded;
    retainBrowserTabHistory(session);
    const page = session.history[session.historyIndex]!;
    session.record.title = page.title;
    session.record.url = page.url;
    this.markTabUsed(session);
    return { tab: session.record, page };
  }

  public goBack(threadId: string, tabId: string): { tab: BrowserTabRecord; page: PageSnapshot } {
    const session = this.requireTab(threadId, tabId);
    if (session.historyIndex === 0) {
      throw new Error("Already at the oldest history entry.");
    }
    session.historyIndex -= 1;
    retainBrowserTabHistory(session);
    const page = session.history[session.historyIndex]!;
    session.record.title = page.title;
    session.record.url = page.url;
    this.markTabUsed(session);
    return { tab: session.record, page };
  }

  public goForward(threadId: string, tabId: string): { tab: BrowserTabRecord; page: PageSnapshot } {
    const session = this.requireTab(threadId, tabId);
    if (session.historyIndex >= session.history.length - 1) {
      throw new Error("Already at the latest history entry.");
    }
    session.historyIndex += 1;
    retainBrowserTabHistory(session);
    const page = session.history[session.historyIndex]!;
    session.record.title = page.title;
    session.record.url = page.url;
    this.markTabUsed(session);
    return { tab: session.record, page };
  }

  public focusTab(threadId: string, tabId: string): BrowserTabRecord {
    const tabs = this.#tabsByThread.get(threadId) ?? [];
    let focused: BrowserTabSession | null = null;

    for (const tab of tabs) {
      tab.record.isActive = tab.record.id === tabId;
      if (tab.record.id === tabId) {
        focused = tab;
      }
    }

    if (!focused) {
      throw new Error(`Browser tab ${tabId} not found.`);
    }

    this.markTabUsed(focused);
    return focused.record;
  }

  public closeTab(threadId: string, tabId: string): BrowserTabRecord[] {
    const tabs = this.#tabsByThread.get(threadId) ?? [];
    const index = tabs.findIndex((candidate) => candidate.record.id === tabId);
    if (index === -1) {
      throw new Error(`Browser tab ${tabId} not found.`);
    }

    const [removed] = tabs.splice(index, 1);
    if (!removed) {
      return this.listTabs(threadId);
    }

    if (removed.record.isActive && tabs.length > 0) {
      const nextIndex = Math.max(0, index - 1);
      tabs.forEach((session, sessionIndex) => {
        session.record.isActive = sessionIndex === nextIndex;
      });
      const nextActive = tabs[nextIndex];
      if (nextActive) this.markTabUsed(nextActive);
    }

    this.#tabsByThread.set(threadId, tabs);
    return this.listTabs(threadId);
  }

  public listTabs(threadId: string): BrowserTabRecord[] {
    return (this.#tabsByThread.get(threadId) ?? []).map((tab) => ({ ...tab.record }));
  }

  public readPageText(threadId: string, tabId: string): { tab: BrowserTabRecord; text: string; title: string; url: string } {
    const session = this.requireTab(threadId, tabId);
    const page = session.history[session.historyIndex]!;
    return {
      tab: { ...session.record },
      text: page.text,
      title: page.title,
      url: page.url
    };
  }

  public syncTab(threadId: string, tabId: string, page: Pick<PageSnapshot, "title" | "url" | "text" | "html">): BrowserTabRecord {
    const session = this.requireTab(threadId, tabId);
    const current = session.history[session.historyIndex];
    const next: PageSnapshot = {
      title: page.title,
      url: page.url,
      text: page.text,
      html: page.html,
      fetchedAt: new Date().toISOString()
    };
    if (current) {
      session.history[session.historyIndex] = next;
    } else {
      session.history = [next];
      session.historyIndex = 0;
    }
    retainBrowserTabHistory(session);
    const retained = session.history[session.historyIndex]!;
    session.record.title = retained.title;
    session.record.url = retained.url;
    this.markTabUsed(session, retained.fetchedAt);
    return { ...session.record };
  }

  public async captureSnapshot(threadId: string, tabId: string, outputDir: string): Promise<{
    filePath: string;
    title: string;
    url: string;
    text: string;
  }> {
    const session = this.requireTab(threadId, tabId);
    const page = session.history[session.historyIndex]!;
    const safeTitle = page.title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page";
    const browserDir = path.join(outputDir, "browser");
    await fs.mkdir(browserDir, { recursive: true });
    const filePath = path.join(browserDir, `${safeTitle}-${Date.now()}.html`);
    await fs.writeFile(filePath, page.html, "utf8");
    return {
      filePath,
      title: page.title,
      url: page.url,
      text: page.text
    };
  }

  public syncPersistedTabs(threadId: string, tabs: BrowserTabRecord[]): void {
    const existing = this.#tabsByThread.get(threadId) ?? [];
    const merged = tabs.map((tab) => {
      const found = existing.find((candidate) => candidate.record.id === tab.id);
      return found ?? {
        record: { ...tab },
        history: [
          {
            title: tab.title,
            url: tab.url,
            text: "",
            html: "",
            fetchedAt: tab.updatedAt
          }
        ],
        historyIndex: 0,
        lastUsedAt: tab.updatedAt
      };
    });
    this.#tabsByThread.set(threadId, merged);
  }

  public clearThread(threadId: string): void {
    this.#tabsByThread.delete(threadId);
  }

  private markTabUsed(session: BrowserTabSession, at = new Date().toISOString()): void {
    this.#usageClock += 1;
    session.lastUsedAt = `${at}#${String(this.#usageClock).padStart(8, "0")}`;
    session.record.updatedAt = at;
  }

  private requireTab(threadId: string, tabId: string): BrowserTabSession {
    const tab = (this.#tabsByThread.get(threadId) ?? []).find((candidate) => candidate.record.id === tabId);
    if (!tab) {
      throw new Error(`Browser tab ${tabId} not found in thread ${threadId}.`);
    }
    return tab;
  }
}

export async function loadPage(
  target: string,
  options: { timeoutMs?: number } = {}
): Promise<PageSnapshot> {
  const resolved = await resolveTarget(target, options.timeoutMs ?? DEFAULT_BROWSER_PAGE_LOAD_TIMEOUT_MS);
  const html = resolved.html;
  const $ = cheerio.load(html);
  const title = $("title").text().trim() || resolved.url;
  const text = $.text().replace(/\s+/g, " ").trim() || "(no readable text)";
  return compactBrowserPageSnapshot({
    title,
    url: resolved.url,
    text,
    html,
    fetchedAt: new Date().toISOString()
  });
}

function resolveFileUrlPath(target: string): string {
  try {
    return fileURLToPath(target);
  } catch {
    // Network shares (file://host/share/...) are rejected by fileURLToPath on
    // Windows; fall back to the decoded pathname so they keep working.
    return decodeURIComponent(new URL(target).pathname);
  }
}

async function resolveTarget(target: string, timeoutMs: number): Promise<{ url: string; html: string }> {
  if (target.startsWith("file://")) {
    const html = await fs.readFile(resolveFileUrlPath(target), "utf8");
    return { url: target, html };
  }

  if (path.isAbsolute(target)) {
    const html = await fs.readFile(target, "utf8");
    return { url: pathToFileURL(target).toString(), html };
  }

  if (target.startsWith("data:")) {
    const response = await fetch(target);
    return { url: target, html: await response.text() };
  }

  const controller = new AbortController();
  return waitForBrowserPageOperation((async () => {
    const response = await fetch(target, {
      headers: {
        "user-agent": "codexh/0.1.0"
      },
      signal: controller.signal
    });
    return { url: response.url || target, html: await response.text() };
  })(), timeoutMs, () => controller.abort());
}
