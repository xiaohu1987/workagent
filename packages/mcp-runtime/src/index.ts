import type { McpServerConfig, ToolSpecDefinition } from "@shared-types";

type AnyMcpClient = {
  listTools?: () => Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: any }> }>;
  callTool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<any>;
  listResources?: () => Promise<{ resources?: Array<{ uri: string; name?: string; description?: string }> }>;
  listResourceTemplates?: () => Promise<{ resourceTemplates?: Array<{ uriTemplate: string; name?: string }> }>;
  readResource?: (params: { uri: string }) => Promise<any>;
  close?: () => Promise<void>;
};

export class McpManager {
  #configs: McpServerConfig[] = [];
  readonly #clients = new Map<string, AnyMcpClient>();

  public constructor(configs: McpServerConfig[] = []) {
    this.#configs = [...configs];
  }

  public setConfigs(configs: McpServerConfig[]): void {
    this.#configs = [...configs];
  }

  public listConfigs(): McpServerConfig[] {
    return [...this.#configs];
  }

  public async refresh(serverIds?: string[]): Promise<void> {
    const requested = serverIds ? new Set(serverIds) : null;
    const activeConfigIds = new Set(
      this.#configs.filter((entry) => entry.enabled).map((entry) => entry.id)
    );

    for (const [serverId, client] of this.#clients) {
      if (activeConfigIds.has(serverId)) {
        continue;
      }
      await client.close?.();
      this.#clients.delete(serverId);
    }

    for (const config of this.#configs.filter(
      (entry) => entry.enabled && (!requested || requested.has(entry.id))
    )) {
      if (this.#clients.has(config.id)) {
        continue;
      }

      const client = await createStdioClient(config);
      this.#clients.set(config.id, client);
    }
  }

  public async listToolSpecs(serverIds?: string[]): Promise<ToolSpecDefinition[]> {
    const allSpecs: ToolSpecDefinition[] = [];
    const requested = serverIds ? new Set(serverIds) : null;

    for (const [serverId, client] of this.#clients) {
      if (requested && !requested.has(serverId)) {
        continue;
      }
      const response = (await client.listTools?.()) ?? {};
      for (const tool of response.tools ?? []) {
        allSpecs.push({
          name: tool.name,
          namespace: serverId,
          description: tool.description ?? "MCP tool",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          riskLevel: "medium",
          exposure: "deferred",
          source: "mcp"
        });
      }
    }

    return allSpecs;
  }

  public async callTool(
    serverId: string,
    toolName: string,
    argumentsJson: Record<string, unknown>
  ): Promise<any> {
    const client = this.#clients.get(serverId);
    if (!client?.callTool) {
      throw new Error(`MCP server ${serverId} is not connected.`);
    }
    return client.callTool({ name: toolName, arguments: argumentsJson });
  }

  public async listResources(serverId?: string): Promise<any[]> {
    const pairs = serverId
      ? [...this.#clients.entries()].filter(([id]) => id === serverId)
      : [...this.#clients.entries()];
    const resources: any[] = [];

    for (const [id, client] of pairs) {
      const response = (await client.listResources?.()) ?? {};
      for (const resource of response.resources ?? []) {
        resources.push({
          server: id,
          uri: resource.uri,
          name: resource.name ?? resource.uri,
          description: resource.description ?? ""
        });
      }
    }

    return resources;
  }

  public async listResourceTemplates(serverId?: string): Promise<any[]> {
    const pairs = serverId
      ? [...this.#clients.entries()].filter(([id]) => id === serverId)
      : [...this.#clients.entries()];
    const templates: any[] = [];

    for (const [id, client] of pairs) {
      const response = (await client.listResourceTemplates?.()) ?? {};
      for (const template of response.resourceTemplates ?? []) {
        templates.push({
          server: id,
          uriTemplate: template.uriTemplate,
          name: template.name ?? template.uriTemplate
        });
      }
    }

    return templates;
  }

  public async readResource(serverId: string, uri: string): Promise<any> {
    const client = this.#clients.get(serverId);
    if (!client?.readResource) {
      throw new Error(`MCP server ${serverId} does not support resources.`);
    }
    return client.readResource({ uri });
  }
}

async function createStdioClient(config: McpServerConfig): Promise<AnyMcpClient> {
  const transportKind = normalizeTransport(config);

  if (transportKind === "stdio") {
    if (!config.command) {
      return {};
    }

    const sdkClient = await import("@modelcontextprotocol/sdk/client/index.js");
    const sdkStdio = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const clientTransport = new sdkStdio.StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      cwd: config.cwd
    });

    const client = new sdkClient.Client(
      {
        name: `codexh-${config.name}`,
        version: "0.1.0"
      },
      {
        capabilities: {}
      }
    );

    await client.connect(clientTransport);
    return client as AnyMcpClient;
  }

  if (!config.url) {
    return {};
  }

  if (config.source === "plugin") {
    return {};
  }

  const sdkClient = await import("@modelcontextprotocol/sdk/client/index.js");
  const clientTransport = transportKind === "sse"
    ? new (await import("@modelcontextprotocol/sdk/client/sse.js")).SSEClientTransport(
        new URL(config.url)
      )
    : new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js"))
        .StreamableHTTPClientTransport(new URL(config.url));

  const client = new sdkClient.Client(
    {
      name: `codexh-${config.name}`,
      version: "0.1.0"
    },
    {
      capabilities: {}
    }
  );

  await client.connect(clientTransport);
  return client as AnyMcpClient;
}

function normalizeTransport(config: McpServerConfig): "stdio" | "sse" | "streamable_http" {
  const value = config.transport?.toLowerCase().replace(/-/g, "_");
  if (value === "sse") {
    return "sse";
  }
  if (value === "http" || value === "streamable_http") {
    return "streamable_http";
  }
  if (config.command) {
    return "stdio";
  }
  return "streamable_http";
}
