import { useState, type Dispatch, type SetStateAction } from "react";
import type { AppConfig, McpServerConfig } from "@shared-types";
import { cloneConfig, createAvailableMcpId, parseMcpJsonConfig } from "../lib/config-utils";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

type Options = {
  configDraft: AppConfig | null;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  showNotice: Notice;
};

export function useMcpDraftEditor({ configDraft, setConfigDraft, showNotice }: Options) {
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"form" | "json">("form");
  const [createDraft, setCreateDraft] = useState<McpServerConfig | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  function updateServerDraft(id: string, patch: Partial<McpServerConfig>) {
    setConfigDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      next.mcpServers = next.mcpServers.map((server) => server.id === id ? { ...server, ...patch } : server);
      return next;
    });
  }

  function addServer() {
    if (!configDraft) return;
    const id = createAvailableMcpId(configDraft.mcpServers);
    setCreateDraft({ id, name: "", transport: "streamable_http", url: "", auth: { mode: "none" }, defaultToolsApprovalMode: "prompt", enabled: true, source: "config" });
    setCreateMode("form");
    setCreateError(null);
    setJsonDraft("");
    setJsonError(null);
    setIsCreateOpen(true);
  }

  function closeCreateSheet() {
    setIsCreateOpen(false);
    setCreateDraft(null);
    setCreateError(null);
    setJsonError(null);
  }

  function confirmCreate() {
    if (!configDraft) return;
    if (createMode === "form") {
      if (!createDraft) return;
      const id = createDraft.id.trim();
      const name = createDraft.name.trim();
      const isStdio = (createDraft.transport ?? "stdio") === "stdio";
      if (!id) return setCreateError("请填写服务 ID。");
      if (!name) return setCreateError("请填写服务名称。");
      if (configDraft.mcpServers.some((server) => server.id === id)) return setCreateError(`服务 ID 已存在：${id}`);
      if (isStdio && !createDraft.command?.trim()) return setCreateError("stdio 服务需要填写命令。");
      if (!isStdio && !createDraft.url?.trim()) return setCreateError("SSE/HTTP 服务需要填写 URL。");
      const server = { ...createDraft, id, name };
      setConfigDraft((current) => current ? { ...cloneConfig(current), mcpServers: [...current.mcpServers, server] } : current);
      closeCreateSheet();
      showNotice("MCP 服务已加入草稿", { tone: "success", message: "请点击保存使配置生效。" });
      return;
    }
    try {
      const servers = parseMcpJsonConfig(jsonDraft);
      if (!servers.length) throw new Error("JSON 中没有可添加的 MCP 服务。");
      const existingIds = new Set(configDraft.mcpServers.map((server) => server.id));
      const duplicate = servers.find((server) => existingIds.has(server.id));
      if (duplicate) throw new Error(`服务 ID 已存在：${duplicate.id}`);
      setConfigDraft((current) => current ? { ...cloneConfig(current), mcpServers: [...current.mcpServers, ...servers] } : current);
      closeCreateSheet();
      showNotice(`已加入 ${servers.length} 个 MCP 服务`, { tone: "success", message: "请点击保存使配置生效。" });
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
    }
  }

  function removeServer(id: string) {
    setConfigDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      next.mcpServers = next.mcpServers.filter((server) => server.id !== id);
      return next;
    });
    setEditingServerId((current) => current === id ? null : current);
  }

  return {
    editingServerId,
    setEditingServerId,
    isCreateOpen,
    createMode,
    setCreateMode,
    createDraft,
    setCreateDraft,
    createError,
    setCreateError,
    jsonDraft,
    setJsonDraft,
    jsonError,
    setJsonError,
    updateServerDraft,
    addServer,
    closeCreateSheet,
    confirmCreate,
    removeServer
  };
}
