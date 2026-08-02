import { useState, type Dispatch, type SetStateAction } from "react";
import type { AppConfig, ModelProfile, ProviderDefinition } from "@shared-types";
import type { ModelTestResult } from "../core/app-types";
import { getModelProfileKey } from "../lib/config-utils";

type Notice = (title: string, options?: { tone?: "success" | "warning"; message?: string }) => void;

type Options = {
  providerSecretDrafts: Record<string, string>;
  setConfig: Dispatch<SetStateAction<AppConfig | null>>;
  updateModelDraft: (providerId: string, modelId: string, patch: Partial<ModelProfile>) => void;
  formatLatency: (milliseconds: number) => string;
  showNotice: Notice;
};

export function useProviderModelTesting({
  providerSecretDrafts,
  setConfig,
  updateModelDraft,
  formatLatency,
  showNotice
}: Options) {
  const [testingModelKey, setTestingModelKey] = useState<string | null>(null);
  const [modelTestResults, setModelTestResults] = useState<Record<string, ModelTestResult>>({});

  async function checkProviderModel(provider: ProviderDefinition, model: ModelProfile) {
    const secretDraft = providerSecretDrafts[provider.id]?.trim();
    const hasSecret = Boolean(secretDraft || provider.apiKey || provider.apiKeyEnv) || provider.type === "mock" || provider.type === "ollama";
    if (!hasSecret) {
      showNotice("请先填写 API Key。", { message: "或者保留当前已保存的密钥。" });
      return;
    }

    const key = getModelProfileKey(provider.id, model.id);
    const testProvider: ProviderDefinition = secretDraft
      ? { ...provider, apiKey: secretDraft, apiKeyEnv: undefined }
      : provider.type === "ollama" && !provider.apiKey && !provider.apiKeyEnv
        ? { ...provider, apiKey: "ollama" }
        : provider;
    setTestingModelKey(key);
    try {
      const result = await window.codexh.testProviderModel({ provider: testProvider, model });
      setModelTestResults((current) => ({ ...current, [key]: result }));
      const capabilityPatch = {
        agentCapability: result.agentCapability,
        agentCapabilityCheckedAt: new Date().toISOString(),
        agentCapabilityReason: result.agentCapabilityReason
      };
      updateModelDraft(provider.id, model.id, capabilityPatch);
      try {
        const savedModel = await window.codexh.saveModelAgentCapability({
          providerId: provider.id,
          modelId: model.id,
          agentCapability: result.agentCapability,
          agentCapabilityReason: result.agentCapabilityReason
        });
        setConfig((current) => current
          ? {
              ...current,
              models: current.models.map((entry) =>
                entry.id === savedModel.id && entry.providerId === savedModel.providerId ? savedModel : entry
              )
            }
          : current
        );
      } catch (error) {
        showNotice("模型已测试，但验证状态未保存。", {
          message: error instanceof Error ? error.message : "请保存模型配置后再测试。",
          tone: "warning"
        });
      }
      showNotice(
        result.agentCapability === "verified"
          ? `${model.displayName?.trim() || model.id} 模型测试成功。`
          : `${model.displayName?.trim() || model.id} 只适合普通聊天。`,
        {
          message: result.agentCapability === "verified"
            ? `连接与 Agent 工具协议均验证通过。延迟 ${formatLatency(result.latencyMs)}。`
            : result.agentCapabilityReason ?? "连接正常，但未通过 Agent 工具协议测试。",
          tone: result.agentCapability === "verified" ? "success" : "warning"
        }
      );
    } catch (error) {
      showNotice("模型测试失败。", {
        message: error instanceof Error ? error.message : "请检查模型地址、密钥和网络连接。"
      });
    } finally {
      setTestingModelKey((current) => current === key ? null : current);
    }
  }

  return { testingModelKey, modelTestResults, checkProviderModel };
}
