import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "@shared-types";

type ToneOption = { value: AppConfig["responseTone"]; label: string; description: string };
type Props = { configDraft: AppConfig; options: ToneOption[]; defaultTone: AppConfig["responseTone"]; setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>; onSave: (options?: { draft?: AppConfig; showSuccessNotice?: boolean }) => Promise<void> };
export function ResponseTonePage({ configDraft, options, defaultTone, setConfigDraft, onSave }: Props) {
  const updateAndSave = (update: (current: AppConfig) => AppConfig) => {
    const nextDraft = update(configDraft);
    setConfigDraft(nextDraft);
    void onSave({ draft: nextDraft, showSuccessNotice: false }).catch((error) => {
      console.error("[renderer] Failed to auto-save response tone", error);
    });
  };

  return (
                <div className="settings-section">
                  <div className="config-block general-tone-settings">
                    <div className="section-copy">
                      <strong>语气设置</strong>
                      <span>选择聊天回复的整体表达风格，不影响任务执行、工具调用和结果准确性。</span>
                    </div>
                    <div className="general-tone-segmented" role="radiogroup" aria-label="回复语气">
                      {options.map((option) => {
                        const active = (configDraft.responseTone ?? defaultTone) === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            className={active ? "active" : ""}
                            onClick={() => updateAndSave((current) => ({ ...current, responseTone: option.value }))}
                          >
                            <strong>{option.label}</strong>
                            <span>{option.description}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="settings-save-row">
                      <span className="subtle-inline">修改后自动保存，后续回复立即使用。</span>
                    </div>
                  </div>

                  <div className="config-block general-tone-settings">
                    <div className="section-copy">
                      <strong>任务标题</strong>
                      <span>新任务的第一条消息发出后立即生成规则标题，随后由模型提炼一句更准确的话标题覆盖它；手动重命名过的标题不会被覆盖。</span>
                    </div>
                    <div className="memory-option-row">
                      <label className="memory-option" title="关闭后只保留规则提炼的标题，不再调用模型">
                        <input
                          type="checkbox"
                          checked={configDraft.desktop.autoTitleGeneration !== false}
                          onChange={(event) => updateAndSave((current) => ({ ...current, desktop: { ...current.desktop, autoTitleGeneration: event.target.checked } }))}
                        />
                        <span>自动提炼标题</span>
                      </label>
                    </div>
                    <div className="settings-save-row">
                      <span className="subtle-inline">由当前对话所选模型生成，超时或失败时保留规则标题。</span>
                    </div>
                  </div>
                </div>
                ); }
