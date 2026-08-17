import { memo, useCallback, useMemo, useState } from "react";
import { IconClose } from "../icons";
import type { AppConfig, ModelProfile } from "@shared-types";
import { getProviderDisplayName, modelKey } from "../lib/config-utils";

type MultimodalPickerRole = "reasoning" | "image" | "video" | "input";

type Props = {
  motionPhase: string;
  role: MultimodalPickerRole;
  configDraft: AppConfig;
  onClose: () => void;
  onApply: (selected: string[]) => void;
  onSetDefault: (kind: "input", providerId: string, modelId: string) => void;
};

function getModelProviderLabel(config: AppConfig, model: ModelProfile): string {
  const provider = config.providers.find((entry) => entry.id === model.providerId);
  const configuredName = provider?.name?.trim();
  if (configuredName && !/^provider-\d+$/i.test(configuredName)) {
    return getProviderDisplayName(provider!);
  }

  const identity = `${model.id} ${model.displayName}`.toLowerCase();
  if (/claude/.test(identity)) return "Anthropic";
  if (/\b(?:glm|chatglm)\b/.test(identity)) return "Zhipu AI";
  if (/deepseek/.test(identity)) return "DeepSeek";
  if (/sensenova|sense-nova|sensechat/.test(identity)) return "SenseNova";
  if (/gpt|chatgpt|\bo[1-4]\b/.test(identity)) return "OpenAI";
  if (/grok|\bxai\b/.test(identity)) return "xAI";
  if (/qwen/.test(identity)) return "Qwen";
  if (/kimi|moonshot/.test(identity)) return "Moonshot AI";
  if (/gemini|imagen/.test(identity)) return "Google";
  if (/hunyuan/.test(identity)) return "Tencent Hunyuan";
  if (/agnes/.test(identity)) return "Agnes AI";

  return configuredName || (provider ? getProviderDisplayName(provider) : model.providerId);
}

export function MultimodalPickerDialog({
  motionPhase,
  role,
  configDraft,
  onClose,
  onApply,
  onSetDefault
}: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const providerId = configDraft.multimodal.input.defaultProviderId;
    const modelId = configDraft.multimodal.input.defaultModelId;
    return role === "input" && providerId && modelId ? new Set([modelKey(providerId, modelId)]) : new Set();
  });
  const candidates = useMemo(() => configDraft.models
    .filter((model) => role === "input" ? model.supportsMultimodalInput : model.role !== role)
    .map((model) => ({
      key: modelKey(model.providerId, model.id),
      model,
      providerLabel: getModelProviderLabel(configDraft, model)
    })), [configDraft, role]);

  const selectModel = useCallback((key: string, providerId: string, modelId: string) => {
    if (role === "input") {
      onSetDefault("input", providerId, modelId);
      onClose();
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [onClose, onSetDefault, role]);

  return (
    <div className="fetch-models-overlay motion-overlay" data-motion={motionPhase}>
      <div className="fetch-models-dialog multimodal-picker-dialog" role="dialog" aria-label="选择模型角色">
        <div className="fetch-models-head">
          <strong>{role === "input" ? "选择多模态识别模型" : "添加模型"}</strong>
          <button type="button" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>
        <div className="fetch-models-list multimodal-picker-list">
          {candidates.map(({ key, model, providerLabel }) => (
            <MultimodalPickerRow
              key={key}
              modelKey={key}
              model={model}
              providerLabel={providerLabel}
              checked={selectedIds.has(key)}
              single={role === "input"}
              onSelect={selectModel}
            />
          ))}
        </div>
        <div className="fetch-models-actions">
          <button className="button ghost" onClick={onClose}>取消</button>
          {role !== "input" ? (
            <button className="button warm" onClick={() => onApply([...selectedIds])} disabled={selectedIds.size === 0}>添加</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const MultimodalPickerRow = memo(function MultimodalPickerRow({
  modelKey: key,
  model,
  providerLabel,
  checked,
  single,
  onSelect
}: {
  modelKey: string;
  model: ModelProfile;
  providerLabel: string;
  checked: boolean;
  single: boolean;
  onSelect: (key: string, providerId: string, modelId: string) => void;
}) {
  return (
    <label className={`fetch-models-item multimodal-picker-item ${checked ? "is-checked" : ""}`}>
      <input
        type={single ? "radio" : "checkbox"}
        checked={checked}
        onChange={() => onSelect(key, model.providerId, model.id)}
      />
      <div className="fetch-models-copy">
        <strong>{model.displayName}</strong>
        <span>{providerLabel}</span>
      </div>
    </label>
  );
});
