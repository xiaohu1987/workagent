import { DEFAULT_RESPONSE_TONE, withGptReasoningCapabilities } from "@shared-types";
import type { AppConfig, McpServerConfig, ModelProfile, ProviderDefinition, ProviderType } from "@shared-types";

export type ProviderTypeOption = {
  value: ProviderType;
  label: string;
};

export const PROVIDER_TYPE_OPTIONS: ProviderTypeOption[] = [
  { value: "openai-compatible", label: "OpenAI 兼容接口" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Google Gemini" },
  { value: "mock", label: "Mock（仅测试）" }
];

export function cloneConfig(config: AppConfig): AppConfig {
  const multimodal = config.multimodal ?? {
    image: { enabled: true },
    video: { enabled: true },
    input: { enabled: true }
  };
  return {
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
    responseTone: config.responseTone ?? DEFAULT_RESPONSE_TONE,
    reasoningEffort: config.reasoningEffort ?? "medium",
    providers: config.providers.map((provider) => ({
      ...provider,
      headers: provider.headers ? { ...provider.headers } : undefined
    })),
    models: config.models.map((model) => ({ ...model })),
    routing: { ...config.routing },
    multimodal: {
      image: {
        enabled: multimodal.image?.enabled !== false,
        defaultProviderId: multimodal.image?.defaultProviderId,
        defaultModelId: multimodal.image?.defaultModelId
      },
      video: {
        enabled: multimodal.video?.enabled !== false,
        defaultProviderId: multimodal.video?.defaultProviderId,
        defaultModelId: multimodal.video?.defaultModelId
      },
      input: {
        enabled: multimodal.input?.enabled !== false,
        defaultProviderId: multimodal.input?.defaultProviderId,
        defaultModelId: multimodal.input?.defaultModelId
      }
    },
    multiAgent: { ...config.multiAgent },
    selfImprovement: {
      generateMemories: config.selfImprovement?.generateMemories !== false,
      useMemories: config.selfImprovement?.useMemories !== false,
      dedicatedTools: config.selfImprovement?.dedicatedTools === true,
      processingModelId: config.selfImprovement?.processingModelId,
      idleMinutes: config.selfImprovement?.idleMinutes ?? 5,
      retentionDays: config.selfImprovement?.retentionDays ?? 180,
      maxMemories: config.selfImprovement?.maxMemories ?? 500
    },
    desktop: { ...config.desktop },
    timeouts: { ...config.timeouts },
    mcpServers: config.mcpServers.map((server) => ({
      ...server,
      args: server.args ? [...server.args] : undefined,
      env: server.env ? { ...server.env } : undefined
    })),
    databaseConnections: config.databaseConnections.map((connection) => ({ ...connection }))
  };
}

export type McpJsonInput = Record<string, unknown>;

export function parseMcpJsonConfig(text: string): McpServerConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 格式无效：${error instanceof Error ? error.message : String(error)}`);
  }

  const root = getMcpJsonEntries(raw);
  const seenIds = new Set<string>();
  const servers: McpServerConfig[] = [];

  for (const [key, value] of Object.entries(root)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`服务 ${key} 必须是对象。`);
    }
    const entry = value as McpJsonInput;
    const id = stringValue(entry.id) ?? key.trim();
    if (!id) throw new Error("服务 ID 不能为空。");
    if (seenIds.has(id)) throw new Error(`服务 ID 重复：${id}`);
    seenIds.add(id);

    const command = stringValue(entry.command);
    const url = stringValue(entry.url);
    const transport = normalizeMcpJsonTransport(stringValue(entry.transport) ?? stringValue(entry.type), command, url);
    if (transport === "stdio" && !command) throw new Error(`服务 ${id} 的 stdio 配置需要 command。`);
    if (transport !== "stdio" && !url) throw new Error(`服务 ${id} 的 ${transport} 配置需要 url。`);

    servers.push({
      id,
      name: stringValue(entry.name) ?? id,
      description: stringValue(entry.description),
      command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
      env: normalizeMcpJsonEnvironment(entry.env),
      cwd: stringValue(entry.cwd),
      url,
      transport,
      ...(entry.auth !== undefined ? { auth: normalizeMcpJsonAuth(entry.auth) } : {}),
      ...(entry.defaultToolsApprovalMode !== undefined ? { defaultToolsApprovalMode: normalizeMcpJsonApprovalMode(entry.defaultToolsApprovalMode) } : {}),
      ...(entry.tools !== undefined ? { tools: normalizeMcpJsonToolPolicies(entry.tools) } : {}),
      source: "config",
      enabled: typeof entry.isActive === "boolean" ? entry.isActive : entry.enabled !== false
    });
  }

  return servers;
}

export function getMcpJsonEntries(raw: unknown): McpJsonInput {
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((value, index) => [`mcp-${index + 1}`, value]));
  }
  if (!raw || typeof raw !== "object") throw new Error("JSON 顶层必须是服务对象、服务数组，或包含 mcpServers 的对象。");
  const root = raw as McpJsonInput;
  const servers = root.mcpServers;
  if (servers !== undefined) return getMcpJsonEntries(servers);
  return root;
}

export function normalizeMcpJsonTransport(value: string | undefined, command: string | undefined, url: string | undefined): "stdio" | "sse" | "streamable_http" {
  const normalized = value?.toLowerCase().replace(/-/g, "_");
  if (normalized === "sse") return "sse";
  if (normalized === "http" || normalized === "streamable_http") return "streamable_http";
  if (normalized === "stdio") return "stdio";
  if (normalized) throw new Error(`不支持的 MCP 传输方式：${value}`);
  return command ? "stdio" : url ? "streamable_http" : "stdio";
}

export function normalizeMcpJsonEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("env 必须是键值对象。");
  return Object.fromEntries(Object.entries(value as McpJsonInput).map(([key, item]) => [key, String(item)]));
}

export function normalizeMcpJsonAuth(value: unknown): McpServerConfig["auth"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "none" };
  const auth = value as McpJsonInput;
  const mode = stringValue(auth.mode) === "bearer_env" || stringValue(auth.mode) === "oauth" ? stringValue(auth.mode) as "bearer_env" | "oauth" : "none";
  return {
    mode,
    bearerTokenEnvVar: stringValue(auth.bearerTokenEnvVar),
    oauthClientId: stringValue(auth.oauthClientId),
    oauthResource: stringValue(auth.oauthResource),
    oauthScopes: Array.isArray(auth.oauthScopes) ? auth.oauthScopes.map(String) : undefined
  };
}

export function normalizeMcpJsonApprovalMode(value: unknown): McpServerConfig["defaultToolsApprovalMode"] {
  return value === "auto" || value === "writes" || value === "approve" || value === "prompt" ? value : "prompt";
}

export function normalizeMcpJsonToolPolicies(value: unknown): McpServerConfig["tools"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as McpJsonInput).map(([name, raw]) => {
    const policy = raw && typeof raw === "object" ? raw as McpJsonInput : {};
    return [name, { enabled: policy.enabled === false ? false : undefined, approvalMode: normalizeMcpJsonApprovalMode(policy.approvalMode) }];
  }));
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function serializeMcpJsonConfig(servers: McpServerConfig[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers.map((server) => [server.id, {
    name: server.name,
    type: server.transport ?? (server.command ? "stdio" : "streamable_http"),
    ...(server.description ? { description: server.description } : {}),
    isActive: server.enabled !== false,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.auth && (server.auth.mode !== "none" || server.auth.bearerTokenEnvVar || server.auth.oauthClientId || server.auth.oauthResource || server.auth.oauthScopes?.length) ? { auth: server.auth } : {}),
    ...(server.defaultToolsApprovalMode && server.defaultToolsApprovalMode !== "prompt" ? { defaultToolsApprovalMode: server.defaultToolsApprovalMode } : {}),
    ...(server.tools ? { tools: server.tools } : {})
  }]));
}

export function createAvailableMcpId(servers: McpServerConfig[]): string {
  let index = servers.length + 1;
  let id = `mcp-${index}`;
  while (servers.some((server) => server.id === id)) {
    index += 1;
    id = `mcp-${index}`;
  }
  return id;
}

export function normalizeDraftConfig(config: AppConfig): AppConfig {
  const next = cloneConfig(config);
  next.models = next.models.filter((model) =>
    next.providers.some((provider) => provider.id === model.providerId)
  );

  next.models = next.models.map((model) => withGptReasoningCapabilities({
    ...model,
    role:
      model.role === "image" || model.role === "video" || model.role === "reasoning"
        ? model.role
        : undefined,
    supportsImageGeneration:
      model.role === "image" ? true : model.supportsImageGeneration === true,
    supportsVideoGeneration:
      model.role === "video" ? true : model.supportsVideoGeneration === true
  }));

  for (const kind of ["image", "video"] as const) {
    const defaults = next.multimodal[kind];
    const validDefault = next.models.some((model) =>
      model.role === kind &&
      model.providerId === defaults.defaultProviderId &&
      model.id === defaults.defaultModelId
    );
    if (!validDefault) {
      const firstRoleModel = next.models.find((model) => model.role === kind);
      next.multimodal[kind] = {
        enabled: defaults.enabled !== false,
        defaultProviderId: firstRoleModel?.providerId,
        defaultModelId: firstRoleModel?.id
      };
    } else {
      next.multimodal[kind] = { ...defaults, enabled: defaults.enabled !== false };
    }
  }

  {
    const defaults = next.multimodal.input ?? { enabled: true };
    const validDefault = next.models.some((model) =>
      model.supportsMultimodalInput &&
      model.providerId === defaults.defaultProviderId &&
      model.id === defaults.defaultModelId
    );
    if (!validDefault) {
      const first = next.models.find((model) => model.supportsMultimodalInput);
      next.multimodal.input = {
        enabled: defaults.enabled !== false,
        defaultProviderId: first?.providerId,
        defaultModelId: first?.id
      };
    } else {
      next.multimodal.input = { ...defaults, enabled: defaults.enabled !== false };
    }
  }

  const firstModel = next.models.find(isReasoningModel) ?? next.models[0];
  if (!firstModel) {
    return next;
  }

  const firstProviderWithModel =
    next.providers.find((provider) => next.models.some((model) => model.providerId === provider.id && isReasoningModel(model))) ??
    next.providers[0] ??
    null;

  if (!firstProviderWithModel) {
    return next;
  }

  if (!next.models.some((model) => model.providerId === next.defaultProvider && isReasoningModel(model))) {
    next.defaultProvider = firstProviderWithModel.id;
  }

  const providerModels = getReasoningModelsForProvider(next, next.defaultProvider);
  if (!providerModels.some((model) => model.id === next.defaultModel)) {
    next.defaultModel = providerModels[0]?.id ?? next.models.find(isReasoningModel)?.id ?? firstModel.id;
  }

  return next;
}

export function resolveSelectionFromConfig(
  config: AppConfig,
  providerId?: string | null,
  modelId?: string | null
): { providerId: string; modelId: string } {
  const normalized = normalizeDraftConfig(config);
  const providerModels = providerId ? getReasoningModelsForProvider(normalized, providerId) : [];

  if (providerId && providerModels.length > 0) {
    return {
      providerId,
      modelId: providerModels.find((model) => model.id === modelId)?.id ?? providerModels[0].id
    };
  }

  const fallbackProviderId =
    normalized.providers.find((provider) => getReasoningModelsForProvider(normalized, provider.id).length > 0)?.id ??
    normalized.providers[0]?.id ??
    "";
  const fallbackModels = getReasoningModelsForProvider(normalized, fallbackProviderId);

  return {
    providerId: fallbackProviderId,
    modelId: fallbackModels.find((model) => model.id === normalized.defaultModel)?.id ?? fallbackModels[0]?.id ?? ""
  };
}

export function resolveSettingsProviderId(config: AppConfig, preferredProviderId?: string | null): string | null {
  if (preferredProviderId && config.providers.some((provider) => provider.id === preferredProviderId)) {
    return preferredProviderId;
  }

  return (
    config.providers.find((provider) => getModelsForProvider(config, provider.id).length > 0)?.id ??
    config.providers[0]?.id ??
    null
  );
}

export function getModelsForProvider(config: Pick<AppConfig, "models">, providerId: string): ModelProfile[] {
  return config.models.filter((model) => model.providerId === providerId);
}

export function isReasoningModel(model: ModelProfile): boolean {
  return model.role === "reasoning";
}

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function getReasoningModelsForProvider(config: Pick<AppConfig, "models">, providerId: string): ModelProfile[] {
  return getModelsForProvider(config, providerId).filter(isReasoningModel);
}

export function getModelProfileKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function getProviderDisplayName(provider: ProviderDefinition): string {
  return provider.name?.trim() || provider.id;
}

export function normalizeProviderProtocol(type: ProviderType): ProviderType {
  return type === "openrouter" || type === "ollama" || type === "vllm" || type === "gateway"
    ? "openai-compatible"
    : type;
}

export function getProviderTransportLabel(type: ProviderType): string {
  const protocol = normalizeProviderProtocol(type);
  return PROVIDER_TYPE_OPTIONS.find((option) => option.value === protocol)?.label ?? protocol;
}

export function getProviderSubtitle(provider: ProviderDefinition): string {
  return provider.baseUrl?.trim() || getProviderTransportLabel(provider.type);
}

export function hasStoredSecret(provider: ProviderDefinition): boolean {
  return Boolean(provider.apiKey || provider.apiKeyEnv);
}

export function createEmptyProvider(existingProviders: ProviderDefinition[]): ProviderDefinition {
  let index = existingProviders.length + 1;
  let id = `provider-${index}`;

  while (existingProviders.some((provider) => provider.id === id)) {
    index += 1;
    id = `provider-${index}`;
  }

  return {
    id,
    name: `自定义供应商 ${index}`,
    type: "openai-compatible",
    baseUrl: ""
  };
}

export function parseMcpEnvironment(value: string): Record<string, string> | undefined {
  const entries = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1)] : null;
    })
    .filter((entry): entry is [string, string] => !!entry && !!entry[0]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function createModelProfile(providerId: string, modelId: string, displayName: string): ModelProfile {
  const normalizedId = modelId.trim();
  const normalizedDisplayName = displayName.trim() || normalizedId;

  return withGptReasoningCapabilities({
    id: normalizedId,
    providerId,
    displayName: normalizedDisplayName,
    contextWindow: 128_000,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsParallelToolCalls: true,
    supportsJsonOutput: true,
    supportsMultimodalInput: false,
    role: undefined,
    supportsImageGeneration: false,
    supportsVideoGeneration: false,
    supportsReasoningSummary: true,
    defaultTemperature: 0.2,
    defaultMaxOutputTokens: 4_096
  });
}

export function buildConfigToSave(
  draft: AppConfig,
  source: AppConfig,
  providerSecretDrafts: Record<string, string>
): AppConfig {
  const next = normalizeDraftConfig(draft);

  next.providers = next.providers.map((provider) => {
    const original = source.providers.find((item) => item.id === provider.id);
    const secretDraft = providerSecretDrafts[provider.id]?.trim();

    return {
      ...provider,
      name: provider.name?.trim() || provider.id,
      baseUrl: provider.baseUrl?.trim() ? provider.baseUrl.trim() : undefined,
      apiKey: secretDraft ? secretDraft : original?.apiKey,
      apiKeyEnv: secretDraft ? undefined : original?.apiKeyEnv ?? provider.apiKeyEnv
    };
  });

  next.models = next.models.map((model) => ({
    ...model,
    id: model.id.trim(),
    displayName: model.displayName.trim() || model.id.trim()
  }));

  return normalizeDraftConfig(next);
}
