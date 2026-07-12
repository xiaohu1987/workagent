import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { BrowserTabRecord } from "@shared-types";

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
}

export class BrowserRuntime {
  readonly #tabsByThread = new Map<string, BrowserTabSession[]>();

  public constructor(private readonly pageLoader: PageLoader = loadPage) {}

  public async openTab(threadId: string, target: string): Promise<{ tab: BrowserTabRecord; page: PageSnapshot }> {
    const page = await this.pageLoader(target);
    const now = new Date().toISOString();
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
      historyIndex: 0
    };

    const tabs = this.#tabsByThread.get(threadId) ?? [];
    for (const existing of tabs) {
      existing.record.isActive = false;
      existing.record.updatedAt = now;
    }
    tabs.unshift(session);
    this.#tabsByThread.set(threadId, tabs);

    return { tab, page };
  }

  public async navigate(threadId: string, tabId: string, target: string): Promise<{ tab: BrowserTabRecord; page: PageSnapshot }> {
    const session = this.requireTab(threadId, tabId);
    const page = await this.pageLoader(target);
    session.history = session.history.slice(0, session.historyIndex + 1);
    session.history.push(page);
    session.historyIndex = session.history.length - 1;
    session.record.title = page.title;
    session.record.url = page.url;
    session.record.updatedAt = new Date().toISOString();
    this.focusTab(threadId, tabId);
    return { tab: session.record, page };
  }

  public async reload(threadId: string, tabId: string): Promise<{ tab: BrowserTabRecord; page: PageSnapshot }> {
    const session = this.requireTab(threadId, tabId);
    const current = session.history[session.historyIndex];
    if (!current) {
      throw new Error(`Browser tab ${tabId} has no history.`);
    }
    const reloaded = await this.pageLoader(current.url);
    session.history[session.historyIndex] = reloaded;
    session.record.title = reloaded.title;
    session.record.url = reloaded.url;
    session.record.updatedAt = new Date().toISOString();
    return { tab: session.record, page: reloaded };
  }

  public goBack(threadId: string, tabId: string): { tab: BrowserTabRecord; page: PageSnapshot } {
    const session = this.requireTab(threadId, tabId);
    if (session.historyIndex === 0) {
      throw new Error("Already at the oldest history entry.");
    }
    session.historyIndex -= 1;
    const page = session.history[session.historyIndex]!;
    session.record.title = page.title;
    session.record.url = page.url;
    session.record.updatedAt = new Date().toISOString();
    return { tab: session.record, page };
  }

  public goForward(threadId: string, tabId: string): { tab: BrowserTabRecord; page: PageSnapshot } {
    const session = this.requireTab(threadId, tabId);
    if (session.historyIndex >= session.history.length - 1) {
      throw new Error("Already at the latest history entry.");
    }
    session.historyIndex += 1;
    const page = session.history[session.historyIndex]!;
    session.record.title = page.title;
    session.record.url = page.url;
    session.record.updatedAt = new Date().toISOString();
    return { tab: session.record, page };
  }

  public focusTab(threadId: string, tabId: string): BrowserTabRecord {
    const tabs = this.#tabsByThread.get(threadId) ?? [];
    const now = new Date().toISOString();
    let focused: BrowserTabRecord | null = null;

    for (const tab of tabs) {
      tab.record.isActive = tab.record.id === tabId;
      tab.record.updatedAt = now;
      if (tab.record.id === tabId) {
        focused = tab.record;
      }
    }

    if (!focused) {
      throw new Error(`Browser tab ${tabId} not found.`);
    }

    return focused;
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
        session.record.updatedAt = new Date().toISOString();
      });
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
        historyIndex: 0
      };
    });
    this.#tabsByThread.set(threadId, merged);
  }

  public clearThread(threadId: string): void {
    this.#tabsByThread.delete(threadId);
  }

  private requireTab(threadId: string, tabId: string): BrowserTabSession {
    const tab = (this.#tabsByThread.get(threadId) ?? []).find((candidate) => candidate.record.id === tabId);
    if (!tab) {
      throw new Error(`Browser tab ${tabId} not found in thread ${threadId}.`);
    }
    return tab;
  }
}

export async function loadPage(target: string): Promise<PageSnapshot> {
  const resolved = await resolveTarget(target);
  const html = resolved.html;
  const $ = cheerio.load(html);
  const title = $("title").text().trim() || resolved.url;
  const text = $.text().replace(/\s+/g, " ").trim() || html;
  return {
    title,
    url: resolved.url,
    text,
    html,
    fetchedAt: new Date().toISOString()
  };
}

async function resolveTarget(target: string): Promise<{ url: string; html: string }> {
  if (target.startsWith("file://")) {
    const filePath = decodeURIComponent(new URL(target).pathname);
    const html = await fs.readFile(filePath, "utf8");
    return { url: target, html };
  }

  if (path.isAbsolute(target)) {
    const html = await fs.readFile(target, "utf8");
    return { url: new URL(`file://${target.replace(/\\/g, "/")}`).toString(), html };
  }

  if (target.startsWith("data:")) {
    const response = await fetch(target);
    return { url: target, html: await response.text() };
  }

  const response = await fetch(target, {
    headers: {
      "user-agent": "codexh/0.1.0"
    }
  });
  return { url: response.url || target, html: await response.text() };
}
