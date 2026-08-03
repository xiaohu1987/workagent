import { IconClose } from "../icons";
import type { AppConfig, ModelProfile } from "@shared-types";
import { getProviderDisplayName, modelKey } from "../lib/config-utils";

type MultimodalPickerRole = "reasoning" | "image" | "video" | "input";

type Props = {
  motionPhase: string;
  role: MultimodalPickerRole;
  configDraft: AppConfig;
  selected: string[];
  setSelected: (selected: string[]) => void;
  onClose: () => void;
  onApply: () => void;
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
  selected,
  setSelected,
  onClose,
  onApply,
  onSetDefault
}: Props) {
  const candidates = configDraft.models.filter((model) =>
    role === "input" ? model.supportsMultimodalInput : model.role !== role
  );

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
          {candidates.map((model) => {
            const key = modelKey(model.providerId, model.id);
            const checked = selected.includes(key);
            const providerLabel = getModelProviderLabel(configDraft, model);

            return (
              <label key={key} className={`fetch-models-item multimodal-picker-item ${checked ? "is-checked" : ""}`}>
                <input
                  type={role === "input" ? "radio" : "checkbox"}
                  checked={checked}
                  onChange={() => {
                    if (role === "input") {
                      setSelected([key]);
                      onSetDefault("input", model.providerId, model.id);
                      onClose();
                      return;
                    }
                    setSelected(checked ? selected.filter((value) => value !== key) : [...selected, key]);
                  }}
                />
                <div className="fetch-models-copy">
                  <strong>{model.displayName}</strong>
                  <span>{providerLabel}</span>
                </div>
              </label>
            );
          })}
        </div>
        <div className="fetch-models-actions">
          <button className="button ghost" onClick={onClose}>取消</button>
          {role !== "input" ? (
            <button className="button warm" onClick={onApply} disabled={!selected.length}>添加</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
