import { BrowserWindow, screen } from "electron";
import type { RuntimeEvent, RuntimeLogEntry, RuntimeLogPage } from "@shared-types";

type Options = {
  getMainWindow: () => BrowserWindow | null;
  getTheme: () => "light" | "dark" | "system";
  getLogEntries: (threadId: string, limit?: number) => Promise<RuntimeLogPage>;
  getLogUrl: (threadId: string) => Promise<string>;
  preloadPath: string;
};

const LOG_WINDOW_WIDTH = 640;
const LOG_WINDOW_HEIGHT = 760;

export class ConversationLogWindow {
  #window: BrowserWindow | null = null;
  #loadingWindow: Promise<BrowserWindow> | null = null;
  #activeThreadId: string | null = null;
  #historyLimit = 300;
  #ready = false;
  readonly #options: Options;

  public constructor(options: Options) {
    this.#options = options;
  }

  public show(threadId: string | null): void {
    if (!threadId) return;
    this.#activeThreadId = threadId;
    this.#historyLimit = 300;
    void this.#ensureWindow().then((window) => {
      if (window.isDestroyed()) return;
      this.#positionNearMainWindow();
      if (!window.isVisible()) window.show();
      window.focus();
      if (this.#ready) void this.#sendHistory();
    });
  }

  public setActiveThread(threadId: string | null): void {
    if (!threadId || !this.#window || this.#window.isDestroyed()) return;
    this.#activeThreadId = threadId;
    this.#historyLimit = 300;
    if (this.#ready) void this.#sendHistory();
  }

  public markReady(): void {
    this.#ready = true;
    void this.#sendHistory();
  }

  public handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type !== "runtime.log") return;
    const entry = event.payload?.entry as RuntimeLogEntry | undefined;
    if (!entry || entry.threadId !== this.#activeThreadId) return;
    this.#send({ kind: "entry", entry });
  }

  public close(): void {
    this.#window?.close();
  }

  public destroy(): void {
    this.#window?.destroy();
    this.#window = null;
    this.#loadingWindow = null;
    this.#ready = false;
    this.#activeThreadId = null;
  }

  async #sendHistory(): Promise<void> {
    const threadId = this.#activeThreadId;
    if (!threadId || !this.#ready) return;
    const page = await this.#options.getLogEntries(threadId, this.#historyLimit);
    if (threadId !== this.#activeThreadId) return;
    this.#send({ kind: "history", threadId, ...page });
  }

  async #ensureWindow(): Promise<BrowserWindow> {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    if (this.#loadingWindow) return this.#loadingWindow;

    this.#loadingWindow = (async () => {
      const logWindow = new BrowserWindow({
        width: LOG_WINDOW_WIDTH,
        height: LOG_WINDOW_HEIGHT,
        minWidth: 440,
        minHeight: 420,
        show: false,
        title: "LLM 实时日志",
        backgroundColor: this.#options.getTheme() === "light" ? "#ffffff" : "#090d13",
        webPreferences: {
          preload: this.#options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false
        }
      });
      this.#window = logWindow;
      this.#ready = false;
      logWindow.on("closed", () => {
        if (this.#window === logWindow) {
          this.#window = null;
          this.#ready = false;
        }
      });
      await logWindow.loadURL(await this.#options.getLogUrl(this.#activeThreadId ?? ""));
      return logWindow;
    })();

    try {
      return await this.#loadingWindow;
    } finally {
      this.#loadingWindow = null;
    }
  }

  #positionNearMainWindow(): void {
    const logWindow = this.#window;
    const mainWindow = this.#options.getMainWindow();
    if (!logWindow || logWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
    const mainBounds = mainWindow.getBounds();
    const workArea = screen.getDisplayMatching(mainBounds).workArea;
    const rightX = mainBounds.x + mainBounds.width + 12;
    const leftX = mainBounds.x - LOG_WINDOW_WIDTH - 12;
    const fitsRight = rightX + LOG_WINDOW_WIDTH <= workArea.x + workArea.width;
    const x = fitsRight
      ? rightX
      : leftX >= workArea.x
        ? leftX
        : Math.max(workArea.x, workArea.x + workArea.width - LOG_WINDOW_WIDTH);
    const y = Math.max(workArea.y, Math.min(mainBounds.y, workArea.y + workArea.height - LOG_WINDOW_HEIGHT));
    logWindow.setPosition(x, y);
  }

  #send(payload: object): void {
    if (!this.#window || this.#window.isDestroyed() || !this.#ready) return;
    this.#window.webContents.send("conversation-log-window:event", payload);
  }
}
