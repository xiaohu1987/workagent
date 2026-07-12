import { describe, expect, it, vi } from "vitest";
import { McpManager, type McpClient } from "@mcp-runtime";
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
});
