import type { Dispatch, SetStateAction } from "react";
import type { SkillLabEvent, SkillLabProgress, SkillMetadata } from "@shared-types";
import { ComposerSelect } from "../../../workspace/composer-select";
import { IconCheck, IconSkills, IconStop } from "../../../icons";

type SkillLabMode = "create" | "optimize";
type SkillLabStatus = "idle" | "clarifying" | "running" | "completed" | "failed" | "cancelled";
type SkillLabClarification = Extract<SkillLabEvent, { type: "skill-lab.clarification" }> & {
  answers: Record<string, string>;
  custom: Record<string, boolean>;
};
type SkillLabApproval = Extract<SkillLabEvent, { type: "skill-lab.approval" }>;
type SkillLabActivity = { id: string; phase: string; summary: string; state: "running" | "tested" };
type SelectOption = { value: string; label: string };

type Props = {
  skillLabMode: SkillLabMode;
  setSkillLabMode: Dispatch<SetStateAction<SkillLabMode>>;
  isSkillLabBusy: boolean;
  skillLabPrompt: string;
  setSkillLabPrompt: Dispatch<SetStateAction<string>>;
  skillLabTargetSkillId: string;
  setSkillLabTargetSkillId: Dispatch<SetStateAction<string>>;
  userSkills: SkillMetadata[];
  skillLabName: string;
  setSkillLabName: Dispatch<SetStateAction<string>>;
  skillLabModelSelection: string;
  setSkillLabModelSelection: Dispatch<SetStateAction<string>>;
  skillLabModelOptions: SelectOption[];
  skillLabIterations: number;
  setSkillLabIterations: Dispatch<SetStateAction<number>>;
  cancelSkillLab: () => Promise<void>;
  skillLabStatus: SkillLabStatus;
  startSkillLab: () => Promise<void>;
  skillLabError: string | null;
  skillLabClarification: SkillLabClarification | null;
  setSkillLabClarification: Dispatch<SetStateAction<SkillLabClarification | null>>;
  submitSkillLabClarification: () => Promise<void>;
  skillLabProgress: SkillLabProgress[];
  skillLabCurrentPhase: string;
  skillLabCurrentSummary: string;
  skillLabHeartbeatText: string;
  skillLabCompletedIterations: number;
  skillLabTotalIterations: number;
  skillLabElapsedLabel: string;
  skillLabCurrentIteration: number;
  skillLabLastCompletedActivity: SkillLabActivity | null;
  skillLabResult: SkillMetadata | null;
  skillLabLastRunMode: SkillLabMode;
  skillLabApproval: SkillLabApproval | null;
  resolveSkillLabApproval: (approved: boolean) => Promise<void>;
  skillLabProgressPercent: number;
};

export function SkillLabPage({ skillLabMode, setSkillLabMode, isSkillLabBusy, skillLabPrompt, setSkillLabPrompt, skillLabTargetSkillId, setSkillLabTargetSkillId, userSkills, skillLabName, setSkillLabName, skillLabModelSelection, setSkillLabModelSelection, skillLabModelOptions, skillLabIterations, setSkillLabIterations, cancelSkillLab, skillLabStatus, startSkillLab, skillLabError, skillLabClarification, setSkillLabClarification, submitSkillLabClarification, skillLabProgress, skillLabCurrentPhase, skillLabCurrentSummary, skillLabHeartbeatText, skillLabCompletedIterations, skillLabTotalIterations, skillLabElapsedLabel, skillLabCurrentIteration, skillLabLastCompletedActivity, skillLabResult, skillLabLastRunMode, skillLabApproval, resolveSkillLabApproval, skillLabProgressPercent }: Props) {
  return (
                <div key="capability-lab" className="settings-section capability-panel skill-lab-settings-section">
                  <div className="config-block skill-lab-editor">
                    <div className="section-copy">
                      <strong>技能实验室</strong>
                      <span>{skillLabMode === "optimize" ? "选择已生成的用户技能，继续测试并迭代完善。" : "输入需求，自动生成并迭代优化可复用 Skill。"}</span>
                    </div>
                    <div className="skill-lab-mode-choice" role="group" aria-label="技能实验室模式">
                      <button
                        type="button"
                        aria-pressed={skillLabMode === "create"}
                        className={skillLabMode === "create" ? "active" : ""}
                        disabled={isSkillLabBusy}
                        onClick={() => setSkillLabMode("create")}
                      >
                        新建 Skill
                      </button>
                      <button
                        type="button"
                        aria-pressed={skillLabMode === "optimize"}
                        className={skillLabMode === "optimize" ? "active" : ""}
                        disabled={isSkillLabBusy}
                        onClick={() => setSkillLabMode("optimize")}
                      >
                        持续优化
                      </button>
                    </div>
                    <label className="settings-field skill-lab-prompt-field">
                      <span>{skillLabMode === "optimize" ? "优化目标（可选）" : "需求"}</span>
                      <textarea
                        value={skillLabPrompt}
                        onChange={(event) => setSkillLabPrompt(event.target.value)}
                        placeholder={skillLabMode === "optimize"
                          ? "例如：加强异常恢复和只读检查；留空则根据现有 Skill 自动测试并优化"
                          : "例如：整理项目发布流程，生成一个包含检查、验证和回滚步骤的工作流 Skill"}
                        rows={7}
                        disabled={isSkillLabBusy}
                      />
                    </label>
                    <div className="skill-lab-options-row">
                      {skillLabMode === "optimize" ? (
                        <label className="settings-field skill-lab-name-field">
                          <span>选择用户技能</span>
                          <ComposerSelect
                            className="form-select skill-lab-skill-select"
                            ariaLabel="选择要持续优化的 Skill"
                            value={skillLabTargetSkillId}
                            disabled={isSkillLabBusy}
                            onChange={setSkillLabTargetSkillId}
                            options={userSkills.map((skill) => ({
                              value: skill.id,
                              label: skill.displayName ?? skill.name
                            }))}
                            placeholder="请选择要持续优化的 Skill"
                            searchable
                            searchPlaceholder="筛选 Skill"
                            emptyLabel="没有匹配的用户 Skill"
                          />
                        </label>
                      ) : (
                        <label className="settings-field skill-lab-name-field">
                          <span>Skill 名称（可选）</span>
                          <input
                            value={skillLabName}
                            onChange={(event) => setSkillLabName(event.target.value)}
                            placeholder="例如：release-workflow"
                            maxLength={64}
                            disabled={isSkillLabBusy}
                          />
                        </label>
                      )}
                      <label className="settings-field skill-lab-model-field">
                        <span>实验模型</span>
                        <ComposerSelect
                          className="form-select skill-lab-skill-select"
                          ariaLabel="选择技能实验室模型"
                          value={skillLabModelSelection}
                          disabled={isSkillLabBusy || skillLabModelOptions.length === 0}
                          onChange={setSkillLabModelSelection}
                          options={skillLabModelOptions}
                          placeholder="请选择实验模型"
                          searchable
                          searchPlaceholder="搜索供应商或模型"
                          emptyLabel="没有可用的实验模型"
                        />
                      </label>
                      <label className="settings-field skill-lab-iterations-field">
                        <span>迭代次数</span>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          step={1}
                          value={skillLabIterations}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (Number.isInteger(value) && value >= 1 && value <= 20) setSkillLabIterations(value);
                          }}
                          disabled={isSkillLabBusy}
                        />
                      </label>
                    </div>
                    <div className="skill-lab-actions">
                      {isSkillLabBusy ? (
                        <button className="button ghost" type="button" onClick={() => void cancelSkillLab()}>
                          <IconStop />
                          <span>{skillLabStatus === "clarifying" ? "取消澄清" : "取消生成"}</span>
                        </button>
                      ) : (
                        <button
                          className="button primary"
                          type="button"
                          disabled={
                            !skillLabModelSelection ||
                            (skillLabMode === "create" ? !skillLabPrompt.trim() : !skillLabTargetSkillId)
                          }
                          onClick={() => void startSkillLab()}
                        >
                          <IconSkills />
                          <span>{skillLabMode === "optimize" ? "开始持续优化" : "分析需求"}</span>
                        </button>
                      )}
                      {skillLabStatus === "failed" && skillLabError ? <span className="skill-lab-error">{skillLabError}</span> : null}
                      {skillLabStatus === "cancelled" ? <span className="subtle-inline">已取消，可重新开始。</span> : null}
                    </div>
                  </div>

                  {skillLabClarification ? (
                    <div className="config-block skill-lab-clarification-block">
                      <div className="section-copy">
                        <strong>需求澄清</strong>
                        <span>{skillLabClarification.summary}</span>
                      </div>
                      <div className="skill-lab-clarification-questions">
                        {skillLabClarification.questions.map((question, index) => (
                          <fieldset key={question.id} className="skill-lab-clarification-question">
                            <legend>{index + 1}. {question.question}{question.required ? " *" : ""}</legend>
                            {question.options.filter((option) => !/^(?:其他|其它)(?:\s*(?:[（(].*[）)]|请说明|手填|自定义|补充))?$/u.test(option.trim())).map((option) => (
                              <label key={option} className="skill-lab-choice-option">
                                <input
                                  type="radio"
                                  name={`skill-lab-${skillLabClarification.clarificationId}-${question.id}`}
                                  checked={!skillLabClarification.custom[question.id] && skillLabClarification.answers[question.id] === option}
                                  onChange={() => setSkillLabClarification((current) => current ? {
                                    ...current,
                                    answers: { ...current.answers, [question.id]: option },
                                    custom: { ...current.custom, [question.id]: false }
                                  } : current)}
                                />
                                <span>{option}</span>
                              </label>
                            ))}
                            {question.allowOther ? (
                              <label className="skill-lab-choice-option">
                                <input
                                  type="radio"
                                  name={`skill-lab-${skillLabClarification.clarificationId}-${question.id}`}
                                  checked={skillLabClarification.custom[question.id] === true}
                                  onChange={() => setSkillLabClarification((current) => current ? {
                                    ...current,
                                    answers: { ...current.answers, [question.id]: "" },
                                    custom: { ...current.custom, [question.id]: true }
                                  } : current)}
                                />
                                <span>其他（手填）</span>
                              </label>
                            ) : null}
                            {question.allowOther && skillLabClarification.custom[question.id] ? (
                              <input
                                className="skill-lab-custom-answer"
                                value={skillLabClarification.answers[question.id] ?? ""}
                                placeholder="请填写你的答案"
                                onChange={(event) => setSkillLabClarification((current) => current ? {
                                  ...current,
                                  answers: { ...current.answers, [question.id]: event.target.value }
                                } : current)}
                              />
                            ) : null}
                            {!question.options.length && !question.allowOther ? (
                              <textarea
                                rows={3}
                                value={skillLabClarification.answers[question.id] ?? ""}
                                onChange={(event) => setSkillLabClarification((current) => current ? {
                                  ...current,
                                  answers: { ...current.answers, [question.id]: event.target.value }
                                } : current)}
                              />
                            ) : null}
                          </fieldset>
                        ))}
                      </div>
                      <div className="skill-lab-clarification-actions">
                        <button
                          className="button primary"
                          type="button"
                          disabled={skillLabClarification.questions.some((question) =>
                            question.required && !skillLabClarification.answers[question.id]?.trim()
                          )}
                          onClick={() => void submitSkillLabClarification()}
                        >
                          <IconCheck />
                          <span>{skillLabProgress.some((item) => item.iteration === 0 && item.state === "tested") ? "确认并继续本轮" : "确认并开始生成"}</span>
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {skillLabStatus !== "idle" ? (
                  <div className={`config-block skill-lab-progress-block is-${skillLabStatus}`}>
                    <div className="skill-lab-live-status" aria-live="polite">
                      <span className="skill-lab-live-icon" aria-hidden>
                        {skillLabStatus === "completed" ? <IconCheck /> : <IconSkills />}
                      </span>
                      <div className="skill-lab-live-copy">
                        <span className="skill-lab-live-kicker">
                          <i aria-hidden />
                          {skillLabHeartbeatText}
                        </span>
                        <strong>{skillLabCurrentPhase}</strong>
                        <p>{skillLabCurrentSummary}</p>
                      </div>
                      <div className="skill-lab-live-metric">
                        <strong>{skillLabCompletedIterations}<span>/{skillLabTotalIterations}</span></strong>
                        <small>{skillLabElapsedLabel}</small>
                      </div>
                    </div>
                    <div
                      className={`skill-lab-progress-track ${isSkillLabBusy ? "is-running" : ""}`}
                      role="progressbar"
                      aria-label="技能迭代完成进度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={skillLabProgressPercent}
                    >
                      <span style={{ width: `${skillLabProgressPercent}%` }} />
                      {isSkillLabBusy ? <i aria-hidden /> : null}
                    </div>
                    <div className="skill-lab-progress-footer">
                      <div className="skill-lab-iteration-rail" aria-label="迭代轮次">
                        {Array.from({ length: skillLabTotalIterations }, (_, index) => {
                          const iteration = index + 1;
                          const progress = skillLabProgress.find((item) => item.iteration === iteration);
                          const completed = skillLabStatus === "completed" || progress?.state === "tested";
                          const active = skillLabStatus === "running" && skillLabCurrentIteration === iteration && !completed;
                          const failed = skillLabStatus === "failed" && skillLabCurrentIteration === iteration;
                          return (
                            <div
                              key={iteration}
                              title={`第 ${iteration} 轮${completed ? "已完成" : active ? "进行中" : "待执行"}`}
                              className={`skill-lab-iteration-node ${completed ? "is-complete" : ""} ${active ? "is-active" : ""} ${failed ? "is-failed" : ""}`}
                            >
                              <span className="skill-lab-iteration-dot">{completed ? <IconCheck /> : iteration}</span>
                            </div>
                          );
                        })}
                      </div>
                      <div className="skill-lab-last-result">
                        {skillLabLastCompletedActivity ? (
                          <><IconCheck /><span>最近完成：{skillLabLastCompletedActivity.phase}</span></>
                        ) : (
                          <><span className="skill-lab-waiting-dot" aria-hidden /><span>初始版本完成后进入第 1 轮测试</span></>
                        )}
                      </div>
                    </div>
                    {skillLabResult ? (
                      <div className="skill-lab-result" role="status">
                        <IconCheck />
                        <span>{skillLabLastRunMode === "optimize" ? "已优化并更新" : "已生成并发布"}：{skillLabResult.displayName ?? skillLabResult.name}</span>
                      </div>
                    ) : null}
                  </div>
                  ) : null}
                  {skillLabApproval ? (
                    <div className="skill-lab-approval" role="alertdialog" aria-live="assertive">
                      <div>
                        <strong>{skillLabApproval.title}</strong>
                        <span>{skillLabApproval.description}</span>
                      </div>
                      <div className="skill-lab-approval-actions">
                        <button className="button ghost" type="button" onClick={() => void resolveSkillLabApproval(false)}>拒绝</button>
                        <button className="button primary" type="button" onClick={() => void resolveSkillLabApproval(true)}>允许本次</button>
                      </div>
                    </div>
                  ) : null}
                </div>
  );
}
