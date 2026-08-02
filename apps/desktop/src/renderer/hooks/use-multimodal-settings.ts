import { useState, type Dispatch, type SetStateAction } from "react";
import type { AppConfig } from "@shared-types";
import { buildConfigToSave, cloneConfig, isReasoningModel, normalizeDraftConfig } from "../lib/config-utils";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;
type PickerRole = "reasoning" | "image" | "video" | "input" | null;
type MultimodalKind = "image" | "video" | "input";

type Options = {
  config: AppConfig | null;
  setConfig: Dispatch<SetStateAction<AppConfig | null>>;
  configDraft: AppConfig | null;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  providerSecretDrafts: Record<string, string>;
  settingsProviderId: string | null;
  refreshConfig: (preferredProviderId?: string | null) => Promise<void>;
  showNotice: Notice;
};

function setRoleOnDraft(draft: AppConfig, providerId: string, modelId: string, role: "reasoning" | "image" | "video" | null) {
  const model = draft.models.find((entry) => entry.providerId === providerId && entry.id === modelId);
  if (!model) return;
  const previousRole = model.role === "image" || model.role === "video" || model.role === "reasoning" ? model.role : null;
  if (role) {
    model.role = role;
    if (role === "image") model.supportsImageGeneration = true;
    if (role === "video") model.supportsVideoGeneration = true;
  } else {
    delete model.role;
  }
  if (previousRole === "image" || previousRole === "video") {
    if (draft.multimodal[previousRole].defaultProviderId === providerId && draft.multimodal[previousRole].defaultModelId === modelId) {
      delete draft.multimodal[previousRole].defaultProviderId;
      delete draft.multimodal[previousRole].defaultModelId;
    }
  }
  if ((role === "image" || role === "video") && !draft.multimodal[role].defaultModelId) {
    draft.multimodal[role].defaultProviderId = providerId;
    draft.multimodal[role].defaultModelId = modelId;
  }
}

export function useMultimodalSettings({
  config,
  setConfig,
  configDraft,
  setConfigDraft,
  providerSecretDrafts,
  settingsProviderId,
  refreshConfig,
  showNotice
}: Options) {
  const [pickerRole, setPickerRole] = useState<PickerRole>(null);
  const [pickerSelected, setPickerSelected] = useState<string[]>([]);

  function resetPicker() {
    setPickerRole(null);
    setPickerSelected([]);
  }

  async function persistChange(mutate: (draft: AppConfig) => void, successTitle = "多模态配置已保存") {
    if (!config || !configDraft) return;
    const nextDraft = cloneConfig(configDraft);
    mutate(nextDraft);
    const normalized = normalizeDraftConfig(nextDraft);
    setConfigDraft(normalized);
    try {
      const nextConfig = buildConfigToSave(normalized, config, providerSecretDrafts);
      await window.codexh.saveConfig(nextConfig);
      setConfig(nextConfig);
      showNotice(successTitle, { message: "已立即生效，无需再点保存。", tone: "success" });
    } catch (error) {
      showNotice("多模态配置保存失败", {
        message: error instanceof Error ? error.message : String(error),
        tone: "warning"
      });
      await refreshConfig(settingsProviderId);
    }
  }

  function setModelRole(providerId: string, modelId: string, role: "reasoning" | "image" | "video" | null) {
    const roleLabel = role === "reasoning" ? "推理模型" : role === "image" ? "图片模型" : role === "video" ? "视频模型" : null;
    void persistChange((next) => setRoleOnDraft(next, providerId, modelId, role), roleLabel ? `已加入${roleLabel}` : "已从多模态列表移除");
  }

  function setMultimodalDefault(kind: MultimodalKind, providerId: string, modelId: string) {
    void persistChange((next) => {
      next.multimodal[kind].defaultProviderId = providerId;
      next.multimodal[kind].defaultModelId = modelId;
    }, `已设为默认${kind === "image" ? "图片" : kind === "video" ? "视频" : "多模态识别"}模型`);
  }

  function setReasoningDefault(providerId: string, modelId: string) {
    void persistChange((next) => {
      const model = next.models.find((entry) => entry.providerId === providerId && entry.id === modelId && isReasoningModel(entry));
      if (!model) return;
      next.defaultProvider = providerId;
      next.defaultModel = modelId;
    }, "已设为默认推理模型");
  }

  function setMultimodalEnabled(kind: MultimodalKind, enabled: boolean) {
    void persistChange((next) => {
      next.multimodal[kind].enabled = enabled;
    }, enabled
      ? `已启用${kind === "image" ? "图片生成" : kind === "video" ? "视频生成" : "多模态识别回退"}`
      : `已关闭${kind === "image" ? "图片生成" : kind === "video" ? "视频生成" : "多模态识别回退"}`);
  }

  function removeFromMultimodalRole(providerId: string, modelId: string) {
    setModelRole(providerId, modelId, null);
  }

  function applyPicker() {
    if (!pickerRole || pickerSelected.length === 0) return;
    const role = pickerRole;
    const selected = [...pickerSelected];
    resetPicker();
    if (role === "input") {
      const key = selected[0];
      if (!key) return;
      const [providerId, ...modelIdParts] = key.split("::");
      const modelId = modelIdParts.join("::");
      if (providerId && modelId) setMultimodalDefault("input", providerId, modelId);
      return;
    }
    const roleLabel = role === "reasoning" ? "推理模型" : role === "image" ? "图片模型" : "视频模型";
    void persistChange((next) => {
      for (const key of selected) {
        const [providerId, ...modelIdParts] = key.split("::");
        const modelId = modelIdParts.join("::");
        if (providerId && modelId) setRoleOnDraft(next, providerId, modelId, role);
      }
    }, `已添加 ${selected.length} 个到${roleLabel}`);
  }

  function clearInputDefault() {
    void persistChange((next) => {
      delete next.multimodal.input.defaultProviderId;
      delete next.multimodal.input.defaultModelId;
    }, "已清除默认多模态识别模型");
  }

  return {
    pickerRole,
    setPickerRole,
    pickerSelected,
    setPickerSelected,
    resetPicker,
    setMultimodalDefault,
    setReasoningDefault,
    setMultimodalEnabled,
    removeFromMultimodalRole,
    applyPicker,
    clearInputDefault
  };
}
