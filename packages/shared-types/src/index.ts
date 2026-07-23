export { modelJsonCandidates, tryParseModelJson } from "./model-json";

export type ThreadMode = "project" | "chat";
export type WorkspaceKind = "project" | "projectless";
export type MultiAgentMode = "disabled" | "proactive";
export type ChildAgentWritePolicy = "read-only";
export type GpaStage = "off" | "goal" | "plan" | "act";
export interface GpaPlanTask {
  id: string;
  title: string;
  done: boolean;
}
export interface GpaState {
  stage: GpaStage;
  /** When enabled for a task, tool calls execute without approval prompts. */
  fullAccess: boolean;
  /** When enabled for a task, local knowledge bases are available to the model. */
  knowledgeEnabled: boolean;
  awaitingConfirmation: "goal" | "plan" | "act" | null;
  confirmationExpiresAt?: string | null;
  planTasks: GpaPlanTask[];
  updatedAt: string;
}
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
export type InteractionResolutionSource = "user" | "timeout";
export type SkillScope = "repo" | "user" | "system" | "admin";
export type KnowledgeScope = "global" | "project" | "imported";

export interface QuickNoteRecord {
  id: string;
  title: string;
  content: string;
  knowledgeBaseId: string;
  knowledgeSourcePath: string;
  createdAt: string;
  updatedAt: string;
}
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
  selectedPluginIds: string[];
  knowledgeBaseIds: string[];
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
  pinnedAt: string | null;
  gpaStateJson: string | null;
  parentThreadId: string | null;
  rootThreadId: string;
  agentPath: string;
  agentRole: string | null;
  lastTaskMessage: string | null;
  multiAgentMode: MultiAgentMode;
}

export interface MultiAgentSettings {
  defaultMode: MultiAgentMode;
  maxConcurrentSubagents: number;
  maxSubagentsPerRoot: number;
  maxDepth: number;
  childWritePolicy: ChildAgentWritePolicy;
}

export interface SubagentResultEnvelope {
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
  summary: string;
  evidence: string[];
  errors: string[];
  agentPath: string;
  threadId: string;
}

export interface SubagentWaitResult {
  agents: SubagentResultEnvelope[];
  timedOut: boolean;
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
  /** Detailed provider usage for the turn when available. */
  usageJson?: string | null;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

/** Aggregated token usage for one provider call, one turn, or one thread. */
export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  inputCacheHitTokens: number;
  inputCacheMissTokens: number;
  inputCacheWriteTokens: number;
  outputTokens: number;
  outputReasoningTokens: number;
  outputContentTokens: number;
  /** Cache hit rate over input tokens, 0–1. */
  cacheHitRate: number;
}

export function createEmptyTokenUsage(): TokenUsage {
  return {
    totalTokens: 0,
    inputTokens: 0,
    inputCacheHitTokens: 0,
    inputCacheMissTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 0,
    outputReasoningTokens: 0,
    outputContentTokens: 0,
    cacheHitRate: 0
  };
}

export function finalizeTokenUsage(partial: Partial<TokenUsage>): TokenUsage {
  const inputTokens = Math.max(0, Math.round(partial.inputTokens ?? 0));
  const inputCacheHitTokens = Math.max(0, Math.round(partial.inputCacheHitTokens ?? 0));
  const inputCacheWriteTokens = Math.max(0, Math.round(partial.inputCacheWriteTokens ?? 0));
  const inputCacheMissTokens = Math.max(
    0,
    Math.round(partial.inputCacheMissTokens ?? Math.max(0, inputTokens - inputCacheHitTokens))
  );
  const outputTokens = Math.max(0, Math.round(partial.outputTokens ?? 0));
  const outputReasoningTokens = Math.max(0, Math.round(partial.outputReasoningTokens ?? 0));
  const outputContentTokens = Math.max(
    0,
    Math.round(partial.outputContentTokens ?? Math.max(0, outputTokens - outputReasoningTokens))
  );
  const totalTokens = Math.max(
    0,
    Math.round(partial.totalTokens ?? inputTokens + outputTokens)
  );
  const cacheHitRate = inputTokens > 0 ? Math.min(1, inputCacheHitTokens / inputTokens) : 0;
  return {
    totalTokens,
    inputTokens,
    inputCacheHitTokens,
    inputCacheMissTokens,
    inputCacheWriteTokens,
    outputTokens,
    outputReasoningTokens,
    outputContentTokens,
    cacheHitRate
  };
}

export function addTokenUsage(left: TokenUsage, right: Partial<TokenUsage> | TokenUsage): TokenUsage {
  return finalizeTokenUsage({
    totalTokens: left.totalTokens + (right.totalTokens ?? 0),
    inputTokens: left.inputTokens + (right.inputTokens ?? 0),
    inputCacheHitTokens: left.inputCacheHitTokens + (right.inputCacheHitTokens ?? 0),
    inputCacheMissTokens: left.inputCacheMissTokens + (right.inputCacheMissTokens ?? 0),
    inputCacheWriteTokens: left.inputCacheWriteTokens + (right.inputCacheWriteTokens ?? 0),
    outputTokens: left.outputTokens + (right.outputTokens ?? 0),
    outputReasoningTokens: left.outputReasoningTokens + (right.outputReasoningTokens ?? 0),
    outputContentTokens: left.outputContentTokens + (right.outputContentTokens ?? 0)
  });
}

export function parseTokenUsageJson(value: string | null | undefined): TokenUsage | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TokenUsage>;
    if (!parsed || typeof parsed !== "object") return null;
    return finalizeTokenUsage(parsed);
  } catch {
    return null;
  }
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
  /** Transient rich tool output for the next model turn. It is not a visible chat message. */
  attachments?: MessageAttachment[];
  followUpMessage?: string;
}

/**
 * Optional v1 contract for MCP tools that inspect large repositories. The
 * envelope keeps pagination separate from the textual MCP protocol payload so
 * clients can retain the complete result without placing it in model context.
 */
export type McpRepositoryResultKind = "repository_tree" | "file_search" | "file_read";

export interface McpRepositoryResultItem {
  path: string;
  type?: "file" | "directory" | "match" | "line";
  name?: string;
  size?: number;
  line?: number;
  preview?: string;
}

export interface McpRepositoryToolResult {
  protocol: "codexh.repository.v1";
  kind: McpRepositoryResultKind;
  summary: string;
  items: McpRepositoryResultItem[];
  returnedCount: number;
  totalCount?: number;
  page?: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export type BrowserAssertionCheck =
  | { type: "url"; value: string; match?: "equals" | "includes" | "regex" }
  | { type: "title"; value: string; match?: "equals" | "includes" | "regex" }
  | { type: "text"; value: string; match?: "equals" | "includes" | "regex" }
  | { type: "element"; selector: string; state?: "exists" | "visible" | "enabled" | "selected" }
  | { type: "images_loaded" }
  | { type: "no_horizontal_overflow" }
  | { type: "canvas_nonblank"; selector?: string; minOpaquePixels?: number; minColors?: number }
  | { type: "no_severe_console_errors" };

export interface BrowserAssertionResult {
  check: BrowserAssertionCheck;
  passed: boolean;
  message: string;
  actual?: unknown;
}

export interface BrowserVerificationRecord {
  threadId: string;
  turnRunId: string;
  tabId: string;
  viewport: BrowserViewport;
  assertions: BrowserAssertionResult[];
  screenshotArtifact?: ArtifactRecord;
  screenshotAttachment?: MessageAttachment;
  visualStatus: "pending" | "inspected" | "skipped";
  visualSkippedReason?: "model_not_multimodal";
  completedAt?: string;
  failureReason?: string;
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
  expiresAt: string | null;
  resolutionSource: InteractionResolutionSource | null;
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

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface QueuedMessageRecord {
  id: string;
  threadId: string;
  content: string;
  displayContent: string;
  attachments: MessageAttachment[];
  status: "queued" | "dispatching";
  createdAt: string;
}

export interface UserInputQuestion {
  id: string;
  label: string;
  prompt: string;
  options?: UserInputOption[];
  allowFreeText?: boolean;
}

export interface UserInputPrompt {
  id: string;
  threadId: string;
  turnRunId: string;
  title: string;
  kind: "generic" | "gpa_plan_clarification";
  allowSkip: boolean;
  expiresAt: string | null;
  defaultAnswers: Record<string, string> | null;
  resolutionSource: InteractionResolutionSource | null;
  questions: UserInputQuestion[];
  status: "pending" | "answered" | "cancelled";
  answers: Record<string, string> | null;
  createdAt: string;
  answeredAt: string | null;
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
  /** User skills are grouped by a lightweight domain label for on-demand loading. */
  domain?: string;
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

export interface SkillUsageStats {
  skillId: string;
  callCount: number;
  successCount: number;
  successRate: number;
  lastUsedAt: string | null;
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
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  transport?: string;
  /** Authentication configuration only. Tokens are deliberately never persisted here. */
  auth?: McpAuthConfig;
  defaultToolsApprovalMode?: McpToolApprovalMode;
  tools?: Record<string, McpToolPolicy>;
  source?: "config" | "plugin";
  pluginId?: string;
  enabled: boolean;
}

export type DatabaseEngine = "postgresql" | "mysql" | "sqlserver";
export type DatabaseTlsMode = "disable" | "require" | "verify";
export type DatabasePermission = "query" | "insert" | "update" | "delete";

/** Connection metadata only. Credentials live in the encrypted desktop store. */
export interface DatabaseConnectionConfig {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  tlsMode: DatabaseTlsMode;
  credentialRef: string;
  enabled: boolean;
  /** Operations that the assistant may execute for this connection. */
  permissions: DatabasePermission[];
  /** Result-row limit for a single query. Runtime-enforced with a hard cap of 1,000. */
  maxRows: number;
}

export type McpToolApprovalMode = "auto" | "prompt" | "writes" | "approve";

export interface McpToolPolicy {
  enabled?: boolean;
  approvalMode?: McpToolApprovalMode;
}

export interface McpAuthConfig {
  mode: "none" | "bearer_env" | "oauth";
  /** Environment variable holding a bearer token; the value is never stored in config. */
  bearerTokenEnvVar?: string;
  /** A pre-registered public OAuth client id. Dynamic registration is intentionally not used. */
  oauthClientId?: string;
  oauthResource?: string;
  oauthScopes?: string[];
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
  /** Multimodal assignment. Omitted means unassigned (not shown in chat dropdown). */
  role?: "reasoning" | "image" | "video";
  /** @deprecated Prefer role === "image". Kept for config migration. */
  supportsImageGeneration?: boolean;
  /** @deprecated Prefer role === "video". Kept for config migration. */
  supportsVideoGeneration?: boolean;
  /** Result of the last real function-calling protocol check for this model. */
  agentCapability?: "unknown" | "verified" | "unsupported";
  agentCapabilityCheckedAt?: string;
  agentCapabilityReason?: string;
  supportsReasoningSummary: boolean;
  defaultTemperature?: number;
  defaultMaxOutputTokens?: number;
}

/** Image or video modality defaults and feature switch. */
export interface MultimodalModalityDefaults {
  /** When false, Agent will not generate this modality even if intent matches. */
  enabled: boolean;
  defaultProviderId?: string;
  defaultModelId?: string;
}

export interface RuntimeTimeoutSettings {
  modelDecisionMs: number;
  recoveryModelDecisionMs: number;
  modelTimeoutRetries: number;
  multimodalIntentClassifyMs: number;
  modelTestMs: number;
  videoGenerationMs: number;
  videoPollIntervalMs: number;
}

export interface ProjectExecutionPolicy {
  /** Controlled mode auto-runs reads, non-destructive patches, and safe verification only. */
  mode: "controlled" | "prompt";
  autoVerify: boolean;
  /** Overrides package.json discovery when present. Commands must be local verification commands. */
  verificationCommands?: string[];
}

export const DEFAULT_PROJECT_EXECUTION_POLICY: ProjectExecutionPolicy = {
  mode: "controlled",
  autoVerify: true
};

export const DEFAULT_RUNTIME_TIMEOUTS: RuntimeTimeoutSettings = {
  modelDecisionMs: 90_000,
  recoveryModelDecisionMs: 20_000,
  modelTimeoutRetries: 5,
  multimodalIntentClassifyMs: 20_000,
  modelTestMs: 30_000,
  videoGenerationMs: 10 * 60_000,
  videoPollIntervalMs: 5_000
};

export function normalizeRuntimeTimeouts(value?: Partial<RuntimeTimeoutSettings> | null): RuntimeTimeoutSettings {
  const source = value ?? {};
  const nonNegativeNumber = (input: unknown, fallback: number) => {
    const numeric = typeof input === "number" && Number.isFinite(input) ? Math.round(input) : fallback;
    return Math.max(0, numeric);
  };

  return {
    modelDecisionMs: nonNegativeNumber(source.modelDecisionMs, DEFAULT_RUNTIME_TIMEOUTS.modelDecisionMs),
    recoveryModelDecisionMs: nonNegativeNumber(source.recoveryModelDecisionMs, DEFAULT_RUNTIME_TIMEOUTS.recoveryModelDecisionMs),
    modelTimeoutRetries: nonNegativeNumber(source.modelTimeoutRetries, DEFAULT_RUNTIME_TIMEOUTS.modelTimeoutRetries),
    multimodalIntentClassifyMs: nonNegativeNumber(source.multimodalIntentClassifyMs, DEFAULT_RUNTIME_TIMEOUTS.multimodalIntentClassifyMs),
    modelTestMs: nonNegativeNumber(source.modelTestMs, DEFAULT_RUNTIME_TIMEOUTS.modelTestMs),
    videoGenerationMs: nonNegativeNumber(source.videoGenerationMs, DEFAULT_RUNTIME_TIMEOUTS.videoGenerationMs),
    videoPollIntervalMs: nonNegativeNumber(source.videoPollIntervalMs, DEFAULT_RUNTIME_TIMEOUTS.videoPollIntervalMs)
  };
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
  multimodal: {
    image: MultimodalModalityDefaults;
    video: MultimodalModalityDefaults;
    /**
     * Default vision/input model. When the chat model cannot accept multimodal
     * attachments, this model recognizes images/files first and the text result
     * is passed to the selected chat model.
     */
    input: MultimodalModalityDefaults;
  };
  desktop: {
    theme: "light" | "dark" | "system";
    approvals: ApprovalMode;
    inAppBrowser: boolean;
  };
  multiAgent: MultiAgentSettings;
  timeouts: RuntimeTimeoutSettings;
  /** Optional per-workspace overrides keyed by normalized absolute workspace path. */
  projectExecutionPolicies?: Record<string, ProjectExecutionPolicy>;
  mcpServers: McpServerConfig[];
  databaseConnections: DatabaseConnectionConfig[];
}

export interface ProviderTurnDecision {
  assistantMessage?: string;
  clarification?: {
    title: string;
    question: string;
    options: UserInputOption[];
    allowFreeText: boolean;
  };
  /** Provider-reported completion token count when its API exposes usage data. */
  outputTokens?: number;
  /** Detailed provider usage when available. Prefer this over outputTokens alone. */
  usage?: TokenUsage;
  toolCalls: RuntimeToolCall[];
  endTurn: boolean;
  /** Explicit provider declaration that every deliverable in the user goal is complete. */
  goalCompleted: boolean;
  /** GPA plan task ids that the provider declares complete in the final ACT response. */
  completedTaskIds?: string[];
  /** Tool-backed evidence for completed GPA plan tasks. */
  completionEvidence?: CompletionEvidenceReference[];
  /** True only when the provider response matched the runtime JSON envelope. */
  isStructured: boolean;
  /** The provider returned a native tool name as plain text and needs a JSON tool-protocol retry. */
  requestTextToolProtocol?: boolean;
  reasoningSummary?: string;
}

export type CompletionEvidenceKind = "observation" | "delivery" | "verification";

export interface CompletionEvidenceReference {
  taskId: string;
  toolCallId: string;
  kind: CompletionEvidenceKind;
}

export interface MessageAttachment {
  id: string;
  kind: "image" | "video" | "file";
  name: string;
  mimeType: string;
  absolutePath: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  source: "user" | "generated";
}

export interface AttachmentImportInput {
  name: string;
  mimeType?: string;
  path?: string;
  data?: Uint8Array;
}

export interface KnowledgeDocumentRecord {
  id: string;
  knowledgeBaseId: string;
  sourcePath: string;
  sourceHash: string;
  title: string;
  mimeHint: string;
  status: "ready" | "missing" | "failed";
  updatedAt: string;
}

export type KnowledgeImportSource =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | { kind: "url"; url: string }
  | { kind: "browser"; url: string; threadId: string; tabId: string };

export interface KnowledgeChunkRecord {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  chunkIndex: number;
  title: string;
  content: string;
  sourcePath: string;
  locator: string;
  createdAt: string;
  score?: number;
}

export interface KnowledgeBaseSummary extends KnowledgeBaseRecord {
  documentCount: number;
  chunkCount: number;
  indexedBytes: number;
  scopeTargetLabel?: string;
}

export interface ProviderTurnInput {
  systemPrompt: string;
  transcript: Array<{
    role: MessageRole;
    content: string;
    attachments?: MessageAttachment[];
    /** Transient metadata used to correlate native tool calls and results. */
    toolCalls?: RuntimeToolCall[];
    toolCallId?: string;
    toolResultOk?: boolean;
  }>;
  availableTools: ToolSpecDefinition[];
  model: ModelProfile;
  provider: ProviderDefinition;
  /** Use the JSON decision envelope instead of provider-native function calls. */
  forceTextToolProtocol?: boolean;
  stream?: boolean;
  onTextDelta?: (delta: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

export interface RuntimeEvent {
  type:
    | "thread.updated"
    | "message.created"
    | "assistant.delta"
    | "assistant.completed"
    | "assistant.execution_output"
    | "agent.retrying"
    | "agent.context_compacted"
    | "agent.repository_exploration"
    | "queue.updated"
    | "turn.updated"
    | "turn.usage"
    | "tool.started"
    | "tool.completed"
    | "approval.requested"
    | "approval.resolved"
    | "user-input.requested"
    | "user-input.resolved"
    | "knowledge.imported"
    | "browser.updated"
    | "browser.verification_started"
    | "browser.assertion_completed"
    | "browser.screenshot_attached"
    | "browser.verification_completed"
    | "gpa.updated"
    | "model.capability.updated"
    | "terminal.output";
  threadId?: string;
  /** Root task used by global notifications while preserving the event's subject thread. */
  notificationThreadId?: string;
  /** Child task that produced the event when notifications are routed to its root task. */
  notificationChildThreadId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SkillLabProgress {
  iteration: number;
  totalIterations: number;
  phase: string;
  summary: string;
  state: "running" | "tested";
}

export type SkillLabEvent =
  | ({ type: "skill-lab.progress"; jobId: string; createdAt: string } & SkillLabProgress)
  | {
      type: "skill-lab.approval";
      jobId: string;
      createdAt: string;
      approvalId: string;
      title: string;
      description: string;
      toolName: string;
    }
  | {
      type: "skill-lab.clarification";
      jobId: string;
      createdAt: string;
      clarificationId: string;
      summary: string;
      questions: Array<{ id: string; question: string; required: boolean; options: string[]; allowOther: boolean }>;
    }
  | { type: "skill-lab.completed"; jobId: string; createdAt: string; skill: SkillMetadata }
  | { type: "skill-lab.failed"; jobId: string; createdAt: string; error: string }
  | { type: "skill-lab.cancelled"; jobId: string; createdAt: string };

export interface NotificationNavigationTarget {
  source: "thread" | "skill-lab";
  targetId: string;
  anchorId?: string;
}

export interface ContextCompactionRecord {
  turnRunId: string;
  contextWindow: number;
  threshold: number;
  target: number;
  beforeTokens: number;
  afterTokens: number;
  messagesBefore: number;
  messagesAfter: number;
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
  /** Total persisted messages; snapshots may contain only the recent portion. */
  messageCount: number;
  hasMoreMessages: boolean;
  queuedMessages: QueuedMessageRecord[];
  approvals: ApprovalRequest[];
  prompts: UserInputPrompt[];
  artifacts: ArtifactRecord[];
  knowledgeBases: KnowledgeBaseRecord[];
  browserTabs: BrowserTabRecord[];
  projectPlugins: Array<{
    plugin: PluginRecord;
    binding: ProjectPluginBinding | null;
  }>;
  toolCalls: ToolCallRecord[];
  contextCompaction: ContextCompactionRecord | null;
  gpa: GpaState | null;
  subagents: ThreadRecord[];
}

export type GitDiffLineKind = "context" | "added" | "removed" | "meta";

export interface GitDiffLine {
  kind: GitDiffLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface GitHunk {
  id: string;
  header: string;
  lines: GitDiffLine[];
}

export interface GitFileChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  stagedHunks: GitHunk[];
  unstagedHunks: GitHunk[];
}

export interface GitSnapshot {
  available: boolean;
  message?: string;
  root?: string;
  head?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  canCreatePullRequest: boolean;
  files: GitFileChange[];
}

export interface GitActionResult {
  ok: boolean;
  message: string;
  snapshot: GitSnapshot;
  pullRequestUrl?: string;
}

export interface ToolSearchResult {
  name: string;
  description: string;
  score: number;
  source: string;
}
