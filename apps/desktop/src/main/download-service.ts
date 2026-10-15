import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { shell } from "electron";
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
/** 磁力解析（等元数据）超时：超时后给出可行动的失败原因，而不是永远停在「解析中」。 */
const P2P_METADATA_TIMEOUT_MS = 180_000;
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
  readonly #torrents = new Map<string, {
    pause: () => void;
    resume: () => void;
    destroy: (options?: { destroyStore?: boolean }) => void;
    /** helper 进程每秒推送的最新实时状态（元数据未到时 hasMetadata 为 false）。 */
    stats?: () => P2pTorrentStats | null;
  }>();
  readonly #stateDir: string;
  readonly #historyFile: string;
  #tickTimer: NodeJS.Timeout | null = null;
  /** P2P 引擎子进程（外部 Node 22 运行 webtorrent；Electron 43 内嵌 Node 24 的 DHT 不工作，见 memory/2026-10-14）。 */
  #p2pProc: ReturnType<typeof spawn> | null = null;
  #p2pReadyPromise: Promise<ReturnType<typeof spawn>> | null = null;
  #p2pStdinBuffer = "";
  readonly #torrentStatsCache = new Map<string, P2pTorrentStats>();
  /** add 请求的握手等待方：收到该任务首条 stats 即视为引擎已受理（元数据解析不再阻塞 add）。 */
  readonly #torrentHandshakeWaiters = new Map<string, () => void>();
  #p2pInstalling = false;
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
    return this.#torrentEntryPath() !== null;
  }

  public isP2pInstalling(): boolean {
    return this.#p2pInstalling;
  }

  /** P2P 组件的隔离安装目录：userData 下，asar 安装版同样可写。 */
  #vendorDir(): string {
    return path.join(this.#options.dataDir, "p2p-vendor");
  }

  /** vendor 目录里 webtorrent 的 ESM 入口文件；没装或残缺返回 null。 */
  #torrentEntryPath(): string | null {
    const pkgPath = path.join(this.#vendorDir(), "node_modules", "webtorrent", "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { main?: string; exports?: Record<string, unknown> };
      const entry = this.#resolveEsmEntry(pkg) ?? "index.js";
      const entryPath = path.join(this.#vendorDir(), "node_modules", "webtorrent", entry);
      return fs.existsSync(entryPath) ? entryPath : null;
    } catch {
      return null;
    }
  }

  #resolveEsmEntry(pkg: { main?: string; exports?: Record<string, unknown> }): string | null {
    const dot = pkg.exports ? (pkg.exports as Record<string, unknown>)["."] : null;
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const scoped = dot as Record<string, string | undefined>;
      return scoped.import ?? scoped.default ?? scoped.node ?? null;
    }
    return pkg.main ?? null;
  }

  /** 机器上的独立 Node 22 运行时：P2P 引擎必须跑在它里面（Node 24 的 DHT 不工作）。 */
  #findNodeExe(): string | null {
    const candidates = [
      "C:\\Program Files\\nodejs\\node.exe",
      path.join(process.env.USERPROFILE ?? "", ".workbuddy", "binaries", "node", "versions", "22.22.2-6", "node.exe"),
      path.join(path.dirname(process.execPath), "node.exe")
    ];
    for (const candidate of candidates) {
      try { if (candidate && fs.existsSync(candidate)) return candidate; } catch { /* 忽略非法路径 */ }
    }
    return null;
  }

  /** helper 脚本落盘在 vendor 目录：与运行形态（源码/打包）无关的稳定路径。 */
  #p2pHelperPath(): string {
    return path.join(this.#vendorDir(), "p2p-helper.cjs");
  }

  #writeP2pHelper(): void {
    const helperPath = this.#p2pHelperPath();
    try {
      if (fs.existsSync(helperPath) && fs.readFileSync(helperPath, "utf8") === P2P_HELPER_SOURCE) return;
    } catch { /* 读不了就重写 */ }
    fs.writeFileSync(helperPath, P2P_HELPER_SOURCE, "utf8");
  }

  /** 启动（或复用）P2P 引擎子进程，ready 后返回。进程崩溃后由 close 处理器重置状态。 */
  async #ensureP2pProcess(): Promise<ReturnType<typeof spawn>> {
    if (this.#p2pReadyPromise) return this.#p2pReadyPromise;
    const entry = this.#torrentEntryPath();
    if (!entry) {
      throw new Error("P2P（BT/磁力）组件未安装，请点击上方「下载安装」按钮。");
    }
    const nodeExe = this.#findNodeExe();
    if (!nodeExe) {
      throw new Error("未找到独立的 Node.js 运行时，P2P 引擎无法启动（P2P 需要外部 Node 22，Electron 内置运行时的 DHT 不工作）。");
    }
    this.#writeP2pHelper();
    this.#p2pReadyPromise = new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
      this.#options.log("download.p2p_helper_spawning", { nodeExe, vendor: this.#vendorDir() });
      const proc = spawn(nodeExe, [this.#p2pHelperPath(), this.#vendorDir()], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.#p2pProc = proc;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      proc.on("error", (error) => {
        this.#p2pProc = null;
        this.#p2pReadyPromise = null;
        settle(() => reject(new Error(`P2P 引擎进程启动失败：${error.message}`)));
      });
      proc.stdout?.on("data", (chunk: Buffer) => this.#handleP2pStdout(chunk));
      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) this.#options.log("download.p2p_helper_stderr", { text: text.slice(0, 400) });
      });
      proc.on("close", (code) => {
        this.#options.log("download.p2p_helper_exit", { code });
        // 引擎死了：所有 P2P 任务失败，下次 add 时重新拉起。
        this.#p2pProc = null;
        this.#p2pReadyPromise = null;
        this.#torrentStatsCache.clear();
        for (const task of this.#tasks.values()) {
          if (task.kind === "p2p") {
            this.#failTask(task, new Error("P2P 引擎进程异常退出，请重新添加下载任务。"));
          }
        }
        for (const waiter of this.#torrentHandshakeWaiters.values()) waiter();
        this.#torrentHandshakeWaiters.clear();
      });
      // ready 消息到达时 resolve（#handleP2pStdout 内）。
      this.#p2pResolveReady = () => settle(() => resolve(proc));
      this.#p2pRejectReady = (message: string) => settle(() => reject(new Error(message)));
    });
    return this.#p2pReadyPromise;
  }

  #p2pResolveReady: (() => void) | null = null;
  #p2pRejectReady: ((message: string) => void) | null = null;

  #p2pSend(command: Record<string, unknown>): void {
    try {
      this.#p2pProc?.stdin?.write(`${JSON.stringify(command)}\n`);
    } catch { /* 进程已死时由 close 处理 */ }
  }

  #handleP2pStdout(chunk: Buffer): void {
    this.#p2pStdinBuffer = `${this.#p2pStdinBuffer}${chunk.toString()}`;
    let newlineAt = this.#p2pStdinBuffer.indexOf("\n");
    while (newlineAt >= 0) {
      const line = this.#p2pStdinBuffer.slice(0, newlineAt).trim();
      this.#p2pStdinBuffer = this.#p2pStdinBuffer.slice(newlineAt + 1);
      if (line) this.#handleP2pMessage(line);
      newlineAt = this.#p2pStdinBuffer.indexOf("\n");
    }
  }

  /** 元数据落定：更新任务展示信息、从「解析中」转入「下载中」。 */
  #resolveTorrentMetadata(id: string, name: string, length: number, torrentPath: string): void {
    const task = this.#tasks.get(id);
    if (!task) return;
    if (name) task.fileName = name;
    if (torrentPath) task.filePath = path.join(torrentPath, name);
    if (length > 0) task.totalBytes = length;
    if (task.status === "probing") task.status = "downloading";
    this.#emit();
  }

  #handleP2pMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#options.log("download.p2p_helper_raw", { text: line.slice(0, 200) });
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : "";
    switch (msg.type) {
      case "ready":
        this.#options.log("download.p2p_helper_ready", { node: msg.node ?? "" });
        this.#p2pResolveReady?.();
        this.#p2pResolveReady = null;
        this.#p2pRejectReady = null;
        break;
      case "fatal":
        this.#options.log("download.p2p_helper_fatal", { message: String(msg.message ?? "") });
        this.#p2pRejectReady?.(String(msg.message ?? "P2P 引擎启动失败。"));
        this.#p2pResolveReady = null;
        this.#p2pRejectReady = null;
        break;
      case "metadata": {
        // webtorrent 的 add 回调时机不可靠（实测可能永远不触发），
        // 元数据落定以 stats 推送为准；这条消息仅作兜底。
        this.#resolveTorrentMetadata(id, typeof msg.name === "string" ? msg.name : "", typeof msg.length === "number" ? msg.length : -1, typeof msg.path === "string" ? msg.path : "");
        break;
      }
      case "stats": {
        const rawFiles = Array.isArray(msg.files) ? msg.files : [];
        const stats: P2pTorrentStats = {
          peers: typeof msg.peers === "number" ? msg.peers : 0,
          downloaded: typeof msg.downloaded === "number" ? msg.downloaded : 0,
          progress: typeof msg.progress === "number" ? msg.progress : 0,
          length: typeof msg.length === "number" ? msg.length : -1,
          dhtNodes: typeof msg.dhtNodes === "number" ? msg.dhtNodes : 0,
          hasMetadata: msg.hasMetadata === true,
          name: typeof msg.name === "string" ? msg.name : "",
          files: rawFiles
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
            .map((entry, index) => ({
              index: typeof entry.index === "number" ? entry.index : index,
              name: typeof entry.name === "string" ? entry.name : "",
              path: typeof entry.path === "string" ? entry.path : "",
              length: typeof entry.length === "number" ? entry.length : 0,
              downloaded: typeof entry.downloaded === "number" ? entry.downloaded : 0,
              progress: typeof entry.progress === "number" ? entry.progress : 0
            }))
        };
        this.#torrentStatsCache.set(id, stats);
        // 首条 stats = 引擎已受理该任务，唤醒 add 握手（元数据解析不再阻塞 add）。
        const handshake = this.#torrentHandshakeWaiters.get(id);
        if (handshake) {
          this.#torrentHandshakeWaiters.delete(id);
          handshake();
        }
        if (stats.hasMetadata) {
          this.#resolveTorrentMetadata(id, stats.name, stats.length, "");
        }
        break;
      }
      case "done": {
        const task = this.#tasks.get(id);
        if (task) this.#finishTask(task);
        break;
      }
      case "error": {
        const task = this.#tasks.get(id);
        if (task) this.#failTask(task, new Error(String(msg.message ?? "P2P 下载出错。")));
        break;
      }
      case "closed":
        this.#torrentStatsCache.delete(id);
        break;
      case "client-error":
        this.#options.log("download.p2p_client_error", { message: String(msg.message ?? "") });
        break;
      default:
        break;
    }
  }

  /**
   * 应用内安装 P2P 组件：npm 装进 userData 下的隔离 vendor 目录（不碰项目
   * node_modules / lockfile，pnpm 工作区也互不影响），然后单独补齐
   * node-datachannel 的原生二进制。成功后由调用方重启应用加载。
   */
  public async installP2pDependency(onProgress: (line: string) => void): Promise<void> {
    if (this.isP2pAvailable()) return;
    if (this.#p2pInstalling) throw new Error("P2P 组件正在安装中，请稍候。");
    this.#p2pInstalling = true;
    this.#emit();
    try {
      await this.#runP2pInstall(onProgress);
    } finally {
      this.#p2pInstalling = false;
      this.#emit();
    }
  }

  async #runP2pInstall(onProgress: (line: string) => void): Promise<void> {
    const vendor = this.#vendorDir();
    await fsp.mkdir(vendor, { recursive: true });
    const pkgPath = path.join(vendor, "package.json");
    if (!fs.existsSync(pkgPath)) {
      await fsp.writeFile(pkgPath, JSON.stringify({ name: "codexh-p2p-vendor", private: true }, null, 2), "utf8");
    }
    // 1) npm 静默脚本安装：node-datachannel 的 postinstall 要从 GitHub 拉
    //    prebuild，网络不稳会让整个安装失败；装完在第 2 步单独补，可控可重试。
    const command = `npm install webtorrent --ignore-scripts --no-audit --no-fund --loglevel=error --registry=https://registry.npmmirror.com --prefix "${vendor}"`;
    onProgress(`执行：${command}`);
    await this.#spawnWithWatchdog(command, { cwd: vendor }, onProgress);
    // 2) 补 node-datachannel 原生二进制（走 GitHub 加速代理，直连兜底）。
    await this.#ensureNodeDatachannelBinary(onProgress);
    // 3) 验证入口文件完整。
    if (!this.#torrentEntryPath()) {
      throw new Error("安装命令已成功，但 P2P 引擎文件不完整，请重试安装。");
    }
    onProgress("P2P 组件安装完成，即将重启应用加载。");
  }

  /** 带看门狗的子进程执行：连续一段时间无输出视为假死，主动终止并报错。 */
  async #spawnWithWatchdog(
    command: string,
    options: { cwd: string },
    onProgress: (line: string) => void,
    stallTimeoutMs = 180_000
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        ...options,
        shell: true,
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }
      });
      let tail = "";
      let lastActivityAt = Date.now();
      let settled = false;
      const watchdog = setInterval(() => {
        if (settled) return;
        if (Date.now() - lastActivityAt > stallTimeoutMs) {
          settled = true;
          clearInterval(watchdog);
          try { child.kill(); } catch { /* 进程已退出则忽略 */ }
          reject(new Error(`安装卡住已终止（连续 ${Math.round(stallTimeoutMs / 1000)} 秒无进展）。请检查网络或代理后重试。`));
        }
      }, 15_000);
      const collect = (chunk: Buffer) => {
        lastActivityAt = Date.now();
        const text = chunk.toString();
        tail = `${tail}${text}`.slice(-4000);
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) onProgress(trimmed);
        }
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        reject(new Error(`无法启动包管理器：${error.message}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        if (code === 0) {
          resolve();
          return;
        }
        const tailLines = tail.trim().split(/\r?\n/).slice(-3).join("  ");
        reject(new Error(`安装失败（退出码 ${code}）：${tailLines || "未知错误"}`));
      });
    });
  }

  /** 补齐 node-datachannel 的 napi prebuild（npm 包不含二进制，GitHub 直连常不稳，走加速代理兜底）。 */
  async #ensureNodeDatachannelBinary(onProgress: (line: string) => void): Promise<void> {
    const ndcDir = path.join(this.#vendorDir(), "node_modules", "node-datachannel");
    const binary = path.join(ndcDir, "build", "Release", "node_datachannel.node");
    if (fs.existsSync(binary)) return;
    let version = "";
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(ndcDir, "package.json"), "utf8")) as { version?: string };
      version = pkg.version ?? "";
    } catch { /* 目录不存在时由下方报错 */ }
    if (!version) throw new Error("未找到 node-datachannel 组件，无法补齐原生二进制。");
    const platform = process.platform;
    const arch = process.arch === "ia32" ? "x86" : process.arch;
    const asset = `node-datachannel-v${version}-napi-v8-${platform}-${arch}.tar.gz`;
    const releaseBase = `https://github.com/murat-dogan/node-datachannel/releases/download/v${version}`;
    const urls = [
      `https://gh-proxy.com/${releaseBase}/${asset}`,
      `${releaseBase}/${asset}`
    ];
    const tmpFile = path.join(this.#vendorDir(), asset);
    let downloaded = false;
    for (const url of urls) {
      onProgress(`下载原生组件：${url}`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 100_000) throw new Error("文件过小，疑似不完整");
        await fsp.writeFile(tmpFile, buffer);
        downloaded = true;
        break;
      } catch (error) {
        onProgress(`下载失败（${error instanceof Error ? error.message : String(error)}），尝试下一个源…`);
        await fsp.rm(tmpFile, { force: true });
      }
    }
    if (!downloaded) throw new Error("原生组件下载失败：所有下载源均不可达，请检查网络后重试。");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(`tar -xzf "${tmpFile}" -C "${ndcDir}"`, { shell: true });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) { resolve(); return; }
        reject(new Error(`解压原生组件失败（退出码 ${code}）。`));
      });
    });
    await fsp.rm(tmpFile, { force: true });
    if (!fs.existsSync(binary)) throw new Error("原生组件解压完成，但二进制文件缺失。");
    onProgress("原生组件就绪。");
  }

  public getSnapshot(): DownloadServiceSnapshot {
    return {
      tasks: [...this.#tasks.values()].map((task) => this.#publicTask(task)),
      history: [...this.#history.values()].map((task) => this.#publicTask(task)),
      defaultDir: this.getDefaultDir(),
      p2pAvailable: this.isP2pAvailable(),
      p2pInstalling: this.#p2pInstalling
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

  /**
   * 子任务（单文件）级控制：暂停=该文件暂不拉取分片；继续=恢复；
   * 删除=移出下载集合（BT 分片交错存储，已落盘部分无法精确抹除，仅不再继续）。
   * helper 侧同步更新它的选中集合，避免整任务 resume 时把暂停的文件重新选上。
   */
  public async controlDownloadFile(id: string, index: number, action: "pause" | "resume" | "remove"): Promise<DownloadTask> {
    const task = this.#tasks.get(id);
    if (!task) throw new Error("下载任务不存在或已结束。");
    if (task.kind !== "p2p") throw new Error("仅 BT/磁力任务支持子任务控制。");
    if (!Number.isInteger(index) || index < 0 || (task.files?.length ?? 0) <= index) {
      throw new Error("文件序号无效。");
    }
    if (action !== "pause" && action !== "resume" && action !== "remove") {
      throw new Error("未知的子任务操作。");
    }
    this.#p2pSend({ type: "control-file", id, index, action });
    const paused = new Set(task.pausedFiles ?? []);
    const removed = new Set(task.removedFiles ?? []);
    const selected = new Set(task.selectedFiles ?? (task.files ?? []).map((file) => file.index));
    if (action === "resume") {
      paused.delete(index);
      removed.delete(index);
      selected.add(index);
    } else {
      selected.delete(index);
      if (action === "pause") {
        paused.add(index);
        removed.delete(index);
      } else {
        removed.add(index);
        paused.delete(index);
      }
    }
    task.selectedFiles = [...selected].sort((a, b) => a - b);
    task.pausedFiles = [...paused].sort((a, b) => a - b);
    task.removedFiles = [...removed].sort((a, b) => a - b);
    // 未走过勾选弹窗的任务首次做子任务控制时，把进度口径切到选择聚合。
    if (!task.fileSelectionDone && (task.files?.length ?? 0) > 1) {
      task.fileSelectionDone = true;
      task.needsFileSelection = false;
    }
    await this.#persistTask(task).catch(() => undefined);
    this.#options.log("download.p2p_file_control", { id, index, action });
    this.#emit();
    return this.#publicTask(task);
  }

  /**
   * BT 多附件任务的文件勾选结果：把选择交给引擎（未勾选的文件 deselect），
   * 恢复任务，并把任务进度口径切到「勾选的文件」聚合。
   */
  public async selectDownloadFiles(id: string, indexes: number[]): Promise<DownloadTask> {
    const task = this.#tasks.get(id);
    if (!task) throw new Error("下载任务不存在或已结束。");
    if (task.kind !== "p2p") throw new Error("仅 BT/磁力任务支持按文件选择下载。");
    const unique = [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b);
    if (unique.length === 0) throw new Error("请至少勾选一个要下载的文件。");
    this.#p2pSend({ type: "select-files", id, indexes: unique });
    task.selectedFiles = unique;
    task.fileSelectionDone = true;
    task.needsFileSelection = false;
    if ((task.files?.length ?? 0) > 0) {
      const selected = new Set(unique);
      let total = 0;
      for (const file of task.files ?? []) {
        if (selected.has(file.index)) total += file.length;
      }
      if (total > 0) task.totalBytes = total;
    }
    if (task.status === "paused") {
      this.#torrents.get(id)?.resume();
      task.status = "downloading";
    }
    await this.#persistTask(task).catch(() => undefined);
    this.#options.log("download.p2p_files_selected", { id: task.id, selected: unique.length });
    this.#emit();
    return this.#publicTask(task);
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

  /**
   * 删除下载记录/取消任务时可选地把文件移入回收站（多文件种子是整个目录）。
   * 文件已不在磁盘按成功处理；返回错误信息，空串表示成功。
   */
  public async deleteFile(filePath: string): Promise<string> {
    const trimmed = filePath.trim();
    if (!trimmed) return "";
    if (!path.isAbsolute(trimmed)) return "删除文件失败：路径无效。";
    let stat: fs.Stats | null = null;
    try {
      stat = await fsp.stat(trimmed);
    } catch {
      return ""; // 文件已不在磁盘上，视为成功
    }
    if (stat.isDirectory()) {
      // 防呆：不允许删掉下载目录本身或它的祖先目录（P2P 解析期 filePath 是下载目录）。
      const defaultDir = this.getDefaultDir();
      const normalized = trimmed.endsWith(path.sep) ? trimmed.slice(0, -1) : trimmed;
      if (defaultDir) {
        const normalizedDefault = defaultDir.endsWith(path.sep) ? defaultDir.slice(0, -1) : defaultDir;
        if (normalizedDefault === normalized || normalizedDefault.startsWith(normalized + path.sep)) {
          return "删除文件失败：不能删除下载目录本身。";
        }
      }
    }
    try {
      await shell.trashItem(trimmed);
      this.#options.log("download.file_trashed", { filePath: trimmed });
      return "";
    } catch (error) {
      return `删除文件失败：${error instanceof Error ? error.message : String(error)}`;
    }
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
    // P2P 引擎子进程：随应用退出（helper 收到 stdin close 会自行清理退出）。
    try {
      this.#p2pProc?.stdin?.end();
      this.#p2pProc?.kill();
    } catch { /* 进程已退出则忽略 */ }
    this.#p2pProc = null;
    this.#p2pReadyPromise = null;
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
        // 双保险：除了 abort 信号，也直接看任务状态。万一出现「旧 controller
        // 还挂着新循环」的路径，暂停/取消后的第一个 chunk 就会停在这里。
        if (controller.signal.aborted || task.status !== "downloading") return;
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

  async #addTorrentTask(source: string, dirOverride?: string): Promise<DownloadTask> {
    const proc = await this.#ensureP2pProcess();
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

    // webtorrent 对磁力会忽略 announce 选项（实测），直接往 URI 追加 tr= 参数。
    let finalSource = source;
    if (/^magnet:/i.test(source)) {
      finalSource = source + EXTRA_ANNOUNCE.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join("");
    }
    this.#options.log("download.p2p_adding", { id, source: source.slice(0, 120), dir, magnet: /^magnet:/i.test(source) });

    this.#torrents.set(id, {
      pause: () => this.#p2pSend({ type: "pause", id }),
      resume: () => this.#p2pSend({ type: "resume", id }),
      destroy: (options) => this.#p2pSend({ type: "destroy", id, options }),
      stats: () => this.#torrentStatsCache.get(id) ?? null
    });
    try {
      // 只等「引擎受理」握手（首条 stats），不等元数据：冷启动 DHT 要慢慢
      // bootstrap，元数据可能要几十秒甚至更久，留给 probing 状态 + 180 秒
      // 解析超时去处理，界面在解析期持续显示节点数。
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#torrentHandshakeWaiters.delete(id);
          reject(new Error("P2P 引擎进程未响应任务请求，请重试。"));
        }, 15_000);
        this.#torrentHandshakeWaiters.set(id, () => {
          clearTimeout(timer);
          resolve();
        });
        void proc;
        this.#p2pSend({ type: "add", id, source: finalSource, path: dir });
      });
    } catch (error) {
      this.#torrents.delete(id);
      this.#torrentStatsCache.delete(id);
      this.#tasks.delete(id);
      this.#p2pSend({ type: "destroy", id });
      this.#emit();
      throw error;
    }
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
      if (task.kind === "p2p" && this.#refreshP2pTask(task, now)) changed = true;
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

  /**
   * P2P 任务每个 tick 从引擎拉实时状态：解析期让节点数动起来（否则界面永远假 0），
   * 元数据到达后转入下载态；解析超时给出明确失败原因。返回是否有变化需要广播。
   */
  #refreshP2pTask(task: RuntimeTask, now: number): boolean {
    let changed = false;
    const entry = this.#torrents.get(task.id);
    const stats = entry?.stats?.();
    if (stats) {
      if (stats.peers !== task.peers) { task.peers = stats.peers; changed = true; }
      if (stats.dhtNodes !== task.dhtNodes) { task.dhtNodes = stats.dhtNodes; changed = true; }
      if (stats.hasMetadata) {
        if (stats.name && stats.name !== task.fileName) { task.fileName = stats.name; changed = true; }
        if (stats.files.length > 0) task.files = stats.files;
        // 多附件任务：元数据一到就暂停等勾选，避免把用户不想要的文件全量拉下来。
        // 单文件种子与已做过选择的任务不受影响。
        if (stats.files.length > 1 && !task.fileSelectionDone && task.status === "downloading") {
          entry?.pause();
          task.status = "paused";
          task.speedBps = 0;
          task.needsFileSelection = true;
          this.#options.log("download.p2p_files_pending_selection", { id: task.id, files: stats.files.length });
          changed = true;
        }
        if (task.status !== "paused") {
          if (stats.downloaded !== task.receivedBytes) { task.receivedBytes = stats.downloaded; changed = true; }
          if (stats.progress !== task.progress) { task.progress = stats.progress; changed = true; }
        }
        // 做过选择后，任务进度按「勾选的文件」聚合，而不是全种子的 downloaded
        // （后者还包含勾选前已经灌进来的字节）。
        if (task.fileSelectionDone && task.selectedFiles && (task.files?.length ?? 0) > 0) {
          const selected = new Set(task.selectedFiles);
          let received = 0;
          let total = 0;
          for (const file of task.files ?? []) {
            if (!selected.has(file.index)) continue;
            received += file.downloaded;
            total += file.length;
          }
          task.receivedBytes = received;
          task.totalBytes = total > 0 ? total : task.totalBytes;
          task.progress = total > 0 ? Math.min(1, received / total) : task.progress;
          changed = true;
        }
      }
      // 暂停态不回灌字节数：webtorrent 的 pause 是软的（不取消在途分片请求，
      // peer 队列里的数据还会灌几秒，torrent.downloaded 持续上涨）。这里不挡住，
      // 界面就会出现「已暂停但进度条还在动」。恢复时 stats 会重新对齐。
      // （上面已处理 paused 的聚合路径，这里只挡 torrent 全局字节数。）
    }
    // 元数据已到（attach 回调里也会转一次，这里兜底解析期轮询路径）。
    if (task.status === "probing" && stats?.hasMetadata) {
      task.status = "downloading";
      changed = true;
    }
    if (task.status !== "probing") return changed;
    const startedAt = Date.parse(task.createdAt);
    if (Number.isFinite(startedAt) && now - startedAt > P2P_METADATA_TIMEOUT_MS) {
      this.#failTask(task, new Error(
        "解析磁力元数据超时（已等待 3 分钟）：本机网络未能从 DHT 与 tracker 找到可连接的做种节点。"
        + "可能是该种子已无活跃做种，或本机网络对 BT 流量受限。"
        + "可换用做种较多的资源，或使用附带可用 tracker 的磁力链接后重试。"
      ));
      return true;
    }
    return changed;
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

/**
 * 追加到磁力任务的公开 tracker（webtorrent 对自带 tracker 的磁力不会补默认列表）。
 * 全部走 WSS/TCP：UDP 受限的环境里这是 peer 发现的兜底通道。
 */
const EXTRA_ANNOUNCE = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.fastcast.nz",
  // 常规 BitTorrent 生态的开放 tracker：经典种子（影视/系统镜像）的节点
  // 主要在 udp/http tracker 上，wss 生态里没有它们。
  "udp://tracker.opentrackr.org:1337/announce",
  "http://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://explodie.org:6969/announce"
];

/** helper 进程推送的单任务实时状态。 */
type P2pTorrentStats = {
  peers: number;
  downloaded: number;
  progress: number;
  length: number;
  /** 引擎 DHT 路由表规模：解析期给用户「引擎活着、正在找节点」的可见反馈。 */
  dhtNodes: number;
  hasMetadata: boolean;
  name: string;
  /** 元数据解析后的文件明细（多附件任务的详情展开与勾选弹窗数据源）。 */
  files: Array<{ index: number; name: string; path: string; length: number; downloaded: number; progress: number }>;
};

/**
 * P2P 引擎 helper：由主进程写到 vendor 目录，用外部 Node 22 运行。
 * 必须独立进程的原因：webtorrent 的 DHT 在 Electron 43（Node 24）主进程里
 * 收不到任何节点/peer（listening 正常），Node 22 一切正常——实测见
 * memory/2026-10-14「解析中卡死」一节。协议：stdin/stdout 每行一个 JSON。
 */
const P2P_HELPER_SOURCE = String.raw`"use strict";
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");
const vendorDir = process.argv[2] || "";
function send(msg) { try { process.stdout.write(JSON.stringify(msg) + "\n"); } catch (e) { /* pipe gone */ } }
(async () => {
  try {
    const pkgPath = path.join(vendorDir, "node_modules", "webtorrent", "package.json");
    const pkg = require(pkgPath);
    const dot = pkg.exports && pkg.exports["."];
    const entry = typeof dot === "string" ? dot : (dot && (dot.import || dot.default || dot.node)) || pkg.main || "index.js";
    const mod = await import(pathToFileURL(path.join(vendorDir, "node_modules", "webtorrent", entry)).href);
    const WebTorrent = mod.default || mod;
    const client = new WebTorrent();
    client.on("error", (e) => send({ type: "client-error", message: String((e && e.message) || e) }));
    send({ type: "ready", node: process.version });
    const torrents = new Map();
    const selectedByTorrent = new Map();
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      let cmd = null;
      try { cmd = JSON.parse(line); } catch (e) { return; }
      if (!cmd || !cmd.type) return;
      const existing = cmd.id ? torrents.get(cmd.id) : null;
      if (cmd.type === "add") {
        try {
          const opts = { path: cmd.path };
          if (cmd.announce) opts.announce = cmd.announce;
          const torrent = client.add(cmd.source, opts, (tor) => {
            send({ type: "metadata", id: cmd.id, name: tor.name || "", length: tor.length || -1, path: tor.path || cmd.path });
          });
          torrents.set(cmd.id, torrent);
          torrent.on("error", (e) => send({ type: "error", id: cmd.id, message: String((e && e.message) || e) }));
          torrent.on("done", () => send({ type: "done", id: cmd.id }));
          const timer = setInterval(() => {
            try {
              let dhtNodes = 0;
              try {
                const nodes = torrent.client && torrent.client.dht && torrent.client.dht.nodes;
                dhtNodes = nodes ? (typeof nodes.count === "function" ? nodes.count() : (nodes.length || 0)) : 0;
              } catch (e2) { dhtNodes = 0; }
              // 文件明细最多带 200 个，超大种子只取前 200 个文件做展示与勾选。
              const files = (torrent.files || []).slice(0, 200).map((f, i) => ({
                index: i,
                name: f.name || "",
                path: (f.path || f.name || "").slice(0, 500),
                length: f.length || 0,
                downloaded: f.downloaded || 0,
                progress: f.progress || 0
              }));
              send({
                type: "stats", id: cmd.id,
                peers: torrent.numPeers || 0,
                downloaded: torrent.downloaded || 0,
                progress: torrent.progress || 0,
                length: torrent.length || -1,
                hasMetadata: !!torrent.name,
                name: torrent.name || "",
                dhtNodes: dhtNodes,
                files: files
              });
            } catch (e3) { clearInterval(timer); }
          }, 1000);
          torrent.once("close", () => { clearInterval(timer); torrents.delete(cmd.id); selectedByTorrent.delete(cmd.id); send({ type: "closed", id: cmd.id }); });
        } catch (e) { send({ type: "error", id: cmd.id, message: String((e && e.message) || e) }); }
        return;
      }
      if (!existing) return;
      if (cmd.type === "pause") {
        // pause 只是不再请求新分片，在途请求还会继续灌数据；把 wire 一并断开，
        // 让「暂停」立刻见效（resume 后靠 DHT/tracker 重新握手，继续下载）。
        existing.pause();
        try { (existing.wires || []).forEach((w) => { try { w.destroy(); } catch (e4) {} }); } catch (e5) {}
      }
      else if (cmd.type === "resume") {
        existing.resume();
        // resume 会恢复引擎默认的「全选」，把用户勾选过的子集重新套回去。
        const kept = selectedByTorrent.get(cmd.id);
        if (kept) {
          try { (existing.files || []).forEach((f, i) => { try { kept.has(i) ? f.select(1) : f.deselect(); } catch (e8) {} }); } catch (e9) {}
        }
      }
      else if (cmd.type === "select-files") {
        const wanted = new Set(Array.isArray(cmd.indexes) ? cmd.indexes.filter((n) => Number.isInteger(n)) : []);
        try { (existing.files || []).forEach((f, i) => { try { wanted.has(i) ? f.select(1) : f.deselect(); } catch (e6) {} }); } catch (e7) {}
        selectedByTorrent.set(cmd.id, wanted);
      }
      else if (cmd.type === "control-file") {
        // 子任务级控制：维护引擎侧选中集合（整任务 resume 时会重放），再对单个文件
        // 做 select/deselect；remove 与 pause 同为 deselect，差别只在主进程的 UI 状态。
        const files = existing.files || [];
        const kept = selectedByTorrent.get(cmd.id) || new Set(files.map((_, i) => i));
        if (cmd.action === "resume") kept.add(cmd.index);
        else kept.delete(cmd.index);
        selectedByTorrent.set(cmd.id, kept);
        const target = files[cmd.index];
        if (target) {
          try { cmd.action === "resume" ? target.select(1) : target.deselect(); } catch (e10) {}
        }
      }
      else if (cmd.type === "destroy") existing.destroy(cmd.options || {});
    });
    process.stdin.on("close", () => {
      try { client.destroy(() => process.exit(0)); } catch (e) { process.exit(0); }
      setTimeout(() => process.exit(0), 3000);
    });
  } catch (e) {
    send({ type: "fatal", message: String((e && e.message) || e) });
    process.exit(1);
  }
})();
`;
