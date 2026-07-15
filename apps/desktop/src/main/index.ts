import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, screen, shell, Tray } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopBackend } from "./app";
import { UpdateService } from "./update-service";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "codexh-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
]);

if (process.platform === "win32") {
  app.setAppUserModelId("com.codexh.desktop");
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let rendererServer: http.Server | null = null;
const backend = new DesktopBackend();
let updates: UpdateService | null = null;
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
    showMainWindow();
  });
}

function showMainWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function quitApplication(): void {
  isQuitting = true;
  tray?.destroy();
  tray = null;
  app.quit();
}

function resolveTrayIconPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath, "icon.ico"),
    path.resolve(__dirname, "../../assets/icon.ico"),
    path.resolve(__dirname, "../../../assets/icon.ico")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function createTray(): void {
  if (tray) {
    return;
  }

  const iconPath = resolveTrayIconPath();
  if (iconPath) {
    tray = new Tray(iconPath);
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }

  tray.setToolTip("CodeXH");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示主窗口",
        click: () => showMainWindow()
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => quitApplication()
      }
    ])
  );
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  if (process.platform === "win32") {
    tray.on("balloon-click", () => showMainWindow());
  }
}

function notifyMinimizedToTray(): void {
  const title = "CodeXH";
  const body = "应用已最小化到系统托盘，不会退出。点击托盘图标可重新打开。";
  const iconPath = resolveTrayIconPath();

  if (Notification.isSupported()) {
    const notification = new Notification({
      title,
      body,
      ...(iconPath ? { icon: iconPath } : {}),
      silent: false
    });
    notification.on("click", () => showMainWindow());
    notification.show();
    return;
  }

  if (process.platform === "win32") {
    tray?.displayBalloon({
      title,
      content: body,
      ...(iconPath ? { icon: iconPath } : { iconType: "info" })
    });
  }
}

async function createWindow(): Promise<void> {
  await backend.initialize();
  const updatePaths = backend.getUpdatePaths();
  updates = new UpdateService({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    cacheDir: updatePaths.cacheDir,
    executablePath: process.execPath,
    getRunningTaskCount: () => backend.listThreads().filter((thread) => thread.status === "running" || thread.status === "waiting").length,
    log: (kind, payload) => backend.appendRuntimeLog(kind, payload),
    emit: (state) => mainWindow?.webContents.send("update:state", state),
    quit: () => quitApplication()
  });
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
      webviewTag: true,
      sandbox: false
    }
  });

  backend.onEvent((event) => {
    mainWindow?.webContents.send("runtime:event", event);
  });

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);
  createTray();
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
    notifyMinimizedToTray();
  });
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
  void updates.check();
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
  ipcMain.handle("threads:search", (_event, query: string) => backend.searchThreads(query));
  ipcMain.handle("threads:create", (_event, payload) => backend.createThread(payload));
  ipcMain.handle("threads:set-pinned", (_event, payload: { threadId: string; isPinned: boolean }) =>
    backend.setThreadPinned(payload.threadId, payload.isPinned)
  );
  ipcMain.handle("threads:rename", (_event, payload: { threadId: string; title: string }) =>
    backend.renameThread(payload.threadId, payload.title)
  );
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
  ipcMain.handle("knowledge:choose-files", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "知识库文档",
          extensions: ["md", "txt", "json", "html", "htm", "csv", "xlsx", "xls", "docx", "pdf", "pptx"]
        },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("knowledge:choose-folders", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "multiSelections"] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("projects:list-files", (_event, threadId: string) => backend.listProjectFiles(threadId));
  ipcMain.handle("projects:read-file", (_event, payload: { threadId: string; path: string }) =>
    backend.readProjectFile(payload.threadId, payload.path)
  );
  ipcMain.handle("threads:delete", (_event, threadId: string) => backend.deleteThread(threadId));
  ipcMain.handle("threads:snapshot", (_event, threadId: string) => backend.getThreadSnapshot(threadId));
  ipcMain.handle("threads:send", (_event, payload) =>
    backend.sendMessage(payload.threadId, payload.content, payload.attachments ?? [], payload.displayContent)
  );
  ipcMain.handle("threads:queue:delete", (_event, payload: { threadId: string; id: string }) =>
    backend.deleteQueuedMessage(payload.threadId, payload.id)
  );
  ipcMain.handle("attachments:import", (_event, payload) =>
    backend.importAttachments(payload.threadId, payload.attachments ?? [])
  );
  ipcMain.handle("attachments:preview", (_event, payload) =>
    backend.getAttachmentDataUrl(payload.threadId, payload.absolutePath)
  );
  ipcMain.handle("attachments:media-url", (_event, payload) =>
    backend.getAttachmentMediaUrl(payload.threadId, payload.absolutePath)
  );
  ipcMain.handle("attachments:preview-local", (_event, payload) =>
    backend.getLocalImagePreview(payload.absolutePath)
  );
  ipcMain.handle("threads:reject-multimodal", (_event, payload: { threadId: string; content: string }) =>
    backend.rejectUnsupportedMultimodalInput(payload.threadId, payload.content)
  );
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
  ipcMain.handle("shell:open-folder", async (_event, targetPath: string) => {
    if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
      return "无效的本地路径。";
    }
    try {
      const stats = await fsp.stat(targetPath);
      return shell.openPath(stats.isDirectory() ? targetPath : path.dirname(targetPath));
    } catch {
      return shell.openPath(path.dirname(targetPath));
    }
  });
  ipcMain.handle("threads:open-file-location", (_event, payload: { threadId: string; path: string }) =>
    backend.openFileLocation(payload.threadId, payload.path)
  );
  ipcMain.handle("skills:list", async (_event, cwd?: string | null) => {
    await backend.reloadSkills(cwd);
    return backend.listSkills();
  });
  ipcMain.handle("skills:usage-stats", () => backend.getSkillUsageStats());
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
  ipcMain.handle("mcp:list", () => backend.listMcpServers());
  ipcMain.handle("mcp:test", (_event, config) => backend.testMcpServer(config));
  ipcMain.handle("mcp:refresh-tools", (_event, serverId?: string) => backend.refreshMcpTools(serverId));
  ipcMain.handle("mcp:login", (_event, serverId: string) => backend.loginMcpServer(serverId));
  ipcMain.handle("mcp:logout", (_event, serverId: string) => backend.logoutMcpServer(serverId));
  ipcMain.handle("knowledge:import", (_event, payload) => backend.importKnowledge(payload));
  ipcMain.handle("knowledge:list", () => backend.listKnowledgeBaseSummaries());
  ipcMain.handle("knowledge:documents", (_event, knowledgeBaseId: string) =>
    backend.listKnowledgeBaseDocuments(knowledgeBaseId)
  );
  ipcMain.handle("knowledge:refresh", (_event, knowledgeBaseId: string) => backend.refreshKnowledgeBase(knowledgeBaseId));
  ipcMain.handle("knowledge:delete", (_event, knowledgeBaseId: string) => backend.deleteKnowledgeBase(knowledgeBaseId));
  ipcMain.handle("browser:open", (_event, payload) => backend.openBrowserTab(payload.threadId, payload.url));
  ipcMain.handle("browser:navigate", (_event, payload) =>
    backend.navigateBrowserTab(payload.threadId, payload.tabId, payload.url)
  );
  ipcMain.handle("browser:focus", (_event, payload) => backend.focusBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:reload", (_event, payload) => backend.reloadBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:back", (_event, payload) => backend.goBackBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:forward", (_event, payload) => backend.goForwardBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:close", (_event, payload) => backend.closeBrowserTab(payload.threadId, payload.tabId));
  ipcMain.handle("browser:register-webcontents", (_event, payload: { threadId: string; tabId: string; webContentsId: number }) =>
    backend.registerBrowserWebContents(payload.threadId, payload.tabId, payload.webContentsId)
  );
  ipcMain.handle("browser:sync-webcontents", (_event, payload: { threadId: string; tabId: string }) =>
    backend.syncBrowserWebContents(payload)
  );
  ipcMain.handle("approval:resolve", (_event, payload) =>
    backend.resolveApproval(payload.id, payload.resolution)
  );
  ipcMain.handle("prompt:answer", (_event, payload) => backend.answerUserPrompt(payload.id, payload.answers));
  ipcMain.handle("gpa:state", (_event, threadId: string) => backend.getGpaState(threadId));
  ipcMain.handle("gpa:set-stage", (_event, payload: { threadId: string; stage: string }) =>
    backend.setGpaStage(payload.threadId, payload.stage as "off" | "goal" | "plan" | "act")
  );
  ipcMain.handle("gpa:project-plan", (_event, threadId: string) => backend.getProjectGpaPlan(threadId));
  ipcMain.handle("gpa:restore-plan", (_event, threadId: string) => backend.restoreProjectGpaPlan(threadId));
  ipcMain.handle("gpa:abandon-plan", (_event, threadId: string) => backend.abandonProjectGpaPlan(threadId));
  ipcMain.handle("gpa:set-full-access", (_event, payload: { threadId: string; fullAccess: boolean }) =>
    backend.setGpaFullAccess(payload.threadId, payload.fullAccess)
  );
  ipcMain.handle("knowledge:set-enabled", (_event, payload: { threadId: string; knowledgeEnabled: boolean }) =>
    backend.setKnowledgeEnabled(payload.threadId, payload.knowledgeEnabled)
  );
  ipcMain.handle("models:fetch", (_event, payload) => backend.fetchProviderModels(payload));
  ipcMain.handle("models:test", (_event, payload) => backend.testProviderModel(payload));
  ipcMain.handle("models:save-capability", (_event, payload) => backend.saveModelAgentCapability(payload));
  ipcMain.handle("updates:state", () => updates?.getState() ?? null);
  ipcMain.handle("updates:check", () => updates?.check() ?? Promise.reject(new Error("更新服务尚未初始化。")));
  ipcMain.handle("updates:download", (_event, payload: { confirmInsecureHttp?: boolean }) =>
    updates?.download(payload?.confirmInsecureHttp === true) ?? Promise.reject(new Error("更新服务尚未初始化。"))
  );
  ipcMain.handle("updates:install", () => updates?.install() ?? Promise.reject(new Error("更新服务尚未初始化。")));
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

      const asset = await fsp.readFile(filePath);
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
  protocol.handle("codexh-media", async (request) => {
    try {
      const url = new URL(request.url);
      const threadId = url.searchParams.get("threadId")?.trim() ?? "";
      const mediaPath = url.searchParams.get("path")?.trim() ?? "";
      if (!threadId || !mediaPath) {
        return new Response("Bad Request", { status: 400 });
      }
      const resolved = await backend.assertThreadMediaPath(threadId, mediaPath);
      return net.fetch(pathToFileURL(resolved).href);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 403 });
    }
  });
  void createWindow().catch(reportStartupError);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(reportStartupError);
      return;
    }

    showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (!isQuitting) {
    return;
  }

  rendererServer?.close();
  rendererServer = null;
  if (process.platform !== "darwin") {
    app.quit();
  }
});
