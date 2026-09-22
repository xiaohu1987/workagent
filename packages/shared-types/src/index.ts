export { modelJsonCandidates, tryParseModelJson } from "./model-json";

export type ThreadMode = "project" | "chat";
export type WorkspaceKind = "project" | "projectless";
export type MultiAgentMode = "disabled" | "proactive";
export type ChildAgentWritePolicy = "inherit" | "read-only";
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
export type SandboxMode = "read-only" | "workspace-write" | "full-access";
export const SANDBOX_MODES = ["read-only", "workspace-write", "full-access"] as const satisfies readonly SandboxMode[];
export const DEFAULT_SANDBOX_MODE: SandboxMode = "read-only";

export function normalizeSandboxMode(value: unknown): SandboxMode {
  return value === "workspace-write" || value === "full-access" || value === "read-only"
    ? value
    : DEFAULT_SANDBOX_MODE;
}

export function normalizeSandboxNetworkAccess(value: unknown): boolean {
  return value === true;
}
export type ApprovalDecision = "approved" | "denied";
export type ApprovalResolutionMode = "once" | "session" | "remember";
export type ApprovalRequestKind = "permission" | "explicit_authorization";
export type InteractionResolutionSource = "user" | "timeout" | "interrupted";
export type SkillScope = "repo" | "user" | "system" | "admin";
export type KnowledgeScope = "global" | "project" | "imported";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type GptReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const GPT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const satisfies readonly GptReasoningEffort[];
export const DEEPSEEK_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly GptReasoningEffort[];

export function isGptReasoningEffort(value: unknown): value is GptReasoningEffort {
  return typeof value === "string" && (
    (GPT_REASONING_EFFORTS as readonly string[]).includes(value) || value === "max"
  );
}

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

export type ProviderTemplate = "deepseek" | "openai_compatible" | "anthropic" | "gemini";
export type ApiFormat = "auto" | "openai_responses" | "openai_chat" | "anthropic" | "gemini";
export type OpenAiApiFormat = Extract<ApiFormat, "openai_responses" | "openai_chat">;
export type CompatibilityProfile = "standard" | "deepseek";

export function isGptFamilyModel(model: Pick<ModelProfile, "id" | "displayName">): boolean {
  const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
  return /(?:^|[^a-z0-9])(?:chat)?gpt(?:$|[^a-z0-9]|\d)/.test(identity)
    || /(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9]|\d)/.test(identity);
}

export function defaultOpenAiApiFormatsForModel(
  model: Pick<ModelProfile, "id" | "displayName">
): OpenAiApiFormat[] {
  return isGptFamilyModel(model)
    ? ["openai_responses", "openai_chat"]
    : ["openai_chat"];
}

export interface ThreadRecord {
  id: string;
  title: string;
  mode: ThreadMode;
  workspaceKind: WorkspaceKind;
  cwd: string | null;
  /** Ordered writable workspace roots. The first entry is the fixed primary cwd. */
  workspaceRoots?: string[];
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
  defaultContextFork?: "none" | "all" | "recent";
  defaultModelId?: string;
  defaultProviderId?: string;
  defaultReasoningEffort?: ReasoningEffort;
}

/**
 * Memory scope. `global` memories are project-independent and shared by every
 * chat; `project` memories belong to exactly one project and must never leak
 * into another project's tasks.
 */
export type SelfImprovementMemoryScope = "global" | "project";

/** How a memory record entered the store. */
export type SelfImprovementMemorySource = "distilled" | "manual";

/** What kind of knowledge a memory record carries. */
export type SelfImprovementMemoryKind = "experience" | "preference" | "error_solution" | "note";

/** Long-lived, redacted experience distilled from completed root tasks. */
export interface SelfImprovementMemoryRecord {
  id: string;
  scope: SelfImprovementMemoryScope;
  projectId: string | null;
  kind: SelfImprovementMemoryKind;
  title: string;
  content: string;
  sourceThreadId: string | null;
  /**
   * Stable identity of the underlying fact, derived from scope + project +
   * topic. Re-distilling the same fact refreshes this record instead of
   * appending a duplicate.
   */
  fingerprint: string;
  source: SelfImprovementMemorySource;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

/** Aggregate counters used by the settings page to show the scope split. */
export interface SelfImprovementMemoryStats {
  total: number;
  global: number;
  project: number;
}

export interface SelfImprovementSettings {
  generateMemories: boolean;
  useMemories: boolean;
  dedicatedTools: boolean;
  /** Distill memories as soon as a root task finishes. */
  autoDistillOnComplete: boolean;
  processingModelId?: string;
  idleMinutes: number;
  retentionDays: number;
  maxMemories: number;
}

export interface SubagentResultEnvelope {
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
  summary: string;
  evidence: string[];
  errors: string[];
  agentPath: string;
  threadId: string;
}

export type SubagentRuntimeState =
  | "queued"
  | "starting"
  | "awaiting_model"
  | "executing_shell_test"
  | "retrying"
  | "stalled"
  | "auto_interrupted"
  | "completed";

/**
 * A point-in-time activity summary used by the parent-task watchdog and the
 * child-task UI. All timestamps are ISO strings so the desktop process and
 * renderer can calculate their own clocks without sharing mutable state.
 */
export interface SubagentWatchdogDiagnostic {
  threadId: string;
  agentPath: string;
  state: SubagentRuntimeState;
  lastToolEventAt: string | null;
  currentTool: string | null;
  isShellOrTest: boolean;
  lastProgressAt: string | null;
  startedAt: string;
  runtimeMs: number;
  idleForMs: number;
  nextInspectionAt: string | null;
  automaticInterruptAt: string | null;
  interruptionReason?: string;
}

export interface SubagentWaitResult {
  agents: SubagentResultEnvelope[];
  timedOut: boolean;
  diagnostics: SubagentWatchdogDiagnostic[];
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

export type UsageAnalyticsGranularity = "day" | "week" | "month";

export interface UsageAnalyticsModelRow {
  providerId: string;
  modelId: string;
  requestCount: number;
  usage: TokenUsage;
}

export interface UsageAnalyticsTrendPoint {
  key: string;
  label: string;
  requestCount: number;
  usage: TokenUsage;
}

export interface UsageAnalyticsSummary {
  generatedAt: string;
  rangeDays: number | null;
  granularity: UsageAnalyticsGranularity;
  totalRequests: number;
  totalUsage: TokenUsage;
  models: UsageAnalyticsModelRow[];
  trend: UsageAnalyticsTrendPoint[];
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
  status: "pending" | "running" | "completed" | "failed" | "denied" | "blocked";
  riskLevel: ToolRiskLevel;
  approvalMode: ApprovalMode;
  startedAt: string;
  completedAt: string | null;
}

/** Bounded tool data used by conversation pages and runtime events. */
export interface ToolCallSummary extends Omit<ToolCallRecord, "resultJson"> {
  resultJson: string | null;
  resultSize: number;
  hasFullResult: boolean;
}

export interface ToolCallDetail {
  toolCallId: string;
  resultJson: string | null;
  resultSize: number;
  available: boolean;
}

export interface ConversationPageCursor {
  createdAt: string;
  id: string;
}

export interface ConversationPage {
  messages: MessageRecord[];
  toolCalls: ToolCallSummary[];
  previousCursor: ConversationPageCursor | null;
  hasMore: boolean;
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
  kind: ApprovalRequestKind;
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

export type ErrorSolutionMemoryKind = "recovered" | "blocked_strategy";
export type ErrorSolutionScopeMode = "shared" | "model";
export type ErrorSolutionMatchKind = "exact_strategy" | "exact_target" | "similar";
export type ErrorSolutionRecallOutcome = "matched" | "blocked" | "prerequisite" | "recovered";

/** Cross-session memory of how a prior tool failure was recovered or should be avoided. */
export interface ErrorSolutionRecord {
  id: string;
  /** Shared records use "*"; model records keep the originating model id. */
  modelId: string;
  projectId: string | null;
  toolName: string;
  memoryKind: ErrorSolutionMemoryKind;
  scopeMode: ErrorSolutionScopeMode;
  taskKeyPattern: string;
  targetKeyPattern: string;
  strategyFingerprint: string;
  errorSignature: string;
  errorSummary: string;
  solutionSummary: string;
  strategyJson: string;
  successCount: number;
  failureCount: number;
  confidence: number;
  sourceThreadId: string | null;
  lastUsedAt: string;
  /** Number of later tool decisions that recalled this experience. */
  recallCount?: number;
  /** Most recent time a later tool decision recalled this experience. */
  lastRecalledAt?: string | null;
  /** Result of the most recent recall, when known. */
  lastRecallOutcome?: ErrorSolutionRecallOutcome | null;
  lastObservedAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  matchKind?: ErrorSolutionMatchKind;
  effectiveConfidence?: number;
  score?: number;
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
  /** Explicit image/video generation request chosen from the composer "+" menu. */
  mediaIntent?: "image" | "video" | null;
  /** Runtime-created continuation; it starts a new turn without a chat bubble. */
  internalKind?: "agent_protocol_recovery" | null;
  /** Zero-based number of automatic protocol-recovery continuations already used. */
  protocolRecoveryBatch?: number;
  /** Successful execution evidence carried across an internal recovery turn. */
  protocolRecoveryEvidence?: Array<{
    toolCallId: string;
    toolRecordId?: string;
    toolName: string;
    kinds: CompletionEvidenceKind[];
    unitTestPassed?: boolean;
    verifiedPaths?: string[];
    resultPreview?: string;
  }>;
  userMessageId: string | null;
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
  category: string;
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
  /** User-facing preset. It supplies defaults but never selects the runtime adapter by itself. */
  providerTemplate?: ProviderTemplate;
  /** The real upstream wire format and the sole runtime adapter selector. */
  apiFormat?: ApiFormat;
  /** Request-shape compatibility applied independently from the upstream format. */
  compatibilityProfile?: CompatibilityProfile;
  /**
   * @deprecated Read only while migrating legacy configuration. Never use at runtime.
   */
  transport?: "chat-completions" | "responses" | "messages";
  /** @deprecated Read only while migrating legacy configuration. */
  deepseekProtocol?: "native" | "openai-compatible";
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  organization?: string;
  /** Final serialized request-body limit in UTF-8 bytes. Undefined and 0 mean no local byte limit. */
  maxRequestBytes?: number;
  /** Maximum native tools sent in one request. Undefined and 0 mean no local tool-count limit. */
  maxTools?: number;
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
  /** OpenAI-compatible formats that completed the connection and native tool roundtrip probe. */
  verifiedApiFormats?: OpenAiApiFormat[];
  /** Preferred format for this specific provider/model pair while apiFormat is auto. */
  preferredApiFormat?: OpenAiApiFormat;
  apiFormatCheckedAt?: string;
  supportsReasoningSummary: boolean;
  /** Provider-supported reasoning effort values. Omitted keeps the provider default. */
  supportedReasoningEfforts?: ReasoningEffort[];
  /** Default reasoning effort for this model when it is selected. */
  defaultReasoningEffort?: ReasoningEffort;
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

export type ResponseTone = "friendly" | "concise";

export const DEFAULT_RESPONSE_TONE: ResponseTone = "concise";

export function normalizeResponseTone(value: unknown): ResponseTone {
  if (value === "friendly" || value === "cute_lolita" || value === "mature_lady") {
    return "friendly";
  }
  return DEFAULT_RESPONSE_TONE;
}

/** Current GPT-5.1+ and o-series reasoning models expose configurable effort. */
export function isConfigurableGptReasoningModel(
  model: Pick<ModelProfile, "id" | "role">
): boolean {
  if (model.role !== "reasoning") return false;
  const identity = model.id.toLowerCase();
  if (/(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9]|\d)/.test(identity)) return true;
  const version = /\bgpt-(\d+)(?:\.(\d+))?/i.exec(identity);
  if (!version) return false;
  const major = Number(version[1]);
  const minor = version[2] === undefined ? 0 : Number(version[2]);
  return major > 5 || (major === 5 && minor >= 1);
}

export function isConfigurableReasoningEffortModel(
  model: Pick<ModelProfile, "id" | "displayName" | "role">
): boolean {
  if (isConfigurableGptReasoningModel(model)) return true;
  if (model.role !== "reasoning") return false;
  const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
  return /\bdeepseek\b/.test(identity)
    || /\b(?:glm|chatglm)\b/.test(identity)
    || /\bgrok\b/.test(identity);
}

export function withGptReasoningCapabilities<T extends ModelProfile>(model: T): T {
  if (!isConfigurableReasoningEffortModel(model)) return model;
  const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
  const isDeepSeek = /\bdeepseek\b/.test(identity);
  const supportedReasoningEfforts: readonly GptReasoningEffort[] = isDeepSeek
    ? DEEPSEEK_REASONING_EFFORTS
    : GPT_REASONING_EFFORTS;
  return {
    ...model,
    supportedReasoningEfforts: [...supportedReasoningEfforts],
    defaultReasoningEffort: supportedReasoningEfforts.includes(model.defaultReasoningEffort as GptReasoningEffort)
      ? model.defaultReasoningEffort
      : isDeepSeek ? "high" : "medium"
  };
}

export function resolveModelReasoningEffort(
  model: Pick<ModelProfile, "id" | "displayName" | "role" | "supportedReasoningEfforts" | "defaultReasoningEffort">,
  globalGptEffort: GptReasoningEffort
): ReasoningEffort | undefined {
  if (!isConfigurableReasoningEffortModel(model)) return model.defaultReasoningEffort;
  const supported = model.supportedReasoningEfforts;
  return supported?.length && !supported.includes(globalGptEffort)
    ? model.defaultReasoningEffort ?? supported[0]
    : globalGptEffort;
}

export type BrowserOpenMode = "in_app" | "external_default";

export const DEFAULT_COMPLETION_AUDIT_ENABLED = false;
export const DEFAULT_COMPLETION_AUDIT_MAX_ATTEMPTS = 3;
export const MIN_COMPLETION_AUDIT_MAX_ATTEMPTS = 1;
export const MAX_COMPLETION_AUDIT_MAX_ATTEMPTS = 8;

export type CompletionAuditMode = "project" | "chat";

export type CompletionAuditModeSettings = {
  enabled: boolean;
  maxAttempts: number;
};

export type CompletionAuditSettings = {
  project: CompletionAuditModeSettings;
  chat: CompletionAuditModeSettings;
};

export function normalizeCompletionAuditEnabled(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_COMPLETION_AUDIT_ENABLED;
}

export function normalizeCompletionAuditMaxAttempts(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return DEFAULT_COMPLETION_AUDIT_MAX_ATTEMPTS;
  return Math.min(
    MAX_COMPLETION_AUDIT_MAX_ATTEMPTS,
    Math.max(MIN_COMPLETION_AUDIT_MAX_ATTEMPTS, Math.round(raw))
  );
}

export function defaultCompletionAuditSettings(): CompletionAuditSettings {
  return {
    project: {
      enabled: DEFAULT_COMPLETION_AUDIT_ENABLED,
      maxAttempts: DEFAULT_COMPLETION_AUDIT_MAX_ATTEMPTS
    },
    chat: {
      enabled: DEFAULT_COMPLETION_AUDIT_ENABLED,
      maxAttempts: DEFAULT_COMPLETION_AUDIT_MAX_ATTEMPTS
    }
  };
}

function normalizeCompletionAuditModeSettings(
  value: unknown,
  fallbackEnabled?: boolean,
  fallbackAttempts?: number
): CompletionAuditModeSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const hasEnabled = Object.prototype.hasOwnProperty.call(source, "enabled");
  const hasAttempts = Object.prototype.hasOwnProperty.call(source, "maxAttempts");
  return {
    enabled: hasEnabled
      ? normalizeCompletionAuditEnabled(source.enabled)
      : fallbackEnabled ?? DEFAULT_COMPLETION_AUDIT_ENABLED,
    maxAttempts: hasAttempts
      ? normalizeCompletionAuditMaxAttempts(source.maxAttempts)
      : fallbackAttempts ?? DEFAULT_COMPLETION_AUDIT_MAX_ATTEMPTS
  };
}

export function normalizeCompletionAuditSettings(input?: {
  completionAudit?: unknown;
  completionAuditEnabled?: unknown;
  completionAuditMaxAttempts?: unknown;
} | null): CompletionAuditSettings {
  const nested = input?.completionAudit;
  const hasNested = Boolean(nested && typeof nested === "object" && !Array.isArray(nested));
  const legacyEnabled = !hasNested && input && Object.prototype.hasOwnProperty.call(input, "completionAuditEnabled")
    ? normalizeCompletionAuditEnabled(input.completionAuditEnabled)
    : undefined;
  const legacyAttempts = !hasNested && input && Object.prototype.hasOwnProperty.call(input, "completionAuditMaxAttempts")
    ? normalizeCompletionAuditMaxAttempts(input.completionAuditMaxAttempts)
    : undefined;
  const source = hasNested ? nested as Record<string, unknown> : {};
  return {
    project: normalizeCompletionAuditModeSettings(source.project, legacyEnabled, legacyAttempts),
    chat: normalizeCompletionAuditModeSettings(source.chat, legacyEnabled, legacyAttempts)
  };
}

export function resolveCompletionAuditModeSettings(
  settings: CompletionAuditSettings | undefined,
  mode: CompletionAuditMode
): CompletionAuditModeSettings {
  return normalizeCompletionAuditSettings({ completionAudit: settings })[mode];
}

export interface AppConfig {
  defaultModel: string;
  defaultProvider: string;
  responseTone: ResponseTone;
  reasoningEffort: GptReasoningEffort;
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
    browserOpenMode: BrowserOpenMode;
    silentBrowserOpen: boolean;
    liveEditPreview: boolean;
    llmLogViewer: boolean;
    /**
     * Ask the model for a distilled thread title after the first message. The
     * rule-based fallback title is written immediately either way.
     */
    autoTitleGeneration: boolean;
    completionAudit: CompletionAuditSettings;
    /**
     * Default sandbox for ordinary chats. Opening a project always promotes
     * to workspace-write unless this is full-access. Secrets stay denied.
     */
    sandboxMode: SandboxMode;
    /** When false, shell commands with outbound traits cannot auto-run. */
    sandboxNetworkAccess: boolean;
  };
  multiAgent: MultiAgentSettings;
  selfImprovement: SelfImprovementSettings;
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
  /** The provider returned an off-protocol response and needs a JSON tool-protocol retry. */
  requestTextToolProtocol?: boolean;
  reasoningSummary?: string;
  /** Opaque Responses API reasoning item required for a later tool-result request. */
  responseReasoningItem?: unknown;
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
  bundleExists?: boolean;
}

export interface ProviderTurnInput {
  systemPrompt: string;
  transcript: Array<{
    role: MessageRole;
    content: string;
    attachments?: MessageAttachment[];
    /** Transient metadata used to correlate native tool calls and results. */
    toolCalls?: RuntimeToolCall[];
    /** Internal reasoning echoed back to providers that require it for tool turns. */
    reasoningContent?: string;
    /** Opaque Responses API reasoning item retained until its tool calls receive results. */
    responseReasoningItem?: unknown;
    toolCallId?: string;
    toolResultOk?: boolean;
  }>;
  availableTools: ToolSpecDefinition[];
  model: ModelProfile;
  provider: ProviderDefinition;
  reasoningEffort?: ReasoningEffort;
  /** Use the JSON decision envelope instead of provider-native function calls. */
  forceTextToolProtocol?: boolean;
  stream?: boolean;
  onTextDelta?: (delta: string) => void | Promise<void>;
  /** Reports provider reasoning text as it is received from a streaming response. */
  onReasoningDelta?: (delta: string) => void | Promise<void>;
  /** Reports a native tool call as soon as its name is streamed by the provider. */
  onToolCallPreparing?: (toolCall: {
    name: string;
    argumentsJson?: string;
  }) => void | Promise<void>;
  onRequestMeasured?: (measurement: {
    requestBytes: number;
    maxRequestBytes: number;
    targetRequestBytes: number;
    maxTools: number;
    toolCount: number;
  }) => void | Promise<void>;
  onProviderTrace?: (trace: {
    phase: "request" | "response" | "error";
    payload: Record<string, unknown>;
  }) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

export type AssistantDraftPhase = "generating" | "validating" | "auditing" | "retrying";

export interface RuntimeEvent {
  type:
    | "thread.updated"
    | "message.created"
    | "assistant.draft.updated"
    | "assistant.completed"
    | "assistant.execution_output"
    | "agent.retrying"
    | "agent.awaiting_model"
    | "agent.watchdog"
    | "agent.tool_call_preparing"
    | "agent.context_compacted"
    | "agent.context_measured"
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
    | "memory.updated"
    | "browser.updated"
    | "browser.verification_started"
    | "browser.assertion_completed"
    | "browser.screenshot_attached"
    | "browser.verification_completed"
    | "gpa.updated"
    | "model.capability.updated"
    | "terminal.output"
    | "runtime.log";
  threadId?: string;
  /** Root task used by global notifications while preserving the event's subject thread. */
  notificationThreadId?: string;
  /** Child task that produced the event when notifications are routed to its root task. */
  notificationChildThreadId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeLogEntry {
  timestamp: string;
  kind: string;
  threadId?: string;
  payload: Record<string, unknown>;
}

export interface RuntimeLogPage {
  entries: RuntimeLogEntry[];
  total: number;
  hasMore: boolean;
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

export interface PendingResumeThread {
  threadId: string;
  title: string;
  interruptedAt: string;
  lastUserMessage: string;
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

export interface ContextSegmentUsage {
  id: "system" | "tools" | "conversation" | "capsules" | "output_reserve";
  tokens: number;
}

export interface ContextMeasurementRecord {
  turnRunId: string;
  modelId: string;
  providerId: string;
  contextWindow: number;
  maxInputTokens: number;
  estimatedInputTokens: number;
  outputReserveTokens: number;
  requestBytes?: number;
  maxRequestBytes?: number;
  targetRequestBytes?: number;
  maxTools?: number;
  toolCount?: number;
  segments: ContextSegmentUsage[];
  createdAt: string;
}

export interface RuntimePromptBundle {
  systemPrompt: string;
  skillContext: AvailableSkillsContext | null;
  knowledgeContext: string | null;
  workflowPackContext?: string | null;
}

export interface RuntimeThreadSnapshotCursor {
  observedAt: string;
  messageCount: number;
  toolCallCount: number;
  artifactCount: number;
}

export interface RuntimeThreadSnapshot {
  snapshotMode?: "full" | "delta";
  snapshotCursor?: RuntimeThreadSnapshotCursor;
  thread: ThreadRecord;
  messages: MessageRecord[];
  /** Total persisted messages for the thread, including those omitted from delta payloads. */
  messageCount: number;
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
  toolCalls: ToolCallSummary[];
  contextCompaction: ContextCompactionRecord | null;
  contextMeasurement?: ContextMeasurementRecord | null;
  gpa: GpaState | null;
  subagents: ThreadRecord[];
  /** Result envelopes preserve interrupted/queued states and terminal summaries for the parent task UI. */
  subagentResults: SubagentResultEnvelope[];
  queuedSubagentIds: string[];
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
  /**
   * 该文件的逐行差异被主动省略（仓库变更过多，或这个文件差异本身过大）。
   * 此时 stagedHunks / unstagedHunks 为空数组，但 additions / deletions 仍然可用。
   */
  diffOmitted?: boolean;
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
  branches: string[];
  localBranches?: string[];
  remoteBranches?: string[];
  canCreatePullRequest: boolean;
  files: GitFileChange[];
  /**
   * true = 本次快照没有解析逐行差异（变更文件数超过闸门，或 diff 输出体积过大）。
   * 文件列表、状态、增删行数仍然完整，只是不含 hunks。
   */
  diffOmitted?: boolean;
  /** 逐行差异被省略的文件数量（= files.length，放在这里方便界面直接展示）。 */
  diffOmittedFiles?: number;
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

/** Instant-messaging targets a task result can be shared to. */
export type ShareTarget = "wechat" | "dingtalk";

/**
 * How the share text is rendered. WeChat has no markdown rendering, so its
 * payload is plain text; DingTalk renders markdown.
 */
export type ShareFormat = "text" | "markdown";

/** Which part of a task is shared: only the final answer, or every answer. */
export type ShareScope = "final" | "all";

/** How the target client will be brought to the foreground. */
export type ShareLaunchMethod = "app-path" | "protocol" | "unavailable";

export interface ShareTargetStatus {
  target: ShareTarget;
  label: string;
  available: boolean;
  launchMethod: ShareLaunchMethod;
  /** Absolute path of the detected client executable, when one was found. */
  appPath: string | null;
}

export interface ShareSendRequest {
  target: ShareTarget;
  /** Fully composed share body. The renderer owns composition so the shared
   *  text matches what the user sees in the transcript. */
  text: string;
}

export interface ShareSendResult {
  ok: boolean;
  target: ShareTarget;
  format: ShareFormat;
  /** Whether the payload reached the system clipboard. */
  copied: boolean;
  /** Whether the client was brought to the foreground. */
  launched: boolean;
  launchMethod: ShareLaunchMethod;
  /** Human readable outcome used for the in-app notice. */
  message: string;
}

/* ------------------------------------------------------------------------- */
/* Formatted task sharing (rendered conversation image)                       */
/* ------------------------------------------------------------------------- */

/**
 * One conversation turn as offered by the share panel's range picker: the user
 * prompt plus every assistant answer it produced.
 */
export interface ShareTurnSummary {
  id: string;
  /** First line of the user prompt, used as the picker row label. */
  prompt: string;
  createdAt: string;
  /** Assistant answers carrying prose in this turn. */
  answerCount: number;
  /** Characters of shareable content in this turn. */
  charCount: number;
}

/** Delivery channel chosen in the share panel. */
export type ShareChannel = "wechat" | "dingtalk" | "copyImage" | "saveImage" | "copyMarkdown";

/** A conversation image rendered by the renderer. */
export interface ShareImagePayload {
  /** `data:image/png;base64,...` */
  dataUrl: string;
  /** Pixel width of the encoded image (already scaled for crispness). */
  width: number;
  /** Pixel height of the encoded image (already scaled for crispness). */
  height: number;
  /** Decoded PNG size in bytes. */
  bytes: number;
}

/** Headline statistics shown above the shared conversation. */
export interface ShareTaskStats {
  conversations: number;
  toolCalls: number;
  files: number;
}

export interface ShareImageRequest {
  channel: ShareChannel;
  /** Rendered conversation image. Absent for the `copyMarkdown` channel. */
  image?: ShareImagePayload;
  /** Markdown fallback written next to the image, so a paste target that
   *  refuses images still receives readable content. */
  markdown: string;
  /** Base file name (without extension) offered by the `saveImage` channel. */
  fileName?: string;
}

export interface ShareImageResult {
  ok: boolean;
  channel: ShareChannel;
  /** Whether the payload reached the system clipboard. */
  copied: boolean;
  /** Whether the target client was brought to the foreground. */
  launched: boolean;
  launchMethod: ShareLaunchMethod;
  /** Absolute path written by the `saveImage` channel. */
  savedPath: string | null;
  /** True when the user dismissed the save dialog. */
  cancelled: boolean;
  /** Human readable outcome used for the in-app notice. */
  message: string;
}
