import { IconClose } from "../icons";
import type { AppConfig, ProviderDefinition } from "@shared-types";

type FetchedModel = { id: string; displayName?: string; contextWindow?: number };

type Props = {
  motionPhase: string;
  fetchedModels: FetchedModel[];
  selectedFetchedModelIds: string[];
  configDraft: AppConfig | null;
  settingsProvider: ProviderDefinition | null;
  setSelectedFetchedModelIds: (ids: string[]) => void;
  setShowFetchedModels: (open: boolean) => void;
  toggleFetchedModelSelection: (modelId: string) => void;
  applyFetchedModels: () => void;
};

export function FetchedModelsDialog({ motionPhase, fetchedModels, selectedFetchedModelIds, configDraft, settingsProvider, setSelectedFetchedModelIds, setShowFetchedModels, toggleFetchedModelSelection, applyFetchedModels }: Props) {
  return <div className="fetch-models-overlay motion-overlay" data-motion={motionPhase}><div className="fetch-models-dialog" role="dialog" aria-label="选择要添加的模型"><div className="fetch-models-head"><strong>选择要添加的模型</strong><button type="button" onClick={() => setShowFetchedModels(false)} title="关闭"><IconClose /></button></div><div className="fetch-models-list">{fetchedModels.map((entry) => { const checked = selectedFetchedModelIds.includes(entry.id); const already = configDraft?.models.some((model) => model.providerId === settingsProvider?.id && model.id === entry.id) ?? false; return <label key={entry.id} className={`fetch-models-item ${checked ? "is-checked" : ""} ${already ? "is-existed" : ""}`}><input type="checkbox" checked={checked} onChange={() => toggleFetchedModelSelection(entry.id)} /><div className="fetch-models-copy"><strong>{entry.id}</strong>{entry.displayName && entry.displayName !== entry.id ? <span>{entry.displayName}</span> : null}</div>{already ? <em>已存在</em> : null}</label>; })}</div><div className="fetch-models-actions"><button className="button ghost" onClick={() => setSelectedFetchedModelIds(fetchedModels.filter((entry) => !configDraft?.models.some((model) => model.providerId === settingsProvider?.id && model.id === entry.id)).map((entry) => entry.id))}>全选</button><button className="button ghost" onClick={() => setShowFetchedModels(false)}>取消</button><button className="button warm" onClick={applyFetchedModels} disabled={!selectedFetchedModelIds.length}>添加到模型列表（{selectedFetchedModelIds.length}）</button></div></div></div>;
}
