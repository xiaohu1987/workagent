import type { McpServerConfig, ToolSpecDefinition } from "@shared-types";

export type McpClient = {
  listTools?: () => Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: any }> }>;
  callTool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<any>;
  listResources?: () => Promise<{ resources?: Array<{ uri: string; name?: string; description?: string }> }>;
  listResourceTemplates?: () => Promise<{ resourceTemplates?: Array<{ uriTemplate: string; name?: string }> }>;
  readResource?: (params: { uri: string }) => Promise<any>;
  close?: () => Promise<void>;
};

export interface McpToolDescriptor {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
}

type ManagedClient = {
  client: McpClient;
  fingerprint: string;
};

export class McpManager {
  #configs: McpServerConfig[] = [];
  readonly #clients = new Map<string, ManagedClient>();
  readonly #statuses = new Map<string, McpConnectionStatus>();

  public constructor(
    configs: McpServerConfig[] = [],
    private readonly createClient: (config: McpServerConfig) => Promise<McpClient> = createMcpClient
  ) {
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
      const response = (await managed.client.listTools?.()) ?? {};
      for (const tool of response.tools ?? []) {
        tools.push({
          server: serverId,
          name: tool.name,
          description: tool.description ?? "MCP tool",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
        });
      }
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
    const client = await this.createClient(config);
    try {
      const [toolResponse, resourceResponse, templateResponse] = await Promise.all([
        discover(() => client.listTools?.(), { tools: [] }),
        discover(() => client.listResources?.(), { resources: [] }),
        discover(() => client.listResourceTemplates?.(), { resourceTemplates: [] })
      ]);
      return {
        tools: (toolResponse.tools ?? []).map((tool) => ({
          server: config.id,
          name: tool.name,
          description: tool.description ?? "MCP tool",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
        })),
        resources: (resourceResponse.resources ?? []).map((resource) => ({
          uri: resource.uri,
          name: resource.name ?? resource.uri,
          description: resource.description ?? ""
        })),
        resourceTemplates: (templateResponse.resourceTemplates ?? []).map((template) => ({
          uriTemplate: template.uriTemplate,
          name: template.name ?? template.uriTemplate
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
    return client.callTool({ name: toolName, arguments: argumentsJson });
  }

  public async listResources(serverId?: string): Promise<any[]> {
    const pairs = serverId
      ? [...this.#clients.entries()].filter(([id]) => id === serverId)
      : [...this.#clients.entries()];
    const resources: any[] = [];
    for (const [id, managed] of pairs) {
      const response = (await managed.client.listResources?.()) ?? {};
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

  private async connect(config: McpServerConfig): Promise<void> {
    this.#statuses.set(config.id, { serverId: config.id, state: "connecting" });
    try {
      const client = await this.createClient(config);
      this.#clients.set(config.id, { client, fingerprint: connectionFingerprint(config) });
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

async function createMcpClient(config: McpServerConfig): Promise<McpClient> {
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
    return client as McpClient;
  }
  if (!config.url) {
    throw new Error("An HTTP or SSE MCP server requires a URL.");
  }
  if (config.source === "plugin") {
    throw new Error("Plugin-provided HTTP MCP servers are not supported.");
  }
  const sdkClient = await import("@modelcontextprotocol/sdk/client/index.js");
  const transport = transportKind === "sse"
    ? new (await import("@modelcontextprotocol/sdk/client/sse.js")).SSEClientTransport(new URL(config.url))
    : new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(new URL(config.url));
  const client = new sdkClient.Client({ name: `codexh-${config.name}`, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client as McpClient;
}

function connectionFingerprint(config: McpServerConfig): string {
  return JSON.stringify({ command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd: config.cwd, url: config.url, transport: normalizeTransport(config), source: config.source });
}

function normalizeTransport(config: McpServerConfig): "stdio" | "sse" | "streamable_http" {
  const value = config.transport?.toLowerCase().replace(/-/g, "_");
  if (value === "sse") return "sse";
  if (value === "http" || value === "streamable_http") return "streamable_http";
  if (config.command) return "stdio";
  return "streamable_http";
}
