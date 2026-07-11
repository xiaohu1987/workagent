import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopBackend } from "./app";

let mainWindow: BrowserWindow | null = null;
let rendererServer: http.Server | null = null;
const backend = new DesktopBackend();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sessionDataDir = path.join(app.getPath("userData"), "session-data");
const hasSingleInstanceLock = app.requestSingleInstanceLock();

app.setPath("sessionData", sessionDataDir);

process.on("unhandledRejection", (reason) => {
  console.error("[main] Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[main] Uncaught exception", error);
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
  });
}

async function createWindow(): Promise<void> {
  await backend.initialize();
  const workArea = screen.getPrimaryDisplay().workArea;
  const preferredWidth = 1212;
  const preferredHeight = 767;
  const horizontalMargin = Math.max(72, Math.floor(workArea.width * 0.04));
  const verticalMargin = Math.max(72, Math.floor(workArea.height * 0.07));
  const availableWidth = Math.max(960, workArea.width - horizontalMargin * 2);
  const availableHeight = Math.max(640, workArea.height - verticalMargin * 2);
  const windowWidth = Math.min(preferredWidth, availableWidth);
  const windowHeight = Math.min(preferredHeight, availableHeight);
  const minWidth = Math.min(960, windowWidth);
  const minHeight = Math.min(640, windowHeight);
  const windowX = workArea.x + Math.max(0, Math.floor((workArea.width - windowWidth) / 2));
  const windowY = workArea.y + Math.max(0, Math.floor((workArea.height - windowHeight) / 2));

  mainWindow = new BrowserWindow({
    x: windowX,
    y: windowY,
    width: windowWidth,
    height: windowHeight,
    minWidth,
    minHeight,
    autoHideMenuBar: true,
    backgroundColor: "#09090a",
    title: "codexh",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#09090a",
      symbolColor: "#f3f4f6",
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  backend.onEvent((event) => {
    mainWindow?.webContents.send("runtime:event", event);
  });

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);
  registerIpc();
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[renderer] Failed to load", { errorCode, errorDescription, validatedURL });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[renderer] Render process gone", details);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadURL(await ensureRendererServerUrl());
  }

  mainWindow.webContents.setZoomFactor(0.9);
}

function reportStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";
  const detail = `${message}${stack}`;

  console.error("[main] Failed to launch codexh", detail);

  if (app.isReady()) {
    dialog.showErrorBox("codexh 启动失败", detail);
  }

  app.exit(1);
}

function registerIpc(): void {
  ipcMain.handle("threads:list", () => backend.listThreads());
  ipcMain.handle("threads:create", (_event, payload) => backend.createThread(payload));
  ipcMain.handle("projects:choose-directory", async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      defaultPath: defaultPath || undefined,
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("attachments:choose-files", async (_event, payload?: { imagesOnly?: boolean }) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: payload?.imagesOnly
        ? [
            { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
            { name: "所有文件", extensions: ["*"] }
          ]
        : [{ name: "所有文件", extensions: ["*"] }]
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("projects:list-files", (_event, threadId: string) => backend.listProjectFiles(threadId));
  ipcMain.handle("projects:read-file", (_event, payload: { threadId: string; path: string }) =>
    backend.readProjectFile(payload.threadId, payload.path)
  );
  ipcMain.handle("threads:delete", (_event, threadId: string) => backend.deleteThread(threadId));
  ipcMain.handle("threads:snapshot", (_event, threadId: string) => backend.getThreadSnapshot(threadId));
  ipcMain.handle("threads:send", (_event, payload) => backend.sendMessage(payload.threadId, payload.content));
  ipcMain.handle("threads:interrupt", (_event, threadId: string) => backend.interruptThread(threadId));
  ipcMain.handle("threads:update-model", (_event, payload) =>
    backend.updateThreadModelSelection(payload.threadId, payload.providerId, payload.modelId)
  );
  ipcMain.handle("threads:add-skill", (_event, payload: { threadId: string; skillId: string }) =>
    backend.addThreadSkill(payload.threadId, payload.skillId)
  );
  ipcMain.handle("terminal:open", (_event, payload: { threadId: string; sessionId?: string }) =>
    backend.openTerminal(payload.threadId, payload.sessionId)
  );
  ipcMain.handle("terminal:write", (_event, payload: { threadId: string; input: string; sessionId?: string }) =>
    backend.writeTerminal(payload.threadId, payload.input, payload.sessionId)
  );
  ipcMain.handle("terminal:close", (_event, payload: { threadId: string; sessionId?: string }) =>
    backend.closeTerminal(payload.threadId, payload.sessionId)
  );
  ipcMain.handle("shell:open-external", (_event, url: string) => shell.openExternal(url));
  ipcMain.handle("shell:open-path", (_event, targetPath: string) => {
    if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
      return "无效的本地路径。";
    }
    return shell.openPath(targetPath);
  });
  ipcMain.handle("skills:list", async (_event, cwd?: string | null) => {
    await backend.reloadSkills(cwd);
    return backend.listSkills();
  });
  ipcMain.handle("plugins:list", () => backend.listPlugins());
  ipcMain.handle("plugins:install", (_event, source: string) => backend.installPlugin(source));
  ipcMain.handle("plugins:set-enabled", (_event, payload) =>
    backend.setProjectPluginEnabled(payload.threadId, payload.pluginId, payload.enabled)
  );
  ipcMain.handle("config:get", () => {
    console.log("[ipc] config:get requested");
    const config = backend.getConfig();
    console.log("[ipc] config:get resolved", {
      providers: config.providers.length,
      models: config.models.length,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel
    });
    return config;
  });
  ipcMain.handle("config:save", (_event, config) => backend.saveConfig(config));
  ipcMain.handle("knowledge:import", (_event, payload) => backend.importKnowledge(payload));
  ipcMain.handle("browser:open", (_event, payload) => backend.openBrowserTab(payload.threadId, payload.url));
  ipcMain.handle("browser:navigate", (_event, payload) =>
    backend.navigateBrowserTab(payload.threadId, payload.tabId, payload.url)
  );
  ipcMain.handle("browser:focus", (_event, payload) => backend.focusBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:reload", (_event, payload) => backend.reloadBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:back", (_event, payload) => backend.goBackBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:forward", (_event, payload) => backend.goForwardBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:close", (_event, payload) => backend.closeBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("approval:resolve", (_event, payload) =>
    backend.resolveApproval(payload.id, payload.resolution)
  );
  ipcMain.handle("prompt:answer", (_event, payload) => backend.answerUserPrompt(payload.id, payload.answers));
  ipcMain.handle("gpa:state", (_event, threadId: string) => backend.getGpaState(threadId));
  ipcMain.handle("gpa:set-stage", (_event, payload: { threadId: string; stage: string }) =>
    backend.setGpaStage(payload.threadId, payload.stage as "off" | "goal" | "plan" | "act")
  );
  ipcMain.handle("gpa:set-full-access", (_event, payload: { threadId: string; fullAccess: boolean }) =>
    backend.setGpaFullAccess(payload.threadId, payload.fullAccess)
  );
  ipcMain.handle("models:fetch", (_event, payload) => backend.fetchProviderModels(payload));
}

async function ensureRendererServerUrl(): Promise<string> {
  if (rendererServer) {
    const address = rendererServer.address();
    if (address && typeof address !== "string") {
      return `http://127.0.0.1:${address.port}/`;
    }
  }

  const rendererRoot = path.resolve(__dirname, "../renderer");
  rendererServer = http.createServer(async (request, response) => {
    try {
      const target = new URL(request.url ?? "/", "http://127.0.0.1");
      const relativePath = normalizeRendererPath(target.pathname);
      const filePath = path.resolve(rendererRoot, relativePath);
      const rootPrefix = `${rendererRoot}${path.sep}`.toLowerCase();
      const normalizedFilePath = filePath.toLowerCase();

      if (normalizedFilePath !== rendererRoot.toLowerCase() && !normalizedFilePath.startsWith(rootPrefix)) {
        response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Forbidden");
        return;
      }

      const asset = await fs.readFile(filePath);
      response.writeHead(200, { "Content-Type": getContentType(filePath) });
      response.end(asset);
    } catch (error) {
      const code = isMissingFileError(error) ? 404 : 500;
      response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(code === 404 ? "Not Found" : "Internal Server Error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    rendererServer?.once("error", reject);
    rendererServer?.listen(0, "127.0.0.1", () => resolve());
  });

  const address = rendererServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Renderer server failed to start.");
  }

  return `http://127.0.0.1:${address.port}/`;
}

function normalizeRendererPath(pathname: string): string {
  if (pathname === "/" || pathname === "") {
    return "index.html";
  }

  return pathname.replace(/^\/+/, "");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

app.whenReady().then(() => {
  void createWindow().catch(reportStartupError);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(reportStartupError);
    }
  });
});

app.on("window-all-closed", () => {
  rendererServer?.close();
  rendererServer = null;
  if (process.platform !== "darwin") {
    app.quit();
  }
});
