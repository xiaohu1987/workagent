import { Fragment, type Dispatch, type SetStateAction } from "react";
import type { AppConfig } from "@shared-types";
import { providerSupportsMediaGeneration } from "../../../../../../../packages/provider-adapters/src/models/media-protocol";
import { getProviderDisplayName, isReasoningModel, modelKey } from "../../../lib/config-utils";
import { IconPlus } from "../../../icons";

type MultimodalPickerRole = "reasoning" | "image" | "video" | "input" | null;
type MultimodalKind = "image" | "video" | "input";

type MultimodalSettingsPageProps = {
  configDraft: AppConfig | null;
  setPickerRole: Dispatch<SetStateAction<MultimodalPickerRole>>;
  setMultimodalEnabled: (kind: MultimodalKind, enabled: boolean) => void;
  setMultimodalDefault: (kind: "image" | "video", providerId: string, modelId: string) => void;
  setReasoningDefault: (providerId: string, modelId: string) => void;
  removeFromMultimodalRole: (providerId: string, modelId: string) => void;
  clearMultimodalInputDefault: () => void;
};

export function MultimodalSettingsPage({
  configDraft,
  setPickerRole,
  setMultimodalEnabled,
  setMultimodalDefault,
  setReasoningDefault,
  removeFromMultimodalRole,
  clearMultimodalInputDefault
}: MultimodalSettingsPageProps) {
  return (
      <div className="settings-section multimodal-settings-section">
        {configDraft ? (
          <>
            {(["reasoning", "image", "video"] as const).map((role) => {
              const models = configDraft.models.filter((model) =>
                role === "reasoning" ? isReasoningModel(model) : model.role === role
              );
              const kind = role === "reasoning" ? null : role;
              const title = role === "reasoning" ? "推理模型" : role === "image" ? "图片模型" : "视频模型";
              const hint = role === "reasoning"
                ? "手动添加后会出现在聊天下拉；可设置默认模型或随时移除。"
                : `从统一模型库中分配${role === "image" ? "图片" : "视频"}生成模型。`;
              const panel = (
                <div key={role} className={`config-block multimodal-model-panel is-${role}`}>
                  <div className="section-copy section-copy-with-action">
                    <div>
                      <strong>{title}</strong>
                      <span>{hint}</span>
                    </div>
                    <button className="model-add-button" onClick={() => {
                      setPickerRole(role);
                    }} title={`添加${title}`}><IconPlus /></button>
                  </div>
                  {kind ? (
                    <div className="multimodal-toggle-row">
                      <span>启用{kind === "image" ? "图片" : "视频"}生成</span>
                      <label className="model-capability-toggle">
                        <input type="checkbox" checked={configDraft.multimodal[kind].enabled} onChange={(event) => setMultimodalEnabled(kind, event.target.checked)} />
                        <span>{configDraft.multimodal[kind].enabled ? "已启用" : "已关闭"}</span>
                      </label>
                    </div>
                  ) : null}
                  {kind && !configDraft.multimodal[kind].enabled ? (
                    <div className="multimodal-empty-tip">
                      {kind === "image" ? "图片" : "视频"}生成已关闭。开启后，Agent 才会在识别到相关意图时调用默认模型。
                    </div>
                  ) : null}
                  <div className={`provider-model-box multimodal-compact-list${!kind || configDraft.multimodal[kind].enabled ? "" : " is-disabled"}`}>
                    {models.length > 0 ? models.map((model) => {
                      const isDefault = kind
                        ? configDraft.multimodal[kind].defaultProviderId === model.providerId &&
                          configDraft.multimodal[kind].defaultModelId === model.id
                        : configDraft.defaultProvider === model.providerId &&
                          configDraft.defaultModel === model.id;
                      const provider = configDraft.providers.find((entry) => entry.id === model.providerId);
                      const mediaUnsupported = Boolean(kind) && !providerSupportsMediaGeneration(provider?.type ?? "");
                      return (
                        <div key={modelKey(model.providerId, model.id)} className="provider-model-row multimodal-list-row">
                          <div className="provider-model-copy multimodal-list-main">
                            <strong>{model.displayName}</strong>
                            <span className="multimodal-list-meta">{provider ? getProviderDisplayName(provider) : model.providerId}</span>
                            {role === "reasoning" ? <em className="mm-tag is-chat">聊天下拉</em> : null}
                            {isDefault ? <em className="mm-tag is-default">默认</em> : null}
                            {model.supportsMultimodalInput ? <em className="mm-tag is-mm">多模态</em> : null}
                            {model.supportsVideoGeneration ? <em className="mm-tag is-video">视频</em> : null}
                            {mediaUnsupported ? (
                              <em className="mm-tag is-unsupported" title="该供应商的接口协议没有图片/视频生成实现，请改用 OpenAI 兼容接口的供应商。">协议不支持</em>
                            ) : null}
                          </div>
                          <div className="provider-model-actions">
                            {!isDefault ? (
                              <button
                                className="settings-mini-button"
                                disabled={mediaUnsupported}
                                title={mediaUnsupported ? "该供应商协议不支持媒体生成，无法设为默认" : undefined}
                                onClick={() => kind
                                  ? setMultimodalDefault(kind, model.providerId, model.id)
                                  : setReasoningDefault(model.providerId, model.id)}
                              >
                                设为默认
                              </button>
                            ) : null}
                            <button className="settings-mini-button" onClick={() => removeFromMultimodalRole(model.providerId, model.id)}>移除</button>
                          </div>
                        </div>
                      );
                    }) : (
                      <div className="provider-empty-state">
                        {role === "reasoning"
                          ? "尚未添加推理模型。点击 + 从模型库加入，加入后才会出现在聊天下拉。"
                          : `尚未添加${title}。请先在供应商设置中添加模型，再点 + 加入，并指定默认模型。`}
                      </div>
                    )}
                  </div>
                  {kind && models.length > 0 && !configDraft.multimodal[kind].defaultModelId ? (
                    <div className="multimodal-empty-tip">
                      请选择一个默认{kind === "image" ? "图片" : "视频"}模型，否则对话中无法自动生成。
                    </div>
                  ) : null}
                </div>
              );
              if (role !== "reasoning") return panel;
              return (
                <Fragment key="reasoning-with-input">
                  {panel}
                  <div className="config-block multimodal-model-panel is-input">
                    <div className="section-copy section-copy-with-action">
                      <div>
                        <strong>默认多模态识别模型</strong>
                        <span>当聊天所选模型不支持多模态输入时，先用此模型识别图片/文件，再把文字结果交给当前模型处理。</span>
                      </div>
                      <button
                        className="model-add-button"
                        type="button"
                        onClick={() => {
                          setPickerRole("input");
                        }}
                        title="选择多模态识别模型"
                      >
                        <IconPlus />
                      </button>
                    </div>
                    <div className="multimodal-toggle-row">
                      <span>启用识别回退</span>
                      <label className="model-capability-toggle">
                        <input
                          type="checkbox"
                          checked={configDraft.multimodal.input.enabled}
                          onChange={(event) => setMultimodalEnabled("input", event.target.checked)}
                        />
                        <span>{configDraft.multimodal.input.enabled ? "已启用" : "已关闭"}</span>
                      </label>
                    </div>
                    {!configDraft.multimodal.input.enabled ? (
                      <div className="multimodal-empty-tip">
                        识别回退已关闭。关闭后，非多模态聊天模型无法处理图片或文件附件。
                      </div>
                    ) : null}
                    <div className={`provider-model-box multimodal-compact-list${configDraft.multimodal.input.enabled ? "" : " is-disabled"}`}>
                      {(() => {
                        const selected = configDraft.models.find(
                          (model) =>
                            model.supportsMultimodalInput &&
                            model.providerId === configDraft.multimodal.input.defaultProviderId &&
                            model.id === configDraft.multimodal.input.defaultModelId
                        );
                        if (!selected) {
                          return (
                            <div className="provider-empty-state">
                              尚未选择识别模型。点击 + 从支持多模态的模型中选一个。
                            </div>
                          );
                        }
                        const provider = configDraft.providers.find((entry) => entry.id === selected.providerId);
                        return (
                          <div className="provider-model-row multimodal-list-row">
                            <div className="provider-model-copy multimodal-list-main">
                              <strong>{selected.displayName}</strong>
                              <span className="multimodal-list-meta">{provider ? getProviderDisplayName(provider) : selected.providerId}</span>
                              <em className="mm-tag is-default">默认</em>
                              <em className="mm-tag is-mm">多模态</em>
                            </div>
                            <div className="provider-model-actions">
                              <button className="settings-mini-button" type="button" onClick={clearMultimodalInputDefault}>
                                清除
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </Fragment>
              );
            })}

            <div className="settings-save-row">
              <span className="subtle-inline">
                操作即保存 · 默认推理：{configDraft.defaultModel ?? "未设置"}
                {" · "}
                默认识别：{configDraft.multimodal.input.defaultModelId ?? "未设置"}
                {" · "}
                默认图片：{configDraft.multimodal.image.defaultModelId ?? "未设置"}
                {" · "}
                默认视频：{configDraft.multimodal.video.defaultModelId ?? "未设置"}
              </span>
            </div>
          </>
        ) : (
          <div className="config-block">
            <div className="detail-empty">正在加载模型配置…</div>
          </div>
        )}
      </div>
  );
}
