import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "@shared-types";

type ToneOption = { value: AppConfig["responseTone"]; label: string; description: string };
type Props = { configDraft: AppConfig; options: ToneOption[]; defaultTone: AppConfig["responseTone"]; setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>; onSave: () => Promise<void> };
export function ResponseTonePage({ configDraft, options, defaultTone, setConfigDraft, onSave }: Props) { return (
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
                            onClick={() => setConfigDraft((current) => current ? { ...current, responseTone: option.value } : current)}
                          >
                            <strong>{option.label}</strong>
                            <span>{option.description}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="settings-save-row">
                      <span className="subtle-inline">保存后立即应用于后续回复。</span>
                      <button className="button warm" type="button" onClick={() => void onSave()}>保存</button>
                    </div>
                  </div>
                </div>
                ); }
