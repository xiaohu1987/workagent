import { useState, type Dispatch, type SetStateAction } from "react";
import type { AppConfig, DatabaseConnectionConfig } from "@shared-types";
import { buildConfigToSave, cloneConfig } from "../lib/config-utils";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

type Options = {
  config: AppConfig | null;
  setConfig: Dispatch<SetStateAction<AppConfig | null>>;
  configDraft: AppConfig | null;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  providerSecretDrafts: Record<string, string>;
  saveConfigDraft: (options?: { showSuccessNotice?: boolean }) => Promise<void>;
  showNotice: Notice;
};

export function useDatabaseConnections({
  config,
  setConfig,
  configDraft,
  setConfigDraft,
  providerSecretDrafts,
  saveConfigDraft,
  showNotice
}: Options) {
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [savedCredentialIds, setSavedCredentialIds] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [savingCredentialId, setSavingCredentialId] = useState<string | null>(null);
  const [changingEnabledId, setChangingEnabledId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});

  function updateDraft(id: string, patch: Partial<DatabaseConnectionConfig>) {
    setConfigDraft((current) => current ? {
      ...cloneConfig(current),
      databaseConnections: current.databaseConnections.map((connection) => connection.id === id ? { ...connection, ...patch } : connection)
    } : current);
  }

  async function setEnabled(connection: DatabaseConnectionConfig, enabled: boolean) {
    const persistedConnection = config?.databaseConnections.find((entry) => entry.id === connection.id);
    if (!config || !persistedConnection) {
      updateDraft(connection.id, { enabled });
      return;
    }
    const previousConfig = config;
    const nextConfig = cloneConfig(config);
    nextConfig.databaseConnections = nextConfig.databaseConnections.map((entry) => entry.id === connection.id ? { ...entry, enabled } : entry);
    updateDraft(connection.id, { enabled });
    setConfig(nextConfig);
    setChangingEnabledId(connection.id);
    try {
      await window.codexh.saveConfig(buildConfigToSave(nextConfig, previousConfig, providerSecretDrafts));
      showNotice(enabled ? "数据库已启用" : "数据库已停用", {
        message: enabled ? "该数据库现在可在聊天中调用。" : "该数据库已从聊天可用数据源中移除。",
        tone: "success"
      });
    } catch (error) {
      updateDraft(connection.id, { enabled: persistedConnection.enabled });
      setConfig(previousConfig);
      showNotice("数据库状态保存失败", { message: error instanceof Error ? error.message : String(error), tone: "warning" });
    } finally {
      setChangingEnabledId((current) => current === connection.id ? null : current);
    }
  }

  function add() {
    if (!configDraft) return;
    const base = "database";
    let index = 1;
    while (configDraft.databaseConnections.some((connection) => connection.id === `${base}-${index}`)) index += 1;
    const id = `${base}-${index}`;
    setConfigDraft((current) => current ? {
      ...cloneConfig(current),
      databaseConnections: [...current.databaseConnections, {
        id, name: "", engine: "postgresql", host: "", port: 5432, database: "", username: "", tlsMode: "require", credentialRef: `database:${id}`, enabled: true, permissions: ["query"], maxRows: 200
      }]
    } : current);
    setEditingId(id);
  }

  function remove(id: string) {
    setConfigDraft((current) => current ? {
      ...cloneConfig(current),
      databaseConnections: current.databaseConnections.filter((connection) => connection.id !== id)
    } : current);
    setEditingId((current) => current === id ? null : current);
    setPasswordDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function test(connection: DatabaseConnectionConfig) {
    const password = passwordDrafts[connection.id] ?? "";
    setTestingId(connection.id);
    try {
      const response = await window.codexh.testDatabase({ connection, password: password || undefined });
      if (!response.ok) throw new Error(response.error);
      setCatalogs((current) => ({ ...current, [connection.id]: response.result.databases }));
      showNotice(`${connection.name || connection.id} 连接成功`, { tone: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(message.startsWith("No password is available") ? "未找到已保存的数据库密码" : "数据库连接失败", {
        message: message.startsWith("No password is available") ? "请输入密码后保存，或直接在密码框中输入后测试。" : message,
        tone: "warning"
      });
    } finally {
      setTestingId((current) => current === connection.id ? null : current);
    }
  }

  async function save(connection: DatabaseConnectionConfig) {
    const password = passwordDrafts[connection.id] ?? "";
    setSavingCredentialId(connection.id);
    try {
      await saveConfigDraft({ showSuccessNotice: false });
      if (password) {
        await window.codexh.saveDatabaseCredential({ connectionId: connection.id, password });
        setPasswordDrafts((current) => ({ ...current, [connection.id]: "" }));
        setSavedCredentialIds((current) => new Set(current).add(connection.id));
      }
      setEditingId(null);
      showNotice("数据库连接已保存", {
        message: password ? "密码已加密保存，可直接测试连接或在聊天中调用该数据库。" : "连接配置已保存。",
        tone: "success"
      });
    } catch (error) {
      showNotice("数据库连接保存失败", { message: error instanceof Error ? error.message : String(error), tone: "warning" });
    } finally {
      setSavingCredentialId((current) => current === connection.id ? null : current);
    }
  }

  return {
    passwordDrafts,
    setPasswordDrafts,
    savedCredentialIds,
    setSavedCredentialIds,
    editingId,
    setEditingId,
    testingId,
    savingCredentialId,
    changingEnabledId,
    catalogs,
    updateDraft,
    setEnabled,
    add,
    remove,
    test,
    save
  };
}
