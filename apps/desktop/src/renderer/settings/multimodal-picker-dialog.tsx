import { IconClose } from "../icons";
import type { AppConfig, ModelProfile } from "@shared-types";

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

export function MultimodalPickerDialog({ motionPhase, role, configDraft, selected, setSelected, onClose, onApply, onSetDefault }: Props) {
  const supportsInput = (model: ModelProfile) => model.supportsMultimodalInput;
  const candidates = configDraft.models.filter((model) => role === "input" ? supportsInput(model) : model.role !== role);
  return <div className="fetch-models-overlay motion-overlay" data-motion={motionPhase}><div className="fetch-models-dialog multimodal-picker-dialog" role="dialog" aria-label="选择模型角色"><div className="fetch-models-head"><strong>{role === "input" ? "选择多模态识别模型" : "添加模型"}</strong><button type="button" onClick={onClose} title="关闭"><IconClose /></button></div><div className="fetch-models-list multimodal-picker-list">{candidates.map((model) => { const key = `${model.providerId}:${model.id}`; const checked = selected.includes(key); return <label key={key} className={`fetch-models-item multimodal-picker-item ${checked ? "is-checked" : ""}`}><input type={role === "input" ? "radio" : "checkbox"} checked={checked} onChange={() => role === "input" ? onSetDefault("input", model.providerId, model.id) : setSelected(checked ? selected.filter((value) => value !== key) : [...selected, key])} /><div className="fetch-models-copy"><strong>{model.displayName}</strong><span>{model.providerId}</span></div></label>; })}</div><div className="fetch-models-actions"><button className="button ghost" onClick={onClose}>取消</button>{role !== "input" ? <button className="button warm" onClick={onApply} disabled={!selected.length}>添加</button> : null}</div></div></div>;
}
