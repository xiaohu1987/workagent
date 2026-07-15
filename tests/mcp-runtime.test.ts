import { describe, expect, it, vi } from "vitest";
import { extractMcpRepositoryToolResult, McpManager, type McpClient } from "@mcp-runtime";
import type { McpServerConfig } from "@shared-types";

const baseConfig: McpServerConfig = {
  id: "stocks",
  name: "Stocks",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
  enabled: true
};

describe("McpManager", () => {
  it("discovers connected MCP tools and validates calls against the directory", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const client: McpClient = {
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: "market_cap", description: "Read market cap", inputSchema: { type: "object" } }]
      }),
      callTool
    };
    const manager = new McpManager([baseConfig], vi.fn().mockResolvedValue(client));

    await manager.refresh(["stocks"]);
    await expect(manager.listTools(["stocks"])).resolves.toEqual([
      expect.objectContaining({ server: "stocks", name: "market_cap" })
    ]);
    await manager.callTool("stocks", "market_cap", { symbol: "301236" });
    expect(callTool).toHaveBeenCalledWith({ name: "market_cap", arguments: { symbol: "301236" } });
    await expect(manager.callTool("stocks", "missing", {})).rejects.toThrow("not available");
  });

  it("closes and reconnects a server when its connection configuration changes", async () => {
    const first: McpClient = { close: vi.fn() };
    const second: McpClient = { close: vi.fn() };
    const createClient = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new McpManager([baseConfig], createClient);

    await manager.refresh(["stocks"]);
    manager.setConfigs([{ ...baseConfig, args: ["updated-server.js"] }]);
    await manager.refresh(["stocks"]);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(manager.listStatuses()).toEqual([
      expect.objectContaining({ serverId: "stocks", state: "connected" })
    ]);
  });

  it("tests a connected server even when optional resource discovery is unsupported", async () => {
    const client: McpClient = {
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: "market_cap", inputSchema: { type: "object" } }]
      }),
      listResources: vi.fn().mockRejectedValue(new Error("Method not found")),
      listResourceTemplates: vi.fn().mockRejectedValue(new Error("Method not found")),
      close: vi.fn()
    };
    const manager = new McpManager([], vi.fn().mockResolvedValue(client));

    await expect(manager.testConfig(baseConfig)).resolves.toEqual({
      tools: [expect.objectContaining({ server: "stocks", name: "market_cap" })],
      resources: [],
      resourceTemplates: [],
      prompts: []
    });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("caches the tool directory, applies policies, and exposes MCP prompts", async () => {
    const listTools = vi.fn().mockResolvedValue({
      tools: [
        { name: "read", inputSchema: { type: "object" } },
        { name: "disabled", inputSchema: { type: "object" } }
      ]
    });
    const client: McpClient = {
      listTools,
      listPrompts: vi.fn().mockResolvedValue({ prompts: [{ name: "summarize", description: "Summarize input" }] })
    };
    const manager = new McpManager([{
      ...baseConfig,
      defaultToolsApprovalMode: "auto",
      tools: { disabled: { enabled: false }, read: { approvalMode: "approve" } }
    }], vi.fn().mockResolvedValue(client), { toolCacheTtlMs: 60_000 });

    await manager.refresh();
    await expect(manager.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "read", approvalMode: "approve" })
    ]);
    await manager.listTools();
    expect(listTools).toHaveBeenCalledTimes(1);
    await expect(manager.listPrompts()).resolves.toEqual([
      expect.objectContaining({ server: "stocks", name: "summarize" })
    ]);
  });
});

describe("repository pagination MCP contract", () => {
  it("accepts structured repository pages and keeps the continuation cursor", () => {
    const result = extractMcpRepositoryToolResult({
      structuredContent: {
        protocol: "codexh.repository.v1",
        kind: "repository_tree",
        summary: "Top-level projects",
        items: [{ path: "src", type: "directory" }, { path: "package.json", type: "file" }],
        returnedCount: 2,
        totalCount: 240,
        page: 1,
        hasMore: true,
        nextCursor: "cursor-2"
      }
    });

    expect(result).toEqual(expect.objectContaining({
      kind: "repository_tree",
      returnedCount: 2,
      hasMore: true,
      nextCursor: "cursor-2"
    }));
  });

  it("accepts a JSON text MCP content block and ignores legacy text", () => {
    const page = {
      kind: "file_search",
      summary: "Matches for auth",
      items: [{ path: "src/auth.ts", type: "match", line: 12, preview: "export function auth" }],
      returnedCount: 1,
      hasMore: false
    };

    expect(extractMcpRepositoryToolResult({ content: [{ type: "text", text: JSON.stringify(page) }] }))
      .toEqual(expect.objectContaining({ kind: "file_search", returnedCount: 1 }));
    expect(extractMcpRepositoryToolResult({ content: [{ type: "text", text: "# a legacy markdown tree" }] })).toBeNull();
  });
});
