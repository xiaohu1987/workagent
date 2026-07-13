import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserRuntime } from "@browser-runtime";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-browser-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("BrowserRuntime", () => {
  it("opens tabs, navigates, and supports history", async () => {
    const browser = new BrowserRuntime();
    const threadId = "thread-1";
    const first = await browser.openTab(
      threadId,
      "data:text/html,<html><head><title>First</title></head><body>Hello one</body></html>"
    );

    expect(first.tab.title).toBe("First");
    expect(browser.listTabs(threadId)).toHaveLength(1);

    const navigated = await browser.navigate(
      threadId,
      first.tab.id,
      "data:text/html,<html><head><title>Second</title></head><body>Hello two</body></html>"
    );
    expect(navigated.tab.title).toBe("Second");

    const back = browser.goBack(threadId, first.tab.id);
    expect(back.page.title).toBe("First");

    const forward = browser.goForward(threadId, first.tab.id);
    expect(forward.page.title).toBe("Second");
  });

  it("captures an HTML snapshot artifact payload", async () => {
    const browser = new BrowserRuntime();
    const threadId = "thread-2";
    const dir = await makeTempDir();
    const opened = await browser.openTab(
      threadId,
      "data:text/html,<html><head><title>Snapshot</title></head><body>capture me</body></html>"
    );

    const snapshot = await browser.captureSnapshot(threadId, opened.tab.id, dir);
    const html = await fs.readFile(snapshot.filePath, "utf8");

    expect(snapshot.filePath.endsWith(".html")).toBe(true);
    expect(html).toContain("capture me");
  });

  it("closes task tabs while preserving tabs that were already open", async () => {
    const browser = new BrowserRuntime();
    const threadId = "thread-cleanup";
    const existing = await browser.openTab(
      threadId,
      "data:text/html,<html><head><title>User tab</title></head><body>keep</body></html>"
    );
    const taskTab = await browser.openTab(
      threadId,
      "data:text/html,<html><head><title>Agent tab</title></head><body>release</body></html>"
    );

    browser.closeTab(threadId, taskTab.tab.id);

    expect(browser.listTabs(threadId).map((tab) => tab.id)).toEqual([existing.tab.id]);
    expect(browser.listTabs(threadId)[0]?.isActive).toBe(true);
  });
});
