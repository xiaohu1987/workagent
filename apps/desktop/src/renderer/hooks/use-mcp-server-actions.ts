import { useState } from "react";
import type { McpServerConfig } from "@shared-types";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;
type McpTestResult = {
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ uri: string; name: string }>;
  resourceTemplates: Array<{ uriTemplate: string; name: string }>;
  prompts: Array<{ name: string; description: string }>;
};

export function useMcpServerActions(refreshMcpServers: () => Promise<void>, showNotice: Notice) {
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({});
  const [testingServerId, setTestingServerId] = useState<string | null>(null);
  const [authBusyId, setAuthBusyId] = useState<string | null>(null);

  async function testServer(server: McpServerConfig) {
    setTestingServerId(server.id);
    try {
      const result = await window.codexh.testMcpServer(server);
      setTestResults((current) => ({
        ...current,
        [server.id]: { tools: result.tools, resources: result.resources, resourceTemplates: result.resourceTemplates, prompts: result.prompts }
      }));
      showNotice(`${server.name} 测试成功`, { tone: "success", message: `发现 ${result.tools.length} 个工具` });
    } catch (error) {
      showNotice(`${server.name} 连接失败`, { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTestingServerId((current) => current === server.id ? null : current);
      await refreshMcpServers();
    }
  }

  async function login(serverId: string) {
    setAuthBusyId(serverId);
    try {
      await window.codexh.loginMcpServer(serverId);
      await refreshMcpServers();
      showNotice("OAuth 登录完成", { tone: "success" });
    } catch (error) {
      showNotice("OAuth 登录失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setAuthBusyId(null);
    }
  }

  async function logout(serverId: string) {
    setAuthBusyId(serverId);
    try {
      await window.codexh.logoutMcpServer(serverId);
      await refreshMcpServers();
      showNotice("OAuth 已退出", { tone: "success" });
    } catch (error) {
      showNotice("OAuth 退出失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setAuthBusyId(null);
    }
  }

  async function refreshToolDirectory(serverId: string) {
    try {
      const tools = await window.codexh.refreshMcpTools(serverId);
      setTestResults((current) => ({
        ...current,
        [serverId]: { ...(current[serverId] ?? { resources: [], resourceTemplates: [], prompts: [] }), tools }
      }));
      showNotice("MCP 工具目录已刷新", { tone: "success", message: `发现 ${tools.length} 个工具` });
    } catch (error) {
      showNotice("刷新 MCP 工具目录失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { testResults, testingServerId, authBusyId, testServer, login, logout, refreshToolDirectory };
}
