import { describe, expect, it, vi } from "vitest";
import { MAX_MCP_PERSISTED_RESULT_CHARACTERS, summarizeMcpToolResultForPersistence } from "@agent-runtime";
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

describe("mcp.call persistence summarization", () => {
  it("truncates oversized content and compacts the raw result payload", () => {
    const oversizedText = "x".repeat(20_000);
    const summarized = summarizeMcpToolResultForPersistence({
      ok: true,
      content: oversizedText,
      json: {
        result: { content: [{ type: "text", text: oversizedText }], isError: false },
        repository: {
          protocol: "codexh.repository.v1",
          kind: "repository_tree",
          summary: "tree",
          items: [],
          returnedCount: 0,
          hasMore: false
        }
      }
    });

    expect(summarized.content.length).toBeLessThanOrEqual(MAX_MCP_PERSISTED_RESULT_CHARACTERS + 100);
    expect(summarized.content).toContain("truncated");
    expect(summarized.json).toMatchObject({ truncated: true, contentLength: 20_000 });
    const rawResult = (summarized.json as Record<string, unknown>).result as Record<string, unknown>;
    expect(rawResult).toMatchObject({ isError: false, contentItemCount: 1 });
    expect(String(rawResult.textPreview).length).toBeLessThanOrEqual(700);
    expect((summarized.json as Record<string, unknown>).repository).toBeDefined();
  });

  it("keeps small raw results intact for the renderer", () => {
    const summarized = summarizeMcpToolResultForPersistence({
      ok: true,
      content: '{"value":42}',
      json: { result: { value: 42 } }
    });

    expect(summarized.json).toMatchObject({ truncated: false, contentLength: 12, result: { value: 42 } });
  });
});

describe("McpManager responsiveness", () => {
  it("fails a hung tool call with a timeout instead of blocking the runtime", async () => {
    vi.useFakeTimers();
    try {
      const client: McpClient = {
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: "slow", inputSchema: { type: "object" } }] }),
        callTool: vi.fn(() => new Promise(() => {}))
      };
      const manager = new McpManager([baseConfig], vi.fn().mockResolvedValue(client));
      await manager.refresh(["stocks"]);

      const pending = manager.callTool("stocks", "slow", {});
      const assertion = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the tool directory cached beyond the previous 30-second window", async () => {
    vi.useFakeTimers();
    try {
      const listTools = vi.fn().mockResolvedValue({ tools: [{ name: "read", inputSchema: { type: "object" } }] });
      const client: McpClient = { listTools };
      const manager = new McpManager([baseConfig], vi.fn().mockResolvedValue(client));

      await manager.refresh(["stocks"]);
      await manager.listTools(["stocks"]);
      await vi.advanceTimersByTimeAsync(60_000);
      await manager.listTools(["stocks"]);

      expect(listTools).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
