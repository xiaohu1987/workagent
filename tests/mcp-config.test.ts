import { describe, expect, it } from "vitest";
import { parseMcpJsonConfig, serializeMcpJsonConfig } from "../apps/desktop/src/renderer/App";

describe("MCP JSON configuration", () => {
  it("accepts keyed service definitions using type and isActive", () => {
    const servers = parseMcpJsonConfig(`{
      "xwwwaa": {
        "name": "1112333",
        "type": "sse",
        "description": "Example service",
        "isActive": true,
        "url": "https://example.com/sse"
      }
    }`);

    expect(servers).toEqual([{
      id: "xwwwaa",
      name: "1112333",
      description: "Example service",
      transport: "sse",
      url: "https://example.com/sse",
      source: "config",
      enabled: true
    }]);
  });

  it("accepts mcpServers wrappers and serializes back to the keyed format", () => {
    const servers = parseMcpJsonConfig(`{
      "mcpServers": {
        "local": { "command": "npx", "args": ["-y", "@example/mcp"], "enabled": false }
      }
    }`);

    expect(servers[0]).toMatchObject({ id: "local", transport: "stdio", enabled: false });
    expect(serializeMcpJsonConfig(servers)).toEqual({
      local: {
        name: "local",
        type: "stdio",
        isActive: false,
        command: "npx",
        args: ["-y", "@example/mcp"]
      }
    });
  });

  it("preserves credential references and tool policies without serializing tokens", () => {
    const [server] = parseMcpJsonConfig(`{
      "private": {
        "url": "https://example.com/mcp",
        "auth": { "mode": "bearer_env", "bearerTokenEnvVar": "MCP_TOKEN" },
        "defaultToolsApprovalMode": "prompt",
        "tools": { "write": { "enabled": false, "approvalMode": "approve" } }
      }
    }`);

    expect(server.auth).toEqual({ mode: "bearer_env", bearerTokenEnvVar: "MCP_TOKEN", oauthClientId: undefined, oauthResource: undefined, oauthScopes: undefined });
    expect(server.tools).toEqual({ write: { enabled: false, approvalMode: "approve" } });
    expect(JSON.stringify(serializeMcpJsonConfig([server]))).not.toContain("MCP_TOKEN_VALUE");
  });
});
