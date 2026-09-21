import { randomUUID } from "node:crypto";

const CLOUD_NOTES_TIMEOUT_MS = 15_000;
const DEFAULT_CLOUD_NOTES_PORT = "3003";

/** 服务端 NoteSchema 的镜像：字段名保持与服务端一致，便于直接落库。 */
export type ServerNote = {
  id: string;
  title: string;
  content: string;
  version: number;
  seq: number;
  deleted: boolean;
  clientUpdatedAt?: string;
  serverUpdatedAt?: string;
  deviceId?: string | null;
};

export type CloudNoteChange = {
  id: string;
  title?: string;
  content?: string;
  version?: number;
  deleted?: boolean;
  clientUpdatedAt?: string;
  deviceId?: string;
};

export type CloudSyncOutcome = {
  applied: Array<{ id: string; status: "created" | "updated" | "conflict" | "unchanged"; version: number }>;
  conflicts: ServerNote[];
  notes: ServerNote[];
  cursor: number;
  serverTime: string;
};

export type CloudNotesSession = {
  serverUrl: string;
  userId: string;
  email: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
};

export type CloudNotesAccount = CloudNotesSession & {
  cursor: number;
  lastSyncedAt: string | null;
  deviceId: string;
};

export type CloudNoteRecord = {
  id: string;
  title: string;
  content: string;
  version: number;
  seq: number;
  deleted: boolean;
  dirty: boolean;
  serverUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudNotesStatus = {
  configured: boolean;
  serverUrl: string;
  email: string;
  displayName: string;
  lastSyncedAt: string | null;
  cursor: number;
  noteCount: number;
  pendingCount: number;
};

export type CloudNotesSyncResult = {
  pushed: number;
  pulled: number;
  conflicts: Array<{ id: string; title: string; serverTitle: string; draftId: string | null }>;
  noteCount: number;
  pendingCount: number;
  cursor: number;
  syncedAt: string;
};

/** 服务端错误体固定为 { error, message }，这里把它保留下来供上层区分冲突与鉴权失效。 */
export class CloudNotesError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly payload: unknown;

  constructor(code: string, message: string, status = 0, payload: unknown = null) {
    super(message);
    this.name = "CloudNotesError";
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

export function createDeviceId(): string {
  return randomUUID();
}

/** 允许用户只填 `192.168.1.10`，自动补协议与默认端口 3003。 */
export function normalizeServerUrl(input: string): string {
  const trimmed = (input ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new CloudNotesError("INVALID_SERVER_URL", "请填写云笔记服务器地址。");
  }
  // 显式写了协议时只接受 http/https；否则 `ftp://host` 会被当成主机名，
  // 拼成 `http://ftp://host` 后协议校验依然通过，非法地址会被放过。
  const explicitScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (explicitScheme && !/^https?$/i.test(explicitScheme[1])) {
    throw new CloudNotesError("INVALID_SERVER_URL", "服务器地址只支持 http 或 https。");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CloudNotesError("INVALID_SERVER_URL", "服务器地址格式不正确，例如 http://127.0.0.1:3003。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CloudNotesError("INVALID_SERVER_URL", "服务器地址只支持 http 或 https。");
  }
  // 带路径前缀说明走的是反向代理（例如 http://host/cloudnotes），端口由代理决定，不能补 3003。
  const pathPrefix = parsed.pathname.replace(/\/+$/, "");
  if (!parsed.port && parsed.protocol === "http:" && !pathPrefix) {
    parsed.port = DEFAULT_CLOUD_NOTES_PORT;
  }
  return `${parsed.protocol}//${parsed.host}${pathPrefix}`;
}

function toSession(serverUrl: string, payload: unknown): CloudNotesSession {
  const body = (payload ?? {}) as Record<string, unknown>;
  const user = (body.user ?? {}) as Record<string, unknown>;
  const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  if (!accessToken || !refreshToken) {
    throw new CloudNotesError("INVALID_SESSION", "服务器返回的登录态不完整，请确认服务端版本一致。");
  }
  const expiresIn = typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn) ? body.expiresIn : 900;
  const email = typeof user.email === "string" ? user.email : "";
  return {
    serverUrl,
    userId: typeof user.id === "string" ? user.id : "",
    email,
    displayName: typeof user.displayName === "string" && user.displayName ? user.displayName : email,
    accessToken,
    refreshToken,
    tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
}

function toServerNote(value: unknown): ServerNote | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) return null;
  return {
    id,
    title: typeof row.title === "string" ? row.title : "",
    content: typeof row.content === "string" ? row.content : "",
    version: Number(row.version ?? 0) || 0,
    seq: Number(row.seq ?? 0) || 0,
    deleted: row.deleted === true,
    clientUpdatedAt: typeof row.clientUpdatedAt === "string" ? row.clientUpdatedAt : undefined,
    serverUpdatedAt: typeof row.serverUpdatedAt === "string" ? row.serverUpdatedAt : undefined,
    deviceId: typeof row.deviceId === "string" ? row.deviceId : null
  };
}

function toServerNoteList(value: unknown): ServerNote[] {
  if (!Array.isArray(value)) return [];
  const notes: ServerNote[] = [];
  for (const entry of value) {
    const note = toServerNote(entry);
    if (note) notes.push(note);
  }
  return notes;
}

export class CloudNotesClient {
  readonly #baseUrl: string;
  #accessToken: string;
  #refreshToken: string;
  #onSession: ((session: { accessToken: string; refreshToken: string; tokenExpiresAt: string }) => void) | null;
  #refreshing: Promise<void> | null = null;

  constructor(options: {
    baseUrl: string;
    accessToken?: string;
    refreshToken?: string;
    onSession?: (session: { accessToken: string; refreshToken: string; tokenExpiresAt: string }) => void;
  }) {
    this.#baseUrl = normalizeServerUrl(options.baseUrl);
    this.#accessToken = options.accessToken ?? "";
    this.#refreshToken = options.refreshToken ?? "";
    this.#onSession = options.onSession ?? null;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** 登录或注册，成功后即可用返回的令牌真实读写笔记。 */
  static async connect(options: {
    serverUrl: string;
    email: string;
    password: string;
    mode: "login" | "register";
    displayName?: string;
  }): Promise<CloudNotesSession> {
    const baseUrl = normalizeServerUrl(options.serverUrl);
    const email = options.email.trim();
    if (!email) throw new CloudNotesError("INVALID_EMAIL", "请填写登录邮箱。");
    if (!options.password) throw new CloudNotesError("INVALID_PASSWORD", "请填写密码。");
    const client = new CloudNotesClient({ baseUrl });
    const path = options.mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const body =
      options.mode === "register"
        ? { email, password: options.password, displayName: options.displayName?.trim() || undefined }
        : { email, password: options.password };
    const payload = await client.#request(path, { method: "POST", body: JSON.stringify(body) }, false);
    return toSession(baseUrl, payload);
  }

  async #request(
    path: string,
    init: { method: string; body?: string; auth?: boolean },
    allowRefresh = true
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body) headers["content-type"] = "application/json";
    if (init.auth !== false && this.#accessToken) headers.authorization = `Bearer ${this.#accessToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUD_NOTES_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new CloudNotesError(
        aborted ? "TIMEOUT" : "NETWORK_ERROR",
        aborted
          ? `请求 ${this.#baseUrl} 超时，请确认服务端可用。`
          : `无法连接 ${this.#baseUrl}，请确认服务已启动且地址可访问。`
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 && allowRefresh && init.auth !== false && this.#refreshToken) {
      await this.#refreshSession();
      return this.#request(path, init, false);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const body = (payload ?? {}) as Record<string, unknown>;
      const code = typeof body.error === "string" ? body.error : `HTTP_${response.status}`;
      const message = typeof body.message === "string" ? body.message : `请求失败（HTTP ${response.status}）。`;
      throw new CloudNotesError(code, message, response.status, payload);
    }
    return payload;
  }

  async #refreshSession(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const payload = (await this.#request(
        "/api/auth/refresh",
        { method: "POST", body: JSON.stringify({ refreshToken: this.#refreshToken }), auth: false },
        false
      )) as Record<string, unknown>;
      const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken : "";
      const refreshToken = typeof payload?.refreshToken === "string" ? payload.refreshToken : "";
      if (!accessToken || !refreshToken) {
        throw new CloudNotesError("INVALID_REFRESH_TOKEN", "登录状态已失效，请重新连接。");
      }
      const expiresIn = typeof payload?.expiresIn === "number" ? payload.expiresIn : 900;
      this.#accessToken = accessToken;
      this.#refreshToken = refreshToken;
      this.#onSession?.({
        accessToken,
        refreshToken,
        tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
      });
    })();
    try {
      await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  async listSince(since: number): Promise<{ notes: ServerNote[]; cursor: number; serverTime: string }> {
    const query = since > 0 ? `?since=${encodeURIComponent(String(since))}&includeDeleted=true` : "?includeDeleted=true";
    const payload = (await this.#request(`/api/notes${query}`, { method: "GET" })) as Record<string, unknown>;
    return {
      notes: toServerNoteList(payload?.notes),
      cursor: Number(payload?.cursor ?? 0) || 0,
      serverTime: typeof payload?.serverTime === "string" ? payload.serverTime : new Date().toISOString()
    };
  }

  /** 一次往返完成「推送本地改动 + 拉取服务端变更」。 */
  async sync(input: { since: number; changes: CloudNoteChange[]; deviceId: string }): Promise<CloudSyncOutcome> {
    const payload = (await this.#request("/api/notes/sync", {
      method: "POST",
      body: JSON.stringify({ since: input.since, changes: input.changes, deviceId: input.deviceId })
    })) as Record<string, unknown>;
    const applied = Array.isArray(payload?.applied)
      ? payload.applied
          .map((entry) => {
            const row = (entry ?? {}) as Record<string, unknown>;
            const id = typeof row.id === "string" ? row.id : "";
            if (!id) return null;
            const status = row.status;
            return {
              id,
              status:
                status === "created" || status === "updated" || status === "conflict" || status === "unchanged"
                  ? status
                  : "unchanged",
              version: Number(row.version ?? 0) || 0
            } as CloudSyncOutcome["applied"][number];
          })
          .filter((entry): entry is CloudSyncOutcome["applied"][number] => entry !== null)
      : [];
    return {
      applied,
      conflicts: toServerNoteList(payload?.conflicts),
      notes: toServerNoteList(payload?.notes),
      cursor: Number(payload?.cursor ?? 0) || 0,
      serverTime: typeof payload?.serverTime === "string" ? payload.serverTime : new Date().toISOString()
    };
  }

  async putNote(
    id: string,
    change: { title?: string; content: string; version?: number; clientUpdatedAt?: string; deviceId?: string }
  ): Promise<{ status: "created" | "updated" | "unchanged"; note: ServerNote }> {
    const payload = (await this.#request(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        title: change.title,
        content: change.content,
        version: change.version,
        clientUpdatedAt: change.clientUpdatedAt,
        deviceId: change.deviceId
      })
    })) as Record<string, unknown>;
    const note = toServerNote(payload?.note);
    if (!note) throw new CloudNotesError("INVALID_RESPONSE", "服务器返回的笔记数据不完整。");
    const status = payload?.status;
    return { status: status === "created" || status === "unchanged" ? status : "updated", note };
  }

  async deleteNote(id: string, version?: number): Promise<{ status: string; note: ServerNote | null }> {
    const query = typeof version === "number" ? `?version=${encodeURIComponent(String(version))}` : "";
    const payload = (await this.#request(`/api/notes/${encodeURIComponent(id)}${query}`, { method: "DELETE" })) as Record<
      string,
      unknown
    >;
    return {
      status: typeof payload?.status === "string" ? payload.status : "updated",
      note: toServerNote(payload?.note)
    };
  }

  /** 撤销当前 refreshToken；失败不阻塞本地断开。 */
  async revoke(refreshToken: string): Promise<void> {
    if (!refreshToken) return;
    try {
      await this.#request(
        "/api/auth/logout",
        { method: "POST", body: JSON.stringify({ refreshToken, all: false }), auth: false },
        false
      );
    } catch {
      // 断开连接以本地清理为准，服务端会话过期后自然失效。
    }
  }
}

/** 409 冲突时从错误体里取出服务端权威副本。 */
export function readConflictNote(error: unknown): ServerNote | null {
  if (!(error instanceof CloudNotesError)) return null;
  if (error.code !== "VERSION_CONFLICT") return null;
  const payload = (error.payload ?? {}) as Record<string, unknown>;
  return toServerNote(payload.server);
}
