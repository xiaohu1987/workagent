import { useState, type Dispatch, type SetStateAction } from "react";
import type { AppConfig, ProviderDefinition } from "@shared-types";
import { cloneConfig, createModelProfile, normalizeDraftConfig } from "../lib/config-utils";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;
type FetchedModel = Awaited<ReturnType<typeof window.codexh.fetchProviderModels>>[number];

type Options = {
  configDraft: AppConfig | null;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  settingsProvider: ProviderDefinition | null;
  providerSecretDrafts: Record<string, string>;
  showNotice: Notice;
};

export function useFetchedProviderModels({
  configDraft,
  setConfigDraft,
  settingsProvider,
  providerSecretDrafts,
  showNotice
}: Options) {
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [selectedFetchedModelIds, setSelectedFetchedModelIds] = useState<string[]>([]);
  const [showFetchedModels, setShowFetchedModels] = useState(false);
  const [isFetchingModels, setIsFetchingModels] = useState(false);

  async function fetchAndShowProviderModels(providerId: string) {
    if (!configDraft) return;
    const provider = configDraft.providers.find((entry) => entry.id === providerId);
    if (!provider) return;
    const baseUrl = (provider.baseUrl ?? "").trim();
    const secret = providerSecretDrafts[provider.id]?.trim();
    const apiKey = secret || provider.apiKey || (provider.apiKeyEnv ? "" : "");
    if (!baseUrl) {
      showNotice("请先填写调用地址。");
      return;
    }
    if (!apiKey && !provider.apiKeyEnv) {
      showNotice("请先填写 API Key。", { message: "或者在 KEY 字段使用环境变量名。" });
      return;
    }

    setIsFetchingModels(true);
    try {
      const list = await window.codexh.fetchProviderModels({
        baseUrl,
        apiKey: apiKey || undefined,
        apiKeyEnv: provider.apiKeyEnv,
        type: provider.type,
        id: provider.id
      });
      setFetchedModels(list);
      setSelectedFetchedModelIds([]);
      setShowFetchedModels(true);
    } catch (error) {
      showNotice("获取模型失败。", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsFetchingModels(false);
    }
  }

  function toggleFetchedModelSelection(modelId: string) {
    setSelectedFetchedModelIds((current) => current.includes(modelId)
      ? current.filter((id) => id !== modelId)
      : [...current, modelId]);
  }

  function applyFetchedModels() {
    if (!configDraft || !settingsProvider) return;
    const candidates = fetchedModels.filter((entry) => selectedFetchedModelIds.includes(entry.id));
    if (candidates.length === 0) {
      showNotice("没有勾选要添加的模型。");
      return;
    }

    const existing = new Set(
      configDraft.models.filter((model) => model.providerId === settingsProvider.id).map((model) => model.id)
    );
    const nextDraft = cloneConfig(configDraft);
    let added = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      if (existing.has(candidate.id)) {
        skipped += 1;
        continue;
      }
      nextDraft.models.push({
        ...createModelProfile(settingsProvider.id, candidate.id, candidate.displayName ?? candidate.id),
        ...(candidate.contextWindow ? { contextWindow: candidate.contextWindow } : {})
      });
      existing.add(candidate.id);
      added += 1;
    }
    setConfigDraft(normalizeDraftConfig(nextDraft));
    setShowFetchedModels(false);
    setSelectedFetchedModelIds([]);
    setFetchedModels([]);
    showNotice(
      added > 0 ? `已添加 ${added} 个模型。` : "没有新增模型。",
      skipped > 0 ? { message: `跳过 ${skipped} 个已存在模型。` } : undefined
    );
  }

  return {
    fetchedModels,
    selectedFetchedModelIds,
    setSelectedFetchedModelIds,
    showFetchedModels,
    setShowFetchedModels,
    isFetchingModels,
    fetchAndShowProviderModels,
    toggleFetchedModelSelection,
    applyFetchedModels
  };
}
