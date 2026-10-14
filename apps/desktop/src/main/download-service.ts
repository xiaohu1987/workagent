import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { DownloadSegment, DownloadServiceSnapshot, DownloadTask } from "@shared-types";

/**
 * 小工具「下载」的主进程引擎。
 *
 * - HTTP(S)：多分段并行下载（服务器支持 Range 时按大小切 2~8 段），
 *   单文件预分配 + 按偏移写入，天然支持大文件流式落盘。
 * - 断点续传：每段进度持久化到 `<dataDir>/state/<id>.json`，暂停/重启后
 *   从已完成的偏移继续（带 ETag/Last-Modified 校验保留在状态里）。
 * - 暂停/恢复/取消：通过 AbortController 切断所有分段请求。
 * - P2P（BT/磁力）：webtorrent 为可选依赖，动态 require；未安装时任务
 *   会失败并给出安装提示，不影响普通下载。
 */

const PROBE_TIMEOUT_MS = 15_000;
const SEGMENT_MIN_SIZE = 8 * 1024 * 1024;
const MAX_SEGMENTS = 8;
const TICK_INTERVAL_MS = 500;
const HISTORY_LIMIT = 200;
const REDIRECT_LIMIT = 6;
const USER_AGENT = "CodeXH-Downloader/1.0";

interface ProbeResult {
  url: string;
  totalBytes: number;
  acceptRanges: boolean;
  fileName?: string;
  etag?: string;
  lastModified?: string;
}

interface HeadedResponse {
  response: http.IncomingMessage;
  /** Final URL after redirects. */
  url: string;
}

interface RuntimeTask extends DownloadTask {
  fileHandle: fs.promises.FileHandle | null;
  controller: AbortController | null;
  lastTickBytes: number;
  lastTickAt: number;
}

interface DownloadServiceOptions {
  /** Persisted default download directory from AppConfig; empty = system fallback. */
  getDefaultDir: () => string | undefined;
  /** Directory for state/history persistence (userData/downloads). */
  dataDir: string;
  emit: (snapshot: DownloadServiceSnapshot) => void;
  log: (kind: string, payload: Record<string, unknown>) => void;
}

function sanitizeFileName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return cleaned.slice(0, 180) || "download";
}

function fileNameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const leaf = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
    return leaf;
  } catch {
    return "";
  }
}

function fileNameFromDisposition(header: string | undefined): string {
  if (!header) return "";
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try { return decodeURIComponent(utf8[1]); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header);
  return (plain?.[1] ?? plain?.[2] ?? "").trim();
}

/** Split the file into at most MAX_SEGMENTS ranges of at least SEGMENT_MIN_SIZE. */
function planSegments(totalBytes: number): DownloadSegment[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return [{ start: 0, end: -1, downloaded: 0 }];
  }
  if (totalBytes < SEGMENT_MIN_SIZE) {
    return [{ start: 0, end: totalBytes - 1, downloaded: 0 }];
  }
  const count = Math.min(MAX_SEGMENTS, Math.max(2, Math.floor(totalBytes / SEGMENT_MIN_SIZE)));
  const chunk = Math.floor(totalBytes / count);
  const segments: DownloadSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * chunk;
    const end = index === count - 1 ? totalBytes - 1 : start + chunk - 1;
    segments.push({ start, end, downloaded: 0 });
  }
  return segments;
}

export class DownloadService {
  readonly #options: DownloadServiceOptions;
  readonly #tasks = new Map<string, RuntimeTask>();
  readonly #history = new Map<string, DownloadTask>();
  readonly #torrents = new Map<string, { pause: () => void; resume: () => void; destroy: (options?: { destroyStore?: boolean }) => void }>();
  readonly #stateDir: string;
  readonly #historyFile: string;
  #tickTimer: NodeJS.Timeout | null = null;
  #torrentEngine: TorrentEngine | null = null;
  #torrentProbed = false;
  #started = false;

  public constructor(options: DownloadServiceOptions) {
    this.#options = options;
    this.#stateDir = path.join(options.dataDir, "state");
    this.#historyFile = path.join(options.dataDir, "history.json");
  }

  /** Load persisted states and resume bookkeeping. Safe to call repeatedly. */
  public async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await fsp.mkdir(this.#stateDir, { recursive: true });
    await this.#loadPersisted();
    this.#tickTimer = setInterval(() => this.#tick(), TICK_INTERVAL_MS);
    this.#tickTimer.unref?.();
    this.#emit();
  }

  public getDefaultDir(): string {
    return this.#options.getDefaultDir()?.trim() || "";
  }

  public isP2pAvailable(): boolean {
    return this.#probeTorrentEngine() !== null;
  }

  public getSnapshot(): DownloadServiceSnapshot {
    return {
      tasks: [...this.#tasks.values()].map((task) => this.#publicTask(task)),
      history: [...this.#history.values()].map((task) => this.#publicTask(task)),
      defaultDir: this.getDefaultDir(),
      p2pAvailable: this.isP2pAvailable()
    };
  }

  public async add(input: { url: string; dir?: string }): Promise<DownloadTask> {
    const url = input.url.trim();
    if (!url) throw new Error("请输入下载地址。");
    const isTorrent = /^magnet:/i.test(url) || /\.torrent$/i.test(url.split("?")[0] ?? "");
    await fsp.mkdir(this.#stateDir, { recursive: true });
    if (isTorrent) {
      return this.#addTorrentTask(url, input.dir);
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("仅支持 http(s) 下载链接、磁力链接（magnet:）与 .torrent 文件。");
    }
    return this.#addHttpTask(url, input.dir);
  }

  public pause(id: string): void {
    const task = this.#tasks.get(id);
    if (!task || task.status === "paused" || task.status === "probing") return;
    if (task.kind === "p2p") {
      this.#torrents.get(id)?.pause();
      task.status = "paused";
      task.speedBps = 0;
      this.#emit();
      return;
    }
    task.status = "paused";
    task.speedBps = 0;
    task.controller?.abort();
    void this.#persistTask(task).then(() => this.#emit());
  }

  public resume(id: string): void {
    const task = this.#tasks.get(id);
    if (!task || task.status !== "paused") return;
    if (task.kind === "p2p") {
      this.#torrents.get(id)?.resume();
      task.status = "downloading";
      this.#emit();
      return;
    }
    task.status = "downloading";
    void this.#runHttpTask(task).catch((error) => this.#failTask(task, error));
    this.#emit();
  }

  public async cancel(id: string): Promise<void> {
    const task = this.#tasks.get(id);
    if (!task) return;
    if (task.kind === "p2p") {
      const torrent = this.#torrents.get(id);
      torrent?.destroy({ destroyStore: true });
      this.#torrents.delete(id);
    } else {
      task.status = "canceled";
      task.controller?.abort();
      if (task.fileHandle) {
        await task.fileHandle.close().catch(() => undefined);
        task.fileHandle = null;
      }
      await fsp.rm(task.filePath, { force: true }).catch(() => undefined);
    }
    this.#tasks.delete(id);
    await fsp.rm(this.#stateFile(id), { force: true }).catch(() => undefined);
    const canceled: DownloadTask = { ...this.#publicTask(task), status: "canceled", speedBps: 0 };
    this.#pushHistory(canceled);
    await this.#persistHistory();
    this.#emit();
  }

  /** Remove one history entry (keeps the file on disk). */
  public async removeHistory(id: string): Promise<void> {
    this.#history.delete(id);
    await this.#persistHistory();
    this.#emit();
  }

  public async clearHistory(): Promise<void> {
    this.#history.clear();
    await this.#persistHistory();
    this.#emit();
  }

  /** Persist every unfinished task as paused so the next launch can resume. */
  public async shutdown(): Promise<void> {
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    for (const task of this.#tasks.values()) {
      if (task.kind === "p2p") {
        this.#torrents.get(task.id)?.pause();
        task.status = "paused";
        continue;
      }
      if (task.status === "downloading" || task.status === "probing") {
        task.status = "paused";
        task.controller?.abort();
      }
      if (task.fileHandle) {
        await task.fileHandle.close().catch(() => undefined);
        task.fileHandle = null;
      }
      await this.#persistTask(task);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP engine
  // ---------------------------------------------------------------------------

  async #addHttpTask(rawUrl: string, dirOverride?: string): Promise<DownloadTask> {
    const dir = dirOverride?.trim() || this.getDefaultDir();
    const id = randomUUID();
    const now = new Date().toISOString();
    const task: RuntimeTask = {
      id,
      url: rawUrl,
      fileName: "下载中...",
      filePath: "",
      kind: "http",
      totalBytes: -1,
      receivedBytes: 0,
      speedBps: 0,
      progress: 0,
      status: "probing",
      segments: [],
      resumable: false,
      createdAt: now,
      fileHandle: null,
      controller: null,
      lastTickBytes: 0,
      lastTickAt: Date.now()
    };
    this.#tasks.set(id, task);
    this.#emit();

    try {
      const probe = await this.#probe(rawUrl);
      const finalUrl = probe.url;
      task.url = finalUrl;
      task.fileName = sanitizeFileName(probe.fileName || fileNameFromUrl(finalUrl) || `download-${Date.now()}`);
      task.totalBytes = probe.totalBytes;
      task.resumable = probe.acceptRanges;
      task.etag = probe.etag;
      task.lastModified = probe.lastModified;
      const targetDir = dir || this.#systemFallbackDir();
      await fsp.mkdir(targetDir, { recursive: true });
      task.filePath = await this.#reservePath(targetDir, task.fileName);

      const handle = await fsp.open(task.filePath, "w");
      if (task.totalBytes > 0) {
        await handle.truncate(task.totalBytes);
      }
      task.fileHandle = handle;
      task.segments = probe.acceptRanges && task.totalBytes > 0 ? planSegments(task.totalBytes) : [{ start: 0, end: task.totalBytes > 0 ? task.totalBytes - 1 : -1, downloaded: 0 }];
      task.status = "downloading";
      task.lastTickBytes = 0;
      task.lastTickAt = Date.now();
      this.#options.log("download.started", { id, url: finalUrl, filePath: task.filePath, totalBytes: task.totalBytes, segments: task.segments.length });
      await this.#persistTask(task);
      this.#emit();
      void this.#runHttpTask(task).catch((error) => this.#failTask(task, error));
      return this.#publicTask(task);
    } catch (error) {
      this.#tasks.delete(id);
      this.#emit();
      throw error;
    }
  }

  async #runHttpTask(task: RuntimeTask): Promise<void> {
    const controller = new AbortController();
    task.controller = controller;
    // 重启后恢复的任务没有句柄：重新打开预分配文件继续按偏移写。
    if (!task.fileHandle) {
      task.fileHandle = await fsp.open(task.filePath, "r+");
      if (task.totalBytes > 0) {
        await task.fileHandle.truncate(task.totalBytes).catch(() => undefined);
      }
    }
    const pending: Array<Promise<void>> = [];
    for (const segment of task.segments) {
      if (controller.signal.aborted) return;
      if (segment.end >= 0 && segment.downloaded > segment.end - segment.start) continue;
      pending.push(this.#runSegment(task, segment, controller));
    }
    await Promise.all(pending);
    if (controller.signal.aborted || task.status !== "downloading") return;
    this.#finishTask(task);
  }

  async #runSegment(task: RuntimeTask, segment: DownloadSegment, controller: AbortController): Promise<void> {
    if (!task.fileHandle) throw new Error("下载文件句柄已关闭。");
    const from = segment.start + segment.downloaded;
    // end === -1 means "stream to EOF" (unknown total size, single segment).
    const to = segment.end < 0 ? undefined : segment.end;
    if (to !== undefined && from > to) return;

    const request = await this.#requestWithRedirects(task.url, {
      method: "GET",
      headers: to !== undefined && task.resumable
        ? { "user-agent": USER_AGENT, range: `bytes=${from}-${to}` }
        : { "user-agent": USER_AGENT },
      signal: controller.signal
    });
    const response = request.response;

    // Server ignored the Range request: restart as a plain single stream.
    if (response.statusCode === 200 && from > 0 && to !== undefined) {
      response.destroy();
      task.resumable = false;
      task.segments = [{ start: 0, end: -1, downloaded: 0 }];
      const handle = await fsp.open(task.filePath, "w");
      await task.fileHandle.close().catch(() => undefined);
      task.fileHandle = handle;
      task.receivedBytes = 0;
      await this.#persistTask(task);
      return this.#runSegment(task, task.segments[0], controller);
    }
    if (response.statusCode !== 206 && response.statusCode !== 200) {
      response.destroy();
      throw new Error(`服务器返回 ${response.statusCode}，无法继续下载。`);
    }

    try {
      for await (const chunk of response) {
        if (controller.signal.aborted) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
        if (!buffer.length) continue;
        await task.fileHandle.write(buffer, 0, buffer.length, segment.start + segment.downloaded);
        segment.downloaded += buffer.length;
        task.receivedBytes += buffer.length;
        task.progress = task.totalBytes > 0 ? Math.min(1, task.receivedBytes / task.totalBytes) : -1;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      response.destroy();
    }
  }

  async #probe(rawUrl: string): Promise<ProbeResult> {
    // 1) HEAD first; many servers answer it correctly and cheaply.
    try {
      const headed = await this.#requestWithRedirects(rawUrl, { method: "HEAD", headers: { "user-agent": USER_AGENT } }, PROBE_TIMEOUT_MS);
      const response = headed.response;
      const length = Number(response.headers["content-length"] ?? "-1");
      const acceptRanges = String(response.headers["accept-range"] ?? response.headers["accept-ranges"] ?? "").toLowerCase() === "bytes";
      response.destroy();
      if ((response.statusCode ?? 600) < 400 && (Number.isFinite(length) && length >= 0 || acceptRanges)) {
        return {
          url: headed.url,
          totalBytes: Number.isFinite(length) ? length : -1,
          acceptRanges,
          fileName: fileNameFromDisposition(response.headers["content-disposition"] as string | undefined),
          etag: response.headers.etag as string | undefined,
          lastModified: response.headers["last-modified"] as string | undefined
        };
      }
    } catch {
      // Fall through to the ranged GET probe.
    }
    // 2) Ranged GET probe: works even when HEAD is disabled.
    const ranged = await this.#requestWithRedirects(rawUrl, { method: "GET", headers: { "user-agent": USER_AGENT, range: "bytes=0-0" } }, PROBE_TIMEOUT_MS);
    const response = ranged.response;
    response.destroy();
    const statusCode = response.statusCode ?? 600;
    if (statusCode >= 400) {
      throw new Error(`无法访问下载地址（HTTP ${statusCode}）。`);
    }
    const contentRange = String(response.headers["content-range"] ?? "");
    const total = /\/(\d+)$/i.exec(contentRange);
    return {
      url: ranged.url,
      totalBytes: total ? Number(total[1]) : -1,
      acceptRanges: response.statusCode === 206 && Boolean(total),
      fileName: fileNameFromDisposition(response.headers["content-disposition"] as string | undefined)
    };
  }

  async #requestWithRedirects(url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }, timeoutMs?: number): Promise<HeadedResponse> {
    let current = url;
    for (let hop = 0; hop < REDIRECT_LIMIT; hop += 1) {
      const response = await this.#requestOnce(current, init, timeoutMs);
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.destroy();
        current = new URL(response.headers.location, current).toString();
        continue;
      }
      return { response, url: current };
    }
    throw new Error("重定向次数过多。");
  }

  #requestOnce(url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }, timeoutMs?: number): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const requester = url.startsWith("https://") ? https : http;
      const request = requester.request(url, {
        method: init.method,
        headers: init.headers,
        signal: init.signal
      }, (response) => resolve(response));
      request.on("error", reject);
      if (timeoutMs) {
        request.setTimeout(timeoutMs, () => request.destroy(new Error("连接超时。")));
      }
      request.end();
    });
  }

  // ---------------------------------------------------------------------------
  // P2P engine (optional webtorrent dependency)
  // ---------------------------------------------------------------------------

  #probeTorrentEngine(): TorrentEngine | null {
    if (this.#torrentProbed) return this.#torrentEngine;
    this.#torrentProbed = true;
    try {
      const require = createRequire(import.meta.url);
      const mod = require("webtorrent") as { default?: TorrentEngineCtor } & TorrentEngineCtor;
      const WebTorrent = (mod.default ?? mod) as TorrentEngineCtor;
      this.#torrentEngine = new WebTorrent() as TorrentEngine;
    } catch {
      this.#torrentEngine = null;
    }
    return this.#torrentEngine;
  }

  async #addTorrentTask(source: string, dirOverride?: string): Promise<DownloadTask> {
    const engine = this.#probeTorrentEngine();
    if (!engine) {
      throw new Error("P2P（BT/磁力）支持需要 webtorrent 依赖：请在项目根目录执行 pnpm add webtorrent 后重启应用。");
    }
    const dir = dirOverride?.trim() || this.getDefaultDir() || this.#systemFallbackDir();
    await fsp.mkdir(dir, { recursive: true });
    const id = randomUUID();
    const now = new Date().toISOString();
    const task: RuntimeTask = {
      id,
      url: source,
      fileName: "解析中...",
      filePath: path.join(dir, ""),
      kind: "p2p",
      totalBytes: -1,
      receivedBytes: 0,
      speedBps: 0,
      progress: 0,
      status: "probing",
      segments: [],
      resumable: true,
      createdAt: now,
      fileHandle: null,
      controller: null,
      lastTickBytes: 0,
      lastTickAt: Date.now()
    };
    this.#tasks.set(id, task);
    this.#emit();

    await new Promise<void>((resolve) => {
      engine.add(source, { path: dir }, (torrent: TorrentInstance) => {
        const refresh = () => {
          task.fileName = torrent.name || task.fileName;
          task.filePath = path.join(torrent.path ?? dir, torrent.name ?? "");
          task.totalBytes = torrent.length || -1;
          task.receivedBytes = torrent.downloaded || 0;
          task.progress = torrent.progress ?? 0;
          task.peers = torrent.numPeers ?? 0;
        };
        refresh();
        this.#torrents.set(id, {
          pause: () => torrent.pause(),
          resume: () => torrent.resume(),
          destroy: (options) => torrent.destroy(options as never)
        });
        torrent.on("download", refresh);
        torrent.on("upload", refresh);
        torrent.on("done", () => {
          refresh();
          this.#finishTask(task);
        });
        torrent.on("error", (error: unknown) => this.#failTask(task, error));
        resolve();
      });
    });
    this.#options.log("download.p2p_started", { id, source: source.slice(0, 120), dir });
    return this.#publicTask(task);
  }

  // ---------------------------------------------------------------------------
  // Shared bookkeeping
  // ---------------------------------------------------------------------------

  #finishTask(task: RuntimeTask): void {
    if (task.status === "completed" || task.status === "failed") return;
    task.status = "completed";
    task.progress = 1;
    task.speedBps = 0;
    task.completedAt = new Date().toISOString();
    if (task.fileHandle) {
      void task.fileHandle.close().catch(() => undefined);
      task.fileHandle = null;
    }
    this.#tasks.delete(task.id);
    void fsp.rm(this.#stateFile(task.id), { force: true }).catch(() => undefined);
    this.#pushHistory(this.#publicTask(task));
    void this.#persistHistory().then(() => this.#emit());
    this.#options.log("download.completed", { id: task.id, filePath: task.filePath, totalBytes: task.totalBytes });
  }

  #failTask(task: RuntimeTask, error: unknown): void {
    if (task.status === "paused" || task.status === "canceled" || task.status === "completed") return;
    const message = error instanceof Error ? error.message : String(error);
    if (message === "_abort_") return;
    task.status = "failed";
    task.error = message;
    task.speedBps = 0;
    if (task.fileHandle) {
      void task.fileHandle.close().catch(() => undefined);
      task.fileHandle = null;
    }
    this.#tasks.delete(task.id);
    void fsp.rm(this.#stateFile(task.id), { force: true }).catch(() => undefined);
    this.#pushHistory(this.#publicTask(task));
    void this.#persistHistory().then(() => this.#emit());
    this.#options.log("download.failed", { id: task.id, error: message });
  }

  #tick(): void {
    const now = Date.now();
    let changed = false;
    for (const task of this.#tasks.values()) {
      if (task.status !== "downloading") continue;
      const deltaBytes = task.receivedBytes - task.lastTickBytes;
      const deltaMs = now - task.lastTickAt;
      if (deltaMs >= TICK_INTERVAL_MS) {
        const instant = deltaBytes * 1000 / deltaMs;
        task.speedBps = task.speedBps > 0 ? task.speedBps * 0.6 + instant * 0.4 : instant;
        task.lastTickBytes = task.receivedBytes;
        task.lastTickAt = now;
      }
      if (task.kind === "http" && task.speedBps >= 0) {
        void this.#persistTask(task);
      }
      changed = true;
    }
    if (changed) this.#emit();
  }

  #publicTask(task: RuntimeTask | DownloadTask): DownloadTask {
    const { fileHandle: _fh, controller: _ctrl, lastTickBytes: _lb, lastTickAt: _lt, ...rest } = task as RuntimeTask;
    return { ...rest };
  }

  #pushHistory(task: DownloadTask): void {
    this.#history.delete(task.id);
    this.#history.set(task.id, task);
    while (this.#history.size > HISTORY_LIMIT) {
      const oldest = this.#history.keys().next().value;
      if (oldest === undefined) break;
      this.#history.delete(oldest);
    }
  }

  #stateFile(id: string): string {
    return path.join(this.#stateDir, `${id}.json`);
  }

  async #persistTask(task: RuntimeTask): Promise<void> {
    if (!task.filePath) return;
    const payload = JSON.stringify(this.#publicTask(task));
    const tmp = `${this.#stateFile(task.id)}.tmp`;
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, this.#stateFile(task.id)).catch(() => fsp.copyFile(tmp, this.#stateFile(task.id)).catch(() => undefined));
  }

  async #persistHistory(): Promise<void> {
    const payload = JSON.stringify([...this.#history.values()]);
    const tmp = `${this.#historyFile}.tmp`;
    await fsp.mkdir(path.dirname(this.#historyFile), { recursive: true });
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, this.#historyFile).catch(() => undefined);
  }

  async #loadPersisted(): Promise<void> {
    try {
      const rawHistory = await fsp.readFile(this.#historyFile, "utf8");
      const parsed = JSON.parse(rawHistory) as DownloadTask[];
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry.id === "string") this.#history.set(entry.id, entry);
        }
      }
    } catch {
      // First launch or corrupted file: start with an empty history.
    }
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(this.#stateDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const raw = await fsp.readFile(path.join(this.#stateDir, entry), "utf8");
        const restored = JSON.parse(raw) as RuntimeTask;
        if (!restored?.id) continue;
        restored.status = "paused";
        restored.speedBps = 0;
        restored.fileHandle = null;
        restored.controller = null;
        restored.lastTickBytes = restored.receivedBytes;
        restored.lastTickAt = Date.now();
        this.#tasks.set(restored.id, restored);
      } catch {
        // Corrupted state file: drop it so the user can re-download.
        await fsp.rm(path.join(this.#stateDir, entry), { force: true }).catch(() => undefined);
      }
    }
  }

  async #reservePath(dir: string, fileName: string): Promise<string> {
    const extension = path.extname(fileName);
    const stem = path.basename(fileName, extension);
    let candidate = path.join(dir, fileName);
    let index = 1;
    for (;;) {
      let exists = false;
      try { exists = (await fsp.stat(candidate)).isFile(); } catch { exists = false; }
      if (!exists) return candidate;
      index += 1;
      candidate = path.join(dir, `${stem} (${index})${extension}`);
    }
  }

  #systemFallbackDir(): string {
    return path.join(this.#options.dataDir, "未指定目录");
  }

  #emit(): void {
    this.#options.emit(this.getSnapshot());
  }
}

// Minimal structural types so the optional webtorrent dependency stays untyped.
type TorrentInstance = {
  name?: string;
  path?: string;
  length?: number;
  downloaded?: number;
  progress?: number;
  numPeers?: number;
  pause: () => void;
  resume: () => void;
  destroy: (options?: object) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type TorrentEngine = {
  add: (source: string, options: { path: string }, onTorrent: (torrent: TorrentInstance) => void) => unknown;
};

type TorrentEngineCtor = new () => TorrentEngine;
