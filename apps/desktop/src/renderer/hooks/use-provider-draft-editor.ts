import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { AppConfig, ModelProfile, ProviderDefinition } from "@shared-types";
import {
  cloneConfig,
  createEmptyProvider,
  createModelProfile,
  getModelsForProvider,
  normalizeDraftConfig,
  resolveSettingsProviderId
} from "../lib/config-utils";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

type Options = {
  configDraft: AppConfig | null;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  showNotice: Notice;
};

export function useProviderDraftEditor({ configDraft, setConfigDraft, showNotice }: Options) {
  const [settingsProviderId, setSettingsProviderId] = useState<string | null>(null);
  const [providerSecretDrafts, setProviderSecretDrafts] = useState<Record<string, string>>({});
  const [newModelId, setNewModelId] = useState("");
  const [newModelDisplayName, setNewModelDisplayName] = useState("");

  const settingsProvider = useMemo(() => {
    if (!configDraft) return null;
    return configDraft.providers.find((provider) => provider.id === settingsProviderId) ?? configDraft.providers[0] ?? null;
  }, [configDraft, settingsProviderId]);
  const settingsProviderModels = useMemo(
    () => configDraft && settingsProvider ? getModelsForProvider(configDraft, settingsProvider.id) : [],
    [configDraft, settingsProvider]
  );

  useEffect(() => {
    if (!configDraft) {
      setSettingsProviderId(null);
      return;
    }
    if (settingsProviderId && configDraft.providers.some((provider) => provider.id === settingsProviderId)) return;
    setSettingsProviderId(resolveSettingsProviderId(configDraft));
  }, [configDraft, settingsProviderId]);

  function reset(nextConfig: AppConfig, preferredProviderId?: string | null) {
    const draft = cloneConfig(nextConfig);
    setConfigDraft(draft);
    setSettingsProviderId(resolveSettingsProviderId(draft, preferredProviderId));
    setProviderSecretDrafts({});
    setNewModelId("");
    setNewModelDisplayName("");
  }

  function updateProviderDraft(providerId: string, patch: Partial<ProviderDefinition>) {
    setConfigDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      next.providers = next.providers.map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider);
      return normalizeDraftConfig(next);
    });
  }

  function addCustomProvider() {
    if (!configDraft) return;
    const nextProvider = createEmptyProvider(configDraft.providers);
    const nextDraft = cloneConfig(configDraft);
    nextDraft.providers.push(nextProvider);
    setConfigDraft(normalizeDraftConfig(nextDraft));
    setSettingsProviderId(nextProvider.id);
    setNewModelId("");
    setNewModelDisplayName("");
  }

  function removeProvider(providerId: string) {
    if (!configDraft) return;
    const remainingModels = configDraft.models.filter((model) => model.providerId !== providerId);
    if (remainingModels.length === 0) {
      showNotice("至少保留一个模型后，才能删除这个供应商。");
      return;
    }
    const nextDraft = cloneConfig(configDraft);
    nextDraft.providers = nextDraft.providers.filter((provider) => provider.id !== providerId);
    nextDraft.models = remainingModels;
    const normalized = normalizeDraftConfig(nextDraft);
    setConfigDraft(normalized);
    setProviderSecretDrafts((current) => {
      const { [providerId]: _removed, ...rest } = current;
      return rest;
    });
    setSettingsProviderId(normalized.providers[0]?.id ?? null);
  }

  function setProviderAsDefault(providerId: string) {
    setConfigDraft((current) => {
      if (!current) return current;
      const providerModels = getModelsForProvider(current, providerId);
      if (providerModels.length === 0) return current;
      const next = cloneConfig(current);
      next.defaultProvider = providerId;
      if (!providerModels.some((model) => model.id === next.defaultModel)) next.defaultModel = providerModels[0].id;
      return normalizeDraftConfig(next);
    });
  }

  function addModelToProvider(providerId: string) {
    if (!configDraft) return;
    const nextId = newModelId.trim();
    if (!nextId) {
      showNotice("请先填写模型名称。");
      return;
    }
    if (configDraft.models.some((model) => model.providerId === providerId && model.id === nextId)) {
      showNotice("模型名称不能重复。", { message: "同一供应商下的模型 ID 必须唯一。" });
      return;
    }
    const nextDraft = cloneConfig(configDraft);
    nextDraft.models.push(createModelProfile(providerId, nextId, newModelDisplayName));
    setConfigDraft(normalizeDraftConfig(nextDraft));
    setNewModelId("");
    setNewModelDisplayName("");
  }

  function updateModelDraft(providerId: string, modelId: string, patch: Partial<ModelProfile>) {
    setConfigDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      next.models = next.models.map((model) =>
        model.providerId === providerId && model.id === modelId ? { ...model, ...patch } : model
      );
      return normalizeDraftConfig(next);
    });
  }

  function removeModel(providerId: string, modelId: string) {
    if (!configDraft) return;
    if (configDraft.models.length <= 1) {
      showNotice("至少保留一个模型。");
      return;
    }
    const nextDraft = cloneConfig(configDraft);
    nextDraft.models = nextDraft.models.filter((model) => model.providerId !== providerId || model.id !== modelId);
    setConfigDraft(normalizeDraftConfig(nextDraft));
  }

  return {
    settingsProviderId,
    setSettingsProviderId,
    providerSecretDrafts,
    setProviderSecretDrafts,
    newModelId,
    setNewModelId,
    newModelDisplayName,
    setNewModelDisplayName,
    settingsProvider,
    settingsProviderModels,
    reset,
    updateProviderDraft,
    addCustomProvider,
    removeProvider,
    setProviderAsDefault,
    addModelToProvider,
    updateModelDraft,
    removeModel
  };
}
