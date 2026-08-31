import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, FileChooser, Frame, Locator, Page } from "playwright-core";
import type {
  BrowserRecording,
  BrowserRecordingAction,
  BrowserRecordingFamily,
  BrowserRecordingFrameTarget,
  BrowserRecordingLocator,
  BrowserRecordingRepairCandidate,
  BrowserRecordingSession,
  DetectedBrowser
} from "@shared-types";
import { parseCandidate, type BrowserRecordingChatBridge, type BrowserRecordingChatHandle, type BrowserRecordingPlaywrightTools } from "./browser-recording-chat";
import type { RuntimeToolCall, ToolSpecDefinition } from "@shared-types";

type RecordingConfig = {
  browser: BrowserRecordingFamily;
  executablePath: string;
  userDataDir: string;
  inputs: Record<string, string>;
  files: Record<string, string[]>;
};

type RecordingEventPayload = {
  kind: "click" | "fill" | "select" | "check" | "press" | "scroll";
  target?: ElementDescription;
  value?: string;
  checked?: boolean;
  key?: string;
  x?: number;
  y?: number;
};

export type ElementDescription = {
  testId?: string;
  role?: string;
  accessibleName?: string;
  label?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  text?: string;
  css: string;
};

type ActiveRecording = {
  kind: "recording";
  recording: BrowserRecording;
  config: RecordingConfig;
  actions: BrowserRecordingAction[];
  context: BrowserContext;
  pageIds: Map<Page, string>;
  pageSequence: number;
  valueKeys: Map<string, string>;
  valueSequence: number;
  lastActionByPage: Map<string, { actionId: string; at: number }>;
  suppressedNavigationPages: Set<Page>;
  queue: Promise<void>;
  closing: boolean;
  chat: BrowserRecordingChatHandle | null;
};

type ActiveReplay = {
  kind: "playback";
  recording: BrowserRecording;
  config: RecordingConfig;
  actions: BrowserRecordingAction[];
  context: BrowserContext;
  pages: Map<string, Page>;
  currentIndex: number;
  closing: boolean;
  chat: BrowserRecordingChatHandle | null;
  candidate?: BrowserRecordingRepairCandidate;
  repairAttempts: Map<string, number>;
};

export type BrowserRecordingRuntimeOptions = {
  recordingsDir: string;
  browserProfilesDir: string;
  /** Read the latest configured Chrome executable path without restarting the runtime. */
  getChromeExecutablePath?: () => string | undefined;
  chooseFiles: (input: { multiple: boolean; title: string }) => Promise<string[]>;
  trashDirectory: (directory: string) => Promise<void>;
  onState?: (state: BrowserRecordingSession) => void;
  chatBridge?: BrowserRecordingChatBridge;
};

const IDLE_SESSION: BrowserRecordingSession = {
  mode: "idle",
  operation: null,
  recordingId: null,
  recordingName: null,
  browser: null,
  stepCount: 0,
  currentStep: 0,
  totalSteps: 0,
  error: null,
  failedActionId: null,
  missingFileKey: null
};

const RECORDING_BINDING = "__codexhRecordBrowserAction";
const ACTION_CORRELATION_MS = 2_500;

export class MissingRecordedFileError extends Error {
  public constructor(public readonly fileKey: string) {
    super(`配置项 ${fileKey} 中的上传文件不存在。`);
    this.name = "MissingRecordedFileError";
  }
}

export function detectInstalledBrowsers(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fsSync.existsSync,
  manualChromePath?: string
): DetectedBrowser[] {
  const definitions: Array<{ family: BrowserRecordingFamily; label: string; candidates: string[] }> = [
    {
      family: "chrome",
      label: "Google Chrome",
      candidates: compactPaths([
        environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        environment.USERPROFILE && path.join(environment.USERPROFILE, "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
        environment.ProgramW6432 && path.join(environment.ProgramW6432, "Google", "Chrome", "Application", "chrome.exe"),
        environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        environment["PROGRAMFILES(X86)"] && path.join(environment["PROGRAMFILES(X86)"]!, "Google", "Chrome", "Application", "chrome.exe")
      ])
    },
    {
      family: "edge",
      label: "Microsoft Edge",
      candidates: compactPaths([
        environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
        environment["PROGRAMFILES(X86)"] && path.join(environment["PROGRAMFILES(X86)"]!, "Microsoft", "Edge", "Application", "msedge.exe"),
        environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
      ])
    }
  ];

  return definitions.map((definition) => {
    if (platform === "win32" && definition.family === "chrome" && manualChromePath?.trim()) {
      const configuredPath = manualChromePath.trim();
      const validConfiguredPath = /(?:^|[\\/])chrome\.exe$/i.test(configuredPath) && exists(configuredPath);
      return {
        family: definition.family,
        label: definition.label,
        available: validConfiguredPath,
        executablePath: validConfiguredPath ? configuredPath : null
      };
    }
    let executablePath = platform === "win32"
      ? definition.candidates.find((candidate) => exists(candidate)) ?? null
      : null;
    if (!executablePath && platform === "win32" && definition.family === "chrome") {
      const registryPath = findChromeFromRegistry();
      if (registryPath && exists(registryPath)) executablePath = registryPath;
    }
    return { family: definition.family, label: definition.label, available: executablePath !== null, executablePath };
  });
}

function findChromeFromRegistry(): string | null {
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe"
  ];
  for (const key of keys) {
    try {
      const output = execFileSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
      const match = output.match(/REG_SZ\s+(.+)$/im);
      const value = match?.[1]?.trim().replace(/^"|"$/g, "");
      if (value && /chrome\.exe$/i.test(value)) return value;
    } catch {
      // Registry lookup is only a fallback; filesystem candidates remain authoritative.
    }
  }
  return null;
}

function compactPaths(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export class BrowserRecordingRuntime {
  readonly #options: BrowserRecordingRuntimeOptions;
  #session: BrowserRecordingSession = { ...IDLE_SESSION };
  #active: ActiveRecording | ActiveReplay | null = null;

  public constructor(options: BrowserRecordingRuntimeOptions) {
    this.#options = options;
  }

  public setChatBridge(chatBridge: BrowserRecordingChatBridge): void {
    this.#options.chatBridge = chatBridge;
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.#options.recordingsDir, { recursive: true }),
      fs.mkdir(this.#options.browserProfilesDir, { recursive: true })
    ]);
    const directories = await fs.readdir(this.#options.recordingsDir, { withFileTypes: true });
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.#options.recordingsDir, entry.name);
      const metadata = await readJson<BrowserRecording>(path.join(directory, "metadata.json")).catch(() => null);
      if (!metadata) continue;
      const actions = await readJson<BrowserRecordingAction[]>(path.join(directory, "actions.json")).catch(() => []);
      const config = await this.readConfig(directory).catch(() => null);
      if (metadata.status !== "recording") {
        if (!fsSync.existsSync(path.join(directory, "recording.md"))) {
          const script = await fs.readFile(path.join(directory, "recording.ts"), "utf8").catch(() => generatePlaywrightScript(metadata, actions));
          await atomicWriteText(path.join(directory, "recording.md"), generateRecordingMarkdown(metadata, actions, script, config ?? undefined));
          await this.writeMetadata({ ...metadata, documentStatus: "ready", documentError: null }).catch(() => undefined);
        }
        continue;
      }
      if (actions.length === 0) {
        await fs.rm(directory, { recursive: true, force: true });
        continue;
      }
      if (!config) {
        await this.writeMetadata({
          ...metadata,
          status: "invalid",
          stepCount: actions.length,
          updatedAt: nowIso(),
          lastError: "录制配置文件缺失或损坏。"
        });
        continue;
      }
      const recovered = { ...metadata, status: "interrupted" as const, stepCount: actions.length, updatedAt: nowIso() };
      await this.writeRecordingBundle(recovered, actions, config, true);
    }
  }

  public getState(): BrowserRecordingSession {
    return { ...this.#session };
  }

  public detectBrowsers(): DetectedBrowser[] {
    return detectInstalledBrowsers(process.platform, process.env, fsSync.existsSync, this.#options.getChromeExecutablePath?.());
  }

  public async listRecordings(): Promise<BrowserRecording[]> {
    const entries = await fs.readdir(this.#options.recordingsDir, { withFileTypes: true });
    const recordings = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const directory = path.join(this.#options.recordingsDir, entry.name);
      try {
        const metadata = await readJson<BrowserRecording>(path.join(directory, "metadata.json"));
        return { ...metadata, directory };
      } catch (error) {
        return {
          id: entry.name,
          name: entry.name,
          browser: "chrome" as const,
          startUrl: "",
          status: "invalid" as const,
          stepCount: 0,
          directory,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          lastRunAt: null,
          lastRunStatus: "failed" as const,
          lastError: compactError(error)
        };
      }
    }));
    return recordings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async startRecording(input: {
    threadId?: string;
    browser: BrowserRecordingFamily;
    name?: string;
    startUrl?: string;
    startUrls?: string[];
  }): Promise<BrowserRecordingSession> {
    this.assertAvailable();
    if (input.browser !== "chrome") throw new Error("浏览器录制目前仅支持 Google Chrome。");
    const detected = this.detectBrowsers().find((browser) => browser.family === input.browser);
    if (!detected?.available || !detected.executablePath) {
      throw new Error("未检测到 Google Chrome，请配置 Chrome 可执行文件路径。");
    }

    const id = randomUUID();
    const directory = path.join(this.#options.recordingsDir, id);
    const userDataDir = path.join(this.#options.browserProfilesDir, input.browser);
    const createdAt = nowIso();
    const rawStartUrls = input.startUrls?.length ? input.startUrls : (input.startUrl ? [input.startUrl] : []);
    const startUrls = rawStartUrls.map(normalizeStartUrl).filter(Boolean);
    const startUrl = startUrls[0] ?? "";
    const recording: BrowserRecording = {
      id,
      name: input.name?.trim().slice(0, 120) || `浏览器录制 ${formatRecordingTime(new Date())}`,
      browser: input.browser,
      startUrl,
      startUrls,
      status: "recording",
      stepCount: 0,
      directory,
      createdAt,
      updatedAt: createdAt,
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
      threadId: input.threadId ?? null,
      enhancedPlanStatus: "none",
      llmError: null
    };
    const config: RecordingConfig = {
      browser: input.browser,
      executablePath: detected.executablePath,
      userDataDir,
      inputs: {},
      files: {}
    };
    await fs.mkdir(path.join(directory, "runs"), { recursive: true });
    await this.writeRecordingBundle(recording, [], config, false);

    let chat: BrowserRecordingChatHandle | null = null;
    try {
      chat = input.threadId && this.#options.chatBridge
        ? await this.#options.chatBridge.begin({ threadId: input.threadId, recordingId: id, operation: "recording" })
        : null;
      const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: detected.executablePath,
        headless: false,
        viewport: null,
        args: ["--start-maximized", "--no-first-run"]
      });
      const active: ActiveRecording = {
        kind: "recording",
        recording,
        config,
        actions: [],
        context,
        pageIds: new Map(),
        pageSequence: 0,
        valueKeys: new Map(),
        valueSequence: 0,
        lastActionByPage: new Map(),
        suppressedNavigationPages: new Set(),
        queue: Promise.resolve(),
        closing: false,
        chat
      };
      this.#active = active;
      await context.exposeBinding(RECORDING_BINDING, async (source, payload: RecordingEventPayload) => {
        active.queue = active.queue.then(() => this.recordBrowserPayload(active, source.page, source.frame, payload));
        await active.queue;
      });
      await context.addInitScript(installRecordingListeners, { bindingName: RECORDING_BINDING });
      context.on("page", (page) => {
        active.queue = active.queue.then(() => this.attachRecordingPage(active, page));
      });
      context.once("close", () => {
        if (!active.closing && this.#active === active) void this.finalizeInterruptedRecording(active);
      });

      const page = await context.newPage();
      await this.attachRecordingPage(active, page, true);
      for (const existing of context.pages()) {
        if (existing !== page) await existing.close().catch(() => undefined);
      }
      for (const [index, url] of startUrls.entries()) {
        const targetPage = index === 0 ? page : await context.newPage();
        await this.attachRecordingPage(active, targetPage, true);
        await this.appendRecordingAction(active, {
          id: randomUUID(), pageId: this.requirePageId(active, targetPage), type: "navigate", url, createdAt: nowIso()
        });
        active.suppressedNavigationPages.add(targetPage);
        await targetPage.goto(url, { waitUntil: "domcontentloaded" }).finally(() => active.suppressedNavigationPages.delete(targetPage));
      }
      this.setSession({
        mode: "recording", operation: "recording", recordingId: id, recordingName: recording.name,
        browser: input.browser, stepCount: active.actions.length, currentStep: 0, totalSteps: 0,
        error: null, failedActionId: null, missingFileKey: null, threadId: input.threadId ?? null,
        llmStatus: "narrating", llmMessage: null, chatTurnRunId: chat?.turnRunId ?? null, chatDraftId: null
      });
      if (chat) void this.#options.chatBridge?.narrate(chat, `录制已启动，共打开 ${startUrls.length || 1} 个起始页面。`);
      return this.getState();
    } catch (error) {
      recording.status = "interrupted";
      recording.lastError = compactError(error);
      recording.updatedAt = nowIso();
      await this.writeRecordingBundle(recording, [], config, false);
      if (chat) await this.#options.chatBridge?.complete(chat, `Playwright 录制启动失败：${compactError(error)}`, "failed");
      this.#active = null;
      this.setSession({ ...IDLE_SESSION });
      throw error;
    }
  }

  public async stopRecording(): Promise<BrowserRecordingSession> {
    const active = this.requireActive("recording");
    await active.queue;
    active.closing = true;
    active.recording.status = "ready";
    active.recording.stepCount = active.actions.length;
    active.recording.updatedAt = nowIso();
    await this.writeRecordingBundle(active.recording, active.actions, active.config, true);
    await active.context.close().catch(() => undefined);
    this.#active = null;
    this.setSession({
      mode: "completed", operation: "recording", recordingId: active.recording.id,
      recordingName: active.recording.name, browser: active.recording.browser,
      stepCount: active.actions.length, currentStep: active.actions.length, totalSteps: active.actions.length,
      error: null, failedActionId: null, missingFileKey: null,
      threadId: active.recording.threadId ?? null,
      llmStatus: active.chat ? "enhancing" : "idle",
      llmMessage: active.chat ? "LLM 正在整理 Playwright 录制。" : null,
      chatTurnRunId: active.chat?.turnRunId ?? null,
      chatDraftId: null
    });
    if (active.chat) {
      void this.enhanceRecordingInBackground(active.recording, active.actions, active.chat).catch(async (error) => {
        active.recording.enhancedPlanStatus = "failed";
        active.recording.llmError = compactError(error);
        active.recording.updatedAt = nowIso();
        await this.writeMetadata(active.recording).catch(() => undefined);
        this.setSession({
          ...this.#session,
          llmStatus: "error",
          llmMessage: "LLM 增强失败，已保留原始 Playwright 计划。"
        });
        await this.#options.chatBridge?.complete(active.chat!, "Playwright 录制完成，但 LLM 增强失败，已保留原始规则计划。", "failed").catch(() => undefined);
      });
    }
    return this.getState();
  }

  public async cancelRecording(): Promise<BrowserRecordingSession> {
    const active = this.requireActive("recording");
    active.closing = true;
    await active.context.close().catch(() => undefined);
    await fs.rm(active.recording.directory, { recursive: true, force: true });
    this.#active = null;
    this.setSession({ ...IDLE_SESSION });
    return this.getState();
  }

  public async play(recordingId: string, threadId?: string): Promise<BrowserRecordingSession> {
    this.assertAvailable();
    const { recording, actions, config } = await this.loadRecording(recordingId);
    const detected = this.detectBrowsers().find((browser) => browser.family === recording.browser);
    if (!detected?.available || !detected.executablePath) throw new Error("录制使用的浏览器当前不可用。");
    config.executablePath = detected.executablePath;
    const chat = threadId && this.#options.chatBridge
      ? await this.#options.chatBridge.begin({ threadId, recordingId, operation: "playback" })
      : null;
    const context = await chromium.launchPersistentContext(config.userDataDir, {
      executablePath: detected.executablePath,
      headless: false,
      viewport: null,
      args: ["--start-maximized", "--no-first-run"]
    });
    const page = await context.newPage();
    for (const existing of context.pages()) {
      if (existing !== page) await existing.close().catch(() => undefined);
    }
    const firstPageId = actions[0]?.pageId ?? "page-1";
    // Some recordings begin with an interaction instead of an explicit navigate
    // action. Seed the retained replay page with the configured start URL so the
    // repair tools never inspect a meaningless about:blank document.
    const firstAction = actions[0];
    if (recording.startUrl && firstAction?.type !== "navigate" && firstAction?.type !== "openPage") {
      await page.goto(recording.startUrl, { waitUntil: "domcontentloaded" });
    }
    const active: ActiveReplay = {
      kind: "playback", recording: { ...recording, threadId: threadId ?? recording.threadId ?? null }, config, actions, context,
      pages: new Map([[firstPageId, page]]), currentIndex: 0, closing: false, chat, repairAttempts: new Map()
    };
    this.#active = active;
    context.once("close", () => {
      if (!active.closing && this.#active === active) void this.stopPlaybackWithStatus(active, "cancelled", "浏览器窗口已关闭。");
    });
    this.setSession({
      mode: "replaying", operation: "playback", recordingId, recordingName: recording.name,
      browser: recording.browser, stepCount: actions.length, currentStep: 0, totalSteps: actions.length,
      error: null, failedActionId: null, missingFileKey: null, threadId,
      llmStatus: "narrating", llmMessage: null, chatTurnRunId: chat?.turnRunId ?? null, chatDraftId: null
    });
    if (chat) void this.#options.chatBridge?.narrate(chat, `回放已启动，共 ${actions.length} 个 Playwright 步骤。`);
    void this.continueReplay(active);
    return this.getState();
  }

  public async retryPlayback(): Promise<BrowserRecordingSession> {
    const active = this.requireActive("playback");
    if (this.#session.mode !== "paused") throw new Error("当前回放没有暂停步骤。");
    if (this.#session.missingFileKey) {
      const files = await this.#options.chooseFiles({ multiple: true, title: "重新选择回放文件" });
      if (files.length === 0) return this.getState();
      active.config.files[this.#session.missingFileKey] = files;
      await this.writeConfig(active.recording.directory, active.config);
    }
    this.setSession({ ...this.#session, mode: "replaying", error: null, failedActionId: null, missingFileKey: null });
    if (active.chat) await this.#options.chatBridge?.progress(active.chat, `正在从第 ${active.currentIndex + 1} 步重试 Playwright 回放。`, true);
    void this.continueReplay(active);
    return this.getState();
  }

  public async applyLlmCandidate(recordingId: string): Promise<BrowserRecordingSession> {
    const directory = this.recordingDirectory(recordingId);
    const candidate = await readJson<BrowserRecordingRepairCandidate>(path.join(directory, "llm", "candidate.json"));
    const actions = await readJson<BrowserRecordingAction[]>(path.join(directory, "enhanced-actions.json"))
      .catch(() => readJson<BrowserRecordingAction[]>(path.join(directory, "actions.json")));
    const config = await this.readConfig(directory);
    const nextActions = applyCandidateOperations(actions, candidate, config);
    await atomicWriteJson(path.join(directory, "enhanced-actions.json"), nextActions);
    const metadata = await readJson<BrowserRecording>(path.join(directory, "metadata.json"));
    const updated = { ...metadata, enhancedPlanStatus: "approved" as const, llmError: null, lastRepairSummary: candidate.rationale.join("；") || "已应用 LLM 修复。", updatedAt: nowIso() };
    await this.writeRecordingBundle(updated, nextActions, config, true, false);
    await fs.rm(path.join(directory, "llm", "candidate.json"), { force: true });
    const active = this.#active?.kind === "playback" && this.#active.recording.id === recordingId ? this.#active : null;
    if (active) {
      active.actions = nextActions;
      const failedIndex = candidate.failedActionId
        ? nextActions.findIndex((action) => action.id === candidate.failedActionId)
        : -1;
      active.currentIndex = failedIndex >= 0
        ? failedIndex
        : Math.min(active.currentIndex, nextActions.length);
      active.candidate = undefined;
      this.setSession({ ...this.#session, mode: "replaying", llmStatus: "idle", llmMessage: null, candidateId: null });
      void this.continueReplay(active);
    } else if (this.#session.recordingId === recordingId) {
      this.setSession({ ...this.#session, llmStatus: "idle", llmMessage: null, candidateId: null });
    }
    return this.getState();
  }

  public async discardLlmCandidate(recordingId: string): Promise<BrowserRecordingSession> {
    const directory = this.recordingDirectory(recordingId);
    await fs.rm(path.join(directory, "llm", "candidate.json"), { force: true });
    const metadata = await readJson<BrowserRecording>(path.join(directory, "metadata.json"));
    await this.writeMetadata({ ...metadata, enhancedPlanStatus: "none", llmError: null, updatedAt: nowIso() });
    if (this.#active?.kind === "playback" && this.#active.recording.id === recordingId) {
      this.#active.candidate = undefined;
      this.setSession({ ...this.#session, llmStatus: "idle", llmMessage: null, candidateId: null });
    } else if (this.#session.recordingId === recordingId) {
      this.setSession({ ...this.#session, llmStatus: "idle", llmMessage: null, candidateId: null });
    }
    return this.getState();
  }

  public async enhanceRecording(recordingId: string, threadId: string): Promise<BrowserRecordingSession> {
    this.assertAvailable();
    const { recording } = await this.loadRecording(recordingId);
    const actions = await readJson<BrowserRecordingAction[]>(path.join(recording.directory, "actions.json"));
    const chat = this.#options.chatBridge
      ? await this.#options.chatBridge.begin({ threadId, recordingId, operation: "recording" })
      : null;
    if (!chat) throw new Error("当前没有可用的聊天模型。");
    await this.enhanceRecordingInBackground(recording, actions, chat);
    return this.getState();
  }

  public async stopPlayback(): Promise<BrowserRecordingSession> {
    const active = this.requireActive("playback");
    await this.stopPlaybackWithStatus(active, "cancelled", null);
    return this.getState();
  }

  public async rename(recordingId: string, name: string): Promise<BrowserRecording> {
    const nextName = name.trim().slice(0, 120);
    if (!nextName) throw new Error("录制名称不能为空。");
    const { recording, actions, config } = await this.loadRecording(recordingId);
    recording.name = nextName;
    recording.updatedAt = nowIso();
    await this.writeRecordingBundle(recording, actions, config, true, false);
    return recording;
  }

  public async delete(recordingId: string): Promise<void> {
    if (this.#active?.recording.id === recordingId) throw new Error("无法删除正在使用的录制。");
    const directory = this.recordingDirectory(recordingId);
    await fs.access(directory);
    await this.#options.trashDirectory(directory);
  }

  public async readScript(recordingId: string): Promise<string> {
    return fs.readFile(path.join(this.recordingDirectory(recordingId), "recording.ts"), "utf8");
  }

  public async readDocument(recordingId: string): Promise<string> {
    const directory = this.recordingDirectory(recordingId);
    const documentPath = path.join(directory, "recording.md");
    const recording = await readJson<BrowserRecording>(path.join(directory, "metadata.json"));
    const actions = await readJson<BrowserRecordingAction[]>(path.join(directory, "enhanced-actions.json")).catch(() => readJson<BrowserRecordingAction[]>(path.join(directory, "actions.json")));
    const script = await fs.readFile(path.join(directory, "recording.ts"), "utf8").catch(() => generatePlaywrightScript(recording, actions));
    const config = await this.readConfig(directory).catch(() => ({ inputs: {}, files: {} } as RecordingConfig));
    const document = generateRecordingMarkdown(recording, actions, script, config);
    await atomicWriteText(documentPath, document);
    await this.writeMetadata({ ...recording, documentStatus: "ready", documentError: null }).catch(() => undefined);
    return document;
  }

  public getDirectory(recordingId: string): string {
    return this.recordingDirectory(recordingId);
  }

  public async shutdown(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (active.kind === "recording") {
      await active.queue;
      await this.finalizeInterruptedRecording(active);
      return;
    }
    await this.stopPlaybackWithStatus(active, "cancelled", "应用已退出。");
  }

  private async attachRecordingPage(active: ActiveRecording, page: Page, primary = false): Promise<void> {
    if (active.pageIds.has(page)) return;
    const pageId = `page-${++active.pageSequence}`;
    active.pageIds.set(page, pageId);
    const opener = await page.opener();
    if (!primary && opener) {
      const openerPageId = active.pageIds.get(opener);
      const recent = openerPageId ? active.lastActionByPage.get(openerPageId) : null;
      const action = recent && Date.now() - recent.at <= ACTION_CORRELATION_MS
        ? active.actions.find((candidate) => candidate.id === recent.actionId)
        : null;
      if (action && (action.type === "click" || action.type === "press")) {
        action.opensPageId = pageId;
        await this.persistRecording(active);
      } else {
        await this.appendRecordingAction(active, {
          id: randomUUID(), pageId, type: "openPage", url: page.url(), openerPageId, createdAt: nowIso()
        });
      }
    }
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || active.suppressedNavigationPages.has(page)) return;
      active.queue = active.queue.then(() => this.recordNavigation(active, page, frame.url()));
    });
    page.on("filechooser", (chooser) => {
      active.queue = active.queue.then(() => this.recordFileChooser(active, page, chooser));
    });
  }

  private async recordNavigation(active: ActiveRecording, page: Page, url: string): Promise<void> {
    if (!isRecordableUrl(url)) return;
    // SSO redirects carry one-time state and token values. They are handled by the
    // page itself and must not become replay steps or URL wait targets.
    if (isLikelyAuthenticationNavigation(url)) return;
    const pageId = this.requirePageId(active, page);
    const recent = active.lastActionByPage.get(pageId);
    const action = recent && Date.now() - recent.at <= ACTION_CORRELATION_MS
      ? active.actions.find((candidate) => candidate.id === recent.actionId)
      : null;
    if (action && (action.type === "click" || action.type === "press")) {
      action.expectedUrl = normalizeRecordedNavigationUrl(url);
      if (!active.recording.startUrl) {
        active.recording.startUrl = url;
        active.recording.startUrls = [url];
      }
      await this.persistRecording(active);
      return;
    }
    const previous = active.actions.at(-1);
    if (previous?.type === "navigate" && previous.pageId === pageId && previous.url === url) return;
    if (!active.recording.startUrl) {
      active.recording.startUrl = url;
      active.recording.startUrls = [url];
    }
    await this.appendRecordingAction(active, { id: randomUUID(), pageId, type: "navigate", url: normalizeRecordedNavigationUrl(url), createdAt: nowIso() });
  }

  private async recordBrowserPayload(active: ActiveRecording, page: Page, frame: Frame, payload: RecordingEventPayload): Promise<void> {
    if (this.#active !== active) return;
    const pageId = this.requirePageId(active, page);
    if (payload.kind === "scroll") {
      const action: BrowserRecordingAction = {
        id: randomUUID(), pageId, type: "scroll", x: payload.x ?? 0, y: payload.y ?? 0, createdAt: nowIso()
      };
      const previous = active.actions.at(-1);
      if (previous?.type === "scroll" && previous.pageId === pageId) {
        previous.x = action.x;
        previous.y = action.y;
        previous.createdAt = action.createdAt;
        await this.persistRecording(active);
      } else {
        await this.appendRecordingAction(active, action);
      }
      return;
    }
    if (!payload.target) return;
    const locator = await this.resolveRecordedLocator(frame, payload.target);
    const actionId = randomUUID();
    const createdAt = nowIso();
    if (payload.kind === "click") {
      await this.appendRecordingAction(active, { id: actionId, pageId, type: "click", locator, createdAt });
      active.lastActionByPage.set(pageId, { actionId, at: Date.now() });
      return;
    }
    if (payload.kind === "press" && payload.key) {
      await this.appendRecordingAction(active, { id: actionId, pageId, type: "press", locator, key: payload.key, createdAt });
      active.lastActionByPage.set(pageId, { actionId, at: Date.now() });
      return;
    }
    if (payload.kind === "check") {
      await this.appendRecordingAction(active, { id: actionId, pageId, type: "check", locator, checked: payload.checked === true, createdAt });
      return;
    }
    const key = this.valueKey(active, locator, payload.kind === "select" ? "select" : "input");
    active.config.inputs[key] = payload.value ?? "";
    const type = payload.kind === "select" ? "select" : "fill";
    const previous = active.actions.at(-1);
    if (previous?.type === type && previous.pageId === pageId && locatorIdentity(previous.locator) === locatorIdentity(locator)) {
      previous.valueKey = key;
      previous.createdAt = createdAt;
      await this.persistRecording(active);
      return;
    }
    await this.appendRecordingAction(active, { id: actionId, pageId, type, locator, valueKey: key, createdAt });
  }

  private async recordFileChooser(active: ActiveRecording, page: Page, chooser: FileChooser): Promise<void> {
    const multiple = await chooser.isMultiple();
    const selected = await this.#options.chooseFiles({ multiple, title: "选择要上传的文件" });
    if (selected.length === 0) return;
    const description = await chooser.element().evaluate(describeElementForUpload);
    const ownerFrame = await chooser.element().ownerFrame();
    if (!ownerFrame) throw new Error("无法定位文件上传控件所在页面。");
    const locator = await this.resolveRecordedLocator(ownerFrame, description);
    const fileKey = this.valueKey(active, locator, "file");
    active.config.files[fileKey] = selected;
    await chooser.setFiles(selected);
    await this.appendRecordingAction(active, {
      id: randomUUID(), pageId: this.requirePageId(active, page), type: "upload", locator, fileKey, createdAt: nowIso()
    });
  }

  private async resolveRecordedLocator(frame: Frame, description: ElementDescription): Promise<BrowserRecordingLocator> {
    const frameTarget = frame.parentFrame() ? { name: frame.name() || undefined, url: frame.url() || undefined } : undefined;
    const candidates = buildRecordedLocatorCandidates(description, frameTarget);
    for (const candidate of candidates) {
      if (await locatorFor(frame, candidate).count().catch(() => 0) === 1) return candidate;
    }
    return { strategy: "css", value: description.css, frame: frameTarget };
  }

  private valueKey(active: ActiveRecording, locator: BrowserRecordingLocator, prefix: string): string {
    const identity = `${prefix}:${locatorIdentity(locator)}`;
    const existing = active.valueKeys.get(identity);
    if (existing) return existing;
    const base = slugifyConfigKey(locator.value) || prefix;
    const key = `${base}_${++active.valueSequence}`;
    active.valueKeys.set(identity, key);
    return key;
  }

  private async appendRecordingAction(active: ActiveRecording, action: BrowserRecordingAction): Promise<void> {
    active.actions.push(action);
    await this.persistRecording(active);
    if (active.chat) {
      await this.#options.chatBridge?.progress(active.chat, `Playwright 录制已记录第 ${active.actions.length} 步（${action.type}）。`);
    }
  }

  private async persistRecording(active: ActiveRecording): Promise<void> {
    active.recording.stepCount = active.actions.length;
    active.recording.updatedAt = nowIso();
    await this.writeRecordingBundle(active.recording, active.actions, active.config, false);
    this.setSession({
      mode: "recording", operation: "recording", recordingId: active.recording.id,
      recordingName: active.recording.name, browser: active.recording.browser,
      stepCount: active.actions.length, currentStep: 0, totalSteps: 0,
      error: null, failedActionId: null, missingFileKey: null,
      threadId: active.recording.threadId ?? null,
      llmStatus: this.#session.llmStatus ?? (active.chat ? "narrating" : "idle"),
      llmMessage: this.#session.llmMessage ?? null,
      chatTurnRunId: active.chat?.turnRunId ?? null,
      chatDraftId: this.#session.chatDraftId ?? null
    });
  }

  private async continueReplay(active: ActiveReplay): Promise<void> {
    while (this.#active === active && !active.closing && active.currentIndex < active.actions.length) {
      const action = active.actions[active.currentIndex]!;
      try {
        await this.executeReplayAction(active, action);
        active.currentIndex += 1;
        if (active.chat) {
          await this.#options.chatBridge?.progress(active.chat, `Playwright 已完成第 ${active.currentIndex}/${active.actions.length} 步（${action.type}）。`);
          if (active.currentIndex % 5 === 0) void this.#options.chatBridge?.narrate(active.chat, `请简短总结当前 Playwright 回放进度，并指出下一阶段可能的页面变化。`, await this.captureReplayContext(active, action));
        }
        this.setSession({ ...this.#session, mode: "replaying", currentStep: active.currentIndex, error: null, failedActionId: null, missingFileKey: null });
      } catch (error) {
        const message = sanitizeRuntimeError(error, active.config);
        const missingFileKey = error instanceof MissingRecordedFileError ? error.fileKey : null;
        await this.captureReplayFailure(active, action).catch(() => undefined);
        const replayContext = await this.captureReplayContext(active, action).catch(() => ({ summary: `失败动作：${JSON.stringify(action)}` }));
        active.recording.lastRunAt = nowIso();
        active.recording.lastRunStatus = "failed";
        active.recording.lastError = message;
        active.recording.updatedAt = nowIso();
         await this.writeRecordingBundle(active.recording, active.actions, active.config, true, false);
      if (active.chat) {
          await this.#options.chatBridge?.progress(active.chat, `Playwright 第 ${active.currentIndex + 1} 步失败，已暂停并保留浏览器页面：${message}`, true);
          await this.#options.chatBridge?.progress(active.chat, "LLM 正在分析失败页面并生成结构化 Playwright 修复候选，请保持浏览器页面打开。", true);
          // Keep the explanatory stream and the structured repair request on a
          // single model turn sequence. Parallel requests can exhaust provider
          // output limits or race the paused-session state.
          void (async () => {
            await this.#options.chatBridge?.narrate(active.chat!, "Playwright 回放在当前步骤失败。请说明失败原因、页面现状以及需要用户确认的修复方向。", replayContext);
            await this.prepareRepairCandidate(active, action, replayContext);
          })();
        }
        this.setSession({ ...this.#session, mode: "paused", error: message, failedActionId: action.id, missingFileKey });
        return;
      }
    }
    if (this.#active !== active || active.closing) return;
    active.recording.lastRunAt = nowIso();
    active.recording.lastRunStatus = "passed";
    active.recording.lastError = null;
    active.recording.updatedAt = nowIso();
    await this.writeRecordingBundle(active.recording, active.actions, active.config, true, false);
    active.closing = true;
    await active.context.close().catch(() => undefined);
    this.#active = null;
    if (active.chat) await this.#options.chatBridge?.complete(active.chat, `Playwright 回放完成，共执行 ${active.actions.length} 个步骤。`);
    this.setSession({
      ...this.#session,
      mode: "completed",
      currentStep: active.actions.length,
      error: null,
      failedActionId: null,
      missingFileKey: null,
      llmStatus: "idle",
      llmMessage: null
    });
  }

  private async executeReplayAction(active: ActiveReplay, action: BrowserRecordingAction): Promise<void> {
    let page = active.pages.get(action.pageId);
    if (action.type === "openPage") {
      page = await active.context.newPage();
      active.pages.set(action.pageId, page);
      if (isRecordableUrl(action.url)) await page.goto(action.url, { waitUntil: "domcontentloaded" });
      return;
    }
    if (action.type === "navigate") {
      if (active.currentIndex > 0 && isLikelyAuthenticationNavigation(action.url)) return;
      if (!page) {
        page = await active.context.newPage();
        active.pages.set(action.pageId, page);
      }
      if (!isRecordedUrlPath(page.url(), action.url)) await page.goto(action.url, { waitUntil: "domcontentloaded" });
      return;
    }
    if (action.type === "waitForUrl") {
      if (!page) throw new Error(`找不到回放页面 ${action.pageId}。`);
      await waitForRecordedUrl(page, action.url, action.timeoutMs ?? 15_000);
      return;
    }
    if (action.type === "waitForPage") {
      const opened = await active.context.waitForEvent("page", { timeout: action.timeoutMs ?? 15_000 });
      const pageId = action.pageId ?? `page-${active.pages.size + 1}`;
      active.pages.set(pageId, opened);
      return;
    }
    if (!page) throw new Error(`找不到回放页面 ${action.pageId}。`);
    if (action.type === "scroll") {
      await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: action.x, y: action.y });
      return;
    }
    if (action.type === "press" && !action.locator) {
      await page.keyboard.press(action.key);
      return;
    }
    const locator = await this.replayLocator(page, action.locator!);
    if (action.type === "waitFor") {
      await locator.waitFor({ state: action.state === "enabled" ? "visible" : action.state, timeout: action.timeoutMs ?? 15_000 });
      if (action.state === "enabled") await expectLocatorEnabled(locator, action.timeoutMs ?? 15_000);
      return;
    }
    if (["click", "fill", "select", "check", "press", "upload"].includes(action.type)) {
      await waitForLocatorVisible(locator, 15_000);
    }
    if (action.type === "fill") {
      await locator.fill(active.config.inputs[action.valueKey] ?? "", { timeout: 15_000 });
      return;
    }
    if (action.type === "select") {
      await locator.selectOption(active.config.inputs[action.valueKey] ?? "", { timeout: 15_000 });
      await settleAfterInteraction(page);
      return;
    }
    if (action.type === "check") {
      if (action.checked) await locator.check({ timeout: 15_000 });
      else await locator.uncheck({ timeout: 15_000 });
      await settleAfterInteraction(page);
      return;
    }
    if (action.type === "upload") {
      const files = active.config.files[action.fileKey] ?? [];
      if (files.length === 0 || !(await allFilesExist(files))) throw new MissingRecordedFileError(action.fileKey);
      await locator.setInputFiles(files, { timeout: 15_000 });
      return;
    }
    const waits: Promise<unknown>[] = [];
    if (action.expectedUrl) waits.push(waitForRecordedUrl(page, action.expectedUrl));
    let popupPromise: Promise<Page> | null = null;
    if (action.opensPageId) popupPromise = active.context.waitForEvent("page", { timeout: 15_000 });
    const operation = action.type === "click"
      ? locator.click({ timeout: 15_000 })
      : locator.press(action.key, { timeout: 15_000 });
    await Promise.all([operation, ...waits]);
    if (popupPromise && action.opensPageId) active.pages.set(action.opensPageId, await popupPromise);
    await settleAfterInteraction(page);
  }

  private async replayLocator(page: Page, descriptor: BrowserRecordingLocator): Promise<Locator> {
    let scope: Page | Frame = page;
    if (descriptor.frame) {
      const matched = page.frames().find((frame) => frameMatches(frame, descriptor.frame!));
      if (!matched) throw new Error("找不到录制步骤对应的 iframe。");
      scope = matched;
    }
    const locator = locatorFor(scope, descriptor);
    if (typeof descriptor.nth === "number") return locator;
    const count = await locator.count().catch(() => 1);
    if (count <= 1) return locator;
    const first = typeof (locator as Locator & { first?: () => Locator }).first === "function"
      ? (locator as Locator & { first: () => Locator }).first()
      : locator;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index) as Locator & { isVisible?: () => Promise<boolean> };
        const visible = typeof candidate.isVisible === "function" ? await candidate.isVisible().catch(() => false) : false;
        if (visible) return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return first;
  }

  private async captureReplayFailure(active: ActiveReplay, action: BrowserRecordingAction): Promise<void> {
    const page = active.pages.get(action.pageId);
    if (!page || page.isClosed()) return;
    const runDirectory = path.join(active.recording.directory, "runs", safeTimestamp());
    await fs.mkdir(runDirectory, { recursive: true });
    await page.screenshot({ path: path.join(runDirectory, `failure-${active.currentIndex + 1}.png`), fullPage: false });
  }

  private async captureReplayContext(active: ActiveReplay, action: BrowserRecordingAction): Promise<{ summary: string; screenshotPath?: string }> {
    const page = active.pages.get(action.pageId);
    if (!page || page.isClosed()) return { summary: `失败动作：${JSON.stringify(action)}` };
    const runDirectory = path.join(active.recording.directory, "runs", safeTimestamp());
    await fs.mkdir(runDirectory, { recursive: true });
    const screenshotPath = path.join(runDirectory, `context-${active.currentIndex + 1}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
    const visibleText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const html = await page.content().catch(() => "");
    const frames = page.frames().map((frame) => ({ name: frame.name(), url: frame.url() }));
    return {
      summary: [
        `失败动作：${JSON.stringify(action)}`,
        `当前 URL：${page.url()}`,
        `页面标题：${await page.title().catch(() => "")}`,
        `Frames：${JSON.stringify(frames)}`,
        `可见文本：\n${redactSensitiveText(visibleText, active.config).slice(0, 12_000)}`,
        `DOM：\n${redactSensitiveText(html, active.config).slice(0, 30_000)}`
      ].join("\n\n"),
      screenshotPath: fsSync.existsSync(screenshotPath) ? screenshotPath : undefined
    };
  }

  private async prepareRepairCandidate(
    active: ActiveReplay,
    action: BrowserRecordingAction,
    context: { summary: string; screenshotPath?: string }
  ): Promise<void> {
    if (!active.chat || !this.#options.chatBridge) return;
    const attempts = active.repairAttempts.get(action.id) ?? 0;
    if (attempts >= 1) {
      this.setSession({ ...this.#session, llmStatus: "error", llmMessage: "自动修复后该步骤再次失败，已暂停等待手动重试。" });
      return;
    }
    active.repairAttempts.set(action.id, attempts + 1);
    this.setSession({ ...this.#session, llmStatus: "repairing", llmMessage: "LLM 正在分析 Playwright 失败现场。", repairAttempt: attempts + 1 });
    const candidate = await this.#options.chatBridge.requestRepairCandidate(active.chat, {
      actions: active.actions,
      failedAction: action,
      context,
      baseRevision: active.recording.updatedAt,
      playwright: this.createRepairPlaywrightTools(active, action)
    });
    // A user may have retried or terminated the paused step while the model was
    // working. In that case this candidate is stale and must not alter the run.
    if (
      active.closing ||
      this.#active !== active ||
      this.#session.mode !== "paused" ||
      this.#session.failedActionId !== action.id
    ) return;
    if (!candidate) {
      this.setSession({ ...this.#session, llmStatus: "error", llmMessage: "LLM 未生成可用的修复候选。" });
      return;
    }
    const directory = path.join(active.recording.directory, "llm");
    await fs.mkdir(directory, { recursive: true });
    await atomicWriteJson(path.join(directory, "candidate.json"), candidate);
    if (candidate.operations.length === 0) {
      this.setSession({ ...this.#session, llmStatus: "error", llmMessage: "LLM 未生成可安全应用的修复候选。", candidateId: candidate.id });
      return;
    }
    try {
      this.setSession({ ...this.#session, llmStatus: "applying", llmMessage: "LLM 修复候选已通过校验，正在自动应用。", candidateId: candidate.id });
      const nextActions = applyCandidateOperations(active.actions, candidate, active.config);
      await atomicWriteJson(path.join(directory, `applied-${safeTimestamp()}-${candidate.id}.json`), candidate);
      await atomicWriteJson(path.join(active.recording.directory, "enhanced-actions.json"), nextActions);
      active.actions = nextActions;
      active.recording.enhancedPlanStatus = "approved";
      active.recording.llmError = null;
      active.recording.lastRepairSummary = candidate.rationale.join("；") || "已自动应用 LLM 修复。";
      active.recording.updatedAt = nowIso();
      await this.writeRecordingBundle(active.recording, active.actions, active.config, true);
      active.candidate = undefined;
      const failedIndex = nextActions.findIndex((item) => item.id === action.id);
      active.currentIndex = failedIndex >= 0 ? failedIndex : Math.min(active.currentIndex, nextActions.length);
      await fs.rm(path.join(directory, "candidate.json"), { force: true });
      await this.#options.chatBridge.progress(active.chat, `LLM 已自动应用修复：${active.recording.lastRepairSummary}，继续执行第 ${active.currentIndex + 1} 步。`, true);
      this.setSession({ ...this.#session, mode: "replaying", llmStatus: "resuming", llmMessage: "修复已应用，正在继续 Playwright 回放。", candidateId: null, appliedCandidateId: candidate.id, repairAttempt: attempts + 1 });
      void this.continueReplay(active);
    } catch (error) {
      active.recording.enhancedPlanStatus = "failed";
      active.recording.llmError = compactError(error);
      active.recording.updatedAt = nowIso();
      await this.writeMetadata(active.recording).catch(() => undefined);
      await this.#options.chatBridge.progress(active.chat, `LLM 修复候选应用失败，已暂停：${compactError(error)}`, true);
      this.setSession({ ...this.#session, llmStatus: "error", llmMessage: "LLM 修复应用失败，已暂停。", candidateId: candidate.id });
    }
  }

  private createRepairPlaywrightTools(active: ActiveReplay, failedAction: BrowserRecordingAction): BrowserRecordingPlaywrightTools {
    const repairPageId = failedAction.pageId;
    const specs: ToolSpecDefinition[] = [
      { name: "playwright.inspect_page", namespace: "playwright", description: `Inspect the already-open replay page ${repairPageId}; never open a new page.`, inputSchema: { type: "object", properties: {} }, riskLevel: "low", source: "dynamic" },
      { name: "playwright.inspect_locator", namespace: "playwright", description: "Inspect a recorded locator, including match count and visibility.", inputSchema: { type: "object", properties: { locator: { type: "object" } }, required: ["locator"] }, riskLevel: "low", source: "dynamic" },
      { name: "playwright.click", namespace: "playwright", description: `Click a locator on the already-open replay page ${repairPageId}; do not open tabs or pages.`, inputSchema: { type: "object", properties: { locator: { type: "object" } }, required: ["locator"] }, riskLevel: "medium", source: "dynamic" },
      { name: "playwright.fill", namespace: "playwright", description: "Fill a locator using an existing recording input valueKey only.", inputSchema: { type: "object", properties: { locator: { type: "object" }, valueKey: { type: "string" } }, required: ["locator", "valueKey"] }, riskLevel: "medium", source: "dynamic" },
      { name: "playwright.select_option", namespace: "playwright", description: "Select an option using an existing recording input valueKey only.", inputSchema: { type: "object", properties: { locator: { type: "object" }, valueKey: { type: "string" } }, required: ["locator", "valueKey"] }, riskLevel: "medium", source: "dynamic" },
      { name: "playwright.wait_for", namespace: "playwright", description: "Wait for a recorded locator to become visible, hidden, attached or enabled.", inputSchema: { type: "object", properties: { locator: { type: "object" }, state: { type: "string", enum: ["attached", "visible", "hidden", "enabled"] } }, required: ["locator", "state"] }, riskLevel: "low", source: "dynamic" }
    ];
    return {
      specs,
      execute: async (call) => {
        const page = active.pages.get(failedAction.pageId);
        if (!page || page.isClosed()) throw new Error("失败步骤对应的浏览器页面已关闭。");
        const args = call.arguments ?? {};
        if (call.name === "playwright.inspect_page") {
          const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
          return JSON.stringify({ url: page.url(), title: await page.title().catch(() => ""), text: redactSensitiveText(text, active.config).slice(0, 8_000), frames: page.frames().map((frame) => ({ name: frame.name(), url: frame.url() })) });
        }
        const descriptor = coerceRepairLocator(args.locator);
        const locator = await this.replayLocator(page, descriptor);
        if (call.name === "playwright.inspect_locator") {
          return JSON.stringify({ count: await locator.count().catch(() => 0), visible: await locator.isVisible().catch(() => false), text: await locator.innerText().catch(() => "") });
        }
        if (call.name === "playwright.wait_for") {
          const state = args.state === "enabled" ? "visible" : args.state;
          if (state !== "attached" && state !== "visible" && state !== "hidden") throw new Error("不支持的等待状态。");
          await locator.waitFor({ state, timeout: 15_000 });
          if (args.state === "enabled") await expectLocatorEnabled(locator, 15_000);
          return JSON.stringify({ ok: true, state: args.state });
        }
        if (call.name === "playwright.click") {
          await waitForLocatorVisible(locator, 15_000);
          await locator.click({ timeout: 15_000 });
          await settleAfterInteraction(page);
          return JSON.stringify({ ok: true, url: page.url() });
        }
        const valueKey = typeof args.valueKey === "string" ? args.valueKey : "";
        if (!valueKey || !(valueKey in active.config.inputs)) throw new Error("工具只能使用录制配置中已有的 valueKey。");
        await waitForLocatorVisible(locator, 15_000);
        if (call.name === "playwright.fill") await locator.fill(active.config.inputs[valueKey]!, { timeout: 15_000 });
        else if (call.name === "playwright.select_option") await locator.selectOption(active.config.inputs[valueKey]!, { timeout: 15_000 });
        else throw new Error(`不支持的 Playwright 修复工具 ${call.name}。`);
        await settleAfterInteraction(page);
        return JSON.stringify({ ok: true, valueKey, url: page.url() });
      }
    };
  }

  private async enhanceRecordingInBackground(
    recording: BrowserRecording,
    actions: BrowserRecordingAction[],
    chat: BrowserRecordingChatHandle
  ): Promise<void> {
    if (!this.#options.chatBridge) return;
    recording.enhancedPlanStatus = "generating";
    recording.updatedAt = nowIso();
    await this.writeMetadata(recording).catch(() => undefined);
    this.setSession({ ...this.#session, llmStatus: "enhancing", llmMessage: "LLM 正在整理 Playwright 录制。" });
    const candidate = await this.#options.chatBridge.requestRepairCandidate(chat, {
      actions,
      context: { summary: `录制动作摘要：\n${JSON.stringify(actions).slice(0, 40_000)}` },
      baseRevision: recording.updatedAt,
      source: "enhancement"
    });
    if (candidate) {
      await fs.mkdir(path.join(recording.directory, "llm"), { recursive: true });
      await atomicWriteJson(path.join(recording.directory, "llm", "candidate.json"), candidate);
      if (candidate.operations.length === 0) {
        recording.enhancedPlanStatus = "approved";
        recording.llmError = null;
        recording.updatedAt = nowIso();
        await this.writeRecordingBundle(recording, actions, await this.readConfig(recording.directory), true);
        await fs.rm(path.join(recording.directory, "llm", "candidate.json"), { force: true });
        this.setSession({ ...this.#session, llmStatus: "idle", llmMessage: "未发现需要增强的步骤。", candidateId: null });
      } else {
        try {
          const config = await this.readConfig(recording.directory);
          const nextActions = applyCandidateOperations(actions, candidate, config);
          await atomicWriteJson(path.join(recording.directory, "llm", `applied-${safeTimestamp()}-${candidate.id}.json`), candidate);
          recording.enhancedPlanStatus = "approved";
          recording.llmError = null;
          recording.lastRepairSummary = candidate.rationale.join("；") || "已自动应用 LLM 增强。";
          recording.updatedAt = nowIso();
          await this.writeRecordingBundle(recording, nextActions, config, true, false);
          await atomicWriteJson(path.join(recording.directory, "enhanced-actions.json"), nextActions);
          await fs.rm(path.join(recording.directory, "llm", "candidate.json"), { force: true });
          await this.#options.chatBridge.progress(chat, `LLM 已自动应用增强：${recording.lastRepairSummary}`, true);
          this.setSession({ ...this.#session, llmStatus: "idle", llmMessage: recording.lastRepairSummary, candidateId: null, appliedCandidateId: candidate.id });
        } catch (error) {
          recording.enhancedPlanStatus = "failed";
          recording.llmError = compactError(error);
          recording.updatedAt = nowIso();
          await this.writeMetadata(recording);
          await this.#options.chatBridge.progress(chat, `LLM 增强应用失败，已保留原始计划：${recording.llmError}`, true);
          this.setSession({ ...this.#session, llmStatus: "error", llmMessage: recording.llmError, candidateId: candidate.id });
        }
      }
    } else {
      recording.enhancedPlanStatus = "failed";
      recording.llmError = "LLM 未生成可用的增强候选。";
      recording.updatedAt = nowIso();
      await this.writeMetadata(recording).catch(() => undefined);
      this.setSession({ ...this.#session, llmStatus: "error", llmMessage: recording.llmError });
    }
    await this.#options.chatBridge.complete(chat, candidate ? "Playwright 录制完成，LLM 增强已自动应用。" : "Playwright 录制完成，已保留原始规则计划。", candidate ? "completed" : "failed");
  }

  private async stopPlaybackWithStatus(active: ActiveReplay, status: "cancelled", message: string | null): Promise<void> {
    if (active.closing) return;
    active.closing = true;
    active.recording.lastRunAt = nowIso();
    active.recording.lastRunStatus = status;
    active.recording.lastError = message;
    active.recording.updatedAt = nowIso();
    await this.writeRecordingBundle(active.recording, active.actions, active.config, true, false).catch(() => undefined);
    await active.context.close().catch(() => undefined);
    if (this.#active === active) this.#active = null;
    if (active.chat) await this.#options.chatBridge?.complete(active.chat, message ? `Playwright 回放已终止：${message}` : "Playwright 回放已终止。", "cancelled");
    this.setSession({
      ...this.#session, mode: "completed", currentStep: active.currentIndex,
      error: message, failedActionId: null, missingFileKey: null,
      llmStatus: "idle", llmMessage: null
    });
  }

  private async finalizeInterruptedRecording(active: ActiveRecording): Promise<void> {
    if (active.closing) return;
    active.closing = true;
    await active.queue;
    active.recording.status = active.actions.length > 0 ? "interrupted" : "invalid";
    active.recording.stepCount = active.actions.length;
    active.recording.updatedAt = nowIso();
    active.recording.lastError = "浏览器录制意外中断。";
    await this.writeRecordingBundle(active.recording, active.actions, active.config, active.actions.length > 0);
    await active.context.close().catch(() => undefined);
    if (this.#active === active) this.#active = null;
    if (active.chat) await this.#options.chatBridge?.complete(active.chat, active.recording.lastError ?? "Playwright 录制已中断。", "failed");
    this.setSession({
      mode: "completed", operation: "recording", recordingId: active.recording.id,
      recordingName: active.recording.name, browser: active.recording.browser,
      stepCount: active.actions.length, currentStep: active.actions.length, totalSteps: active.actions.length,
      error: active.recording.lastError, failedActionId: null, missingFileKey: null,
      threadId: active.recording.threadId ?? null,
      llmStatus: "error",
      llmMessage: active.recording.lastError,
      chatTurnRunId: active.chat?.turnRunId ?? null,
      chatDraftId: null
    });
  }

  private async loadRecording(recordingId: string): Promise<{
    recording: BrowserRecording;
    actions: BrowserRecordingAction[];
    config: RecordingConfig;
  }> {
    const directory = this.recordingDirectory(recordingId);
    const [recording, actions, config] = await Promise.all([
      readJson<BrowserRecording>(path.join(directory, "metadata.json")),
      readJson<BrowserRecordingAction[]>(path.join(directory, "enhanced-actions.json"))
        .catch(() => readJson<BrowserRecordingAction[]>(path.join(directory, "actions.json"))),
      this.readConfig(directory)
    ]);
    return { recording: { ...recording, directory }, actions, config };
  }

  private async readConfig(directory: string): Promise<RecordingConfig> {
    return readJson<RecordingConfig>(path.join(directory, "recording.config.json"));
  }

  private async writeRecordingBundle(
    recording: BrowserRecording,
    actions: BrowserRecordingAction[],
    config: RecordingConfig,
    writeScript: boolean,
    writeRawActions = true
  ): Promise<void> {
    await fs.mkdir(recording.directory, { recursive: true });
    const script = generatePlaywrightScript(recording, actions);
    const document = generateRecordingMarkdown(recording, actions, script, config);
    recording.documentStatus = "ready";
    recording.documentError = null;
    await Promise.all([
      this.writeMetadata(recording),
      writeRawActions ? atomicWriteJson(path.join(recording.directory, "actions.json"), actions) : Promise.resolve(),
      this.writeConfig(recording.directory, config),
      atomicWriteText(path.join(recording.directory, "recording.ts"), script),
      atomicWriteText(path.join(recording.directory, "recording.md"), document)
    ]);
  }

  private writeMetadata(recording: BrowserRecording): Promise<void> {
    return atomicWriteJson(path.join(recording.directory, "metadata.json"), recording);
  }

  private writeConfig(directory: string, config: RecordingConfig): Promise<void> {
    return atomicWriteJson(path.join(directory, "recording.config.json"), config);
  }

  private recordingDirectory(recordingId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(recordingId)) throw new Error("无效的录制 ID。");
    return path.join(this.#options.recordingsDir, recordingId);
  }

  private requirePageId(active: ActiveRecording, page: Page): string {
    const pageId = active.pageIds.get(page);
    if (!pageId) throw new Error("浏览器页面尚未完成录制初始化。");
    return pageId;
  }

  private requireActive<T extends "recording" | "playback">(kind: T): Extract<ActiveRecording | ActiveReplay, { kind: T }> {
    if (this.#active?.kind !== kind) throw new Error(kind === "recording" ? "当前没有进行中的录制。" : "当前没有进行中的回放。");
    return this.#active as Extract<ActiveRecording | ActiveReplay, { kind: T }>;
  }

  private assertAvailable(): void {
    if (this.#active) throw new Error("已有浏览器录制或回放正在运行。");
  }

  private setSession(session: BrowserRecordingSession): void {
    this.#session = { ...session };
    this.#options.onState?.(this.getState());
  }
}

export function applyCandidateOperations(actions: BrowserRecordingAction[], candidate: BrowserRecordingRepairCandidate, config?: RecordingConfig): BrowserRecordingAction[] {
  const validated = parseCandidate(JSON.stringify({
    operations: candidate.operations,
    rationale: candidate.rationale,
    confidence: candidate.confidence
  }));
  if (!validated) throw new Error("LLM 修复候选结构无效，未执行任何修改。");
  const next = [...actions];
  for (const operation of validated.operations) {
    const index = next.findIndex((action) => action.id === operation.actionId);
    if (index < 0) throw new Error(`LLM 修复候选引用了未知动作 ${operation.actionId}。`);
    if (operation.op === "delete") {
      next.splice(index, 1);
      continue;
    }
    if (!operation.action || typeof operation.action !== "object") throw new Error("LLM 修复候选缺少动作内容。");
    if (operation.action.pageId !== next[index]!.pageId || !isSupportedActionType(operation.action.type)) throw new Error("LLM 修复候选包含无效页面动作。");
    if (config && operation.action.type === "fill" && !(operation.action.valueKey in config.inputs)) throw new Error("LLM 修复候选引用了未知输入配置。");
    if (config && operation.action.type === "select" && !(operation.action.valueKey in config.inputs)) throw new Error("LLM 修复候选引用了未知选择配置。");
    if (config && operation.action.type === "upload" && !(operation.action.fileKey in config.files)) throw new Error("LLM 修复候选引用了未知上传配置。");
    if (operation.op === "replace") next.splice(index, 1, operation.action);
    else if (operation.op === "insertBefore") next.splice(index, 0, operation.action);
    else next.splice(index + 1, 0, operation.action);
  }
  if (next.length > 2_000) throw new Error("LLM 修复候选动作数量超出限制。");
  return next;
}

function isSupportedActionType(value: BrowserRecordingAction["type"]): boolean {
  return ["navigate", "openPage", "waitFor", "waitForUrl", "waitForPage", "click", "fill", "select", "check", "press", "scroll", "upload"].includes(value);
}

export function buildRecordedLocatorCandidates(
  description: ElementDescription,
  frame?: BrowserRecordingFrameTarget
): BrowserRecordingLocator[] {
  const candidates: BrowserRecordingLocator[] = [];
  if (description.testId) candidates.push({ strategy: "testId", value: description.testId, frame });
  if (description.role && description.accessibleName) candidates.push({ strategy: "role", role: description.role, value: description.accessibleName, exact: true, frame });
  if (description.label) candidates.push({ strategy: "label", value: description.label, exact: true, frame });
  if (description.placeholder) candidates.push({ strategy: "placeholder", value: description.placeholder, exact: true, frame });
  if (description.name) candidates.push({ strategy: "name", value: description.name, frame });
  if (description.id) candidates.push({ strategy: "id", value: description.id, frame });
  if (description.text) candidates.push({ strategy: "text", value: description.text.slice(0, 160), exact: true, frame });
  candidates.push({ strategy: "css", value: description.css, frame });
  return candidates;
}

export function generatePlaywrightScript(recording: BrowserRecording, actions: BrowserRecordingAction[]): string {
  const lines = [
    'import { readFileSync } from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { chromium, type Frame, type Page } from "playwright";',
    '',
    'const directory = path.dirname(fileURLToPath(import.meta.url));',
    'const config = JSON.parse(readFileSync(path.join(directory, "recording.config.json"), "utf8"));',
    'const context = await chromium.launchPersistentContext(config.userDataDir, {',
    '  executablePath: config.executablePath,',
    '  headless: false,',
    '  viewport: null',
    '});',
    'const pages = new Map<string, Page>();',
    'const firstPage = await context.newPage();',
    `pages.set(${JSON.stringify(actions[0]?.pageId ?? "page-1")}, firstPage);`,
    '',
    'function scope(page: Page, frame?: { name?: string; url?: string }): Page | Frame {',
    '  if (!frame) return page;',
    '  const matched = page.frames().find((item) =>',
    '    (!frame.name || item.name() === frame.name) && (!frame.url || item.url() === frame.url)',
    '  );',
    '  if (!matched) throw new Error("Recorded iframe is unavailable.");',
    '  return matched;',
    '}',
    '',
    'async function waitForRecordedUrl(page: Page, expected: string, timeout = 15_000): Promise<void> {',
    '  const target = new URL(expected);',
    '  await page.waitForURL((url) => url.origin === target.origin && normalizeRecordedPath(url.pathname) === normalizeRecordedPath(target.pathname), { timeout });',
    '}',
    '',
    'function normalizeRecordedPath(value: string): string {',
    '  return value.length > 1 ? value.replace(/\\/+$/, "") : value;',
    '}',
    '',
    'function isLikelyAuthenticationNavigation(value: string): boolean {',
    '  try {',
    '    const parsed = new URL(value);',
    '    const decoded = decodeURIComponent(`${parsed.pathname}${parsed.search}${parsed.hash}`);',
    '    return /(?:id_token|access_token|refresh_token|token_type|expires_in|session_state|state|nonce|code)=/i.test(decoded)',
    '      || /returnurl=.*(?:authorize|state|nonce)/i.test(decoded)',
    '      || /\\/(?:oidc|oauth2?|authorize|passport)(?:\\/|$)/i.test(parsed.pathname);',
    '  } catch {',
    '    return false;',
    '  }',
    '}',
    '',
    `// ${recording.name.replace(/[\r\n]+/g, " ")}`
  ];
  for (const action of actions) lines.push(...scriptLinesForAction(action));
  lines.push('', 'await context.close();', '');
  return lines.join("\n");
}

/** Generates the user-facing, read-only recording document without persisting secrets. */
export function generateRecordingMarkdown(
  recording: BrowserRecording,
  actions: BrowserRecordingAction[],
  script = generatePlaywrightScript(recording, actions),
  config?: Pick<RecordingConfig, "inputs" | "files">
): string {
  const urls = (recording.startUrls?.length ? recording.startUrls : recording.startUrl ? [recording.startUrl] : [])
    .map(sanitizeDocumentUrl)
    .filter(Boolean);
  const lines = [
    `# ${safeDocumentText(recording.name)}`,
    "",
    `- 浏览器：${recording.browser === "edge" ? "Microsoft Edge" : "Google Chrome"}`,
    `- 起始网址：${urls.length ? urls.join("、") : "未设置"}`,
    `- 更新时间：${recording.updatedAt}`,
    `- 最近运行：${formatDocumentRunStatus(recording.lastRunStatus)}${recording.lastError ? `（${safeDocumentText(recording.lastError)}）` : ""}`,
    "",
    "## 操作步骤",
    ""
  ];
  if (actions.length === 0) lines.push("暂无已保存的操作。", "");
  describeRecordingActions(actions, config).forEach((description, index) => lines.push(`${index + 1}. ${description}`));
  if (recording.lastRepairSummary) {
    lines.push("", "## 最近一次 LLM 修复", "", safeDocumentText(recording.lastRepairSummary));
  }
  lines.push("", "## Playwright 脚本", "", "```ts", script.replace(/```/g, "\\`\\`\\`"), "```", "");
  return lines.join("\n");
}

function describeRecordingAction(action: BrowserRecordingAction, config?: Pick<RecordingConfig, "inputs" | "files">): string {
  const target = "locator" in action && action.locator ? describeLocator(action.locator) : "当前页面";
  switch (action.type) {
    case "navigate": return `导航到 ${sanitizeDocumentUrl(action.url)}`;
    case "openPage": return `打开新页面${sanitizeDocumentUrl(action.url) ? `并导航到 ${sanitizeDocumentUrl(action.url)}` : ""}`;
    case "waitFor": return `等待${target}${action.state === "visible" ? "显示" : action.state === "hidden" ? "隐藏" : action.state === "enabled" ? "可用" : "出现"}`;
    case "waitForUrl": return `等待页面导航到 ${sanitizeDocumentUrl(action.url)}`;
    case "waitForPage": return "等待新页面打开";
    case "click": return `点击${target}`;
    case "fill": return `填写${isDateField(action, config) ? "日期字段" : "文本字段"}${target}${describeRecordedValue(action.valueKey, config)}`;
    case "select": return `在下拉字段${target}中选择${describeRecordedValue(action.valueKey, config)}`;
    case "check": return `${action.checked ? "勾选" : "取消勾选"}复选框${target}`;
    case "press": return `在${target}按键 ${safeDocumentText(action.key)}`;
    case "scroll": return `滚动页面到位置 (${action.x}, ${action.y})`;
    case "upload": return `向${target}上传文件（使用配置项 ${action.fileKey}）`;
  }
}

function describeRecordingActions(actions: BrowserRecordingAction[], config?: Pick<RecordingConfig, "inputs" | "files">): string[] {
  return actions.map((action, index) => {
    const previous = actions[index - 1];
    const next = actions[index + 1];
    if (action.type === "click" && previous?.type === "click" && previous.pageId === action.pageId && isMenuChoice(action)) {
      return `在上一步打开的菜单或下拉框中选择${describeLocator(action.locator)}`;
    }
    if (action.type === "click" && next?.type === "click" && next.pageId === action.pageId && isMenuChoice(next)) {
      return `点击${describeLocator(action.locator)}，打开菜单或下拉选项`;
    }
    return describeRecordingAction(action, config);
  });
}

function describeRecordedValue(key: string, config?: Pick<RecordingConfig, "inputs" | "files">): string {
  if (isSensitiveConfigKey(key)) return `（使用配置项 ${safeDocumentText(key)}，值已隐藏）`;
  const value = config?.inputs[key];
  if (typeof value !== "string") return `（使用配置项 ${safeDocumentText(key)}）`;
  return value.length > 0
    ? `：${safeDocumentValue(value)}`
    : "：空值";
}

function isDateField(action: Extract<BrowserRecordingAction, { type: "fill" }>, config?: Pick<RecordingConfig, "inputs" | "files">): boolean {
  const value = config?.inputs[action.valueKey] ?? "";
  return /(?:日期|date|日历|时间)/i.test(action.locator.value) || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isSensitiveConfigKey(key: string): boolean {
  return /(?:password|passwd|pwd|token|secret|auth|credential|cookie|session|private|验证码|密码)/i.test(key);
}

function safeDocumentValue(value: string): string {
  return `“${safeDocumentText(value).replace(/"/g, "\\\"")}”`;
}

function isMenuChoice(action: Extract<BrowserRecordingAction, { type: "click" }>): boolean {
  const role = action.locator.role?.toLowerCase();
  return role === "menuitem" || role === "option" || role === "menuitemcheckbox" || role === "menuitemradio"
    || /(?:菜单|下拉|选项|立项)/.test(action.locator.value);
}

function describeLocator(locator: BrowserRecordingLocator): string {
  const frame = locator.frame ? "（iframe 内）" : "";
  if (locator.strategy === "role") return `角色 ${safeDocumentText(locator.role ?? "控件")}“${safeDocumentText(locator.value)}”${frame}`;
  if (["label", "placeholder", "name", "id", "testId"].includes(locator.strategy)) return `${locator.strategy} 定位“${safeDocumentText(locator.value)}”${frame}`;
  if (locator.strategy === "text") return `文本控件${frame}`;
  return `CSS 定位控件${frame}`;
}

function sanitizeDocumentUrl(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(token|code|state|nonce|session|auth|secret|password|sig|signature)/i.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    if (isLikelyAuthenticationNavigation(value)) {
      parsed.search = "";
      parsed.hash = "";
    }
    return parsed.toString();
  } catch {
    return safeDocumentText(value);
  }
}

function safeDocumentText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[<>`]/g, "").slice(0, 500);
}

function formatDocumentRunStatus(status: BrowserRecording["lastRunStatus"]): string {
  if (status === "passed") return "通过";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已终止";
  return "未运行";
}

function scriptLinesForAction(action: BrowserRecordingAction): string[] {
  const page = `pages.get(${JSON.stringify(action.pageId)})!`;
  if (action.type === "navigate") return isLikelyAuthenticationNavigation(action.url) ? [
    "{",
    `  const page = pages.get(${JSON.stringify(action.pageId)}) ?? await context.newPage();`,
    `  pages.set(${JSON.stringify(action.pageId)}, page);`,
    `  if (page.url() === "about:blank") await page.goto(${JSON.stringify(sanitizeDocumentUrl(action.url))});`,
    "}"
  ] : [
    "{",
    `  const page = pages.get(${JSON.stringify(action.pageId)}) ?? await context.newPage();`,
    `  pages.set(${JSON.stringify(action.pageId)}, page);`,
    `  await page.goto(${JSON.stringify(sanitizeDocumentUrl(action.url))});`,
    "}"
  ];
  if (action.type === "openPage") return [
    `const ${safeIdentifier(action.pageId)} = await context.newPage();`,
    `pages.set(${JSON.stringify(action.pageId)}, ${safeIdentifier(action.pageId)});`,
    ...(isRecordableUrl(action.url) ? [`await ${safeIdentifier(action.pageId)}.goto(${JSON.stringify(sanitizeDocumentUrl(action.url))});`] : [])
  ];
  if (action.type === "waitForUrl") return [`await waitForRecordedUrl(${page}, ${JSON.stringify(sanitizeDocumentUrl(action.url))}, ${action.timeoutMs ?? 15_000});`];
  if (action.type === "waitForPage") return [
    `{ const opened = await context.waitForEvent("page", { timeout: ${action.timeoutMs ?? 15_000} });`,
    `  pages.set(${JSON.stringify(action.pageId)}, opened);`,
    `}`
  ];
  if (action.type === "scroll") return [`await ${page}.evaluate(() => window.scrollTo(${action.x}, ${action.y}));`];
  if (action.type === "press" && !action.locator) return [`await ${page}.keyboard.press(${JSON.stringify(action.key)});`];
  const locator = scriptLocatorExpression(page, action.locator!);
  if (action.type === "waitFor") return [
    `await ${locator}.waitFor({ state: ${JSON.stringify(action.state === "enabled" ? "visible" : action.state)}, timeout: ${action.timeoutMs ?? 15_000} });`,
    ...(action.state === "enabled" ? [`if (!(await ${locator}.isEnabled())) throw new Error("Recorded locator is disabled.");`] : [])
  ];
  const visibleWait = `await ${locator}.waitFor({ state: "visible", timeout: 15_000 });`;
  if (action.type === "fill") return [visibleWait, `await ${locator}.fill(config.inputs[${JSON.stringify(action.valueKey)}] ?? "");`];
  if (action.type === "select") return [visibleWait, `await ${locator}.selectOption(config.inputs[${JSON.stringify(action.valueKey)}] ?? "");`];
  if (action.type === "check") return [visibleWait, `await ${locator}.${action.checked ? "check" : "uncheck"}();`];
  if (action.type === "upload") return [visibleWait, `await ${locator}.setInputFiles(config.files[${JSON.stringify(action.fileKey)}] ?? []);`];
  const operation = action.type === "click" ? `${locator}.click()` : `${locator}.press(${JSON.stringify(action.key)})`;
  const waiters: string[] = [];
  if (action.expectedUrl) waiters.push(`waitForRecordedUrl(${page}, ${JSON.stringify(sanitizeDocumentUrl(action.expectedUrl))})`);
  if (action.opensPageId) waiters.push('context.waitForEvent("page")');
  if (waiters.length === 0) return [visibleWait, `await ${operation};`];
  if (!action.opensPageId) return [visibleWait, `await Promise.all([${[...waiters, operation].join(", ")}]);`];
  const resultName = safeIdentifier(action.opensPageId);
  const destructure = `[${waiters.map((_, index) => index === waiters.length - 1 ? resultName : "").join(", ")}]`;
  const result = [visibleWait, `const ${destructure} = await Promise.all([${[...waiters, operation].join(", ")}]);`];
  if (action.opensPageId) result.push(`pages.set(${JSON.stringify(action.opensPageId)}, ${resultName});`);
  return result;
}

function scriptLocatorExpression(pageExpression: string, locator: BrowserRecordingLocator): string {
  const scopeExpression = `scope(${pageExpression}, ${JSON.stringify(locator.frame)})`;
  const base = locatorExpression(scopeExpression, locator);
  return typeof locator.nth === "number" ? `${base}.nth(${locator.nth})` : base;
}

function locatorExpression(scopeExpression: string, locator: BrowserRecordingLocator): string {
  switch (locator.strategy) {
    case "role": return `${scopeExpression}.getByRole(${JSON.stringify(locator.role)}, { name: ${JSON.stringify(locator.value)}, exact: ${locator.exact === true} })`;
    case "label": return `${scopeExpression}.getByLabel(${JSON.stringify(locator.value)}, { exact: ${locator.exact === true} })`;
    case "placeholder": return `${scopeExpression}.getByPlaceholder(${JSON.stringify(locator.value)}, { exact: ${locator.exact === true} })`;
    case "text": return `${scopeExpression}.getByText(${JSON.stringify(locator.value)}, { exact: ${locator.exact === true} })`;
    case "testId": return `${scopeExpression}.locator(${JSON.stringify(testIdSelector(locator.value))})`;
    case "name": return `${scopeExpression}.locator(${JSON.stringify(`[name=${JSON.stringify(locator.value)}]`)})`;
    case "id": return `${scopeExpression}.locator(${JSON.stringify(`[id=${JSON.stringify(locator.value)}]`)})`;
    default: return `${scopeExpression}.locator(${JSON.stringify(locator.value)})`;
  }
}

function locatorFor(scope: Page | Frame, descriptor: BrowserRecordingLocator): Locator {
  let locator: Locator;
  switch (descriptor.strategy) {
    case "role": locator = scope.getByRole(descriptor.role as never, { name: descriptor.value, exact: descriptor.exact }); break;
    case "label": locator = scope.getByLabel(descriptor.value, { exact: descriptor.exact }); break;
    case "placeholder": locator = scope.getByPlaceholder(descriptor.value, { exact: descriptor.exact }); break;
    case "text": locator = scope.getByText(descriptor.value, { exact: descriptor.exact }); break;
    case "testId": locator = scope.locator(testIdSelector(descriptor.value)); break;
    case "name": locator = scope.locator(`[name=${JSON.stringify(descriptor.value)}]`); break;
    case "id": locator = scope.locator(`[id=${JSON.stringify(descriptor.value)}]`); break;
    default: locator = scope.locator(descriptor.value); break;
  }
  return typeof descriptor.nth === "number" ? locator.nth(descriptor.nth) : locator;
}

function coerceRepairLocator(value: unknown): BrowserRecordingLocator {
  if (!value || typeof value !== "object") throw new Error("Playwright 修复工具缺少 locator。");
  const candidate = value as Partial<BrowserRecordingLocator>;
  const strategies: BrowserRecordingLocator["strategy"][] = ["testId", "role", "label", "placeholder", "name", "id", "text", "css"];
  if (!strategies.includes(candidate.strategy as BrowserRecordingLocator["strategy"]) || typeof candidate.value !== "string" || candidate.value.length === 0 || candidate.value.length > 500) {
    throw new Error("Playwright 修复工具包含无效 locator。");
  }
  if (candidate.strategy === "role" && typeof candidate.role !== "string") throw new Error("role locator 缺少 role。");
  return {
    strategy: candidate.strategy!, value: candidate.value, role: candidate.role, exact: candidate.exact === true,
    nth: Number.isInteger(candidate.nth) && (candidate.nth as number) >= 0 ? candidate.nth : undefined,
    frame: candidate.frame && typeof candidate.frame === "object" ? {
      name: typeof candidate.frame.name === "string" ? candidate.frame.name.slice(0, 200) : undefined,
      url: typeof candidate.frame.url === "string" ? candidate.frame.url.slice(0, 500) : undefined
    } : undefined
  };
}

function testIdSelector(value: string): string {
  const encoded = JSON.stringify(value);
  return `[data-testid=${encoded}], [data-test=${encoded}], [data-test-id=${encoded}]`;
}

function locatorIdentity(locator: BrowserRecordingLocator): string {
  return JSON.stringify(locator);
}

function frameMatches(frame: Frame, target: BrowserRecordingFrameTarget): boolean {
  return (!target.name || frame.name() === target.name) && (!target.url || frame.url() === target.url);
}

function normalizeStartUrl(value?: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("起始网址仅支持 HTTP 或 HTTPS。");
  return parsed.toString();
}

function normalizeRecordedNavigationUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (isLikelyAuthenticationNavigation(value)) {
      parsed.search = "";
      parsed.hash = "";
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function isLikelyAuthenticationNavigation(value: string): boolean {
  try {
    const parsed = new URL(value);
    const serialized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const decoded = decodeURIComponent(serialized);
    return /(?:id_token|access_token|refresh_token|token_type|expires_in|session_state|state|nonce|code)=/i.test(decoded)
      || /returnurl=.*(?:authorize|state|nonce)/i.test(decoded)
      || /\/(?:oidc|oauth2?|authorize|passport)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isRecordedUrlPath(current: string, expected: string): boolean {
  try {
    const actualUrl = new URL(current);
    const expectedUrl = new URL(expected);
    return actualUrl.origin.toLowerCase() === expectedUrl.origin.toLowerCase()
      && normalizeRecordedPath(actualUrl.pathname) === normalizeRecordedPath(expectedUrl.pathname);
  } catch {
    return current === expected;
  }
}

function normalizeRecordedPath(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

async function waitForRecordedUrl(page: Page, expected: string, timeout = 15_000): Promise<void> {
  await page.waitForURL((url) => isRecordedUrlPath(url.toString(), expected), { timeout });
}

async function expectLocatorEnabled(locator: Locator, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("录制控件在等待时间内仍不可用。");
}

async function waitForLocatorVisible(locator: Locator, timeout: number): Promise<void> {
  const waitFor = (locator as Locator & { waitFor?: (options: { state: "visible"; timeout: number }) => Promise<void> }).waitFor;
  if (typeof waitFor === "function") await waitFor.call(locator, { state: "visible", timeout });
}

async function settleAfterInteraction(page: Page): Promise<void> {
  const waitForTimeout = (page as Page & { waitForTimeout?: (timeout: number) => Promise<void> }).waitForTimeout;
  if (typeof waitForTimeout === "function") await waitForTimeout.call(page, 100);
}

function isRecordableUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

function slugifyConfigKey(value: string): string {
  return value.normalize("NFKC").replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

function safeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_$]/g, "_").replace(/^[^a-zA-Z_$]/, "_$&");
}

function formatRecordingTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nowIso(): string {
  return new Date().toISOString();
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function sanitizeRuntimeError(error: unknown, config: RecordingConfig): string {
  return redactSensitiveText(compactError(error), config);
}

function redactSensitiveText(text: string, config: RecordingConfig): string {
  let message = text;
  const sensitiveValues = [
    ...Object.values(config.inputs),
    ...Object.values(config.files).flat()
  ].filter((value) => value.length >= 2).sort((left, right) => right.length - left.length);
  for (const value of sensitiveValues) message = message.split(value).join("[redacted]");
  return message;
}

async function allFilesExist(files: string[]): Promise<boolean> {
  const results = await Promise.all(files.map((file) => fs.stat(file).then((stats) => stats.isFile()).catch(() => false)));
  return results.every(Boolean);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteText(filePath: string, value: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, value, "utf8");
  await fs.rename(temporary, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function installRecordingListeners({ bindingName }: { bindingName: string }): void {
  const targetWindow = window as unknown as Window & Record<string, unknown>;
  if (targetWindow.__codexhRecorderInstalled) return;
  targetWindow.__codexhRecorderInstalled = true;
  const send = (payload: RecordingEventPayload) => {
    const binding = targetWindow[bindingName];
    if (typeof binding === "function") void (binding as (value: RecordingEventPayload) => Promise<void>)(payload);
  };
  const describe = (element: Element): ElementDescription => {
    const html = element as HTMLElement;
    const input = element as HTMLInputElement;
    const labels = "labels" in input && input.labels ? [...input.labels].map((label) => label.innerText.trim()).filter(Boolean) : [];
    const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
    const implicitRoles: Record<string, string> = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img" };
    const role = element.getAttribute("role") || (element.tagName === "INPUT"
      ? input.type === "checkbox" ? "checkbox" : input.type === "radio" ? "radio" : input.type === "button" || input.type === "submit" ? "button" : "textbox"
      : implicitRoles[element.tagName]);
    const accessibleName = element.getAttribute("aria-label") || labelledBy || labels[0] || element.getAttribute("title") || (html.innerText || "").trim() || input.value;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement && parts.length < 7) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const parent: Element | null = current.parentElement;
      const siblings: Element[] = parent ? [...parent.children].filter((item: Element) => item.tagName === current!.tagName) : [];
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      parts.unshift(`${current.tagName.toLowerCase()}${suffix}`);
      current = parent;
    }
    return {
      testId: element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-test-id") || undefined,
      role: role || undefined,
      accessibleName: accessibleName?.trim().slice(0, 160) || undefined,
      label: labels[0]?.slice(0, 160),
      placeholder: element.getAttribute("placeholder")?.slice(0, 160) || undefined,
      name: element.getAttribute("name") || undefined,
      id: element.id || undefined,
      text: (html.innerText || "").trim().replace(/\s+/g, " ").slice(0, 160) || undefined,
      css: parts.join(" > ") || element.tagName.toLowerCase()
    };
  };
  document.addEventListener("click", (event) => {
    const element = event.target instanceof Element ? event.target.closest("button,a,input,select,textarea,[role],[contenteditable=true]") : null;
    if (!element) return;
    if (element instanceof HTMLInputElement && ["file", "checkbox", "radio"].includes(element.type)) return;
    if (element instanceof HTMLSelectElement) return;
    send({ kind: "click", target: describe(element) });
  }, true);
  document.addEventListener("input", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) return;
    if (element instanceof HTMLInputElement && ["file", "checkbox", "radio"].includes(element.type)) return;
    send({ kind: "fill", target: describe(element), value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText });
  }, true);
  document.addEventListener("change", (event) => {
    const element = event.target;
    if (element instanceof HTMLSelectElement) send({ kind: "select", target: describe(element), value: element.value });
    if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) send({ kind: "check", target: describe(element), checked: element.checked });
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
    const element = event.target instanceof Element ? event.target : null;
    send({ kind: "press", target: element ? describe(element) : undefined, key: event.key });
  }, true);
  let scrollTimer = 0;
  window.addEventListener("scroll", () => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => send({ kind: "scroll", x: window.scrollX, y: window.scrollY }), 220);
  }, { passive: true });
}

function describeElementForUpload(element: Element): ElementDescription {
  const html = element as HTMLElement;
  const input = element as HTMLInputElement;
  const labels = input.labels ? [...input.labels].map((label) => label.innerText.trim()).filter(Boolean) : [];
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 7) {
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent: Element | null = current.parentElement;
    const siblings: Element[] = parent ? [...parent.children].filter((item: Element) => item.tagName === current!.tagName) : [];
    parts.unshift(`${current.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""}`);
    current = parent;
  }
  return {
    testId: element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-test-id") || undefined,
    role: "textbox",
    accessibleName: element.getAttribute("aria-label") || labels[0] || element.getAttribute("title") || undefined,
    label: labels[0]?.slice(0, 160),
    placeholder: element.getAttribute("placeholder") || undefined,
    name: element.getAttribute("name") || undefined,
    id: element.id || undefined,
    text: (html.innerText || "").trim().slice(0, 160) || undefined,
    css: parts.join(" > ") || "input[type=file]"
  };
}
