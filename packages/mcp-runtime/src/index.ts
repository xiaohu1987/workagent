import type {
  McpRepositoryResultItem,
  McpRepositoryResultKind,
  McpRepositoryToolResult,
  McpServerConfig,
  McpToolApprovalMode,
  ToolSpecDefinition
} from "@shared-types";

export type { McpRepositoryResultItem, McpRepositoryResultKind, McpRepositoryToolResult } from "@shared-types";

export type McpOAuthProvider = import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider;

export type McpClient = {
  listTools?: () => Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }> }>;
  callTool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<any>;
  listResources?: () => Promise<{ resources?: Array<{ uri: string; name?: string; description?: string }> }>;
  listResourceTemplates?: () => Promise<{ resourceTemplates?: Array<{ uriTemplate: string; name?: string }> }>;
  readResource?: (params: { uri: string }) => Promise<any>;
  listPrompts?: () => Promise<{ prompts?: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }> }>;
  getPrompt?: (params: { name: string; arguments?: Record<string, string> }) => Promise<any>;
  close?: () => Promise<void>;
};

export interface McpToolDescriptor {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approvalMode: McpToolApprovalMode;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface McpPromptDescriptor {
  server: string;
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpConnectionStatus {
  serverId: string;
  state: "idle" | "connecting" | "connected" | "error" | "disabled";
  error?: string;
  connectedAt?: string;
}

export interface McpConnectionTestResult {
  tools: McpToolDescriptor[];
  resources: Array<{ uri: string; name: string; description: string }>;
  resourceTemplates: Array<{ uriTemplate: string; name: string }>;
  prompts: McpPromptDescriptor[];
}

export interface McpManagerOptions {
  resolveBearerToken?: (config: McpServerConfig) => string | undefined | Promise<string | undefined>;
  createOAuthProvider?: (config: McpServerConfig) => McpOAuthProvider | undefined | Promise<McpOAuthProvider | undefined>;
  toolCacheTtlMs?: number;
  onToolsChanged?: (serverId: string) => void;
}

/**
 * Reads the optional repository-inspection envelope from either MCP structured
 * content or a JSON text content block. Servers that do not implement the
 * contract continue to work and simply return null here.
 */
export function extractMcpRepositoryToolResult(raw: unknown): McpRepositoryToolResult | null {
  for (const candidate of collectMcpResultCandidates(raw)) {
    const normalized = normalizeMcpRepositoryToolResult(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function collectMcpResultCandidates(raw: unknown): unknown[] {
  const candidates: unknown[] = [raw];
  if (!isRecord(raw)) return candidates;
  candidates.push(raw.structuredContent, raw.result);
  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      if (!isRecord(item) || typeof item.text !== "string") continue;
      try {
        candidates.push(JSON.parse(item.text));
      } catch {
        // Text-only MCP servers are intentionally left on the compatibility path.
      }
    }
  }
  return candidates;
}

function normalizeMcpRepositoryToolResult(value: unknown): McpRepositoryToolResult | null {
  if (!isRecord(value)) return null;
  const kind = normalizeRepositoryResultKind(value.kind);
  if (!kind || !Array.isArray(value.items) || typeof value.summary !== "string") return null;
  const items = value.items
    .map(normalizeRepositoryResultItem)
    .filter((item): item is McpRepositoryResultItem => item !== null)
    .slice(0, 200);
  const hasMore = value.hasMore === true;
  const nextCursor = typeof value.nextCursor === "string" && value.nextCursor.trim()
    ? value.nextCursor.slice(0, 2_048)
    : undefined;
  return {
    protocol: "codexh.repository.v1",
    kind,
    summary: value.summary.slice(0, 1_000),
    items,
    returnedCount: clampCount(value.returnedCount, items.length),
    totalCount: toOptionalCount(value.totalCount),
    page: toOptionalCount(value.page),
    hasMore,
    ...(hasMore && nextCursor ? { nextCursor } : {})
  };
}

function normalizeRepositoryResultKind(value: unknown): McpRepositoryResultKind | null {
  return value === "repository_tree" || value === "file_search" || value === "file_read" ? value : null;
}

function normalizeRepositoryResultItem(value: unknown): McpRepositoryResultItem | null {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.trim()) return null;
  const type = value.type === "file" || value.type === "directory" || value.type === "match" || value.type === "line"
    ? value.type
    : undefined;
  return {
    path: value.path.slice(0, 1_024),
    ...(type ? { type } : {}),
    ...(typeof value.name === "string" ? { name: value.name.slice(0, 256) } : {}),
    ...(typeof value.size === "number" && Number.isFinite(value.size) ? { size: Math.max(0, Math.floor(value.size)) } : {}),
    ...(typeof value.line === "number" && Number.isFinite(value.line) ? { line: Math.max(1, Math.floor(value.line)) } : {}),
    ...(typeof value.preview === "string" ? { preview: value.preview.slice(0, 500) } : {})
  };
}

function clampCount(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function toOptionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ManagedClient = {
  client: McpClient;
  fingerprint: string;
};

type CachedTools = {
  fingerprint: string;
  fetchedAt: number;
  tools: McpToolDescriptor[];
};

export class McpManager {
  #configs: McpServerConfig[] = [];
  readonly #clients = new Map<string, ManagedClient>();
  readonly #statuses = new Map<string, McpConnectionStatus>();
  readonly #toolCache = new Map<string, CachedTools>();
  readonly #createClient: (config: McpServerConfig) => Promise<McpClient>;
  readonly #toolCacheTtlMs: number;

  public constructor(
    configs: McpServerConfig[] = [],
    createClient?: (config: McpServerConfig) => Promise<McpClient>,
    options: McpManagerOptions = {}
  ) {
    this.#createClient = createClient ?? ((config) => createMcpClient(config, {
      ...options,
      onToolsChanged: (serverId) => {
        this.#toolCache.delete(serverId);
        options.onToolsChanged?.(serverId);
      }
    }));
    this.#toolCacheTtlMs = options.toolCacheTtlMs ?? 30_000;
    this.setConfigs(configs);
  }

  public setConfigs(configs: McpServerConfig[]): void {
    this.#configs = [...configs];
    const configById = new Map(this.#configs.map((config) => [config.id, config]));

    for (const [serverId, managed] of this.#clients) {
      const next = configById.get(serverId);
      if (!next || !next.enabled || connectionFingerprint(next) !== managed.fingerprint) {
        void managed.client.close?.();
        this.#clients.delete(serverId);
        this.#toolCache.delete(serverId);
      }
    }

    for (const config of this.#configs) {
      if (!config.enabled) {
        this.#statuses.set(config.id, { serverId: config.id, state: "disabled" });
      } else if (!this.#clients.has(config.id)) {
        this.#statuses.set(config.id, { serverId: config.id, state: "idle" });
      }
    }
    for (const serverId of [...this.#statuses.keys()]) {
      if (!configById.has(serverId)) {
        this.#statuses.delete(serverId);
        this.#toolCache.delete(serverId);
      }
    }
  }

  public listConfigs(): McpServerConfig[] {
    return [...this.#configs];
  }

  public listStatuses(): McpConnectionStatus[] {
    return this.#configs.map((config) =>
      this.#statuses.get(config.id) ?? {
        serverId: config.id,
        state: config.enabled ? "idle" : "disabled"
      }
    );
  }

  public async refresh(serverIds?: string[]): Promise<void> {
    const requested = serverIds ? new Set(serverIds) : null;
    const activeConfigs = this.#configs.filter(
      (config) => config.enabled && (!requested || requested.has(config.id))
    );

    await Promise.all(activeConfigs.map(async (config) => {
      const existing = this.#clients.get(config.id);
      if (existing && existing.fingerprint === connectionFingerprint(config)) {
        return;
      }
      if (existing) {
        await existing.client.close?.();
        this.#clients.delete(config.id);
      }
      try {
        await this.connect(config);
      } catch {
        // Keep other MCP servers usable; the connection state retains the error.
      }
    }));
  }

  public async listTools(serverIds?: string[]): Promise<McpToolDescriptor[]> {
    const requested = serverIds ? new Set(serverIds) : null;
    const tools: McpToolDescriptor[] = [];
    for (const [serverId, managed] of this.#clients) {
      if (requested && !requested.has(serverId)) {
        continue;
      }
      tools.push(...await this.getServerTools(serverId, managed));
    }
    return tools;
  }

  public async listToolSpecs(serverIds?: string[]): Promise<ToolSpecDefinition[]> {
    const tools = await this.listTools(serverIds);
    return tools.map((tool) => ({
      name: tool.name,
      namespace: tool.server,
      description: tool.description,
      inputSchema: tool.inputSchema,
      riskLevel: "medium",
      exposure: "deferred",
      source: "mcp"
    }));
  }

  public async testConfig(config: McpServerConfig): Promise<McpConnectionTestResult> {
    const client = await this.#createClient(config);
    try {
      const [toolResponse, resourceResponse, templateResponse, promptResponse] = await Promise.all([
        discover(() => client.listTools?.(), { tools: [] }),
        discover(() => client.listResources?.(), { resources: [] }),
        discover(() => client.listResourceTemplates?.(), { resourceTemplates: [] }),
        discover(() => client.listPrompts?.(), { prompts: [] })
      ]);
      return {
        tools: (toolResponse.tools ?? []).map((tool) => ({
          server: config.id,
          name: tool.name,
          description: tool.description ?? "MCP tool",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          approvalMode: config.tools?.[tool.name]?.approvalMode ?? config.defaultToolsApprovalMode ?? "prompt",
          annotations: tool.annotations
        })),
        resources: (resourceResponse.resources ?? []).map((resource) => ({
          uri: resource.uri,
          name: resource.name ?? resource.uri,
          description: resource.description ?? ""
        })),
        resourceTemplates: (templateResponse.resourceTemplates ?? []).map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name ?? template.uriTemplate
        })),
        prompts: (promptResponse.prompts ?? []).map((prompt) => ({
          server: config.id,
          name: prompt.name,
          description: prompt.description ?? "MCP prompt",
          arguments: prompt.arguments ?? []
        }))
      };
    } finally {
      await client.close?.();
    }
  }

  public async callTool(serverId: string, toolName: string, argumentsJson: Record<string, unknown>): Promise<any> {
    const client = this.#clients.get(serverId)?.client;
    if (!client?.callTool) {
      throw new Error(`MCP server ${serverId} is not connected.`);
    }
    const tools = await this.listTools([serverId]);
    if (!tools.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP tool ${serverId}:${toolName} is not available.`);
    }
    try {
      return await client.callTool({ name: toolName, arguments: argumentsJson });
    } catch (error) {
      if (!isMissingToolError(error)) throw error;
      await this.refreshToolDirectory([serverId]);
      if (!(await this.listTools([serverId])).some((tool) => tool.name === toolName)) {
        throw new Error(`MCP tool ${serverId}:${toolName} is not available after refreshing the directory.`);
      }
      throw error;
    }
  }

  public async listResources(serverId?: string): Promise<any[]> {
    const pairs = serverId
      ? [...this.#clients.entries()].filter(([id]) => id === serverId)
      : [...this.#clients.entries()];
    const resources: any[] = [];
    for (const [id, managed] of pairs) {
      let response: { resources?: Array<{ uri: string; name?: string; description?: string }> } = {};
      try {
        response = (await managed.client.listResources?.()) ?? {};
      } catch (error) {
        // MCP servers are allowed to omit optional resource capabilities.
        // JSON-RPC -32601 must not abort otherwise usable Skill Lab runs.
        if (!isMethodUnavailableError(error)) throw error;
      }
      for (const resource of response.resources ?? []) {
        resources.push({ server: id, uri: resource.uri, name: resource.name ?? resource.uri, description: resource.description ?? "" });
      }
    }
    return resources;
  }

  public async listResourceTemplates(serverId?: string): Promise<any[]> {
    const pairs = serverId
      ? [...this.#clients.entries()].filter(([id]) => id === serverId)
      : [...this.#clients.entries()];
    const templates: any[] = [];
    for (const [id, managed] of pairs) {
      const response = (await managed.client.listResourceTemplates?.()) ?? {};
      for (const template of response.resourceTemplates ?? []) {
        templates.push({ server: id, uriTemplate: template.uriTemplate, name: template.name ?? template.uriTemplate });
      }
    }
    return templates;
  }

  public async readResource(serverId: string, uri: string): Promise<any> {
    const client = this.#clients.get(serverId)?.client;
    if (!client?.readResource) {
      throw new Error(`MCP server ${serverId} does not support resources.`);
    }
    return client.readResource({ uri });
  }

  public async listPrompts(serverId?: string): Promise<McpPromptDescriptor[]> {
    const pairs = serverId
      ? [...this.#clients.entries()].filter(([id]) => id === serverId)
      : [...this.#clients.entries()];
    const prompts: McpPromptDescriptor[] = [];
    for (const [id, managed] of pairs) {
      const response = (await managed.client.listPrompts?.()) ?? {};
      for (const prompt of response.prompts ?? []) {
        prompts.push({ server: id, name: prompt.name, description: prompt.description ?? "MCP prompt", arguments: prompt.arguments ?? [] });
      }
    }
    return prompts;
  }

  public async getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<any> {
    const client = this.#clients.get(serverId)?.client;
    if (!client?.getPrompt) throw new Error(`MCP server ${serverId} does not support prompts.`);
    return client.getPrompt({ name, arguments: args });
  }

  public async refreshToolDirectory(serverIds?: string[]): Promise<McpToolDescriptor[]> {
    const requested = serverIds ? new Set(serverIds) : null;
    for (const serverId of this.#toolCache.keys()) {
      if (!requested || requested.has(serverId)) this.#toolCache.delete(serverId);
    }
    return this.listTools(serverIds);
  }

  public getToolApprovalMode(serverId: string, toolName: string): McpToolApprovalMode {
    const config = this.#configs.find((entry) => entry.id === serverId);
    return config?.tools?.[toolName]?.approvalMode ?? config?.defaultToolsApprovalMode ?? "prompt";
  }

  private async connect(config: McpServerConfig): Promise<void> {
    this.#statuses.set(config.id, { serverId: config.id, state: "connecting" });
    try {
      const client = await this.#createClient(config);
      this.#clients.set(config.id, { client, fingerprint: connectionFingerprint(config) });
      this.#toolCache.delete(config.id);
      this.#statuses.set(config.id, { serverId: config.id, state: "connected", connectedAt: new Date().toISOString() });
    } catch (error) {
      this.#statuses.set(config.id, {
        serverId: config.id,
        state: "error",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async getServerTools(serverId: string, managed: ManagedClient): Promise<McpToolDescriptor[]> {
    const cached = this.#toolCache.get(serverId);
    if (cached && cached.fingerprint === managed.fingerprint && Date.now() - cached.fetchedAt < this.#toolCacheTtlMs) {
      return cached.tools;
    }
    const config = this.#configs.find((entry) => entry.id === serverId);
    const response = (await managed.client.listTools?.()) ?? {};
    const tools = (response.tools ?? [])
      .filter((tool) => config?.tools?.[tool.name]?.enabled !== false)
      .map((tool) => ({
        server: serverId,
        name: tool.name,
        description: tool.description ?? "MCP tool",
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        approvalMode: config?.tools?.[tool.name]?.approvalMode ?? config?.defaultToolsApprovalMode ?? "prompt",
        annotations: tool.annotations
      }));
    this.#toolCache.set(serverId, { fingerprint: managed.fingerprint, fetchedAt: Date.now(), tools });
    return tools;
  }
}

/**
 * An MCP connection can be valid while a server omits optional discovery APIs.
 * Connection testing should report the supported capabilities instead of failing
 * because, for example, resources/list is not implemented.
 */
async function discover<T>(operation: () => Promise<T> | undefined, fallback: T): Promise<T> {
  try {
    return (await operation()) ?? fallback;
  } catch {
    return fallback;
  }
}

async function createMcpClient(config: McpServerConfig, options: McpManagerOptions = {}): Promise<McpClient> {
  const transportKind = normalizeTransport(config);
  if (transportKind === "stdio") {
    if (!config.command) {
      throw new Error("A stdio MCP server requires a command.");
    }
    const sdkClient = await import("@modelcontextprotocol/sdk/client/index.js");
    const sdkStdio = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new sdkStdio.StdioClientTransport({ command: config.command, args: config.args ?? [], env: config.env, cwd: config.cwd });
    const client = new sdkClient.Client({ name: `codexh-${config.name}`, version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => options.onToolsChanged?.(config.id));
    return client as McpClient;
  }
  if (!config.url) {
    throw new Error("An HTTP or SSE MCP server requires a URL.");
  }
  if (transportKind === "sse" && config.auth?.mode && config.auth.mode !== "none") {
    throw new Error("Authenticated MCP servers require Streamable HTTP; legacy SSE is compatibility-only.");
  }
  const sdkClient = await import("@modelcontextprotocol/sdk/client/index.js");
  const headers: Record<string, string> = {};
  if (config.auth?.mode === "bearer_env") {
    const token = await options.resolveBearerToken?.(config);
    if (!token) throw new Error(`MCP server ${config.id} requires a bearer token in ${config.auth.bearerTokenEnvVar ?? "the configured environment variable"}.`);
    headers.Authorization = `Bearer ${token}`;
  }
  const oauthProvider = config.auth?.mode === "oauth" ? await options.createOAuthProvider?.(config) : undefined;
  if (config.auth?.mode === "oauth" && !oauthProvider) {
    throw new Error(`MCP server ${config.id} requires OAuth login. Use the MCP settings to sign in.`);
  }
  const transport = transportKind === "sse"
    ? new (await import("@modelcontextprotocol/sdk/client/sse.js")).SSEClientTransport(new URL(config.url))
    : new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: Object.keys(headers).length ? { headers } : undefined,
      authProvider: oauthProvider
    });
  const client = new sdkClient.Client({ name: `codexh-${config.name}`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => options.onToolsChanged?.(config.id));
  return client as McpClient;
}

function connectionFingerprint(config: McpServerConfig): string {
  return JSON.stringify({ command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd, url: config.url, transport: normalizeTransport(config), auth: config.auth, source: config.source });
}

function isMissingToolError(error: unknown): boolean {
  return /tool.*(?:not found|unknown|unavailable)|(?:not found|unknown).*tool/i.test(error instanceof Error ? error.message : String(error));
}

function isMethodUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:-32601|method\s+['"]?[^'" ]+['"]?\s+is\s+not\s+available|method\s+not\s+found)/i.test(message);
}

function normalizeTransport(config: McpServerConfig): "stdio" | "sse" | "streamable_http" {
  const value = config.transport?.toLowerCase().replace(/-/g, "_");
  if (value === "sse") return "sse";
  if (value === "http" || value === "streamable_http") return "streamable_http";
  if (config.command) return "stdio";
  return "streamable_http";
}
