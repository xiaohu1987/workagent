import type { Dispatch, SetStateAction } from "react";
import { isGptFamilyModel } from "@shared-types";
import type { AppConfig, ModelProfile, ProviderDefinition, ProviderTemplate } from "@shared-types";
import { IMAGE_GENERATION_PROTOCOL_LABELS, imageGenerationProtocolForModel, providerSupportsMediaGeneration } from "../../../../../../../packages/provider-adapters/src/models/media-protocol";
import { OPENAI_API_FORMAT_OPTIONS, PROVIDER_TEMPLATE_OPTIONS, getModelProfileKey, getProviderDisplayName, hasProviderTestEndpoint, hasStoredSecret } from "../../../lib/config-utils";
import { ComposerSelect } from "../../../workspace/composer-select";
import { IconCheck, IconClose, IconPlus } from "../../../icons";
import type { ModelTestResult } from "../../../core/app-types";

type ProviderSettingsPageProps = {
  configDraft: AppConfig | null; config: AppConfig | null; settingsProvider: ProviderDefinition | null; settingsProviderModels: ModelProfile[];
  providerSecretDrafts: Record<string,string>; setProviderSecretDrafts: Dispatch<SetStateAction<Record<string,string>>>;
  isFetchingModels: boolean; newModelId: string; newModelDisplayName: string; modelTestResults: Record<string,ModelTestResult>; testingModelKey: string | null;
  onSetProviderId: (id:string)=>void; onSetNewModelId: (value:string)=>void; onSetNewModelDisplayName: (value:string)=>void;
  onAddCustomProvider: ()=>void; onRemoveProvider: (id:string)=>void; onUpdateProvider: (id:string, patch:Partial<ProviderDefinition>)=>void; onFetchModels: (id:string)=>Promise<void>;
  onUpdateModel: (providerId:string, modelId:string, patch:Partial<ModelProfile>)=>void; onCheckModel: (provider:ProviderDefinition, model:ModelProfile)=>Promise<void>;
  onRemoveModel: (providerId:string, modelId:string)=>void; onAddModel: (providerId:string)=>void; onSave: ()=>Promise<void>; onRefresh: ()=>Promise<void>; onShowNotice: (title:string)=>void;
  formatLatency: (ms:number)=>string; formatTokensPerSecond: (value:number)=>string;
};

export function ProviderSettingsPage({ configDraft, config, settingsProvider, settingsProviderModels, providerSecretDrafts, setProviderSecretDrafts, isFetchingModels, newModelId, newModelDisplayName, modelTestResults, testingModelKey, onSetProviderId, onSetNewModelId, onSetNewModelDisplayName, onAddCustomProvider, onRemoveProvider, onUpdateProvider, onFetchModels, onUpdateModel, onCheckModel, onRemoveModel, onAddModel, onSave, onRefresh, onShowNotice, formatLatency, formatTokensPerSecond }: ProviderSettingsPageProps) {
  const template = settingsProvider?.providerTemplate ?? "openai_compatible";
  const isOpenAiFormat = settingsProvider?.apiFormat === "auto" || settingsProvider?.apiFormat === "openai_responses" || settingsProvider?.apiFormat === "openai_chat";
  const canTestModels = settingsProvider ? hasProviderTestEndpoint(settingsProvider) : false;

  function formatStatus(model: ModelProfile): string {
    if (settingsProvider?.apiFormat === "auto" && !isGptFamilyModel(model)) {
      return model.preferredApiFormat === "openai_chat" || model.verifiedApiFormats?.includes("openai_chat")
        ? "已验证：Chat Completions"
        : "自动：Chat Completions";
    }
    if (!model.preferredApiFormat && model.verifiedApiFormats?.includes("openai_chat")) return "Responses 暂时不可用，已使用 Chat";
    if (!model.apiFormatCheckedAt || !model.preferredApiFormat) return "未检测";
    if (model.preferredApiFormat === "openai_responses") return "已验证：Responses";
    if (settingsProvider?.apiFormat === "auto") return "自动选择：Chat Completions";
    return "已验证：Chat Completions";
  }

  return (
      <div className="settings-section provider-settings-section">
        {configDraft ? (
          <div className="provider-settings-layout">
            <aside className="provider-list-panel">
              <div className="provider-list-header">
                <strong className="provider-list-title">提供商</strong>
                <button className="settings-add-provider" onClick={onAddCustomProvider}>
                  + 供应商
                </button>
              </div>
              <div className="provider-list-scroll">
                {configDraft.providers.map((provider) => (
                  <div key={provider.id} className="provider-list-card-row">
                    <button
                      className={`provider-list-card ${settingsProvider?.id === provider.id ? "selected" : ""}`}
                      onClick={() => {
                        onSetProviderId(provider.id);
                        onSetNewModelId("");
                        onSetNewModelDisplayName("");
                      }}
                    >
                      <strong>{getProviderDisplayName(provider)}</strong>
                    </button>
                    <button
                      className="provider-remove-button"
                      onClick={() => onRemoveProvider(provider.id)}
                      title="删除供应商"
                    >
                      <IconClose />
                    </button>
                  </div>
                ))}
              </div>
            </aside>

            <section className="provider-detail-panel">
              {settingsProvider ? (
                <>
                  <div className="provider-detail-grid">
                    <label className="settings-field">
                      <span>供应商名称</span>
                      <input
                        value={settingsProvider.name ?? ""}
                        onChange={(event) =>
                          onUpdateProvider(settingsProvider.id, { name: event.target.value })
                        }
                        placeholder="例如 OpenAI / 英伟达 / 企业网关"
                      />
                    </label>

                    <label className="settings-field">
                      <span>供应商模板</span>
                      <ComposerSelect
                        className="form-select provider-type-select"
                        ariaLabel="供应商模板"
                        value={template}
                        onChange={(value) => onUpdateProvider(settingsProvider.id, { providerTemplate: value as ProviderTemplate })}
                        options={PROVIDER_TEMPLATE_OPTIONS}
                        placeholder="选择供应商模板"
                      />
                    </label>

                    <label className="settings-field full">
                      <span>上游格式</span>
                      {isOpenAiFormat ? (
                        <ComposerSelect
                          className="form-select provider-type-select"
                          ariaLabel="上游格式"
                          value={settingsProvider.apiFormat ?? "auto"}
                          onChange={(value) => onUpdateProvider(settingsProvider.id, { apiFormat: value as ProviderDefinition["apiFormat"] })}
                          options={OPENAI_API_FORMAT_OPTIONS}
                          placeholder="选择上游格式"
                        />
                      ) : (
                        <div className="provider-fixed-format">
                          {settingsProvider.apiFormat === "anthropic" ? "Anthropic Messages" : "Google Gemini"}
                        </div>
                      )}
                      <small className="settings-field-hint">自动模式下，GPT 模型优先使用 Responses，其他模型直接使用 Chat Completions；检测结果缓存 24 小时。</small>
                    </label>

                    <label className="settings-field">
                      <span>调用 URL</span>
                      <input
                        value={settingsProvider.baseUrl ?? ""}
                        onChange={(event) =>
                          onUpdateProvider(settingsProvider.id, { baseUrl: event.target.value })
                        }
                        placeholder="https://api.example.com/v1"
                      />
                    </label>

                    <label className="settings-field">
                      <div className="provider-secret-row">
                        <span>Key</span>
                        {hasStoredSecret(settingsProvider) ? (
                          <em className="secret-badge">已检测到已保存密钥</em>
                        ) : null}
                      </div>
                      <input
                        type="password"
                        autoComplete="off"
                        value={providerSecretDrafts[settingsProvider.id] ?? ""}
                        onChange={(event) =>
                          {
                            setProviderSecretDrafts((current) => ({
                              ...current,
                              [settingsProvider.id]: event.target.value
                            }));
                            for (const model of settingsProviderModels) {
                              onUpdateModel(settingsProvider.id, model.id, {
                                verifiedApiFormats: undefined,
                                preferredApiFormat: undefined,
                                apiFormatCheckedAt: undefined,
                                agentCapability: undefined,
                                agentCapabilityCheckedAt: undefined,
                                agentCapabilityReason: undefined
                              });
                            }
                          }
                        }
                        placeholder="输入 API Key，留空则保留当前值"
                      />
                    </label>
                  </div>

                  <details className="provider-advanced-settings">
                    <summary>高级设置</summary>
                    <div className="provider-detail-grid">
                      <label className="settings-field full">
                        <span>兼容模式</span>
                        <ComposerSelect
                          className="form-select"
                          ariaLabel="兼容模式"
                          value={settingsProvider.compatibilityProfile ?? "standard"}
                          onChange={(value) => onUpdateProvider(settingsProvider.id, { compatibilityProfile: value as ProviderDefinition["compatibilityProfile"] })}
                          options={[
                            { value: "standard", label: "标准" },
                            { value: "deepseek", label: "DeepSeek 扩展" }
                          ]}
                          placeholder="选择兼容模式"
                        />
                      </label>
                      <label className="settings-field">
                        <span>最大工具数量</span>
                        <input type="number" min={0} value={settingsProvider.maxTools ?? 0} onChange={(event) => onUpdateProvider(settingsProvider.id, { maxTools: Math.max(0, Number(event.target.value) || 0) })} />
                      </label>
                      <label className="settings-field">
                        <span>最大请求字节</span>
                        <input type="number" min={0} value={settingsProvider.maxRequestBytes ?? 0} onChange={(event) => onUpdateProvider(settingsProvider.id, { maxRequestBytes: Math.max(0, Number(event.target.value) || 0) })} />
                      </label>
                      <label className="settings-field full">
                        <span>附加请求头（JSON）</span>
                        <textarea
                          key={`${settingsProvider.id}:${JSON.stringify(settingsProvider.headers ?? {})}`}
                          defaultValue={JSON.stringify(settingsProvider.headers ?? {}, null, 2)}
                          onBlur={(event) => {
                            try {
                              const parsed = JSON.parse(event.target.value || "{}");
                              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
                                !Object.values(parsed).every((value) => typeof value === "string")) throw new Error();
                              onUpdateProvider(settingsProvider.id, { headers: parsed as Record<string, string> });
                            } catch {
                              onShowNotice("请求头 JSON 格式无效。");
                            }
                          }}
                        />
                      </label>
                    </div>
                  </details>

                  <div className="provider-model-section">
                    <div className="section-copy section-copy-with-action">
                      <div>
                        <strong>模型列表</strong>
                        <span>保存后，聊天窗口会按这里的供应商和模型列表进行筛选。</span>
                      </div>
                      <button
                        className="model-fetch-button"
                        onClick={() => void onFetchModels(settingsProvider.id)}
                        disabled={isFetchingModels || !settingsProvider.baseUrl?.trim()}
                        title="从供应商接口拉取所有可用模型"
                      >
                        {isFetchingModels ? "获取中…" : "获取模型"}
                      </button>
                    </div>

                    <div className="provider-model-box">
                      {settingsProviderModels.length > 0 ? (
                        settingsProviderModels.map((model) => {
                          const isMediaModel = model.role === "image" || model.role === "video";
                          const mediaUnsupported = isMediaModel && !providerSupportsMediaGeneration(settingsProvider.type);
                          return (
                          <div key={model.id} className="provider-model-row">
                            <div className="provider-model-copy">
                              <div className="provider-model-title">
                                <strong>{model.id}</strong>
                                {model.agentCapability === "verified" && model.apiFormatCheckedAt ? (
                                  <span
                                    className="model-agent-verified"
                                    title="Agent 已验证"
                                    aria-label="Agent 已验证"
                                  >
                                    <IconCheck />
                                  </span>
                                ) : null}
                              </div>
                              {model.displayName !== model.id ? <span>{model.displayName}</span> : null}
                              {isMediaModel ? (
                                <span
                                  className={`model-media-tag ${model.role === "image" ? "is-image" : "is-video"}${mediaUnsupported ? " is-unsupported" : ""}`}
                                  title={mediaUnsupported
                                    ? "当前供应商的接口协议没有图片/视频生成实现，请改用 OpenAI 兼容接口的供应商。"
                                    : "图片/视频模型不走上方接口协议，按模型自身的生成协议调用。"}
                                >
                                  {mediaUnsupported
                                    ? `当前协议不支持${model.role === "image" ? "图片" : "视频"}生成`
                                    : `${model.role === "image" ? "图片模型" : "视频模型"} · ${IMAGE_GENERATION_PROTOCOL_LABELS[imageGenerationProtocolForModel(model)]}`}
                                </span>
                              ) : null}
                              {!isMediaModel && modelTestResults[getModelProfileKey(settingsProvider.id, model.id)] ? (
                                <span className="model-test-result">
                                  延迟 {formatLatency(modelTestResults[getModelProfileKey(settingsProvider.id, model.id)].latencyMs)}
                                  <i aria-hidden="true">·</i>
                                  输出 {modelTestResults[getModelProfileKey(settingsProvider.id, model.id)].outputTokens} Tokens
                                  <i aria-hidden="true">·</i>
                                  {formatTokensPerSecond(modelTestResults[getModelProfileKey(settingsProvider.id, model.id)].tokensPerSecond)}
                                </span>
                              ) : null}
                              {!isMediaModel ? (
                              <span className="model-api-format-status">{formatStatus(model)}</span>
                              ) : null}
                            </div>
                            <div className="provider-model-actions">
                              {!isMediaModel ? (
                              <label className="model-context-window-field" title="模型上下文窗口，单位为 tokens">
                                <span>上下文</span>
                                <input
                                  type="number"
                                  min={1_024}
                                  step={1_024}
                                  value={model.contextWindow}
                                  onChange={(event) => onUpdateModel(settingsProvider.id, model.id, {
                                    contextWindow: Math.max(1_024, Math.floor(Number(event.target.value) || 128_000))
                                  })}
                                />
                              </label>
                              ) : null}
                              <label className="model-capability-toggle" title="启用后，此模型可以接收文件、文件夹和图片附件。">
                                <input
                                  type="checkbox"
                                  checked={model.supportsMultimodalInput}
                                  onChange={(event) =>
                                    onUpdateModel(settingsProvider.id, model.id, { supportsMultimodalInput: event.target.checked })
                                  }
                                />
                                <span>支持多模态</span>
                              </label>
                              {!isMediaModel ? (() => {
                                const isTesting = testingModelKey === getModelProfileKey(settingsProvider.id, model.id);
                                return (
                                  <button
                                    className={`settings-mini-button model-test-button${isTesting ? " is-testing" : ""}`}
                                    onClick={() => void onCheckModel(settingsProvider, model)}
                                    disabled={isTesting || !canTestModels}
                                    aria-busy={isTesting}
                                    title={canTestModels ? "测试模型连接与 Agent 工具协议" : "请先填写调用 URL"}
                                  >
                                    <span className="model-test-label">
                                      {isTesting ? "测试中" : "测试"}
                                      {isTesting ? <i aria-hidden="true" /> : null}
                                    </span>
                                  </button>
                                );
                              })() : null}
                              <button
                                className="settings-icon-button"
                                onClick={() => onRemoveModel(settingsProvider.id, model.id)}
                                title="删除模型"
                              >
                                <IconClose />
                              </button>
                            </div>
                          </div>
                          );
                        })
                      ) : (
                        <div className="provider-empty-state">
                          当前供应商还没有模型，先在下方添加一个模型即可。
                        </div>
                      )}

                      <div className="model-add-row">
                        <input
                          value={newModelId}
                          onChange={(event) => onSetNewModelId(event.target.value)}
                          placeholder="模型名称"
                        />
                        <input
                          value={newModelDisplayName}
                          onChange={(event) => onSetNewModelDisplayName(event.target.value)}
                          placeholder="显示名称（可选）"
                        />
                        <button
                          className="model-add-button"
                          onClick={() => onAddModel(settingsProvider.id)}
                          title="添加模型"
                        >
                          <IconPlus />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="settings-save-row">
                    <span className="subtle-inline">
                      当前默认：{(() => {
                        const provider = configDraft.providers.find((entry) => entry.id === configDraft.defaultProvider);
                        return provider ? getProviderDisplayName(provider) : configDraft.defaultProvider;
                      })()} / {configDraft.defaultModel}
                    </span>
                    <button className="button warm" onClick={() => void onSave()}>
                      保存
                    </button>
                  </div>
                </>
              ) : (
                <div className="provider-empty-state">还没有可编辑的供应商。</div>
              )}
            </section>
          </div>
        ) : (
          <div className="config-block">
            <div className="detail-empty">正在加载模型配置…</div>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button
                className="button ghost"
                onClick={() => void onRefresh()}
              >
                重试加载
              </button>
              <button
                className="button ghost"
                onClick={() => {
                  console.log("[renderer] current config", config);
                  console.log("[renderer] current configDraft", configDraft);
                  onShowNotice(`config=${config ? "ok" : "null"}, configDraft=${configDraft ? "ok" : "null"}`);
                }}
              >
                检查状态
              </button>
            </div>
          </div>
        )}
      </div>
  );
}
