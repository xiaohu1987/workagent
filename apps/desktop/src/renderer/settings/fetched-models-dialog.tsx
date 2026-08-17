import { memo, useCallback, useMemo, useState } from "react";
import { IconClose } from "../icons";
import type { AppConfig, ProviderDefinition } from "@shared-types";

type FetchedModel = { id: string; displayName?: string; contextWindow?: number };

type Props = {
  motionPhase: string;
  fetchedModels: FetchedModel[];
  configDraft: AppConfig | null;
  settingsProvider: ProviderDefinition | null;
  setShowFetchedModels: (open: boolean) => void;
  applyFetchedModels: (selectedModelIds: string[]) => void;
};

const FetchedModelRow = memo(function FetchedModelRow({
  entry,
  checked,
  already,
  onToggle
}: {
  entry: FetchedModel;
  checked: boolean;
  already: boolean;
  onToggle: (modelId: string) => void;
}) {
  return (
    <label className={`fetch-models-item ${checked ? "is-checked" : ""} ${already ? "is-existed" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={already}
        onChange={() => onToggle(entry.id)}
      />
      <div className="fetch-models-copy">
        <strong>{entry.id}</strong>
        {entry.displayName && entry.displayName !== entry.id ? <span>{entry.displayName}</span> : null}
      </div>
      {already ? <em>已存在</em> : null}
    </label>
  );
});

export function FetchedModelsDialog({ motionPhase, fetchedModels, configDraft, settingsProvider, setShowFetchedModels, applyFetchedModels }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const existingIds = useMemo(() => new Set(
    configDraft?.models
      .filter((model) => model.providerId === settingsProvider?.id)
      .map((model) => model.id) ?? []
  ), [configDraft?.models, settingsProvider?.id]);

  const toggleSelection = useCallback((modelId: string) => {
    if (existingIds.has(modelId)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, [existingIds]);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(fetchedModels.filter((entry) => !existingIds.has(entry.id)).map((entry) => entry.id)));
  }, [existingIds, fetchedModels]);

  return (
    <div className="fetch-models-overlay motion-overlay" data-motion={motionPhase}>
      <div className="fetch-models-dialog" role="dialog" aria-label="选择要添加的模型">
        <div className="fetch-models-head">
          <strong>选择要添加的模型</strong>
          <button type="button" onClick={() => setShowFetchedModels(false)} title="关闭"><IconClose /></button>
        </div>
        <div className="fetch-models-list">
          {fetchedModels.map((entry) => (
            <FetchedModelRow
              key={entry.id}
              entry={entry}
              checked={selectedIds.has(entry.id)}
              already={existingIds.has(entry.id)}
              onToggle={toggleSelection}
            />
          ))}
        </div>
        <div className="fetch-models-actions">
          <button className="button ghost" onClick={selectAll}>全选</button>
          <button className="button ghost" onClick={() => setShowFetchedModels(false)}>取消</button>
          <button className="button warm" onClick={() => applyFetchedModels([...selectedIds])} disabled={selectedIds.size === 0}>
            添加到模型列表（{selectedIds.size}）
          </button>
        </div>
      </div>
    </div>
  );
}
