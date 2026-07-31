import { net } from "electron";

export const HTTP_PROXY_TIMEOUT_MS = 30_000;
export const HTTP_PROXY_MAX_BODY_BYTES = 1024 * 1024;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export interface HttpProxyRequestPayload {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export type HttpProxyResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      bodyText: string;
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
  deadlineAt: number
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= maxBytes) return { text, truncated: false };
    return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)), truncated: true };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      if (Date.now() > deadlineAt) {
        truncated = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        const remaining = maxBytes - (received - value.byteLength);
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
  return { text: new TextDecoder().decode(merged), truncated };
}

export async function executeHttpRequest(payload: HttpProxyRequestPayload): Promise<HttpProxyResult> {
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
    const bodyLimit = method === "HEAD" ? 0 : HTTP_PROXY_MAX_BODY_BYTES;
    const { text, truncated } =
      bodyLimit === 0
        ? { text: "", truncated: false }
        : await readBodyWithLimit(response, bodyLimit, deadlineAt);
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      bodyText: text,
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
