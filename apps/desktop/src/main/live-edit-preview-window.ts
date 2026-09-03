import { BrowserWindow, screen } from "electron";
import { LiveEditPreviewQueue, type LiveEditPreviewSession } from "./live-edit-preview-queue";

export type { LiveEditPreviewSession } from "./live-edit-preview-queue";

type Options = {
  getMainWindow: () => BrowserWindow | null;
  getTheme: () => "light" | "dark" | "system";
  getPreviewUrl: () => Promise<string>;
  preloadPath: string;
};

const PREVIEW_WIDTH = 380;
const PREVIEW_GAP = 8;

export class LiveEditPreviewWindow {
  #activeRootThreadId: string | null = null;
  #previewWindow: BrowserWindow | null = null;
  #queue = new LiveEditPreviewQueue();
  #loadingWindow: Promise<BrowserWindow> | null = null;
  #previewReady = false;
  #options: Options;

  constructor(options: Options) {
    this.#options = options;
  }

  setActiveRootThread(threadId: string | null): void {
    if (this.#activeRootThreadId !== threadId) this.clear();
    this.#activeRootThreadId = threadId;
  }

  matchesActiveThread(threadId?: string, notificationThreadId?: string): boolean {
    return Boolean(this.#activeRootThreadId && (threadId === this.#activeRootThreadId || notificationThreadId === this.#activeRootThreadId));
  }

  start(session: LiveEditPreviewSession): void {
    this.#queue.start(session);
    void this.#showCurrent();
  }

  complete(toolCallId: string): void {
    const current = this.#queue.complete(toolCallId);
    if (current) {
      this.#send({ kind: "complete", toolCallId });
    }
  }

  acknowledgePath(toolCallId: string, path: string): void {
    const next = this.#queue.acknowledge(toolCallId, path);
    if (!next) {
      this.#previewWindow?.hide();
      return;
    }
    void this.#showCurrent();
  }

  reposition(): void {
    const mainWindow = this.#options.getMainWindow();
    const previewWindow = this.#previewWindow;
    if (!mainWindow || !previewWindow || previewWindow.isDestroyed()) return;

    const mainBounds = mainWindow.getBounds();
    const workArea = screen.getDisplayMatching(mainBounds).workArea;
    const rightX = mainBounds.x + mainBounds.width + PREVIEW_GAP;
    const leftX = mainBounds.x - PREVIEW_WIDTH - PREVIEW_GAP;
    const fitsRight = rightX + PREVIEW_WIDTH <= workArea.x + workArea.width;
    const x = fitsRight ? rightX : leftX >= workArea.x ? leftX : Math.max(workArea.x, workArea.x + workArea.width - PREVIEW_WIDTH);
    const y = Math.max(workArea.y, Math.min(mainBounds.y, workArea.y + workArea.height - mainBounds.height));
    const height = Math.min(mainBounds.height, workArea.height);
    previewWindow.setBounds({ x, y, width: PREVIEW_WIDTH, height });
  }

  hide(): void {
    this.#previewWindow?.hide();
  }

  show(): void {
    void this.#showCurrent();
  }

  markReady(): void {
    this.#previewReady = true;
    void this.#showCurrent();
  }

  clear(): void {
    this.#queue.clear();
    this.#previewWindow?.hide();
  }

  destroy(): void {
    this.#queue.clear();
    this.#previewWindow?.destroy();
    this.#previewWindow = null;
    this.#previewReady = false;
  }

  async #showCurrent(): Promise<void> {
    if (!this.#queue.current) return;
    const mainWindow = this.#options.getMainWindow();
    if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
    const window = await this.#ensureWindow();
    const current = this.#queue.current;
    if (window.isDestroyed() || !current || !this.#previewReady) return;
    this.reposition();
    if (!window.isVisible()) window.showInactive();
    this.#send({
      kind: "show",
      toolCallId: current.toolCallId,
      threadId: current.threadId,
      path: current.paths[current.pathIndex],
      completed: current.completed
    });
    if (current.completed) this.#send({ kind: "complete", toolCallId: current.toolCallId });
  }

  async #ensureWindow(): Promise<BrowserWindow> {
    if (this.#previewWindow && !this.#previewWindow.isDestroyed()) return this.#previewWindow;
    if (this.#loadingWindow) return this.#loadingWindow;

    this.#loadingWindow = (async () => {
      const mainWindow = this.#options.getMainWindow();
      const previewWindow = new BrowserWindow({
        width: PREVIEW_WIDTH,
        height: Math.max(480, mainWindow?.getBounds().height ?? 720),
        frame: false,
        resizable: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: this.#options.getTheme() === "light" ? "#ffffff" : "#0b0c0e",
        parent: mainWindow ?? undefined,
        webPreferences: {
          preload: this.#options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      });
      this.#previewWindow = previewWindow;
      this.#previewReady = false;
      previewWindow.on("closed", () => {
        if (this.#previewWindow === previewWindow) {
          this.#previewWindow = null;
          this.#previewReady = false;
        }
      });
      await previewWindow.loadURL(await this.#options.getPreviewUrl());
      return previewWindow;
    })();

    try {
      return await this.#loadingWindow;
    } finally {
      this.#loadingWindow = null;
    }
  }

  #send(payload: object): void {
    const previewWindow = this.#previewWindow;
    if (!previewWindow || previewWindow.isDestroyed()) return;
    previewWindow.webContents.send("live-edit-preview:event", payload);
  }
}
