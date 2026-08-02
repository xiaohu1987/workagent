import { IconSkills, IconTrash } from "../../../icons";
import type { Dispatch, SetStateAction } from "react";
import type { SkillMetadata, SkillUsageStats } from "@shared-types";
import type { ManagedRemoval } from "../../../core/app-types";

type Props = {
  userSkills: SkillMetadata[];
  resolveSkillUsageStats: (skill: SkillMetadata) => SkillUsageStats;
  setManagedRemoval: Dispatch<SetStateAction<ManagedRemoval | null>>;
};

export function UserSkillsPage({ userSkills, resolveSkillUsageStats, setManagedRemoval }: Props) { return (
                <div key="capability-user-skills" className="settings-section capability-panel user-skill-settings-section">
                  <div className="config-block user-skill-library-block">
                    <div className="section-copy">
                      <strong>已生成技能</strong>
                      <span>在历史聊天上右键选择“提炼技能”后，生成的工作流会显示在这里，并可在后续聊天中复用。</span>
                    </div>
                    <div className="capability-list">
                      {userSkills.length > 0 ? userSkills.map((skill) => {
                        const callCount = resolveSkillUsageStats(skill).callCount;
                        return <article key={skill.id} className="skill-row capability-list-item">
                          <div className="skill-row-main">
                            <div className="skill-row-title">
                              <span className="skill-row-icon" aria-hidden><IconSkills /></span>
                              <strong title={skill.displayName ?? skill.name}>{skill.displayName ?? skill.name}</strong>
                              <span className="skill-scope-pill user">用户</span>
                              <span className="skill-domain-chip">提炼</span>
                            </div>
                            <p className="skill-row-desc" title={skill.description}>{skill.description}</p>
                            <div className="skill-row-meta">
                              <span className="skill-stat">用户技能</span>
                              <span className={`skill-stat ${callCount > 0 ? "is-hot" : ""}`}>
                                调用 {callCount.toLocaleString()} 次
                              </span>
                              <span className="skill-row-path" title={skill.skillPath}>{skill.skillPath}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="button ghost danger-icon-button skill-remove-button"
                            title={`删除 ${skill.displayName ?? skill.name}`}
                            aria-label={`删除 ${skill.displayName ?? skill.name}`}
                            onClick={() => setManagedRemoval({ kind: "skill", skill })}
                          >
                            <IconTrash />
                          </button>
                        </article>;
                      }) : <div className="detail-empty">尚未生成用户技能。</div>}
                    </div>
                  </div>
                </div>
); }
