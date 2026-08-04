import fs from "node:fs/promises";
import path from "node:path";
import { net } from "electron";
import {
  hasAttachmentDisposition,
  isTextualResponseMimeType,
  normalizeResponseMimeType,
  looksLikeBinaryData,
  resolveHttpDownloadFileName,
  shouldDownloadHttpResponse
} from "./http-download";

export const HTTP_PROXY_TIMEOUT_MS = 30_000;
export const HTTP_PROXY_MAX_BODY_BYTES = 1024 * 1024;
export const HTTP_PROXY_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export interface HttpProxyRequestPayload {
  threadId: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  downloadFileName?: string;
}

export type HttpProxyResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      bodyText: string;
      bodyKind: "text" | "file";
      download?: {
        fileName: string;
        filePath: string;
        mimeType: string;
        sizeBytes: number;
      };
      truncated: boolean;
      durationMs: number;
    }
  | { ok: false; error: string };

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) => typeof key === "string" && typeof item === "string"
  );
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  deadlineAt: number,
  binaryMaxBytes = maxBytes
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const effectiveLimit = looksLikeBinaryData(bytes) ? binaryMaxBytes : maxBytes;
    if (bytes.byteLength <= effectiveLimit) return { bytes, truncated: false };
    return { bytes: bytes.slice(0, effectiveLimit), truncated: true };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  let effectiveLimit = maxBytes;
  try {
    for (;;) {
      if (Date.now() > deadlineAt) {
        truncated = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (received === 0 && binaryMaxBytes > maxBytes && looksLikeBinaryData(value)) {
        effectiveLimit = binaryMaxBytes;
      }
      received += value.byteLength;
      if (received > effectiveLimit) {
        const remaining = effectiveLimit - (received - value.byteLength);
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已关闭时忽略取消错误。
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged, truncated };
}

export async function writeUniqueDownload(directory: string, fileName: string, bytes: Uint8Array): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = path.join(directory, attempt === 0 ? fileName : `${stem} (${attempt})${extension}`);
    try {
      const handle = await fs.open(candidate, "wx");
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法生成不重复的下载文件名。");
}

export async function executeHttpRequest(
  payload: HttpProxyRequestPayload,
  getThreadOutputDir: (threadId: string) => Promise<string>
): Promise<HttpProxyResult> {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "请求参数缺失。" };
  }
  const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "";
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, error: `不支持的请求方法:${String(payload.method)}。` };
  }
  if (typeof payload.url !== "string" || !payload.url) {
    return { ok: false, error: "请求地址缺失。" };
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(payload.url);
  } catch {
    return { ok: false, error: "请求地址无法解析。" };
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    return { ok: false, error: "仅支持 http/https 请求。" };
  }
  if (payload.headers !== undefined && !isPlainStringRecord(payload.headers)) {
    return { ok: false, error: "请求头格式非法。" };
  }
  if (payload.body !== undefined && typeof payload.body !== "string") {
    return { ok: false, error: "请求体必须是字符串。" };
  }
  if (typeof payload.threadId !== "string" || !payload.threadId.trim()) {
    return { ok: false, error: "任务 ID 缺失。" };
  }
  if (payload.downloadFileName !== undefined && typeof payload.downloadFileName !== "string") {
    return { ok: false, error: "下载文件名格式非法。" };
  }
  if ((method === "GET" || method === "HEAD") && payload.body) {
    return { ok: false, error: `${method} 请求不允许携带请求体。` };
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + HTTP_PROXY_TIMEOUT_MS * 2;
  try {
    const response = await net.fetch(targetUrl.toString(), {
      method,
      headers: payload.headers ?? {},
      body: payload.body,
      signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS),
      redirect: "follow",
      cache: "no-store"
    });
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const mimeType = normalizeResponseMimeType(responseHeaders);
    const possibleFile = response.status >= 200 && response.status < 300 && (
      hasAttachmentDisposition(responseHeaders) || !isTextualResponseMimeType(mimeType)
    );
    const declaredBodyBytes = Number(responseHeaders["content-length"] ?? 0);
    if (possibleFile && Number.isFinite(declaredBodyBytes) && declaredBodyBytes > HTTP_PROXY_MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: `返回文件超过 ${Math.round(HTTP_PROXY_MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB，未开始下载。` };
    }
    const bodyLimit = method === "HEAD"
      ? 0
      : possibleFile || !mimeType
        ? HTTP_PROXY_MAX_DOWNLOAD_BYTES
        : HTTP_PROXY_MAX_BODY_BYTES;
    const { bytes, truncated } =
      bodyLimit === 0
        ? { bytes: new Uint8Array(), truncated: false }
        : await readBodyWithLimit(response, bodyLimit, deadlineAt, HTTP_PROXY_MAX_DOWNLOAD_BYTES);
    const downloadResponse = shouldDownloadHttpResponse(response.status, responseHeaders, bytes);
    if (downloadResponse && truncated) {
      return { ok: false, error: `返回文件超过 ${Math.round(HTTP_PROXY_MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB，未保存不完整文件。` };
    }
    if (downloadResponse) {
      const fileName = resolveHttpDownloadFileName({
        preferredFileName: payload.downloadFileName,
        headers: responseHeaders,
        url: targetUrl.toString()
      });
      const outputDir = await getThreadOutputDir(payload.threadId);
      const filePath = await writeUniqueDownload(outputDir, fileName, bytes);
      return {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        bodyText: "",
        bodyKind: "file",
        download: {
          fileName: path.basename(filePath),
          filePath,
          mimeType: mimeType || "application/octet-stream",
          sizeBytes: bytes.byteLength
        },
        truncated: false,
        durationMs: Date.now() - startedAt
      };
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      bodyText: new TextDecoder().decode(bytes),
      bodyKind: "text",
      truncated,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, error: `请求超时(${Math.round(HTTP_PROXY_TIMEOUT_MS / 1000)} 秒)。` };
    }
    return { ok: false, error: `请求失败:${error instanceof Error ? error.message : String(error)}` };
  }
}
