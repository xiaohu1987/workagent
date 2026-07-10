export type ThreadMode = "project" | "chat";
export type WorkspaceKind = "project" | "projectless";
export type ThreadStatus = "idle" | "running" | "waiting" | "completed" | "failed";
export type TurnKind = "regular" | "review" | "compact" | "subagent";
export type TurnStatus =
  | "pending_init"
  | "running"
  | "waiting_tool"
  | "waiting_approval"
  | "waiting_user_input"
  | "compacting"
  | "interrupted"
  | "aborted"
  | "completed"
  | "failed";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type ToolRiskLevel = "low" | "medium" | "high";
export type ToolExposure = "direct" | "deferred";
export type ApprovalMode = "auto" | "prompt" | "session" | "remembered";
export type ApprovalDecision = "approved" | "denied";
export type ApprovalResolutionMode = "once" | "session" | "remember";
export type SkillScope = "repo" | "user" | "system" | "admin";
export type KnowledgeScope = "global" | "project" | "imported";
export type ProviderType =
  | "mock"
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "ollama"
  | "vllm"
  | "gateway";

export interface ThreadRecord {
  id: string;
  title: string;
  mode: ThreadMode;
  workspaceKind: WorkspaceKind;
  cwd: string | null;
  projectId: string | null;
  workspaceId: string | null;
  modelId: string;
  providerId: string;
  status: ThreadStatus;
  selectedSkillIds: string[];
  knowledgeBaseIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  turnRunId: string | null;
  role: MessageRole;
  content: string;
  metadataJson: string | null;
  createdAt: string;
}

export interface TurnRunRecord {
  id: string;
  threadId: string;
  kind: TurnKind;
  status: TurnStatus;
  providerId: string;
  modelId: string;
  resolvedModelSnapshotJson: string;
  promptTokens: number;
  completionTokens: number;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface ToolSpecDefinition {
  name: string;
  namespace?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  parallelSafe?: boolean;
  exposure?: ToolExposure;
  source?: "builtin" | "mcp" | "plugin" | "dynamic";
}

export interface ToolCallRecord {
  id: string;
  threadId: string;
  turnRunId: string;
  toolName: string;
  argumentsJson: string;
  resultJson: string | null;
  status: "pending" | "running" | "completed" | "failed" | "denied";
  riskLevel: ToolRiskLevel;
  approvalMode: ApprovalMode;
  startedAt: string;
  completedAt: string | null;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  json?: Record<string, unknown>;
  artifacts?: ArtifactRecord[];
  followUpMessage?: string;
}

export interface RuntimeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  turnRunId: string;
  toolCallId: string | null;
  projectId: string | null;
  title: string;
  description: string;
  scope: ApprovalMode;
  riskLevel: ToolRiskLevel;
  approvalKey: string;
  payloadJson: string;
  status: "pending" | "approved" | "denied";
  resolutionMode: ApprovalResolutionMode | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RememberedApprovalRecord {
  id: string;
  projectId: string | null;
  approvalKey: string;
  title: string;
  description: string;
  riskLevel: ToolRiskLevel;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserInputPrompt {
  id: string;
  threadId: string;
  turnRunId: string;
  title: string;
  questions: Array<{
    id: string;
    label: string;
    prompt: string;
    options?: string[];
  }>;
  status: "pending" | "answered";
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  threadId: string;
  turnRunId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  artifactKind: string;
  displayName: string;
  absolutePath: string;
  relativePath: string | null;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string | null;
  sourceKind: string;
  isUserVisible: boolean;
  status?: "ready" | "missing";
  createdAt: string;
}

export interface SkillMetadata {
  id: string;
  name: string;
  qualifiedName: string;
  description: string;
  shortDescription?: string;
  scope: SkillScope;
  rootPath: string;
  skillPath: string;
  metadataPath: string | null;
  pluginId?: string;
  defaultPrompt?: string;
  displayName?: string;
  brandColor?: string;
  dependencies: Array<{
    type?: string;
    value?: string;
    description?: string;
    transport?: string;
    command?: string;
    url?: string;
  }>;
  allowImplicitInvocation: boolean;
  products: string[];
  contentHash: string;
}

export interface AvailableSkillsContext {
  text: string;
  visibleSkillIds: string[];
  omittedSkillIds: string[];
  warning?: string;
}

export interface KnowledgeConcept {
  id: string;
  knowledgeBaseId: string;
  sourceDocumentId: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  sourcePath: string;
  bundleRelativePath: string;
  body: string;
  createdAt: string;
}

export interface KnowledgeBaseRecord {
  id: string;
  scope: KnowledgeScope;
  projectId: string | null;
  displayName: string;
  bundleRoot: string;
  okfVersion: string;
  status: "ready" | "importing" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeImportJob {
  id: string;
  knowledgeBaseId: string;
  sourcePaths: string[];
  createdAt: string;
}

export interface BrowserTabRecord {
  id: string;
  threadId: string;
  title: string;
  url: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  manifestPath: string;
  installPath: string;
  enabled: boolean;
  source: string;
}

export interface PluginManifestSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  skillsDir?: string | null;
  hooksFile?: string | null;
  repository?: string | null;
  mcpServers: McpServerConfig[];
  hooks: PluginHookDeclaration[];
}

export interface PluginHookDeclaration {
  key: string;
  eventName: string;
  matcher: string | null;
  command: string | null;
  commandWindows: string | null;
  statusMessage: string | null;
  timeoutSec: number | null;
  sourcePath: string;
}

export interface ProjectPluginBinding {
  projectId: string;
  pluginId: string;
  enabled: boolean;
  settingsJson?: string | null;
}

export interface McpServerConfig {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  transport?: string;
  source?: "config" | "plugin";
  pluginId?: string;
  enabled: boolean;
}

export interface ProviderDefinition {
  id: string;
  name?: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  organization?: string;
}

export interface ModelProfile {
  id: string;
  providerId: string;
  displayName: string;
  contextWindow: number;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsParallelToolCalls: boolean;
  supportsJsonOutput: boolean;
  supportsMultimodalInput: boolean;
  supportsReasoningSummary: boolean;
  defaultTemperature?: number;
  defaultMaxOutputTokens?: number;
}

export interface AppConfig {
  defaultModel: string;
  defaultProvider: string;
  providers: ProviderDefinition[];
  models: ModelProfile[];
  routing: {
    plannerModelId?: string;
    executorModelId?: string;
    summarizerModelId?: string;
  };
  desktop: {
    theme: "light" | "dark" | "system";
    approvals: ApprovalMode;
    inAppBrowser: boolean;
  };
  mcpServers: McpServerConfig[];
}

export interface ProviderTurnDecision {
  assistantMessage?: string;
  toolCalls: RuntimeToolCall[];
  endTurn: boolean;
  reasoningSummary?: string;
}

export interface ProviderTurnInput {
  systemPrompt: string;
  transcript: Array<{
    role: MessageRole;
    content: string;
  }>;
  availableTools: ToolSpecDefinition[];
  model: ModelProfile;
  provider: ProviderDefinition;
  abortSignal?: AbortSignal;
}

export interface RuntimeEvent {
  type:
    | "thread.updated"
    | "message.created"
    | "turn.updated"
    | "tool.started"
    | "tool.completed"
    | "approval.requested"
    | "approval.resolved"
    | "user-input.requested"
    | "knowledge.imported"
    | "browser.updated";
  threadId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimePromptBundle {
  systemPrompt: string;
  skillContext: AvailableSkillsContext | null;
  knowledgeContext: string | null;
  workflowPackContext?: string | null;
}

export interface RuntimeThreadSnapshot {
  thread: ThreadRecord;
  messages: MessageRecord[];
  approvals: ApprovalRequest[];
  prompts: UserInputPrompt[];
  artifacts: ArtifactRecord[];
  knowledgeBases: KnowledgeBaseRecord[];
  browserTabs: BrowserTabRecord[];
  projectPlugins: Array<{
    plugin: PluginRecord;
    binding: ProjectPluginBinding | null;
  }>;
}

export interface ToolSearchResult {
  name: string;
  description: string;
  score: number;
  source: string;
}
