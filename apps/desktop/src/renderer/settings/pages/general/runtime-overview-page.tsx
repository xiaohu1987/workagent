import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "@shared-types";
import { ComposerSelect } from "../../../workspace/composer-select";
import { IconChart, IconChecklist, IconGear, IconGlobe, IconSkills } from "../../../icons";
import { getProviderDisplayName, modelKey } from "../../../lib/config-utils";

type Props = { config: AppConfig | null; configDraft: AppConfig | null; threadCount: number; skillCount: number; subagentDefaultModelValue: string; subagentDefaultModelOptions: Array<{ value: string; label: string }>; setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>; onSave: () => Promise<void>; onSetLlmLogViewerEnabled: (enabled: boolean) => void };
export function RuntimeOverviewPage({ config, configDraft, threadCount, skillCount, subagentDefaultModelValue, subagentDefaultModelOptions, setConfigDraft, onSave, onSetLlmLogViewerEnabled }: Props) { return (
      <div className="settings-section">
        <div className="general-overview">
          <div className="general-overview-heading">
            <strong><IconChart />运行概览</strong>
            <span className="general-overview-status"><i aria-hidden />本地服务正常</span>
          </div>
          <div className="general-overview-stats">
            <article className="general-overview-stat">
              <span className="general-overview-icon blue"><IconChecklist /></span>
              <div><span>会话</span><strong>{threadCount}</strong></div>
            </article>
            <article className="general-overview-stat">
              <span className="general-overview-icon green"><IconSkills /></span>
              <div><span>技能</span><strong>{skillCount}</strong></div>
            </article>
            <article className="general-overview-stat">
              <span className="general-overview-icon amber"><IconGlobe /></span>
              <div><span>供应商</span><strong>{config?.providers.length ?? 0}</strong></div>
            </article>
            <article className="general-overview-stat">
              <span className="general-overview-icon cyan"><IconChart /></span>
              <div><span>模型</span><strong>{config?.models.length ?? 0}</strong></div>
            </article>
          </div>
        </div>

        <div className="config-block general-defaults-panel">
          <div className="section-copy">
            <strong><IconGear />当前默认配置</strong>
            <span>全局执行与桌面服务状态</span>
          </div>
          <div className="general-defaults-grid">
            <div className="general-default-item">
              <span><IconGlobe />默认供应商</span>
              <strong title={config?.defaultProvider ?? "未配置"}>
                {(() => {
                  const provider = config?.providers.find((entry) => entry.id === config.defaultProvider);
                  return provider ? getProviderDisplayName(provider) : config?.defaultProvider ?? "未配置";
                })()}
              </strong>
            </div>
            <div className="general-default-item">
              <span><IconChart />默认模型</span>
              <strong title={config?.defaultModel ?? "未配置"}>{config?.defaultModel ?? "未配置"}</strong>
            </div>
            <div className="general-default-item">
              <span><IconChecklist />审批模式</span>
              <strong>{config?.desktop.approvals ?? "prompt"}</strong>
            </div>
            <div className="general-default-item">
              <span><IconGlobe />内置浏览器</span>
              <strong className={config?.desktop.inAppBrowser ? "is-online" : "is-offline"}><i aria-hidden />{config?.desktop.inAppBrowser ? "已启用" : "已关闭"}</strong>
            </div>
          </div>
        </div>

        {configDraft ? (
          <>
          <div className="config-block">
            <div className="section-copy section-copy-with-action">
              <div>
                <strong>对话日志</strong>
                <span>开启后打开独立日志窗口，实时查看当前对话的完整 LLM、工具和错误日志。</span>
              </div>
              <label className={`mcp-enable-switch ${configDraft.desktop.llmLogViewer ? "is-on" : ""}`}>
                <input type="checkbox" checked={configDraft.desktop.llmLogViewer} onChange={(event) => onSetLlmLogViewerEnabled(event.target.checked)} />
                <span className="mcp-enable-track" aria-hidden="true"><span className="mcp-enable-thumb" /></span>
                <span className="mcp-enable-label">{configDraft.desktop.llmLogViewer ? "启用" : "禁用"}</span>
              </label>
            </div>
          </div>
          <div className="config-block general-subagent-settings">
            <div className="section-copy">
              <strong><IconSkills />子智能体</strong>
              <span>子任务共享当前工作区并沿用审批策略；模型未指定时跟随创建它的主任务。</span>
            </div>
            <div className="general-subagent-settings-grid">
              <label className="settings-field">
                <span>默认模型</span>
                <ComposerSelect
                  className="form-select"
                  ariaLabel="子智能体默认模型"
                  value={subagentDefaultModelValue}
                  onChange={(value) => setConfigDraft((current) => {
                    if (!current) return current;
                    if (value === "__inherit__") {
                      return { ...current, multiAgent: { ...current.multiAgent, defaultModelId: undefined, defaultProviderId: undefined } };
                    }
                    const model = current.models.find((item) => modelKey(item.providerId, item.id) === value);
                    return model ? { ...current, multiAgent: { ...current.multiAgent, defaultModelId: model.id, defaultProviderId: model.providerId } } : current;
                  })}
                  options={subagentDefaultModelOptions}
                  placeholder="选择默认模型"
                />
                <small className="settings-field-hint">不指定时，子智能体沿用创建它的主任务所用模型</small>
              </label>
              <label className="settings-field">
                <span>总并发（含主智能体）</span>
                <input type="number" min="2" max="8" value={configDraft.multiAgent.maxConcurrentSubagents} onChange={(event) => setConfigDraft((current) => current ? { ...current, multiAgent: { ...current.multiAgent, maxConcurrentSubagents: Number(event.target.value) || 4 } } : current)} />
                <small className="settings-field-hint">2–8 · 同时运行的智能体总数（含主智能体），超出的子任务排队</small>
              </label>
              <label className="settings-field">
                <span>每次任务上限</span>
                <input type="number" min="1" max="16" value={configDraft.multiAgent.maxSubagentsPerRoot} onChange={(event) => setConfigDraft((current) => current ? { ...current, multiAgent: { ...current.multiAgent, maxSubagentsPerRoot: Number(event.target.value) || 8 } } : current)} />
                <small className="settings-field-hint">1–16 · 单个主任务最多可委派的子智能体总数</small>
              </label>
              <label className="settings-field">
                <span>最大层级</span>
                <input type="number" min="1" max="6" value={configDraft.multiAgent.maxDepth} onChange={(event) => setConfigDraft((current) => current ? { ...current, multiAgent: { ...current.multiAgent, maxDepth: Number(event.target.value) || 3 } } : current)} />
                <small className="settings-field-hint">1–6 · 允许主 → 子 → 孙嵌套委派的最大深度</small>
              </label>
              <label className="settings-field">
                <span>默认上下文</span>
                <ComposerSelect className="form-select" ariaLabel="子智能体默认上下文" value={configDraft.multiAgent.defaultContextFork ?? "all"} onChange={(value) => setConfigDraft((current) => current ? { ...current, multiAgent: { ...current.multiAgent, defaultContextFork: value === "none" || value === "recent" ? value : "all" } } : current)} options={[{ value: "all", label: "全部上下文" }, { value: "recent", label: "最近 6 条" }, { value: "none", label: "不继承" }]} placeholder="选择上下文" />
                <small className="settings-field-hint">创建时从父任务继承的对话历史量，越少越省 token</small>
              </label>
              <label className="settings-field">
                <span>默认推理强度</span>
                <ComposerSelect className="form-select" ariaLabel="子智能体默认推理强度" value={configDraft.multiAgent.defaultReasoningEffort ?? "medium"} onChange={(value) => setConfigDraft((current) => current ? { ...current, multiAgent: { ...current.multiAgent, defaultReasoningEffort: value === "low" || value === "high" ? value : "medium" } } : current)} options={[{ value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" }]} placeholder="选择推理强度" />
                <small className="settings-field-hint">越高推理越深入，但更慢、成本更高</small>
              </label>
              <div className="settings-field general-permission-field">
                <span>执行权限</span>
                <label className="memory-switch"><input type="checkbox" checked={configDraft.multiAgent.childWritePolicy !== "read-only"} onChange={(event) => setConfigDraft((current) => current ? { ...current, multiAgent: { ...current.multiAgent, childWritePolicy: event.target.checked ? "inherit" : "read-only" } } : current)} /> <span>继承父任务权限</span></label>
                <small className="settings-field-hint">取消勾选后子智能体为只读，只能分析、不能修改工作区</small>
              </div>
            </div>
            <div className="settings-save-row"><span className="subtle-inline">更改仅影响后续创建的子智能体。</span><button className="button warm" type="button" onClick={() => void onSave()}>保存</button></div>
          </div>
          </>
        ) : null}
      </div>
      ); }
