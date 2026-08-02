import { IconSkills, IconTrash } from "../../../icons";
import type { Dispatch, SetStateAction } from "react";
import type { PluginRecord } from "@shared-types";
import type { ManagedRemoval } from "../../../core/app-types";

type Props = {
  plugins: PluginRecord[];
  pluginCallCounts: ReadonlyMap<string, number>;
  setManagedRemoval: Dispatch<SetStateAction<ManagedRemoval | null>>;
};

export function PluginsPage({ plugins, pluginCallCounts, setManagedRemoval }: Props) { return (
                <div key="capability-plugins" className="settings-section capability-panel plugin-settings-section">
                  <div className="config-block plugin-library-card">
                    <div className="section-copy">
                      <strong>已安装插件</strong>
                      <span>在聊天输入框的“插件”菜单中选择后，AI 会自动匹配其中的 Skill。这里仅用于安装和查看已安装的能力包。</span>
                    </div>
                    <div className="capability-list">
                      {plugins.map((plugin) => {
                        const callCount = pluginCallCounts.get(plugin.id) ?? 0;
                        return (
                          <article key={plugin.id} className="skill-row capability-list-item">
                            <div className="skill-row-main">
                              <div className="skill-row-title">
                                <span className="skill-row-icon" aria-hidden><IconSkills /></span>
                                <strong title={plugin.name}>{plugin.name}</strong>
                                <span className="skill-scope-pill plugin">插件</span>
                                <span className="skill-domain-chip">v{plugin.version}</span>
                              </div>
                              <p className="skill-row-desc" title={plugin.source}>{plugin.source}</p>
                              <div className="skill-row-meta">
                                <span className="skill-stat">已安装</span>
                                <span className={`skill-stat ${callCount > 0 ? "is-hot" : ""}`}>
                                  调用 {callCount.toLocaleString()} 次
                                </span>
                                <span className="skill-row-path" title={plugin.installPath}>{plugin.installPath}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="button ghost danger-icon-button skill-remove-button"
                              title={`移除 ${plugin.name}`}
                              aria-label={`移除 ${plugin.name}`}
                              onClick={() => setManagedRemoval({ kind: "plugin", plugin })}
                            >
                              <IconTrash />
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </div>
); }
