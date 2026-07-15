import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

export type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  remoteVersion?: string;
  changelog?: string;
  downloadUrl?: string;
  insecureTransport?: boolean;
  missingSha256?: boolean;
  progress?: number;
  receivedBytes?: number;
  totalBytes?: number;
  downloadedInstaller?: string;
  error?: string;
  isPackaged: boolean;
}

interface UpdateManifest {
  version_code?: unknown;
  download_url?: unknown;
  sha256?: unknown;
  hash?: unknown;
  checksum?: unknown;
  file_sha256?: unknown;
  changelog?: unknown;
}

interface UpdateServiceOptions {
  currentVersion: string;
  isPackaged: boolean;
  cacheDir: string;
  executablePath: string;
  getRunningTaskCount: () => number;
  log: (kind: string, payload: Record<string, unknown>) => Promise<void>;
  emit: (state: UpdateState) => void;
  quit: () => void;
}

const VERSION_ENDPOINT = "http://8.162.8.43:3002/api/version/latest";
const UPDATE_TIMEOUT_MS = 10_000;

export class UpdateService {
  readonly #state: UpdateState;
  #expectedSha256: string | null = null;
  #downloadedInstaller: string | null = null;

  public constructor(private readonly options: UpdateServiceOptions) {
    this.#state = {
      phase: "idle",
      currentVersion: options.currentVersion,
      isPackaged: options.isPackaged
    };
  }

  public getState(): UpdateState {
    return { ...this.#state };
  }

  public async check(): Promise<UpdateState> {
    this.#setState({
      phase: "checking",
      error: undefined,
      progress: undefined,
      receivedBytes: undefined,
      totalBytes: undefined,
      downloadedInstaller: undefined
    });
    await this.options.log("update.check_started", { currentVersion: this.#state.currentVersion });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);

    try {
      const response = await fetch(VERSION_ENDPOINT, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`更新服务返回 HTTP ${response.status}。`);
      const manifest = await response.json() as UpdateManifest;
      const remoteVersion = readVersion(manifest.version_code);
      const downloadUrl = readDownloadUrl(manifest.download_url);
      const sha256 = readSha256(manifest.sha256 ?? manifest.hash ?? manifest.checksum ?? manifest.file_sha256);
      const changelog = typeof manifest.changelog === "string" ? manifest.changelog.trim() : "";
      const insecureTransport = new URL(downloadUrl).protocol === "http:" || new URL(VERSION_ENDPOINT).protocol === "http:";
      const missingSha256 = sha256 === null;

      if (!isVersionGreater(remoteVersion, this.#state.currentVersion)) {
        this.#expectedSha256 = null;
        this.#downloadedInstaller = null;
        this.#setState({
          phase: "up-to-date", remoteVersion, changelog, downloadUrl, insecureTransport, missingSha256,
          error: undefined, receivedBytes: undefined, totalBytes: undefined, downloadedInstaller: undefined
        });
        await this.options.log("update.not_available", { currentVersion: this.#state.currentVersion, remoteVersion });
        return this.getState();
      }

      this.#expectedSha256 = sha256;
      this.#downloadedInstaller = null;
      this.#setState({
        phase: "available", remoteVersion, changelog, downloadUrl, insecureTransport, missingSha256,
        error: undefined, progress: undefined, receivedBytes: undefined, totalBytes: undefined, downloadedInstaller: undefined
      });
      await this.options.log("update.available", { currentVersion: this.#state.currentVersion, remoteVersion, insecureTransport, missingSha256 });
      // 仅在 HTTPS 且具备 sha256 时自动下载，避免未校验安装包静默落地。
      if (!insecureTransport && !missingSha256 && this.options.isPackaged) {
        void this.download(false);
      }
      return this.getState();
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "检查更新超时，请稍后重试。"
        : error instanceof Error ? error.message : String(error);
      this.#setState({ phase: "error", error: message });
      await this.options.log("update.check_failed", { message });
      return this.getState();
    } finally {
      clearTimeout(timeout);
    }
  }

  public async download(confirmInsecureHttp: boolean): Promise<UpdateState> {
    if (!this.options.isPackaged) throw new Error("开发模式只能检查更新，不能下载或覆盖安装。");
    if (this.#state.phase !== "available" || !this.#state.downloadUrl || !this.#state.remoteVersion) {
      throw new Error("当前没有可下载的更新。");
    }
    if ((this.#state.insecureTransport || this.#state.missingSha256) && !confirmInsecureHttp) {
      throw new Error(this.#state.missingSha256
        ? "更新清单未提供 sha256，需确认后才可下载未校验安装包。"
        : "当前更新源使用不安全 HTTP，需确认后才可下载。");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const updatesDir = path.join(this.options.cacheDir, "updates");
    const target = path.join(updatesDir, `CodeXH-Setup-${this.#state.remoteVersion}.exe`);
    const partial = `${target}.partial`;
    try {
      this.#setState({ phase: "downloading", progress: 0, receivedBytes: 0, totalBytes: undefined, downloadedInstaller: undefined, error: undefined });
      await this.options.log("update.download_started", { remoteVersion: this.#state.remoteVersion, insecureTransport: this.#state.insecureTransport === true });
      await fsp.mkdir(updatesDir, { recursive: true });
      await fsp.rm(partial, { force: true });
      const response = await fetch(this.#state.downloadUrl, { signal: controller.signal, cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`下载更新失败：HTTP ${response.status}。`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/html")) {
        throw new Error("下载地址返回了网页而不是 Windows 安装包，请联系更新服务管理员修正下载地址。");
      }
      const total = Number(response.headers.get("content-length") ?? 0);
      this.#setState({ totalBytes: Number.isFinite(total) && total > 0 ? total : undefined });
      const hash = createHash("sha256");
      const output = fs.createWriteStream(partial, { flags: "w" });
      const reader = response.body.getReader();
      let received = 0;
      let isFirstChunk = true;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (isFirstChunk) {
            isFirstChunk = false;
            if (chunk.byteLength < 2 || chunk[0] !== 0x4d || chunk[1] !== 0x5a) {
              throw new Error("下载内容不是有效的 Windows 安装包，请联系更新服务管理员修正下载地址。");
            }
          }
          hash.update(chunk);
          received += chunk.byteLength;
          if (!output.write(chunk)) await once(output, "drain");
          this.#setState({
            progress: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : undefined,
            receivedBytes: received
          });
        }
        output.end();
        await once(output, "finish");
      } catch (error) {
        output.destroy();
        throw error;
      }

      if (received === 0) throw new Error("下载的安装包为空。");
      const actualSha256 = hash.digest("hex");
      if (this.#expectedSha256 && actualSha256 !== this.#expectedSha256) {
        throw new Error("安装包 SHA-256 校验失败，已拒绝安装。");
      }
      await fsp.rename(partial, target);
      this.#downloadedInstaller = target;
      this.#setState({ phase: "downloaded", progress: 100, receivedBytes: received, totalBytes: total || undefined, downloadedInstaller: target, error: undefined });
      await this.options.log(
        this.#expectedSha256 ? "update.download_verified" : "update.download_unverified",
        { remoteVersion: this.#state.remoteVersion, bytes: received, sha256: actualSha256 }
      );
      return this.getState();
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => undefined);
      const message = error instanceof Error && error.name === "AbortError"
        ? "下载安装包超时，请稍后重试。"
        : error instanceof Error ? error.message : String(error);
      this.#setState({ phase: "error", error: message, progress: undefined, receivedBytes: undefined, totalBytes: undefined, downloadedInstaller: undefined });
      await this.options.log("update.download_failed", { message });
      return this.getState();
    } finally {
      clearTimeout(timeout);
    }
  }

  public async install(): Promise<void> {
    if (!this.options.isPackaged) throw new Error("开发模式不能执行覆盖安装。");
    if (this.#state.phase !== "downloaded" || !this.#downloadedInstaller) throw new Error("安装包尚未下载并校验完成。");
    if (this.options.getRunningTaskCount() > 0) throw new Error("仍有执行中的任务，请完成或停止任务后再安装更新。");

    const launcher = path.join(this.options.cacheDir, "updates", `install-${Date.now()}.cmd`);
    const installer = quoteForCmd(this.#downloadedInstaller);
    const executable = quoteForCmd(this.options.executablePath);
    const command = [
      "@echo off",
      "timeout /t 2 /nobreak >nul",
      `start \"\" /wait ${installer} /S`,
      `start \"\" ${executable}`,
      "del \"%~f0\""
    ].join("\r\n");
    await fsp.writeFile(launcher, command, "utf8");
    const child = spawn("cmd.exe", ["/d", "/c", launcher], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    this.#setState({ phase: "installing", error: undefined });
    await this.options.log("update.install_started", { remoteVersion: this.#state.remoteVersion });
    setTimeout(() => this.options.quit(), 200);
  }

  #setState(patch: Partial<UpdateState>): void {
    Object.assign(this.#state, patch);
    this.options.emit(this.getState());
  }
}

function readVersion(value: unknown): string {
  if (typeof value !== "string" || !isSemver(value.trim())) throw new Error("更新服务返回的 version_code 无效。");
  return value.trim().replace(/^v/i, "");
}

function readDownloadUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("更新服务未返回 download_url。");
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol) || !url.pathname.toLowerCase().endsWith(".exe")) {
    throw new Error("更新服务返回的 download_url 无效。");
  }
  return url.toString();
}

function readSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^sha-?256\s*[:=]?\s*/i, "");
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return null;
  return normalized.toLowerCase();
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

export function isVersionGreater(candidate: string, current: string): boolean {
  const next = parseSemver(candidate);
  const installed = parseSemver(current);
  if (!next || !installed) return false;
  for (const index of [0, 1, 2]) {
    if (next.core[index] !== installed.core[index]) return next.core[index] > installed.core[index];
  }
  if (!next.prerelease && installed.prerelease) return true;
  if (next.prerelease && !installed.prerelease) return false;
  return (next.prerelease ?? "").localeCompare(installed.prerelease ?? "", undefined, { numeric: true }) > 0;
}

function isSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

function parseSemver(value: string): { core: number[]; prerelease?: string } | null {
  const matched = value.trim().replace(/^v/i, "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/);
  return matched ? { core: [Number(matched[1]), Number(matched[2]), Number(matched[3])], prerelease: matched[4] } : null;
}
