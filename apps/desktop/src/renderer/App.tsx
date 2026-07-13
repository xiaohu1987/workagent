import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import "./timeline.css";
import type {
  AppConfig,
  ApprovalRequest,
  ArtifactRecord,
  GpaStage,
  GpaState,
  KnowledgeBaseSummary,
  KnowledgeDocumentRecord,
  KnowledgeScope,
  MessageAttachment,
  MessageRecord,
  McpServerConfig,
  ModelProfile,
  QueuedMessageRecord,
  PluginRecord,
  ProviderDefinition,
  ProviderType,
  RuntimeThreadSnapshot,
  SkillMetadata,
  ThreadRecord,
  ToolCallRecord,
  UserInputPrompt
} from "@shared-types";
import {
  canDeleteThread,
  getComposerPrimaryActionState,
  getDeleteThreadBlockedMessage,
  getHistoryItemAffordance,
  isThreadExecutionInProgress
} from "./thread-ui-state";

type SettingsTab = "general" | "knowledge" | "provider" | "multimodal" | "skills" | "agent" | "mcp" | "update";
type RightWorkspaceTab = "preview" | "terminal" | "browser" | "files";
type ResizePane = "sidebar" | "right-workspace";

type UpdateState = {
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";
  currentVersion: string;
  remoteVersion?: string;
  changelog?: string;
  downloadUrl?: string;
  insecureTransport?: boolean;
  missingSha256?: boolean;
  progress?: number;
  error?: string;
  isPackaged: boolean;
};

type ProjectFileEntry = {
  path: string;
  kind: "file" | "directory";
  size?: number;
};

type ProjectFileTreeNode = {
  path: string;
  name: string;
  kind: "file" | "directory";
  children: ProjectFileTreeNode[];
};

type PreviewCacheEntry = {
  content: string;
  truncated: boolean;
};

type ComposerAttachment =
  | { id: string; kind: "file" | "folder" | "image"; path: string; label: string; file?: File; previewUrl?: string }
  | { id: string; kind: "code"; path: string; content: string; label: string; intent: "reference" | "edit" }
  | { id: string; kind: "skill"; skillId: string; label: string; description: string }
  | { id: string; kind: "mcp"; serverId: string; label: string; description: string };

type ComposerAttachmentInput =
  | { kind: "file" | "folder" | "image"; path: string; label: string; file?: File; previewUrl?: string }
  | { kind: "code"; path: string; content: string; label: string; intent: "reference" | "edit" }
  | { kind: "skill"; skillId: string; label: string; description: string }
  | { kind: "mcp"; serverId: string; label: string; description: string };

type ComposerBinaryAttachment = {
  id: string;
  kind: "file" | "image";
  path: string;
  label: string;
  file?: File;
  previewUrl?: string;
};

type BrowserWebviewElement = HTMLElement & {
  getWebContentsId: () => number;
};

type MessageKnowledgeSource = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  sourcePath: string;
  locator?: string;
};

type MessageBrowserSource = {
  title: string;
  url: string;
};

type KnowledgeSourceAttachment = {
  path: string;
  kind: "file" | "folder";
};

type ContextUsageSegment = {
  id: string;
  label: string;
  tokens: number;
  color: string;
};

type ContextUsage = {
  contextWindow: number;
  usedTokens: number;
  percentage: number;
  segments: ContextUsageSegment[];
};

type WorkspaceContextMenuAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

function composerAttachmentKey(attachment: ComposerAttachment | ComposerAttachmentInput): string {
  switch (attachment.kind) {
    case "code":
      return `${attachment.kind}:${attachment.path}:${attachment.content}`;
    case "skill":
      return `${attachment.kind}:${attachment.skillId}`;
    case "mcp":
      return `${attachment.kind}:${attachment.serverId}`;
    default:
      return `${attachment.kind}:${attachment.path}`;
  }
}

type TerminalWorkspaceTab = {
  id: string;
  title: string;
};

type TerminalSessionState = {
  output: string;
  cwd: string;
  shell: string;
};

type WelcomeCard = {
  id: string;
  title: string;
  prompt: string;
  accentClass: string;
  icon: ReactNode;
};

type ProviderTypeOption = {
  value: ProviderType;
  label: string;
};

type ComposerSelectOption = {
  value: string;
  label: string;
};

type ChatEventType =
  | "commentary"
  | "tool_call"
  | "tool_result"
  | "file_view"
  | "file_change"
  | "test_result"
  | "final";

type ChatEventBlock = {
  type: ChatEventType;
  title?: string;
  content: string;
  name?: string;
  status?: string;
  path?: string;
  action?: string;
  startLine?: number;
  durationMs?: number;
  exitCode?: number;
  ok?: boolean;
};

type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "code"; language?: string; content: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

type AppNoticeTone = "success" | "warning";

type AppNotice = {
  id: number;
  title: string;
  message?: string;
  tone: AppNoticeTone;
};

type ModelTestResult = {
  latencyMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  agentCapability: "verified" | "unsupported";
  agentCapabilityReason?: string;
};

type TimelineEntry =
  | { kind: "message"; id: string; createdAt: string; message: MessageRecord }
  | { kind: "tool"; id: string; createdAt: string; toolCall: ToolCallRecord }
  | { kind: "file-summary"; id: string; createdAt: string; files: FileChangeSummaryItem[] }
  | { kind: "directory-read-group"; id: string; createdAt: string; directory: string; count: number };

type FileChangeAction = "created" | "modified" | "deleted";

type FileChangeSummaryItem = {
  path: string;
  absolutePath?: string;
  action: FileChangeAction;
  additions: number;
  deletions: number;
  kind?: "generated-image" | "generated-video" | "patch";
  description?: string;
};

type ConversationTurnItem = {
  id: string;
  content: string;
  createdAt: string;
  files: FileChangeSummaryItem[];
};

type StreamingAssistant = {
  threadId: string;
  turnRunId: string;
  content: string;
  completed: boolean;
  messageId?: string;
};

type ActiveToolCall = {
  threadId: string;
  toolCallId: string;
  toolName: string;
};

type RuntimeProgress = {
  threadId: string;
  phase: "preparing" | "thinking" | "generating" | "tool";
  runtimeObserved: boolean;
};

type RuntimeActivityEntry =
  | { id: string; kind: "status"; label: string; createdAt: string }
  | { id: string; kind: "output"; label: string; content: string; createdAt: string }
  | { id: string; kind: "tool"; toolCall: ToolCallRecord };

type RuntimeActivity = {
  threadId: string;
  entries: RuntimeActivityEntry[];
};

type McpRuntimeServer = McpServerConfig & {
  status: { state: "idle" | "connecting" | "connected" | "error" | "disabled"; error?: string };
};

type HistorySearchResult = {
  thread: ThreadRecord;
  snippet: string | null;
  score: number;
};

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; hint: string }> = [
  { id: "provider", label: "供应商设置", hint: "供应商、调用地址、密钥与模型列表" },
  { id: "multimodal", label: "多模态", hint: "配置生图模型与视频模型" },
  { id: "skills", label: "Skill 管理", hint: "已加载技能与来源范围" },
  { id: "mcp", label: "MCP 管理", hint: "已配置的 MCP 服务" },
  { id: "knowledge", label: "知识库", hint: "导入、绑定和 OKF Bundle" },
  { id: "update", label: "更新", hint: "检查、下载和安装 CodeXH 更新" }
];

const WELCOME_CARDS: WelcomeCard[] = [
  {
    id: "explore",
    title: "探索并理解代码",
    prompt: "请先帮我梳理这个项目的结构、关键模块和启动方式。",
    accentClass: "blue",
    icon: <IconExplore />
  },
  {
    id: "build",
    title: "构建新功能、应用或工具",
    prompt: "请根据当前项目结构继续实现新功能，并给出关键修改点。",
    accentClass: "violet",
    icon: <IconBuild />
  },
  {
    id: "review",
    title: "审查代码并提出修改建议",
    prompt: "请审查当前项目代码，优先指出问题、风险和建议修复方案。",
    accentClass: "green",
    icon: <IconReview />
  },
  {
    id: "fix",
    title: "修复问题和失败",
    prompt: "请帮我定位当前项目的问题，并直接修复启动或运行失败的原因。",
    accentClass: "orange",
    icon: <IconFix />
  }
];

const PROVIDER_TYPE_OPTIONS: ProviderTypeOption[] = [
  { value: "openai-compatible", label: "OpenAI Chat Completions" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama", label: "Ollama" },
  { value: "vllm", label: "vLLM" },
  { value: "gateway", label: "Gateway" },
  { value: "mock", label: "Mock Provider" }
];

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_RIGHT_WORKSPACE_WIDTH = 300;
const MAX_RIGHT_WORKSPACE_WIDTH = 720;
const MIN_CHAT_WIDTH = 380;

function getStoredPanelWidth(key: string, fallback: number, minimum: number, maximum: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
  } catch {
    return fallback;
  }
}

function clampPanelWidth(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.min(Math.max(value, minimum), maximum));
}

export function App() {
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    getStoredPanelWidth("codexh.sidebar-width", 288, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  );
  const [rightWorkspaceWidth, setRightWorkspaceWidth] = useState(() =>
    getStoredPanelWidth("codexh.right-workspace-width", 410, MIN_RIGHT_WORKSPACE_WIDTH, MAX_RIGHT_WORKSPACE_WIDTH)
  );
  const [resizingPane, setResizingPane] = useState<ResizePane | null>(null);
  const [rightWorkspaceTab, setRightWorkspaceTab] = useState<RightWorkspaceTab>("files");
  const [terminalTabsByThread, setTerminalTabsByThread] = useState<Record<string, TerminalWorkspaceTab[]>>({});
  const [activeTerminalTabByThread, setActiveTerminalTabByThread] = useState<Record<string, string>>({});
  const [terminalInputsByThread, setTerminalInputsByThread] = useState<Record<string, Record<string, string>>>({});
  const [terminalSessionsByThread, setTerminalSessionsByThread] = useState<
    Record<string, Record<string, TerminalSessionState>>
  >({});
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [previewTabsByThread, setPreviewTabsByThread] = useState<Record<string, string[]>>({});
  const [activePreviewPathByThread, setActivePreviewPathByThread] = useState<Record<string, string | null>>({});
  const [projectFilePreviewsByThread, setProjectFilePreviewsByThread] = useState<
    Record<string, Record<string, PreviewCacheEntry | null>>
  >({});
  const [isProjectFilesLoading, setIsProjectFilesLoading] = useState(false);
  const selectedThreadIdRef = useRef<string | null>(null);
  const pendingUserMessagesRef = useRef<Record<string, MessageRecord[]>>({});
  const snapshotRequestIdsRef = useRef<Record<string, number>>({});
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeThreadSnapshot | null>(null);
  const [streamingAssistants, setStreamingAssistants] = useState<Record<string, StreamingAssistant>>({});
  const [activeToolCall, setActiveToolCall] = useState<ActiveToolCall | null>(null);
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null);
  const [runtimeActivities, setRuntimeActivities] = useState<Record<string, RuntimeActivity>>({});
  const [expandedRuntimeThreads, setExpandedRuntimeThreads] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [isHistorySearchOpen, setIsHistorySearchOpen] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySearchResults, setHistorySearchResults] = useState<HistorySearchResult[]>([]);
  const [isHistorySearchLoading, setIsHistorySearchLoading] = useState(false);
  const [historyContextMenu, setHistoryContextMenu] = useState<{ x: number; y: number; thread: ThreadRecord } | null>(null);
  const [editingUserMessage, setEditingUserMessage] = useState<{ id: string; content: string } | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [isContextReportOpen, setIsContextReportOpen] = useState(false);
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [gpaState, setGpaState] = useState<GpaState>({
    stage: "off",
    fullAccess: false,
    knowledgeEnabled: false,
    awaitingConfirmation: null,
    planTasks: [],
    updatedAt: ""
  });
  const [gpaComposerSelected, setGpaComposerSelected] = useState(false);
  const [gpaMenuOpen, setGpaMenuOpen] = useState(false);
  const [composerAddMenuView, setComposerAddMenuView] = useState<"root" | "skills" | "mcp">("root");
  const [gpaMenuPos, setGpaMenuPos] = useState<{ left: number; top: number } | null>(null);
  const gpaAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerAddMenuCloseTimerRef = useRef<number | null>(null);
  const [gpaRevisionOpen, setGpaRevisionOpen] = useState(false);
  const [gpaRevisionDraft, setGpaRevisionDraft] = useState("");
  const [gpaRevisionSubmitting, setGpaRevisionSubmitting] = useState(false);
  const gpaRevisionRef = useRef<HTMLTextAreaElement | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<AppConfig | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [mcpRuntimeServers, setMcpRuntimeServers] = useState<McpRuntimeServer[]>([]);
  const [editingMcpServerId, setEditingMcpServerId] = useState<string | null>(null);
  const [testingMcpServerId, setTestingMcpServerId] = useState<string | null>(null);
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, { tools: Array<{ name: string; description: string }>; resources: Array<{ uri: string; name: string }>; resourceTemplates: Array<{ uriTemplate: string; name: string }> }>>({});
  const [settingsProviderId, setSettingsProviderId] = useState<string | null>(null);
  const [providerSecretDrafts, setProviderSecretDrafts] = useState<Record<string, string>>({});
  const [newModelId, setNewModelId] = useState("");
  const [newModelDisplayName, setNewModelDisplayName] = useState("");
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [testingModelKey, setTestingModelKey] = useState<string | null>(null);
  const [modelTestResults, setModelTestResults] = useState<Record<string, ModelTestResult>>({});
  const [fetchedModels, setFetchedModels] = useState<{ id: string; displayName?: string }[]>([]);
  const [showFetchedModels, setShowFetchedModels] = useState(false);
  const [selectedFetchedModelIds, setSelectedFetchedModelIds] = useState<string[]>([]);
  const [fetchedModelsTarget, setFetchedModelsTarget] = useState<"provider">("provider");
  const [multimodalPickerRole, setMultimodalPickerRole] = useState<"reasoning" | "image" | "video" | null>(null);
  const [multimodalPickerSelected, setMultimodalPickerSelected] = useState<string[]>([]);
  const [composerProviderId, setComposerProviderId] = useState("");
  const [composerModelId, setComposerModelId] = useState("");
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceAttachment[]>([]);
  const [knowledgeName, setKnowledgeName] = useState("Imported Knowledge");
  const [knowledgeScope, setKnowledgeScope] = useState<KnowledgeScope>("global");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseSummary[]>([]);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<Record<string, KnowledgeDocumentRecord[]>>({});
  const [knowledgeBusyId, setKnowledgeBusyId] = useState<string | null>(null);
  const [pluginSource, setPluginSource] = useState("https://github.com/obra/superpowers");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProjectCreateOpen, setIsProjectCreateOpen] = useState(false);
  const [projectPathDraft, setProjectPathDraft] = useState("");
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [resolvingPromptId, setResolvingPromptId] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("provider");
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [isNoticeHovered, setIsNoticeHovered] = useState(false);
  const [exitingNoticeId, setExitingNoticeId] = useState<number | null>(null);
  const [isTranscriptAtLatest, setIsTranscriptAtLatest] = useState(true);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [deletingQueuedMessageId, setDeletingQueuedMessageId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatTranscriptRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollRef = useRef<HTMLPreElement | null>(null);
  const shouldAutoScrollRef = useRef(false);
  const pendingLatestScrollThreadIdRef = useRef<string | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollReleaseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    void window.codexh.getUpdateState().then(setUpdateState).catch(() => undefined);
    return window.codexh.onUpdateState(setUpdateState);
  }, []);

  useEffect(() => {
    if (!isHistorySearchOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsHistorySearchLoading(true);
      void window.codexh.searchThreads(historySearchQuery).then((results) => {
        if (!cancelled) setHistorySearchResults(results as HistorySearchResult[]);
      }).catch((error) => {
        if (!cancelled) showNotice("搜索历史对话失败", { message: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        if (!cancelled) setIsHistorySearchLoading(false);
      });
    }, 100);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [historySearchQuery, isHistorySearchOpen]);

  useEffect(() => {
    if (!isHistorySearchOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsHistorySearchOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHistorySearchOpen]);

  useEffect(() => {
    // Do not carry a collapsed/hidden state into a new app session.
    setIsSidebarCollapsed(false);
    setIsTerminalOpen(false);
    setSidebarWidth((current) =>
      current >= MIN_SIDEBAR_WIDTH && current <= MAX_SIDEBAR_WIDTH ? current : 288
    );
    setRightWorkspaceWidth((current) =>
      current >= MIN_RIGHT_WORKSPACE_WIDTH && current <= MAX_RIGHT_WORKSPACE_WIDTH ? current : 410
    );
  }, []);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    window.localStorage.setItem("codexh.sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem("codexh.right-workspace-width", String(rightWorkspaceWidth));
  }, [rightWorkspaceWidth]);

  useEffect(() => {
    if (!resizingPane) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = appShellRef.current?.getBoundingClientRect();
      if (!bounds) {
        return;
      }
      const availableWidth = bounds.width;
      if (resizingPane === "sidebar") {
        const maximum = Math.min(MAX_SIDEBAR_WIDTH, availableWidth - rightWorkspaceWidth - MIN_CHAT_WIDTH - 16);
        setSidebarWidth(clampPanelWidth(event.clientX - bounds.left, MIN_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, maximum)));
      } else {
        const maximum = Math.min(MAX_RIGHT_WORKSPACE_WIDTH, availableWidth - sidebarWidth - MIN_CHAT_WIDTH - 16);
        setRightWorkspaceWidth(clampPanelWidth(bounds.right - event.clientX, MIN_RIGHT_WORKSPACE_WIDTH, Math.max(MIN_RIGHT_WORKSPACE_WIDTH, maximum)));
      }
    };
    const stopResizing = () => setResizingPane(null);
    document.body.classList.add("panel-resizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
    return () => {
      document.body.classList.remove("panel-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
    };
  }, [resizingPane, rightWorkspaceWidth, sidebarWidth]);

  function selectThreadId(nextThreadId: string | null) {
    selectedThreadIdRef.current = nextThreadId;
    setSelectedThreadId(nextThreadId);
  }

  const currentTerminalTabs = selectedThreadId ? terminalTabsByThread[selectedThreadId] ?? [] : [];
  const activeTerminalSessionId = selectedThreadId
    ? activeTerminalTabByThread[selectedThreadId] ?? currentTerminalTabs[0]?.id ?? null
    : null;
  const activeTerminalSession =
    selectedThreadId && activeTerminalSessionId
      ? terminalSessionsByThread[selectedThreadId]?.[activeTerminalSessionId] ?? null
      : null;
  const activeTerminalInput =
    selectedThreadId && activeTerminalSessionId
      ? terminalInputsByThread[selectedThreadId]?.[activeTerminalSessionId] ?? ""
      : "";
  const previewTabs = selectedThreadId ? previewTabsByThread[selectedThreadId] ?? [] : [];
  const selectedProjectFile = selectedThreadId ? activePreviewPathByThread[selectedThreadId] ?? null : null;
  const projectFilePreview =
    selectedThreadId && selectedProjectFile
      ? projectFilePreviewsByThread[selectedThreadId]?.[selectedProjectFile] ?? null
      : null;

  function ensureThreadTerminalTabs(threadId: string) {
    setTerminalTabsByThread((current) => {
      if (current[threadId]?.length) {
        return current;
      }
      return {
        ...current,
        [threadId]: [{ id: "default", title: "终端" }]
      };
    });
    setActiveTerminalTabByThread((current) => (
      current[threadId]
        ? current
        : {
            ...current,
            [threadId]: "default"
          }
    ));
  }

  function setActiveTerminalInput(value: string) {
    if (!selectedThreadId || !activeTerminalSessionId) {
      return;
    }
    setTerminalInputsByThread((current) => ({
      ...current,
      [selectedThreadId]: {
        ...(current[selectedThreadId] ?? {}),
        [activeTerminalSessionId]: value
      }
    }));
  }

  function updateTerminalSessionState(
    threadId: string,
    sessionId: string,
    updater: (current: TerminalSessionState | null) => TerminalSessionState
  ) {
    setTerminalSessionsByThread((current) => ({
      ...current,
      [threadId]: {
        ...(current[threadId] ?? {}),
        [sessionId]: updater(current[threadId]?.[sessionId] ?? null)
      }
    }));
  }

  function openProjectPreview(path: string) {
    if (!selectedThreadId) {
      return;
    }
    setPreviewTabsByThread((current) => {
      const tabs = current[selectedThreadId] ?? [];
      if (tabs.includes(path)) {
        return current;
      }
      return {
        ...current,
        [selectedThreadId]: [...tabs, path]
      };
    });
    setActivePreviewPathByThread((current) => ({
      ...current,
      [selectedThreadId]: path
    }));
    setRightWorkspaceTab("preview");
  }

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }
    ensureThreadTerminalTabs(selectedThreadId);
    setGpaComposerSelected(false);
  }, [selectedThreadId]);

  useEffect(() => {
    if (!gpaMenuOpen) {
      setComposerAddMenuView("root");
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGpaMenuOpen(false);
        setGpaMenuPos(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [gpaMenuOpen]);

  function startRuntimeActivity(threadId: string) {
    const createdAt = new Date().toISOString();
    setRuntimeActivities((current) => ({
      ...current,
      [threadId]: {
        threadId,
        entries: [{ id: `submitted-${createdAt}`, kind: "status", label: "消息已发送，正在准备任务", createdAt }]
      }
    }));
    setExpandedRuntimeThreads((current) => ({ ...current, [threadId]: false }));
  }

  function appendRuntimeStatus(threadId: string, label: string, createdAt = new Date().toISOString()) {
    setRuntimeActivities((current) => {
      const activity = current[threadId] ?? { threadId, entries: [] };
      const last = activity.entries.at(-1);
      if (last?.kind === "status" && last.label === label) return current;
      return {
        ...current,
        [threadId]: {
          ...activity,
          entries: [...activity.entries, { id: `status-${createdAt}-${label}`, kind: "status", label, createdAt }]
        }
      };
    });
  }

  function appendRuntimeOutput(
    threadId: string,
    label: string,
    content: string,
    createdAt = new Date().toISOString()
  ) {
    setRuntimeActivities((current) => {
      const activity = current[threadId] ?? { threadId, entries: [] };
      return {
        ...current,
        [threadId]: {
          ...activity,
          entries: [...activity.entries, { id: `output-${createdAt}`, kind: "output", label, content, createdAt }]
        }
      };
    });
  }

  function upsertRuntimeTool(threadId: string, toolCall: ToolCallRecord) {
    setRuntimeActivities((current) => {
      const activity = current[threadId] ?? { threadId, entries: [] };
      const existingIndex = activity.entries.findIndex((entry) => entry.kind === "tool" && entry.toolCall.id === toolCall.id);
      const entries = existingIndex < 0
        ? [...activity.entries, { id: `tool-${toolCall.id}`, kind: "tool" as const, toolCall }]
        : activity.entries.map((entry, index) => index === existingIndex
          ? { id: entry.id, kind: "tool" as const, toolCall }
          : entry
        );
      return { ...current, [threadId]: { ...activity, entries } };
    });
  }

  function completeRuntimeTool(
    threadId: string,
    toolCallId: string,
    status: Extract<ToolCallRecord["status"], "completed" | "failed">,
    resultJson: string | null,
    completedAt: string
  ) {
    setRuntimeActivities((current) => {
      const activity = current[threadId];
      if (!activity) return current;
      return {
        ...current,
        [threadId]: {
          ...activity,
          entries: activity.entries.map((entry) => entry.kind === "tool" && entry.toolCall.id === toolCallId
            ? { ...entry, toolCall: { ...entry.toolCall, status, resultJson, completedAt } }
            : entry
          )
        }
      };
    });
  }

  function clearRuntimeActivity(threadId: string) {
    setRuntimeActivities((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setExpandedRuntimeThreads((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }

  useEffect(() => {
    const dispose = window.codexh.onRuntimeEvent((event) => {
      const typed = event as {
        threadId?: string;
        type: string;
        createdAt?: string;
        payload?: {
          gpa?: GpaState;
          turnRunId?: string;
          delta?: string;
          content?: string;
          title?: string;
          attempt?: number;
          maxAttempts?: number;
          reason?: string;
          messageId?: string;
          toolCallId?: string;
          toolName?: string;
          argumentsJson?: string;
          resultJson?: string;
          riskLevel?: ToolCallRecord["riskLevel"];
          approvalMode?: ToolCallRecord["approvalMode"];
          status?: ToolCallRecord["status"];
          startedAt?: string;
          completedAt?: string;
          message?: { role?: MessageRecord["role"] };
          thread?: ThreadRecord;
          modelId?: string;
          agentCapability?: ModelProfile["agentCapability"];
          agentCapabilityCheckedAt?: string;
          agentCapabilityReason?: string;
          data?: string;
          sessionId?: string;
        };
      };
      const currentSelectedThreadId = selectedThreadIdRef.current;
      if (typed.type === "terminal.output" && typed.threadId === currentSelectedThreadId) {
        const sessionId = typeof typed.payload?.sessionId === "string" ? typed.payload.sessionId : "default";
        updateTerminalSessionState(currentSelectedThreadId, sessionId, (current) => ({
          output: `${current?.output ?? ""}${typed.payload?.data ?? ""}`.slice(-80_000),
          cwd: current?.cwd ?? "",
          shell: current?.shell ?? "PowerShell"
        }));
        return;
      }
      if (typed.type === "gpa.updated" && typed.payload?.gpa) {
        setGpaState(typed.payload.gpa);
        setGpaComposerSelected(typed.payload.gpa.stage !== "off");
        return;
      }
      if (typed.type === "model.capability.updated" && typed.payload?.modelId) {
        const modelId = typed.payload.modelId;
        const patch = {
          agentCapability: typed.payload.agentCapability,
          agentCapabilityCheckedAt: typed.payload.agentCapabilityCheckedAt,
          agentCapabilityReason: typed.payload.agentCapabilityReason
        };
        const updateCapability = (current: AppConfig | null) => current
          ? {
              ...current,
              models: current.models.map((model) => model.id === modelId ? { ...model, ...patch } : model)
            }
          : current;
        setConfig(updateCapability);
        setConfigDraft(updateCapability);
      }
      if (typed.type === "browser.updated" && typed.threadId === currentSelectedThreadId) {
        setRightWorkspaceTab("browser");
        setIsTerminalOpen(true);
      }
      if (
        typed.type === "tool.started" &&
        typed.threadId &&
        typed.payload?.toolCallId &&
        typed.payload?.toolName
      ) {
        setActiveToolCall({
          threadId: typed.threadId,
          toolCallId: typed.payload.toolCallId,
          toolName: typed.payload.toolName
        });
        upsertRuntimeTool(typed.threadId, {
          id: typed.payload.toolCallId,
          threadId: typed.threadId,
          turnRunId: typeof typed.payload.turnRunId === "string" ? typed.payload.turnRunId : "",
          toolName: typed.payload.toolName,
          argumentsJson: typeof typed.payload.argumentsJson === "string" ? typed.payload.argumentsJson : "{}",
          resultJson: null,
          status: "running",
          riskLevel: typed.payload.riskLevel ?? "medium",
          approvalMode: typed.payload.approvalMode ?? "prompt",
          startedAt: typeof typed.payload.startedAt === "string" ? typed.payload.startedAt : typed.createdAt ?? new Date().toISOString(),
          completedAt: null
        });
        setRuntimeProgress({ threadId: typed.threadId, phase: "tool", runtimeObserved: true });
        return;
      }
      if (typed.type === "tool.completed" && typed.payload?.toolCallId) {
        setActiveToolCall((current) =>
          current?.toolCallId === typed.payload?.toolCallId ? null : current
        );
        if (typed.threadId) {
          const runtimeThreadId = typed.threadId;
          completeRuntimeTool(
            runtimeThreadId,
            typed.payload.toolCallId,
            typed.payload.status === "failed" ? "failed" : "completed",
            typeof typed.payload.resultJson === "string" ? typed.payload.resultJson : null,
            typeof typed.payload.completedAt === "string" ? typed.payload.completedAt : typed.createdAt ?? new Date().toISOString()
          );
          appendRuntimeStatus(runtimeThreadId, "工具已完成，正在整理结果", typed.createdAt);
          setRuntimeProgress((current) =>
            current?.threadId === runtimeThreadId
              ? { ...current, phase: "thinking", runtimeObserved: true }
              : current
          );
        }
        return;
      }
      if (typed.type === "assistant.delta" && typed.threadId && typed.payload?.turnRunId) {
        const threadId = typed.threadId;
        const payload = typed.payload;
        const turnRunId = payload.turnRunId as string;
        setStreamingAssistants((current) => ({
          ...current,
          [turnRunId]: {
            threadId,
            turnRunId,
            content: payload.content ?? "",
            completed: false
          }
        }));
        appendRuntimeStatus(threadId, "正在生成回复", typed.createdAt);
        setRuntimeProgress({ threadId, phase: "generating", runtimeObserved: true });
        return;
      }
      if (typed.type === "assistant.execution_output" && typed.threadId && typed.payload?.content) {
        appendRuntimeOutput(
          typed.threadId,
          typed.payload.title ?? "待整理的模型执行输出",
          typed.payload.content,
          typed.createdAt
        );
        appendRuntimeStatus(typed.threadId, "正在校验并整理结果", typed.createdAt);
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "model_timeout") {
        const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
        const maxAttempts = typeof typed.payload.maxAttempts === "number" ? typed.payload.maxAttempts : 5;
        appendRuntimeStatus(typed.threadId, `模型响应超时，正在重试 (${attempt}/${maxAttempts})`, typed.createdAt);
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "message.created" && typed.threadId && typed.payload?.message?.role === "user") {
        const runtimeThreadId = typed.threadId;
        appendRuntimeStatus(runtimeThreadId, "正在理解任务", typed.createdAt);
        setRuntimeProgress((current) =>
          current?.threadId === runtimeThreadId
            ? { ...current, phase: "thinking", runtimeObserved: true }
            : current
        );
      }
      if (typed.type === "thread.updated" && typed.threadId && typed.payload?.thread) {
        const runtimeThreadId = typed.threadId;
        const status = typed.payload.thread.status;
        setRuntimeProgress((current) => {
          if (!current || current.threadId !== runtimeThreadId) return current;
          if (status === "running") return { ...current, phase: "thinking", runtimeObserved: true };
          return current.runtimeObserved ? null : current;
        });
        if (status !== "running") {
          clearRuntimeActivity(runtimeThreadId);
        }
      }
      if (typed.type === "assistant.completed" && typed.payload?.turnRunId) {
        const { turnRunId, messageId } = typed.payload;
        setStreamingAssistants((current) => {
          const active = current[turnRunId];
          if (!active) {
            return current;
          }

          return {
            ...current,
            [turnRunId]: {
              ...active,
              completed: true,
              messageId: typeof messageId === "string" ? messageId : undefined
            }
          };
        });
      }
      void refreshThreads();

      if (!typed.threadId || typed.threadId === currentSelectedThreadId) {
        void refreshSnapshot(typed.threadId ?? currentSelectedThreadId);
      }

      if (
        typed.type === "thread.updated" ||
        typed.type === "browser.updated" ||
        typed.type === "knowledge.imported"
      ) {
        void refreshPlugins();
        void refreshSkills();
      }
    });
    return dispose;
  }, []);

  useEffect(() => {
    if (!isTerminalOpen || !selectedThreadId || rightWorkspaceTab !== "terminal" || !activeTerminalSessionId) {
      return;
    }

    let cancelled = false;

    void window.codexh.openTerminal({ threadId: selectedThreadId, sessionId: activeTerminalSessionId }).then((terminal) => {
      if (cancelled || selectedThreadIdRef.current !== selectedThreadId) {
        return;
      }
      updateTerminalSessionState(selectedThreadId, activeTerminalSessionId, (current) => ({
        output: terminal.output.length >= (current?.output.length ?? 0) ? terminal.output : (current?.output ?? ""),
        cwd: terminal.cwd,
        shell: terminal.shell
      }));
    }).catch((error: unknown) => {
      if (!cancelled) {
        updateTerminalSessionState(selectedThreadId, activeTerminalSessionId, (current) => ({
          output: `Terminal error: ${error instanceof Error ? error.message : String(error)}\n`,
          cwd: current?.cwd ?? "",
          shell: current?.shell ?? "PowerShell"
        }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeTerminalSessionId, isTerminalOpen, rightWorkspaceTab, selectedThreadId]);

  useEffect(() => {
    const node = terminalScrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [activeTerminalSession?.output]);

  useEffect(() => {
    if (!isTerminalOpen || !selectedThreadId || (rightWorkspaceTab !== "preview" && rightWorkspaceTab !== "files")) {
      return;
    }

    let cancelled = false;
    setIsProjectFilesLoading(true);
    void window.codexh.listProjectFiles(selectedThreadId).then((entries) => {
      if (cancelled || selectedThreadIdRef.current !== selectedThreadId) {
        return;
      }
      setProjectFiles(entries);
      setActivePreviewPathByThread((current) => {
        const nextDefault = entries.find((entry) => entry.kind === "file")?.path ?? null;
        const existing = current[selectedThreadId];
        return {
          ...current,
          [selectedThreadId]:
            existing && entries.some((entry) => entry.path === existing && entry.kind === "file")
              ? existing
              : nextDefault
        };
      });
    }).catch(() => {
      if (!cancelled) {
        setProjectFiles([]);
        setActivePreviewPathByThread((current) => ({
          ...current,
          [selectedThreadId]: null
        }));
      }
    }).finally(() => {
      if (!cancelled) {
        setIsProjectFilesLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isTerminalOpen, rightWorkspaceTab, selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId || !selectedProjectFile) {
      return;
    }

    let cancelled = false;
    setProjectFilePreviewsByThread((current) => ({
      ...current,
      [selectedThreadId]: {
        ...(current[selectedThreadId] ?? {}),
        [selectedProjectFile]: null
      }
    }));
    void window.codexh.readProjectFile({ threadId: selectedThreadId, path: selectedProjectFile }).then((file) => {
      if (!cancelled && selectedThreadIdRef.current === selectedThreadId) {
        setProjectFilePreviewsByThread((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            [selectedProjectFile]: { content: file.content, truncated: file.truncated }
          }
        }));
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        setProjectFilePreviewsByThread((current) => ({
          ...current,
          [selectedThreadId]: {
            ...(current[selectedThreadId] ?? {}),
            [selectedProjectFile]: {
              content: error instanceof Error ? error.message : String(error),
              truncated: false
            }
          }
        }));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectFile, selectedThreadId]);

  useEffect(() => {
    if (!isSettingsOpen && !isProjectCreateOpen && !notice) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (notice) {
          dismissNotice(notice.id);
          return;
        }

        if (isProjectCreateOpen) {
          setIsProjectCreateOpen(false);
          return;
        }

        setIsSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isProjectCreateOpen, isSettingsOpen, notice]);

  useEffect(() => {
    if (!notice || isNoticeHovered) {
      return;
    }

    const timer = window.setTimeout(
      () => dismissNotice(notice.id),
      notice.tone === "success" ? 3200 : 4200
    );

    return () => window.clearTimeout(timer);
  }, [isNoticeHovered, notice]);

  useEffect(() => {
    if (!notice || exitingNoticeId !== notice.id) return;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current?.id === notice.id ? null : current));
      setExitingNoticeId((current) => current === notice.id ? null : current);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [exitingNoticeId, notice]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );
  const selectedProjectCwd = selectedThread?.mode === "project" ? selectedThread.cwd ?? null : null;

  useEffect(() => {
    if (isSettingsOpen && settingsTab === "skills") {
      void refreshSkills();
    }
  }, [isSettingsOpen, settingsTab, selectedThread?.cwd]);

  useEffect(() => {
    if (isSettingsOpen && settingsTab === "knowledge") void refreshKnowledgeBases();
  }, [isSettingsOpen, settingsTab]);

  const activeSnapshotThreadId = snapshot?.thread.id ?? null;
  const activeSnapshotThreadStatus = snapshot?.thread.status ?? null;
  const pendingApprovals = useMemo(
    () => (snapshot?.approvals ?? []).filter((item) => item.status === "pending"),
    [snapshot]
  );
  const pendingPrompts = useMemo(
    () => (snapshot?.prompts ?? []).filter((item) => item.status === "pending"),
    [snapshot]
  );
  const userInputPrompts = snapshot?.prompts ?? [];
  const canImportProjectKnowledge = selectedThread?.mode === "project" && !!selectedThread.cwd;
  const workflowBindings = snapshot?.projectPlugins ?? [];
  const selectedThreadStatus = activeSnapshotThreadStatus ?? selectedThread?.status ?? null;
  const selectedMessages = snapshot?.messages ?? [];
  const queuedMessages = snapshot?.queuedMessages ?? [];
  const visibleMessages = useMemo(
    () => filterTranscriptMessages(selectedMessages, activeSnapshotThreadStatus),
    [activeSnapshotThreadStatus, selectedMessages]
  );
  const timelineEntries = useMemo(
    () => buildTimelineEntries(visibleMessages, snapshot?.toolCalls ?? [], snapshot?.artifacts ?? [], selectedThread?.cwd, selectedThreadStatus),
    [selectedThread?.cwd, selectedThreadStatus, snapshot?.artifacts, snapshot?.toolCalls, visibleMessages]
  );
  const conversationTurns = useMemo(
    () => buildConversationTurnItems(visibleMessages, snapshot?.toolCalls ?? [], selectedThread?.cwd),
    [selectedThread?.cwd, snapshot?.toolCalls, visibleMessages]
  );
  const activeStreamingAssistant = useMemo(
    () =>
      Object.values(streamingAssistants)
        .filter(
          (entry) =>
            entry.threadId === activeSnapshotThreadId &&
            entry.content &&
            !isPatchAssistantMessage(entry.content)
        )
        .sort((left, right) => left.turnRunId.localeCompare(right.turnRunId))
        .at(-1) ?? null,
    [activeSnapshotThreadId, streamingAssistants]
  );
  const composerPrimaryAction = getComposerPrimaryActionState(
    selectedThreadStatus,
    input.trim() || composerAttachments.length > 0 ? "content" : ""
  );
  const isActiveThreadExecuting = composerPrimaryAction.kind === "interrupt";
  const activeRuntimeThreadId = activeSnapshotThreadId ?? selectedThreadId;
  const localRuntimeProgress = runtimeProgress?.threadId === activeRuntimeThreadId
    ? runtimeProgress
    : null;
  const activeRuntimeActivity = activeRuntimeThreadId ? runtimeActivities[activeRuntimeThreadId] ?? null : null;
  const isRuntimeActivityExpanded = activeRuntimeThreadId ? !!expandedRuntimeThreads[activeRuntimeThreadId] : false;
  const isTaskProcessing = selectedThreadStatus === "running" || !!localRuntimeProgress;
  const isPreparingRuntime = !!localRuntimeProgress && !localRuntimeProgress.runtimeObserved;
  const taskProcessingLabel = useMemo(
    () =>
      activeToolCall?.threadId === activeSnapshotThreadId
        ? getToolProcessingLabel(activeToolCall.toolName)
        : activeStreamingAssistant
          ? "正在生成回复"
          : isPreparingRuntime
            ? "消息已发送，正在准备任务"
            : "正在思考",
    [activeSnapshotThreadId, activeStreamingAssistant, activeToolCall, isPreparingRuntime]
  );
  const workspaceLabel = useMemo(() => getWorkspaceLabel(selectedThread), [selectedThread]);
  const showWelcome = timelineEntries.length === 0;
  const latestVisibleMessageId = timelineEntries[timelineEntries.length - 1]?.id ?? null;
  const settingsProvider = useMemo(() => {
    if (!configDraft) {
      return null;
    }

    return configDraft.providers.find((provider) => provider.id === settingsProviderId) ?? configDraft.providers[0] ?? null;
  }, [configDraft, settingsProviderId]);
  const settingsProviderModels = useMemo(
    () => (configDraft && settingsProvider ? getModelsForProvider(configDraft, settingsProvider.id) : []),
    [configDraft, settingsProvider]
  );
  const composerProviders = useMemo(
    () =>
      config?.providers.filter((provider) => getReasoningModelsForProvider(config, provider.id).length > 0) ?? [],
    [config]
  );
  const composerModels = useMemo(
    () => (config ? getReasoningModelsForProvider(config, composerProviderId) : []),
    [config, composerProviderId]
  );
  const selectedComposerModel = useMemo(
    () => composerModels.find((model) => model.id === composerModelId) ?? null,
    [composerModelId, composerModels]
  );
  const composerSupportsMultimodalInput = selectedComposerModel?.supportsMultimodalInput ?? false;
  const composerSupportsAgentTools =
    selectedComposerModel?.supportsToolCalling === true &&
    selectedComposerModel.agentCapability !== "unsupported";
  const composerProviderOptions = useMemo<ComposerSelectOption[]>(
    () =>
      composerProviders.map((provider) => ({
        value: provider.id,
        label: getProviderDisplayName(provider)
      })),
    [composerProviders]
  );
  const composerModelOptions = useMemo<ComposerSelectOption[]>(
    () =>
      composerModels.map((model) => ({
        value: model.id,
        label: model.displayName === model.id ? model.id : `${model.displayName} (${model.id})`
      })),
    [composerModels]
  );
  const composerModelGroups = useMemo(
    () =>
      config
        ? composerProviders.map((provider) => ({
            providerId: provider.id,
            providerLabel: getProviderDisplayName(provider),
            models: getReasoningModelsForProvider(config, provider.id).map((model) => ({
              id: model.id,
              label: model.displayName === model.id ? model.id : `${model.displayName} (${model.id})`,
              supportsMultimodalInput: model.supportsMultimodalInput
            }))
          }))
        : [],
    [composerProviders, config]
  );
  const currentModelTriggerLabel = useMemo(() => {
    const providerLabel = composerProviders.find((provider) => provider.id === composerProviderId)
      ? getProviderDisplayName(composerProviders.find((provider) => provider.id === composerProviderId)!)
      : null;
    const modelLabel = composerModelOptions.find((option) => option.value === composerModelId)?.label ?? null;
    if (providerLabel && modelLabel) {
      return `${providerLabel} · ${modelLabel}`;
    }
    return modelLabel ?? providerLabel ?? "选择模型";
  }, [composerModelOptions, composerProviderId, composerProviders, composerModelId]);
  const activeAssistantLabel = useMemo(() => {
    if (!config) {
      return "Assistant";
    }

    const targetProviderId = selectedThread?.providerId ?? composerProviderId ?? config.defaultProvider;
    const targetModelId = selectedThread?.modelId ?? composerModelId ?? config.defaultModel;
    const targetModel =
      config.models.find((model) => model.id === targetModelId && model.providerId === targetProviderId) ??
      config.models.find((model) => model.id === targetModelId) ??
      null;

    if (!targetModel) {
      return targetModelId || "Assistant";
    }

    return targetModel.displayName?.trim() || targetModel.id;
  }, [config, composerModelId, composerProviderId, selectedThread]);
  const contextUsage = useMemo(() => {
    const targetProviderId = selectedThread?.providerId ?? composerProviderId ?? config?.defaultProvider;
    const targetModelId = selectedThread?.modelId ?? composerModelId ?? config?.defaultModel;
    const contextWindow =
      config?.models.find((model) => model.id === targetModelId && model.providerId === targetProviderId)?.contextWindow ??
      config?.models.find((model) => model.id === targetModelId)?.contextWindow ??
      128_000;
    return buildContextUsage({
      contextWindow,
      messages: selectedMessages,
      toolCalls: snapshot?.toolCalls ?? [],
      gpaStage: gpaState.stage,
      selectedSkillCount: selectedThread?.selectedSkillIds.length ?? 0,
      mcpServerCount: config?.mcpServers.length ?? 0,
      pendingInput: `${input}\n${formatComposerAttachments(composerAttachments)}`
    });
  }, [composerAttachments, composerModelId, composerProviderId, config, gpaState.stage, input, selectedMessages, selectedThread, snapshot?.toolCalls]);
  const settingsTitle = useMemo(() => {
    switch (settingsTab) {
      case "provider":
        return "模型提供商";
      case "multimodal":
        return "多模态模型";
      case "skills":
        return "Skill 管理";
      case "mcp":
        return "MCP 管理";
      case "knowledge":
        return "知识库";
      case "update":
        return "应用更新";
      default:
        return "设置";
    }
  }, [settingsTab]);

  function cancelPendingAutoScrollFrame() {
    if (autoScrollFrameRef.current === null) {
      return;
    }

    window.cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = null;
  }

  function clearAutoScrollReleaseTimer() {
    if (autoScrollReleaseTimerRef.current === null) {
      return;
    }

    window.clearTimeout(autoScrollReleaseTimerRef.current);
    autoScrollReleaseTimerRef.current = null;
  }

  function settleAutoScroll(status: ThreadRecord["status"] | null) {
    if (isThreadExecutionInProgress(status)) {
      clearAutoScrollReleaseTimer();
      return;
    }

    clearAutoScrollReleaseTimer();
    autoScrollReleaseTimerRef.current = window.setTimeout(() => {
      autoScrollReleaseTimerRef.current = null;
      shouldAutoScrollRef.current = false;
    }, 320);
  }

  function scrollTranscriptToLatest(behavior: ScrollBehavior = "auto") {
    const node = chatScrollRef.current;
    if (!node) {
      return;
    }

    shouldAutoScrollRef.current = true;
    setIsTranscriptAtLatest(true);
    cancelPendingAutoScrollFrame();
    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      node.scrollTo({
        top: node.scrollHeight,
        left: 0,
        behavior
      });
    });
  }

  function handleTranscriptScroll() {
    const node = chatScrollRef.current;
    if (!node) {
      return;
    }

    const atLatest = node.scrollHeight - node.scrollTop - node.clientHeight <= 48;
    shouldAutoScrollRef.current = atLatest;
    setIsTranscriptAtLatest((current) => current === atLatest ? current : atLatest);
  }

  useEffect(() => {
    return () => {
      cancelPendingAutoScrollFrame();
      clearAutoScrollReleaseTimer();
    };
  }, []);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    setStreamingAssistants((current) => {
      let changed = false;
      const next = { ...current };

      for (const [turnRunId, entry] of Object.entries(current)) {
        if (entry.threadId !== snapshot.thread.id) {
          continue;
        }

        const persisted = entry.messageId
          ? snapshot.messages.some((message) => message.id === entry.messageId)
          : snapshot.messages.some(
              (message) => message.role === "assistant" && message.turnRunId === turnRunId
            );
        const turnFinished = !isThreadExecutionInProgress(snapshot.thread.status);
        if ((entry.completed && persisted) || (turnFinished && !persisted)) {
          delete next[turnRunId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [snapshot]);

  useEffect(() => {
    if (!showWelcome) {
      return;
    }

    cancelPendingAutoScrollFrame();
    clearAutoScrollReleaseTimer();
    chatScrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [activeSnapshotThreadId, showWelcome]);

  useLayoutEffect(() => {
    if (showWelcome) {
      setIsTranscriptAtLatest(true);
      return;
    }

    if (!shouldAutoScrollRef.current) {
      handleTranscriptScroll();
    }
  }, [activeSnapshotThreadId, latestVisibleMessageId, showWelcome]);

  useLayoutEffect(() => {
    if (!activeSnapshotThreadId || pendingLatestScrollThreadIdRef.current !== activeSnapshotThreadId) {
      return;
    }

    pendingLatestScrollThreadIdRef.current = null;
    if (showWelcome) {
      return;
    }

    shouldAutoScrollRef.current = true;
    scrollTranscriptToLatest();
    settleAutoScroll(activeSnapshotThreadStatus);
  }, [activeSnapshotThreadId, activeSnapshotThreadStatus, latestVisibleMessageId, showWelcome]);

  useEffect(() => {
    if (showWelcome) {
      return;
    }

    const shouldAutoScroll = shouldAutoScrollRef.current;
    if (!shouldAutoScroll) {
      return;
    }

    if (!chatScrollRef.current) {
      return;
    }

    scrollTranscriptToLatest("smooth");
    settleAutoScroll(activeSnapshotThreadStatus);
  }, [activeSnapshotThreadId, activeSnapshotThreadStatus, latestVisibleMessageId, showWelcome, visibleMessages.length]);

  useEffect(() => {
    const transcriptNode = chatTranscriptRef.current;
    if (!transcriptNode || showWelcome) {
      return;
    }

    const observer = new ResizeObserver(() => {
      const shouldFollowLatest = shouldAutoScrollRef.current;
      if (!shouldFollowLatest) {
        return;
      }

      scrollTranscriptToLatest();
      settleAutoScroll(activeSnapshotThreadStatus);
    });

    observer.observe(transcriptNode);
    return () => observer.disconnect();
  }, [activeSnapshotThreadId, activeSnapshotThreadStatus, showWelcome]);

  useEffect(() => {
    if (!configDraft) {
      setSettingsProviderId(null);
      return;
    }

    if (settingsProviderId && configDraft.providers.some((provider) => provider.id === settingsProviderId)) {
      return;
    }

    const nextProviderId =
      configDraft.providers.find((provider) => getModelsForProvider(configDraft, provider.id).length > 0)?.id ??
      configDraft.providers[0]?.id ??
      null;
    setSettingsProviderId(nextProviderId);
  }, [configDraft, settingsProviderId]);

  useEffect(() => {
    if (!config) {
      return;
    }

    const nextSelection = selectedThread
      ? resolveSelectionFromConfig(config, selectedThread.providerId, selectedThread.modelId)
      : resolveSelectionFromConfig(config, composerProviderId, composerModelId);

    if (nextSelection.providerId !== composerProviderId) {
      setComposerProviderId(nextSelection.providerId);
    }

    if (nextSelection.modelId !== composerModelId) {
      setComposerModelId(nextSelection.modelId);
    }
  }, [config, selectedThreadId, selectedThread]);

  async function refreshAll() {
    await Promise.all([refreshThreads(), refreshSkills(), refreshPlugins(), refreshConfig(), refreshMcpServers()]);
  }

  async function refreshThreads() {
    const nextThreads = (await window.codexh.listThreads()) as ThreadRecord[];
    setThreads(nextThreads);

    // Runtime listeners are registered once, so read the current selection from the ref
    // instead of the render that created the listener.
    const currentSelectedThreadId = selectedThreadIdRef.current;
    const targetThreadId =
      currentSelectedThreadId && nextThreads.some((thread) => thread.id === currentSelectedThreadId)
        ? currentSelectedThreadId
        : nextThreads[0]?.id ?? null;

    if (targetThreadId !== currentSelectedThreadId) {
      selectThreadId(targetThreadId);
    }

    await refreshSnapshot(targetThreadId);
  }

  async function refreshSnapshot(threadId: string | null) {
    if (!threadId) {
      setSnapshot(null);
      return;
    }

    const requestId = (snapshotRequestIdsRef.current[threadId] ?? 0) + 1;
    snapshotRequestIdsRef.current[threadId] = requestId;
    try {
      const next = (await window.codexh.getThreadSnapshot(threadId)) as RuntimeThreadSnapshot;
      if (snapshotRequestIdsRef.current[threadId] !== requestId) {
        return;
      }
      const pending = pendingUserMessagesRef.current[threadId] ?? [];
      const remaining = pending.filter((optimistic) => !next.messages.some(
        (message) =>
          message.role === "user" &&
          message.content === optimistic.content &&
          Date.parse(message.createdAt) >= Date.parse(optimistic.createdAt) - 1_000
      ));
      if (remaining.length > 0) {
        pendingUserMessagesRef.current[threadId] = remaining;
      } else {
        delete pendingUserMessagesRef.current[threadId];
      }
      setSnapshot({
        ...next,
        messages: remaining.length > 0 ? [...next.messages, ...remaining] : next.messages
      });
      if (next.gpa) {
        setGpaState(next.gpa);
        setGpaComposerSelected(next.gpa.stage !== "off");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice("加载聊天记录失败。", { message });
    }
  }

  function appendOptimisticUserMessage(threadId: string, content: string, attachments: MessageAttachment[] = []): MessageRecord {
    const optimisticMessage: MessageRecord = {
      id: `optimistic-${Date.now()}`,
      threadId,
      turnRunId: null,
      role: "user",
      content,
      metadataJson: attachments.length > 0 ? JSON.stringify({ attachments }) : null,
      createdAt: new Date().toISOString()
    };

    pendingUserMessagesRef.current[threadId] = [
      ...(pendingUserMessagesRef.current[threadId] ?? []),
      optimisticMessage
    ];
    setSnapshot((current) => {
      if (!current || current.thread.id !== threadId) {
        return current;
      }
      return {
        ...current,
        messages: [...current.messages, optimisticMessage]
      };
    });
    return optimisticMessage;
  }

  async function openThread(threadId: string, options?: { scrollToLatest?: boolean }) {
    if (options?.scrollToLatest) {
      cancelPendingAutoScrollFrame();
      clearAutoScrollReleaseTimer();
      shouldAutoScrollRef.current = true;
      pendingLatestScrollThreadIdRef.current = threadId;
    }

    selectThreadId(threadId);
    await refreshSnapshot(threadId);
  }

  async function refreshSkills() {
    setSkills((await window.codexh.listSkills(selectedThread?.cwd)) as SkillMetadata[]);
  }

  async function refreshPlugins() {
    setPlugins((await window.codexh.listPlugins()) as PluginRecord[]);
  }

  async function refreshConfig(preferredProviderId?: string | null) {
    try {
      const nextConfig = (await window.codexh.getConfig()) as AppConfig;
      setConfig(nextConfig);
      resetConfigDraft(nextConfig, preferredProviderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`加载模型配置失败：${message}`);
    }
  }

  async function createThread(mode: "project" | "chat") {
    if (mode === "project") {
      setProjectPathDraft("");
      setIsProjectCreateOpen(true);
      return;
    }

    const thread = await createThreadRecord(mode);
    selectThreadId(thread.id);
    await refreshAll();
    await refreshSnapshot(thread.id);
  }

  async function createThreadRecord(mode: "project" | "chat", cwdInput?: string) {
    const title = mode === "project" ? "新建项目" : "新建任务";
    const cwd = mode === "project" && cwdInput?.trim() ? cwdInput.trim() : undefined;
    const selection = config
      ? resolveSelectionFromConfig(config, composerProviderId, composerModelId)
      : null;

    return (await window.codexh.createThread({
      title,
      mode,
      cwd,
      providerId: selection?.providerId ?? null,
      modelId: selection?.modelId ?? null
    })) as ThreadRecord;
  }

  async function openProjectFolder(targetPath: string) {
    const error = await window.codexh.openPath(targetPath);
    if (error) {
      showNotice("无法打开项目文件夹", { message: error });
    }
  }

  async function openGeneratedFileLocation(filePath: string) {
    if (!selectedThreadId) return;
    const error = await window.codexh.openFileLocation({ threadId: selectedThreadId, path: filePath });
    if (error) {
      showNotice("无法打开文件夹", { message: error });
    }
  }

  async function confirmProjectCreate() {
    if (!projectPathDraft) {
      showNotice("请选择项目文件夹。");
      return;
    }
    const thread = await createThreadRecord("project", projectPathDraft);
    setIsProjectCreateOpen(false);
    setProjectPathDraft("");
    selectThreadId(thread.id);
    await refreshAll();
    await refreshSnapshot(thread.id);
  }

  async function chooseProjectFolder() {
    setIsPickingProjectFolder(true);
    try {
      const selectedPath = await window.codexh.chooseProjectDirectory(projectPathDraft || undefined);
      if (selectedPath) {
        setProjectPathDraft(selectedPath);
      }
    } catch (error) {
      showNotice("选择项目文件夹失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    } finally {
      setIsPickingProjectFolder(false);
    }
  }

  async function resolvePendingApproval(
    approvalId: string,
    decision: "approved" | "denied",
    mode?: "once" | "session" | "remember"
  ) {
    setResolvingApprovalId(approvalId);
    try {
      await window.codexh.resolveApproval(approvalId, { decision, mode });
    } catch (error) {
      showNotice("处理审批失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    } finally {
      setResolvingApprovalId(null);
      await refreshThreads();
      await refreshSnapshot(activeSnapshotThreadId ?? selectedThreadId);
    }
  }

  function showNotice(title: string, options?: { message?: string; tone?: AppNoticeTone }) {
    setIsNoticeHovered(false);
    setExitingNoticeId(null);
    setNotice({
      id: Date.now(),
      title,
      message: options?.message,
      tone: options?.tone ?? "warning"
    });
  }

  function requestDeleteHistoryThread(thread: ThreadRecord) {
    const blockedMessage = getDeleteThreadBlockedMessage(thread.status, deletingThreadId);
    if (blockedMessage) {
      showNotice(blockedMessage);
      return;
    }

    if (!canDeleteThread(thread.status, deletingThreadId)) {
      return;
    }

    void confirmDeleteHistoryThread(thread);
  }

  async function confirmDeleteHistoryThread(thread: ThreadRecord) {
    setDeletingThreadId(thread.id);
    try {
      await window.codexh.deleteThread(thread.id);
      await refreshThreads();
      showNotice("任务已删除。", { tone: "success" });
    } catch (error) {
      showNotice("删除失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    } finally {
      setDeletingThreadId((current) => (current === thread.id ? null : current));
    }
  }

  async function sendMessage(
    forcedContent?: string,
    stageOverride?: GpaStage,
    options?: { internal?: boolean }
  ) {
    const inputContent = (forcedContent ?? input.trim()).trim();
    if (!inputContent && (forcedContent || composerAttachments.length === 0)) {
      return;
    }

    let unsupportedMultimodalInput = false;
    if (!forcedContent) {
      if (
        !composerProviderId ||
        !composerModelId ||
        !composerModels.some((model) => model.id === composerModelId)
      ) {
        showNotice("请先在聊天框下方选择可用的供应商和模型。");
        return;
      }
      const hasMultimodalAttachment = composerAttachments.some(
        (attachment) => attachment.kind === "file" || attachment.kind === "folder" || attachment.kind === "image"
      );
      if (hasMultimodalAttachment && !selectedComposerModel?.supportsMultimodalInput) {
        unsupportedMultimodalInput = true;
      }
    }

    let threadId = selectedThreadId;
    if (!threadId) {
      const thread = await createThreadRecord("chat");
      threadId = thread.id;
      selectThreadId(thread.id);
      await refreshThreads();
    }

    if (unsupportedMultimodalInput) {
      await window.codexh.rejectUnsupportedMultimodal({ threadId, content: inputContent });
      setInput("");
      setComposerAttachments([]);
      setGpaComposerSelected(false);
      showNotice("此模型不支持多模态", {
        message: "已在对话中返回原因，请切换到支持多模态输入的模型后再重试。"
      });
      await refreshThreads();
      await refreshSnapshot(threadId);
      return;
    }

    const stage = stageOverride ?? gpaState.stage;
    if (stage !== "off") {
      await window.codexh.setGpaStage({ threadId, stage });
    }
    if (gpaState.fullAccess) {
      await window.codexh.setGpaFullAccess({ threadId, fullAccess: true });
    }
    if (!forcedContent) {
      const skillIds = composerAttachments
        .filter((attachment): attachment is Extract<ComposerAttachment, { kind: "skill" }> => attachment.kind === "skill")
        .map((attachment) => attachment.skillId);
      for (const skillId of new Set(skillIds)) {
        await window.codexh.addThreadSkill({ threadId, skillId });
      }
    }

    let importedAttachments: MessageAttachment[] = [];
    if (!forcedContent) {
      try {
        importedAttachments = await importComposerAttachments(threadId, composerAttachments);
      } catch (error) {
        showNotice("添加附件失败", { message: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    const raw = (forcedContent ?? [inputContent, formatComposerAttachments(composerAttachments.filter((attachment) => attachment.kind !== "file" && attachment.kind !== "image"))]
      .filter(Boolean).join("\n\n")).trim();
    const displayContent = forcedContent ?? inputContent;
    const queueingBehindActiveTask = isThreadExecutionInProgress(selectedThreadStatus) || isPreparingRuntime;
    const optimisticMessage = !options?.internal && !queueingBehindActiveTask
      ? appendOptimisticUserMessage(threadId, displayContent, importedAttachments)
      : null;
    if (!options?.internal && !queueingBehindActiveTask) {
      startRuntimeActivity(threadId);
      setRuntimeProgress({ threadId, phase: "preparing", runtimeObserved: false });
    }
    try {
      await window.codexh.sendMessage({ threadId, content: raw, displayContent, attachments: importedAttachments });
    } catch (error) {
      if (optimisticMessage) {
        pendingUserMessagesRef.current[threadId] = (pendingUserMessagesRef.current[threadId] ?? [])
          .filter((message) => message.id !== optimisticMessage.id);
        setSnapshot((current) => current?.thread.id === threadId
          ? { ...current, messages: current.messages.filter((message) => message.id !== optimisticMessage.id) }
          : current
        );
      }
      setRuntimeProgress((current) => current?.threadId === threadId ? null : current);
      clearRuntimeActivity(threadId);
      showNotice("发送消息失败", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!forcedContent) {
      setInput("");
      setComposerAttachments([]);
    }
    clearAutoScrollReleaseTimer();
    shouldAutoScrollRef.current = true;
    window.setTimeout(() => {
      void refreshSnapshot(threadId);
    }, 120);
  }

  async function copyUserMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      showNotice("已复制消息内容。", { tone: "success" });
    } catch (error) {
      showNotice("复制失败。", {
        message: error instanceof Error ? error.message : "请检查剪贴板权限。"
      });
    }
  }

  function beginUserMessageEdit(message: MessageRecord) {
    if (isActiveThreadExecuting || isPreparingRuntime) {
      showNotice("任务执行中，停止后才能重新编辑消息。");
      return;
    }
    setEditingUserMessage({ id: message.id, content: message.content });
  }

  function cancelUserMessageEdit() {
    setEditingUserMessage(null);
  }

  async function submitUserMessageEdit() {
    const content = editingUserMessage?.content.trim();
    if (!content) {
      return;
    }
    if (
      !composerProviderId ||
      !composerModelId ||
      !composerModels.some((model) => model.id === composerModelId)
    ) {
      showNotice("请先在聊天框下方选择可用的供应商和模型。");
      return;
    }

    await sendMessage(content);
    setEditingUserMessage(null);
  }

  async function handleGpaStageSelect(stage: GpaStage) {
    setGpaState((prev) => ({ ...prev, stage, awaitingConfirmation: null }));
    setGpaComposerSelected(stage !== "off");
    setGpaMenuOpen(false);
    setGpaMenuPos(null);
    const threadId = selectedThreadId;
    if (threadId) {
      await window.codexh.setGpaStage({ threadId, stage });
    }
  }

  async function confirmGpaStage() {
    if (gpaState.awaitingConfirmation === "goal") {
      await sendMessage(
        "[internal:gpa-confirm] Continue with the confirmed goal. Produce the PLAN task list and acceptance criteria.",
        "plan",
        { internal: true }
      );
    } else if (gpaState.awaitingConfirmation === "plan") {
      await sendMessage(
        "[internal:gpa-confirm] The plan is confirmed. Enter ACT and implement the planned tasks.",
        "act",
        { internal: true }
      );
    }
  }

  function openGpaRevision() {
    setGpaRevisionOpen(true);
    window.requestAnimationFrame(() => gpaRevisionRef.current?.focus());
  }

  function cancelGpaRevision() {
    setGpaRevisionOpen(false);
    setGpaRevisionDraft("");
  }

  async function submitGpaRevision() {
    const revision = gpaRevisionDraft.trim();
    if (!revision) {
      gpaRevisionRef.current?.focus();
      return;
    }

    setGpaRevisionSubmitting(true);
    try {
      await sendMessage(`请根据以下修改意见更新当前计划：\n\n${revision}`, "plan");
      setGpaRevisionDraft("");
      setGpaRevisionOpen(false);
    } catch (error) {
      showNotice("提交修改失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    } finally {
      setGpaRevisionSubmitting(false);
    }
  }

  async function interruptActiveThread() {
    const threadId = activeSnapshotThreadId ?? selectedThreadId;
    if (!threadId) {
      return;
    }

    // Switch the control back immediately. The subsequent refresh reconciles
    // the optimistic state with the persisted runtime state.
    const updatedAt = new Date().toISOString();
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId ? { ...thread, status: "idle", updatedAt } : thread
      )
    );
    setSnapshot((current) =>
      current?.thread.id === threadId
        ? { ...current, thread: { ...current.thread, status: "idle", updatedAt } }
        : current
    );

    try {
      await window.codexh.interruptThread(threadId);
    } catch (error) {
      showNotice("停止任务失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    } finally {
      await refreshThreads();
      await refreshSnapshot(threadId);
    }
  }

  async function enableGpaMode() {
    if (gpaState.stage !== "off") {
      setGpaComposerSelected(true);
      setGpaMenuOpen(false);
      setGpaMenuPos(null);
      return;
    }
    await handleGpaStageSelect("goal");
  }

  async function setFullAccess(fullAccess: boolean) {
    setGpaState((prev) => ({ ...prev, fullAccess }));
    setGpaMenuOpen(false);
    setGpaMenuPos(null);
    if (selectedThreadId) {
      await window.codexh.setGpaFullAccess({ threadId: selectedThreadId, fullAccess });
    }
  }

  async function handleComposerPrimaryAction() {
    if (isActiveThreadExecuting) {
      await interruptActiveThread();
      return;
    }

    await sendMessage();
  }

  async function deleteQueuedMessage(id: string) {
    if (!selectedThreadId) return;
    setDeletingQueuedMessageId(id);
    try {
      await window.codexh.deleteQueuedMessage({ threadId: selectedThreadId, id });
      await refreshSnapshot(selectedThreadId);
    } catch (error) {
      showNotice("删除排队消息失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeletingQueuedMessageId((current) => current === id ? null : current);
    }
  }

  async function importKnowledge() {
    if (knowledgeScope === "project" && !canImportProjectKnowledge) {
      return;
    }

    const sourcePaths = knowledgeSources.map((source) => source.path);

    if (sourcePaths.length === 0) {
      showNotice("请至少填写一个本地文档路径。");
      return;
    }

    try {
      await window.codexh.importKnowledge({
        displayName: knowledgeName.trim() || "Imported Knowledge",
        scope: knowledgeScope,
        sourcePaths,
        threadId: selectedThreadId ?? undefined
      });
      setKnowledgeSources([]);
      await Promise.all([refreshSnapshot(selectedThreadId), refreshKnowledgeBases()]);
      showNotice("知识库已导入", { tone: "success" });
    } catch (error) {
      showNotice("知识库导入失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function answerPendingPrompt(prompt: UserInputPrompt, answers: Record<string, string>) {
    setResolvingPromptId(prompt.id);
    try {
      await window.codexh.answerPrompt(prompt.id, answers);
      await refreshSnapshot(prompt.threadId);
    } catch (error) {
      showNotice("提交选择失败。", {
        message: error instanceof Error ? error.message : "请重新开始任务后再试。"
      });
    } finally {
      setResolvingPromptId((current) => current === prompt.id ? null : current);
    }
  }

  async function toggleThreadPinned(thread: ThreadRecord) {
    try {
      await window.codexh.setThreadPinned({ threadId: thread.id, isPinned: !thread.isPinned });
      await refreshThreads();
      showNotice(thread.isPinned ? "已取消置顶。" : "任务已置顶。", { tone: "success" });
    } catch (error) {
      showNotice("修改置顶状态失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    }
  }

  async function setKnowledgeEnabled(knowledgeEnabled: boolean) {
    setGpaState((prev) => ({ ...prev, knowledgeEnabled }));
    setGpaMenuOpen(false);
    setGpaMenuPos(null);
    if (selectedThreadId) {
      await window.codexh.setKnowledgeEnabled({ threadId: selectedThreadId, knowledgeEnabled });
    }
  }

  async function chooseKnowledgeSources(kind: "files" | "folders") {
    const paths = kind === "files"
      ? await window.codexh.chooseKnowledgeFiles()
      : await window.codexh.chooseKnowledgeFolders();
    if (paths.length === 0) return;
    setKnowledgeSources((current) => {
      const existing = new Set(current.map((source) => source.path.toLowerCase()));
      const additions = paths
        .filter((sourcePath) => !existing.has(sourcePath.toLowerCase()))
        .map((sourcePath) => ({ path: sourcePath, kind: kind === "files" ? "file" : "folder" } satisfies KnowledgeSourceAttachment));
      return [...current, ...additions];
    });
  }

  function removeKnowledgeSource(sourcePath: string) {
    setKnowledgeSources((current) => current.filter((source) => source.path !== sourcePath));
  }

  async function refreshKnowledgeBases() {
    try {
      setKnowledgeBases((await window.codexh.listKnowledgeBases()) as KnowledgeBaseSummary[]);
    } catch (error) {
      showNotice("加载知识库失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function toggleKnowledgeDocuments(knowledgeBaseId: string) {
    if (knowledgeDocuments[knowledgeBaseId]) {
      setKnowledgeDocuments((current) => {
        const next = { ...current };
        delete next[knowledgeBaseId];
        return next;
      });
      return;
    }
    try {
      const documents = await window.codexh.listKnowledgeDocuments(knowledgeBaseId) as KnowledgeDocumentRecord[];
      setKnowledgeDocuments((current) => ({ ...current, [knowledgeBaseId]: documents }));
    } catch (error) {
      showNotice("读取文档列表失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function refreshKnowledgeBase(knowledgeBaseId: string) {
    setKnowledgeBusyId(knowledgeBaseId);
    try {
      await window.codexh.refreshKnowledgeBase(knowledgeBaseId);
      setKnowledgeDocuments((current) => {
        const next = { ...current };
        delete next[knowledgeBaseId];
        return next;
      });
      await refreshKnowledgeBases();
      showNotice("知识库索引已刷新", { tone: "success" });
    } catch (error) {
      showNotice("刷新知识库失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setKnowledgeBusyId(null);
    }
  }

  async function deleteKnowledgeBase(knowledgeBaseId: string) {
    setKnowledgeBusyId(knowledgeBaseId);
    try {
      await window.codexh.deleteKnowledgeBase(knowledgeBaseId);
      setKnowledgeDocuments((current) => {
        const next = { ...current };
        delete next[knowledgeBaseId];
        return next;
      });
      await Promise.all([refreshKnowledgeBases(), refreshSnapshot(selectedThreadId)]);
      showNotice("知识库已删除", { tone: "success" });
    } catch (error) {
      showNotice("删除知识库失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setKnowledgeBusyId(null);
    }
  }

  async function installPlugin() {
    if (!pluginSource.trim()) {
      return;
    }

    await window.codexh.installPlugin(pluginSource.trim());
    await refreshPlugins();
    await refreshSkills();
  }

  async function saveConfigDraft() {
    if (!config || !configDraft) {
      return;
    }

    if (configDraft.models.length === 0) {
      showNotice("请至少保留一个模型。");
      return;
    }

    const nextConfig = buildConfigToSave(configDraft, config, providerSecretDrafts);
    const preferredProviderId = settingsProviderId;
    await window.codexh.saveConfig(nextConfig);
    setConfig(nextConfig);
    showNotice("配置已保存。", {
      message: "聊天区已同步最新的供应商和模型列表。",
      tone: "success"
    });
    await refreshConfig(preferredProviderId);
    await refreshThreads();
    await refreshMcpServers();
  }

  function updateMcpServerDraft(id: string, patch: Partial<McpServerConfig>) {
    setConfigDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      next.mcpServers = next.mcpServers.map((server) => server.id === id ? { ...server, ...patch } : server);
      return next;
    });
  }

  function dismissNotice(noticeId: number) {
    setIsNoticeHovered(false);
    setExitingNoticeId((current) => current ?? noticeId);
  }

  function addMcpServer() {
    setConfigDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      let index = next.mcpServers.length + 1;
      let id = `mcp-${index}`;
      while (next.mcpServers.some((server) => server.id === id)) {
        index += 1;
        id = `mcp-${index}`;
      }
      next.mcpServers.push({ id, name: `MCP 服务 ${index}`, transport: "stdio", command: "", args: [], enabled: true });
      setEditingMcpServerId(id);
      return next;
    });
  }

  function removeMcpServer(id: string) {
    setConfigDraft((current) => {
      if (!current) return current;
      const next = cloneConfig(current);
      next.mcpServers = next.mcpServers.filter((server) => server.id !== id);
      return next;
    });
    setEditingMcpServerId((current) => current === id ? null : current);
  }

  async function testMcpServer(server: McpServerConfig) {
    setTestingMcpServerId(server.id);
    try {
      const result = await window.codexh.testMcpServer(server);
      setMcpTestResults((current) => ({
        ...current,
        [server.id]: { tools: result.tools, resources: result.resources, resourceTemplates: result.resourceTemplates }
      }));
      showNotice(`${server.name} 测试成功`, { tone: "success", message: `发现 ${result.tools.length} 个工具` });
    } catch (error) {
      showNotice(`${server.name} 连接失败`, { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTestingMcpServerId((current) => current === server.id ? null : current);
      await refreshMcpServers();
    }
  }

  function queuePrompt(text: string) {
    setInput(text);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function addComposerAttachment(attachment: ComposerAttachmentInput) {
    setComposerAttachments((current) => {
      const duplicate = current.some((entry) => composerAttachmentKey(entry) === composerAttachmentKey(attachment));
      return duplicate ? current : [...current, { ...attachment, id: globalThis.crypto.randomUUID() } as ComposerAttachment];
    });
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  async function importComposerAttachments(threadId: string, attachments: ComposerAttachment[]): Promise<MessageAttachment[]> {
    const importable = attachments.filter(
      (attachment) => attachment.kind === "image" || attachment.kind === "file"
    ) as ComposerBinaryAttachment[];
    if (importable.length === 0) return [];
    const payload = await Promise.all(importable.map(async (attachment) => ({
      name: attachment.label,
      mimeType: attachment.file?.type || undefined,
      path: attachment.file ? undefined : attachment.path,
      data: attachment.file ? new Uint8Array(await attachment.file.arrayBuffer()) : undefined
    })));
    return await window.codexh.importAttachments({ threadId, attachments: payload }) as MessageAttachment[];
  }

  async function addDroppedFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith("image/");
      const previewUrl = isImage ? await readFileAsDataUrl(file).catch(() => undefined) : undefined;
      addComposerAttachment({
        kind: isImage ? "image" : "file",
        path: "",
        label: file.name,
        file,
        previewUrl
      });
    }
  }

  async function refreshMcpServers() {
    setMcpRuntimeServers((await window.codexh.listMcpServers()) as McpRuntimeServer[]);
  }

  function clearComposerAddMenuCloseTimer() {
    if (composerAddMenuCloseTimerRef.current !== null) {
      window.clearTimeout(composerAddMenuCloseTimerRef.current);
      composerAddMenuCloseTimerRef.current = null;
    }
  }

  function scheduleComposerAddMenuClose() {
    clearComposerAddMenuCloseTimer();
    composerAddMenuCloseTimerRef.current = window.setTimeout(() => {
      setComposerAddMenuView("root");
      composerAddMenuCloseTimerRef.current = null;
    }, 160);
  }

  function removeComposerAttachment(id: string) {
    setComposerAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  async function chooseComposerFiles(imagesOnly: boolean) {
    const paths = await window.codexh.chooseAttachmentFiles({ imagesOnly });
    for (const path of paths) {
      const previewUrl = imagesOnly
        ? await window.codexh.previewLocalImage({ absolutePath: path }).catch(() => undefined)
        : undefined;
      addComposerAttachment({
        kind: imagesOnly ? "image" : "file",
        path,
        label: path.split(/[\\/]/).pop() || path,
        previewUrl
      });
    }
    setGpaMenuOpen(false);
    setGpaMenuPos(null);
  }

  function resetConfigDraft(nextConfig: AppConfig, preferredProviderId?: string | null) {
    const draft = cloneConfig(nextConfig);
    const nextProviderId = resolveSettingsProviderId(draft, preferredProviderId);
    setConfigDraft(draft);
    setSettingsProviderId(nextProviderId);
    setProviderSecretDrafts({});
    setMultimodalPickerRole(null);
    setMultimodalPickerSelected([]);
    setNewModelId("");
    setNewModelDisplayName("");
  }

  function updateProviderDraft(providerId: string, patch: Partial<ProviderDefinition>) {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }

      const next = cloneConfig(current);
      next.providers = next.providers.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              ...patch
            }
          : provider
      );
      return normalizeDraftConfig(next);
    });
  }

  function addCustomProvider() {
    if (!configDraft) {
      return;
    }

    const nextProvider = createEmptyProvider(configDraft.providers);
    const nextDraft = cloneConfig(configDraft);
    nextDraft.providers.push(nextProvider);
    setConfigDraft(normalizeDraftConfig(nextDraft));
    setSettingsProviderId(nextProvider.id);
    setNewModelId("");
    setNewModelDisplayName("");
  }

  function removeProvider(providerId: string) {
    if (!configDraft) {
      return;
    }

    const remainingModels = configDraft.models.filter((model) => model.providerId !== providerId);
    if (remainingModels.length === 0) {
      showNotice("至少保留一个模型后，才能删除这个供应商。");
      return;
    }

    const nextDraft = cloneConfig(configDraft);
    nextDraft.providers = nextDraft.providers.filter((provider) => provider.id !== providerId);
    nextDraft.models = remainingModels;
    const normalized = normalizeDraftConfig(nextDraft);

    setConfigDraft(normalized);
    setProviderSecretDrafts((current) => {
      const { [providerId]: _removed, ...rest } = current;
      return rest;
    });
    setSettingsProviderId(normalized.providers[0]?.id ?? null);
  }

  function setProviderAsDefault(providerId: string) {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }

      const providerModels = getModelsForProvider(current, providerId);
      if (providerModels.length === 0) {
        return current;
      }

      const next = cloneConfig(current);
      next.defaultProvider = providerId;
      if (!providerModels.some((model) => model.id === next.defaultModel)) {
        next.defaultModel = providerModels[0].id;
      }
      return normalizeDraftConfig(next);
    });
  }

  async function fetchAndShowProviderModels(providerId: string) {
    if (!configDraft) {
      return;
    }
    const provider = configDraft.providers.find((entry) => entry.id === providerId);
    if (!provider) {
      return;
    }
    const baseUrl = (provider.baseUrl ?? "").trim();
    const secret = providerSecretDrafts[provider.id]?.trim();
    const apiKey = secret || provider.apiKey || (provider.apiKeyEnv ? "" : "");
    if (!baseUrl) {
      showNotice("请先填写调用地址。");
      return;
    }
    if (!apiKey && !provider.apiKeyEnv) {
      showNotice("请先填写 API Key。", {
        message: "或者在 KEY 字段使用环境变量名。"
      });
      return;
    }
    setIsFetchingModels(true);
    setFetchedModelsTarget("provider");
    try {
      const list = await window.codexh.fetchProviderModels({
        baseUrl,
        apiKey: apiKey || undefined,
        apiKeyEnv: provider.apiKeyEnv,
        type: provider.type,
        id: provider.id
      });
      setFetchedModels(list);
      setSelectedFetchedModelIds([]);
      setShowFetchedModels(true);
    } catch (error) {
      showNotice("获取模型失败。", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setIsFetchingModels(false);
    }
  }

  function toggleFetchedModelSelection(modelId: string) {
    setSelectedFetchedModelIds((current) =>
      current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId]
    );
  }

  function applyFetchedModels() {
    if (!configDraft) {
      return;
    }
    const candidates = fetchedModels.filter((entry) =>
      selectedFetchedModelIds.includes(entry.id)
    );
    if (candidates.length === 0) {
      showNotice("没有勾选要添加的模型。");
      return;
    }

    if (!settingsProvider) {
      return;
    }
    const existing = new Set(configDraft.models.map((model) => model.id));
    const nextDraft = cloneConfig(configDraft);
    let added = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      if (existing.has(candidate.id)) {
        skipped += 1;
        continue;
      }
      nextDraft.models.push(
        createModelProfile(settingsProvider.id, candidate.id, candidate.displayName ?? candidate.id)
      );
      existing.add(candidate.id);
      added += 1;
    }
    setConfigDraft(normalizeDraftConfig(nextDraft));
    setShowFetchedModels(false);
    setSelectedFetchedModelIds([]);
    setFetchedModels([]);
    showNotice(
      added > 0 ? `已添加 ${added} 个模型。` : "没有新增模型。",
      skipped > 0 ? { message: `跳过 ${skipped} 个已存在模型。` } : undefined
    );
  }

  function addModelToProvider(providerId: string) {
    if (!configDraft) {
      return;
    }

    const nextId = newModelId.trim();
    if (!nextId) {
      showNotice("请先填写模型名称。");
      return;
    }

    if (configDraft.models.some((model) => model.id === nextId)) {
      showNotice("模型名称不能重复。", {
        message: "请换一个唯一的 ID。"
      });
      return;
    }

    const nextDraft = cloneConfig(configDraft);
    nextDraft.models.push(createModelProfile(providerId, nextId, newModelDisplayName));
    setConfigDraft(normalizeDraftConfig(nextDraft));
    setNewModelId("");
    setNewModelDisplayName("");
  }

  function updateModelDraft(modelId: string, patch: Partial<ModelProfile>) {
    setConfigDraft((current) => {
      if (!current) {
        return current;
      }
      const next = cloneConfig(current);
      next.models = next.models.map((model) =>
        model.id === modelId ? { ...model, ...patch } : model
      );
      return normalizeDraftConfig(next);
    });
  }

  function setModelRole(providerId: string, modelId: string, role: "reasoning" | "image" | "video" | null) {
    const roleLabel = role === "reasoning" ? "推理模型" : role === "image" ? "图片模型" : role === "video" ? "视频模型" : null;
    void persistMultimodalChange((next) => {
      const model = next.models.find((entry) => entry.providerId === providerId && entry.id === modelId);
      if (!model) return;
      const previousRole = model.role === "image" || model.role === "video" || model.role === "reasoning"
        ? model.role
        : null;
      if (role) {
        model.role = role;
        if (role === "image") model.supportsImageGeneration = true;
        if (role === "video") model.supportsVideoGeneration = true;
      } else {
        delete model.role;
      }
      if (previousRole === "image" || previousRole === "video") {
        if (next.multimodal[previousRole].defaultProviderId === providerId &&
          next.multimodal[previousRole].defaultModelId === modelId) {
          delete next.multimodal[previousRole].defaultProviderId;
          delete next.multimodal[previousRole].defaultModelId;
        }
      }
      if ((role === "image" || role === "video") && !next.multimodal[role].defaultModelId) {
        next.multimodal[role].defaultProviderId = providerId;
        next.multimodal[role].defaultModelId = modelId;
      }
    }, roleLabel ? `已加入${roleLabel}` : "已从多模态列表移除");
  }

  function setMultimodalDefault(kind: "image" | "video", providerId: string, modelId: string) {
    void persistMultimodalChange((next) => {
      next.multimodal[kind].defaultProviderId = providerId;
      next.multimodal[kind].defaultModelId = modelId;
    }, `已设为默认${kind === "image" ? "图片" : "视频"}模型`);
  }

  function setMultimodalEnabled(kind: "image" | "video", enabled: boolean) {
    void persistMultimodalChange((next) => {
      next.multimodal[kind].enabled = enabled;
    }, enabled
      ? `已启用${kind === "image" ? "图片" : "视频"}生成`
      : `已关闭${kind === "image" ? "图片" : "视频"}生成`);
  }

  function removeFromMultimodalRole(providerId: string, modelId: string) {
    setModelRole(providerId, modelId, null);
  }

  function applyMultimodalPicker() {
    if (!multimodalPickerRole || multimodalPickerSelected.length === 0) return;
    const role = multimodalPickerRole;
    const selected = [...multimodalPickerSelected];
    const roleLabel = role === "reasoning" ? "推理模型" : role === "image" ? "图片模型" : "视频模型";
    setMultimodalPickerRole(null);
    setMultimodalPickerSelected([]);
    void persistMultimodalChange((next) => {
      for (const key of selected) {
        const [providerId, ...modelIdParts] = key.split("::");
        const modelId = modelIdParts.join("::");
        if (!providerId || !modelId) continue;
        const model = next.models.find((entry) => entry.providerId === providerId && entry.id === modelId);
        if (!model) continue;
        const previousRole = model.role === "image" || model.role === "video" || model.role === "reasoning"
          ? model.role
          : null;
        model.role = role;
        if (role === "image") model.supportsImageGeneration = true;
        if (role === "video") model.supportsVideoGeneration = true;
        if (previousRole === "image" || previousRole === "video") {
          if (next.multimodal[previousRole].defaultProviderId === providerId &&
            next.multimodal[previousRole].defaultModelId === modelId) {
            delete next.multimodal[previousRole].defaultProviderId;
            delete next.multimodal[previousRole].defaultModelId;
          }
        }
        if ((role === "image" || role === "video") && !next.multimodal[role].defaultModelId) {
          next.multimodal[role].defaultProviderId = providerId;
          next.multimodal[role].defaultModelId = modelId;
        }
      }
    }, `已添加 ${selected.length} 个到${roleLabel}`);
  }

  async function persistMultimodalChange(mutate: (draft: AppConfig) => void, successTitle = "多模态配置已保存") {
    if (!config || !configDraft) return;
    const nextDraft = cloneConfig(configDraft);
    mutate(nextDraft);
    const normalized = normalizeDraftConfig(nextDraft);
    setConfigDraft(normalized);
    try {
      const nextConfig = buildConfigToSave(normalized, config, providerSecretDrafts);
      await window.codexh.saveConfig(nextConfig);
      setConfig(nextConfig);
      showNotice(successTitle, {
        message: "已立即生效，无需再点保存。",
        tone: "success"
      });
    } catch (error) {
      showNotice("多模态配置保存失败", {
        message: error instanceof Error ? error.message : String(error),
        tone: "warning"
      });
      await refreshConfig(settingsProviderId);
    }
  }

  function removeModel(modelId: string) {
    if (!configDraft) {
      return;
    }

    if (configDraft.models.length <= 1) {
      showNotice("至少保留一个模型。");
      return;
    }

    const nextDraft = cloneConfig(configDraft);
    nextDraft.models = nextDraft.models.filter((model) => model.id !== modelId);
    setConfigDraft(normalizeDraftConfig(nextDraft));
  }

  async function checkProviderModel(provider: ProviderDefinition, model: ModelProfile) {
    const secretDraft = providerSecretDrafts[provider.id]?.trim();
    const hasSecret =
      Boolean(secretDraft || provider.apiKey || provider.apiKeyEnv) ||
      provider.type === "mock" ||
      provider.type === "ollama";

    if (!hasSecret) {
      showNotice("请先填写 API Key。", {
        message: "或者保留当前已保存的密钥。"
      });
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
      updateModelDraft(model.id, capabilityPatch);
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
      setTestingModelKey((current) => (current === key ? null : current));
    }
  }

  async function checkForUpdates() {
    try {
      setUpdateState(await window.codexh.checkForUpdates());
    } catch (error) {
      showNotice("检查更新失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function downloadAvailableUpdate() {
    if (!updateState) return;
    const needsConfirm = updateState.insecureTransport === true || updateState.missingSha256 === true;
    if (needsConfirm) {
      const reasons = [
        updateState.insecureTransport ? "更新源使用 HTTP，可能被篡改" : null,
        updateState.missingSha256 ? "更新清单未提供 sha256，无法校验安装包完整性" : null
      ].filter(Boolean).join("；");
      if (!window.confirm(`${reasons}。仍要继续下载吗？`)) return;
    }
    try {
      setUpdateState(await window.codexh.downloadUpdate({ confirmInsecureHttp: needsConfirm }));
    } catch (error) {
      showNotice("下载更新失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function installDownloadedUpdate() {
    if (!window.confirm("安装更新会关闭 CodeXH 并覆盖当前版本，是否继续？")) return;
    try {
      await window.codexh.installUpdate();
    } catch (error) {
      showNotice("暂时无法安装更新", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function updateComposerSelection(providerId: string, modelId: string) {
    setComposerProviderId(providerId);
    setComposerModelId(modelId);

    if (!selectedThreadId) {
      return;
    }

    await window.codexh.updateThreadModelSelection({ threadId: selectedThreadId, providerId, modelId });
    await refreshThreads();
    await refreshSnapshot(selectedThreadId);
  }

  function handleComposerProviderChange(nextProviderId: string) {
    if (!config) {
      return;
    }

    const nextModels = getReasoningModelsForProvider(config, nextProviderId);
    if (nextModels.length === 0) {
      showNotice("这个供应商下还没有模型。", {
        message: "请先去设置里添加。"
      });
      return;
    }

    const nextModelId =
      nextModels.find((model) => model.id === composerModelId)?.id ?? nextModels[0].id;
    void updateComposerSelection(nextProviderId, nextModelId);
  }

  function handleComposerModelChange(providerId: string, modelId: string) {
    if (!providerId || !modelId) {
      return;
    }

    void updateComposerSelection(providerId, modelId);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }

    if (
      event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      void handleComposerPrimaryAction();
    }
  }

  function submitTerminalInput() {
    const command = activeTerminalInput.trim();
    if (!command || !selectedThreadId || !activeTerminalSessionId) {
      return;
    }

    setActiveTerminalInput("");
    void window.codexh
      .writeTerminal({ threadId: selectedThreadId, input: command, sessionId: activeTerminalSessionId })
      .catch((error: unknown) => {
        updateTerminalSessionState(selectedThreadId, activeTerminalSessionId, (current) => ({
          output: `${current?.output ?? ""}\nTerminal error: ${error instanceof Error ? error.message : String(error)}\n`
            .slice(-80_000),
          cwd: current?.cwd ?? "",
          shell: current?.shell ?? "PowerShell"
        }));
    });
  }

  return (
    <div
      ref={appShellRef}
      className={`app-shell ${isSidebarCollapsed ? "sidebar-collapsed" : ""} ${
        isTerminalOpen ? "terminal-open" : ""
      }`}
      style={{
        "--sidebar-pane-width": `${sidebarWidth}px`,
        "--right-workspace-pane-width": `${rightWorkspaceWidth}px`
      } as React.CSSProperties}
    >
      <header className="windowbar">
        <div className="windowbar-left">
          <button
            className="title-icon-button"
            title={isSidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"}
            aria-label={isSidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"}
            aria-pressed={!isSidebarCollapsed}
            onClick={() => setIsSidebarCollapsed((current) => !current)}
          >
            <IconSidebar />
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-scroll">
          <div className="sidebar-brand-row">
            <div className="sidebar-brand">
              <strong>Code<span className="sidebar-brand-accent">XH</span></strong>
              <span>AI Workspace</span>
            </div>
            <button
              className="sidebar-search"
              title="搜索历史对话"
              onClick={() => {
                setHistorySearchQuery("");
                setHistorySearchResults([]);
                setIsHistorySearchOpen(true);
              }}
            >
              <IconSearch />
            </button>
          </div>

          <div className="sidebar-nav">
            <button className="sidebar-nav-button" onClick={() => void createThread("chat")}>
              <span className="sidebar-nav-icon">
                <IconCompose />
              </span>
              <span>新建任务</span>
            </button>
            <button className="sidebar-nav-button" onClick={() => void createThread("project")}>
              <span className="sidebar-nav-icon">
                <IconFolder />
              </span>
              <span>新建项目</span>
              <span className="sidebar-nav-plus">
                <IconPlus />
              </span>
            </button>
          </div>

          <div className="sidebar-section-title">任务历史</div>

              <div className="history-list">
            {threads.length === 0 ? (
              <div className="history-empty">还没有任务</div>
            ) : (
              threads.map((thread) => {
                const historyItemAffordance = getHistoryItemAffordance(thread.status);
                const isThreadRunning = historyItemAffordance.kind === "running-indicator";

                return (
                  <div
                    key={thread.id}
                    className={`history-item history-item-${thread.mode} ${selectedThreadId === thread.id ? "selected" : ""} ${isThreadRunning ? "running" : ""}`}
                    title={isThreadRunning ? historyItemAffordance.title : undefined}
                    aria-busy={isThreadRunning}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setHistoryContextMenu({ x: event.clientX, y: event.clientY, thread });
                    }}
                  >
                    <button
                      type="button"
                      className="history-item-main"
                      onClick={() => {
                        void openThread(thread.id, { scrollToLatest: true });
                      }}
                    >
                      <span className="history-item-label">{thread.title}</span>
                      {thread.isPinned ? <span className="history-item-pin" title="已置顶" aria-label="已置顶"><IconPin /></span> : null}
                    </button>
                    {!isThreadRunning && (
                      <button
                        type="button"
                        className="history-item-delete"
                        title={historyItemAffordance.title}
                        aria-label={`删除任务 ${thread.title}`}
                        disabled={Boolean(deletingThreadId)}
                        onClick={(event) => {
                          event.stopPropagation();
                          requestDeleteHistoryThread(thread);
                        }}
                      >
                        <IconTrash />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {historyContextMenu ? (
            <WorkspaceContextMenu
              x={historyContextMenu.x}
              y={historyContextMenu.y}
              onClose={() => setHistoryContextMenu(null)}
              actions={[{
                id: "toggle-history-pin",
                label: historyContextMenu.thread.isPinned ? "取消置顶" : "置顶任务",
                icon: <IconPin />,
                onSelect: () => void toggleThreadPinned(historyContextMenu.thread)
              }]}
            />
          ) : null}
        </div>

        <button
          className="sidebar-settings"
          onClick={() => {
            if (config) {
              resetConfigDraft(config);
            }
            setSettingsTab("provider");
            setIsSettingsOpen(true);
          }}
        >
          <span className="sidebar-settings-main">
            <IconGear />
            <span>设置</span>
          </span>
          <span className="sidebar-settings-help">
            <IconHelpCircle />
          </span>
        </button>
      </aside>

      {isHistorySearchOpen ? (
        <div className="history-search-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsHistorySearchOpen(false); }}>
          <section className="history-search-dialog" role="dialog" aria-modal="true" aria-label="搜索历史对话">
            <div className="history-search-header">
              <strong>搜索历史对话</strong>
              <button className="history-search-close" type="button" onClick={() => setIsHistorySearchOpen(false)} title="关闭"><IconClose /></button>
            </div>
            <div className="history-search-input-wrap"><IconSearch /><input autoFocus value={historySearchQuery} onChange={(event) => setHistorySearchQuery(event.target.value)} placeholder="输入关键词，搜索标题和历史消息" /></div>
            <div className="history-search-hint">双击结果即可快速打开该对话</div>
            <div className="history-search-results">
              {isHistorySearchLoading ? <div className="history-search-empty">正在搜索...</div> : null}
              {!isHistorySearchLoading && historySearchResults.length === 0 ? <div className="history-search-empty">没有匹配的历史对话</div> : null}
              {!isHistorySearchLoading ? historySearchResults.map((result) => (
                <button
                  key={result.thread.id}
                  className={`history-search-result ${result.thread.id === selectedThreadId ? "is-current" : ""}`}
                  type="button"
                  onDoubleClick={() => {
                    setIsHistorySearchOpen(false);
                    void openThread(result.thread.id, { scrollToLatest: true });
                  }}
                >
                  <span className="history-search-result-title">{result.thread.title}</span>
                  <span className="history-search-result-meta">{result.thread.mode === "project" ? "项目对话" : "普通对话"} · {formatRelativeTime(result.thread.updatedAt)}</span>
                  {result.snippet ? <span className="history-search-result-snippet">{result.snippet}</span> : null}
                </button>
              )) : null}
            </div>
          </section>
        </div>
      ) : null}

      {!isSidebarCollapsed ? (
        <PanelResizeHandle
          pane="sidebar"
          active={resizingPane === "sidebar"}
          onPointerDown={() => setResizingPane("sidebar")}
        />
      ) : null}

      <main className="workspace">
        {!isTerminalOpen ? (
          <div className="workspace-controls">
            <button
              type="button"
              className="workspace-control-button"
              title="显示终端"
              aria-label="显示终端"
              onClick={() => {
                setRightWorkspaceTab("files");
                setIsTerminalOpen(true);
              }}
            >
              <IconTerminal />
            </button>
          </div>
        ) : null}
        {(pendingApprovals.length > 0 || pendingPrompts.length > 0) && (
          <div className="pending-strip">
            {pendingApprovals.length > 0 ? (
              <div className="pending-pill">
                <span className="pending-count">{pendingApprovals.length}</span>
                <span>待审批</span>
              </div>
            ) : null}
            {pendingPrompts.length > 0 ? (
              <button
                type="button"
                className="pending-pill"
                onClick={() => document.getElementById(`user-input-prompt-${pendingPrompts[0]?.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              >
                <span className="pending-count">{pendingPrompts.length}</span>
                <span>需要选择</span>
              </button>
            ) : null}
          </div>
        )}

        <section className="chat-canvas">
          <div
            ref={chatScrollRef}
            className={`chat-scroll ${showWelcome ? "welcome-mode" : ""}`}
            onScroll={handleTranscriptScroll}
          >
            {!showWelcome ? (
              <div className="conversation-turn-rail-shell">
                <ConversationTurnRail turns={conversationTurns} />
              </div>
            ) : null}
            {showWelcome ? (
              <div className="welcome-empty-state" />
            ) : (
              <div ref={chatTranscriptRef} className="chat-transcript task-timeline">
                {gpaState.stage !== "off" ? <PlanTimeline state={gpaState} /> : null}
                {timelineEntries.map((entry) =>
                  entry.kind === "message" ? (
                    renderTranscriptMessage(entry.message, activeAssistantLabel, {
                      editingMessage: editingUserMessage,
                      onEditDraftChange: (content) =>
                        setEditingUserMessage((current) => current ? { ...current, content } : current),
                      onCopy: (content) => void copyUserMessage(content),
                      onEdit: beginUserMessageEdit,
                      onEditCancel: cancelUserMessageEdit,
                      onEditSubmit: () => void submitUserMessageEdit()
                    })
                  ) : entry.kind === "file-summary" ? (
                    <FileChangeSummary
                      key={entry.id}
                      files={entry.files}
                      onOpenFolder={(filePath) => void openGeneratedFileLocation(filePath)}
                    />
                  ) : entry.kind === "directory-read-group" ? (
                    <DirectoryReadGroup key={entry.id} directory={entry.directory} count={entry.count} />
                  ) : (
                    <ExecutionStep key={entry.id} toolCall={entry.toolCall} />
                  )
                )}
                {pendingApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    resolving={resolvingApprovalId === approval.id}
                    onResolve={(decision, mode) => void resolvePendingApproval(approval.id, decision, mode)}
                  />
                ))}
                {userInputPrompts.map((prompt) => (
                  <UserInputPromptCard
                    key={prompt.id}
                    prompt={prompt}
                    resolving={resolvingPromptId === prompt.id}
                    canAnswer={selectedThreadStatus === "waiting"}
                    onAnswer={(answers) => void answerPendingPrompt(prompt, answers)}
                  />
                ))}
                {gpaState.awaitingConfirmation === "goal" || gpaState.awaitingConfirmation === "plan" ? (
                  <GpaConfirmationCard
                    stage={gpaState.awaitingConfirmation}
                    disabled={gpaRevisionSubmitting}
                    isEditing={gpaRevisionOpen}
                    revisionDraft={gpaRevisionDraft}
                    revisionRef={gpaRevisionRef}
                    onConfirm={() => void confirmGpaStage()}
                    onRevise={openGpaRevision}
                    onRevisionChange={setGpaRevisionDraft}
                    onRevisionCancel={cancelGpaRevision}
                    onRevisionSubmit={() => void submitGpaRevision()}
                  />
                ) : null}
                {activeStreamingAssistant ? (
                  <section className="streaming-assistant" aria-live="polite">
                    {renderStreamingAssistant(
                      stripAssistantToolMarkup(activeStreamingAssistant.content),
                      `stream-${activeStreamingAssistant.turnRunId}`
                    )}
                  </section>
                ) : null}
                {isTaskProcessing ? (
                  <RuntimeActivityPanel
                    label={taskProcessingLabel}
                    entries={activeRuntimeActivity?.entries ?? []}
                    expanded={isRuntimeActivityExpanded}
                    onToggle={() => {
                      if (!activeRuntimeThreadId) return;
                      setExpandedRuntimeThreads((current) => ({
                        ...current,
                        [activeRuntimeThreadId]: !current[activeRuntimeThreadId]
                      }));
                    }}
                  />
                ) : null}
              </div>
            )}
          </div>

          <footer
            className={`composer-shell ${queuedMessages.length > 0 ? "has-queue" : ""}`}
            style={queuedMessages.length > 0
              ? {
                  "--queued-message-space": `${48 + queuedMessages.length * 40}px`,
                  "--queued-message-scroll-offset": `${3 + queuedMessages.length * 40}px`
                } as CSSProperties
              : undefined}
          >
            {queuedMessages.length > 0 ? (
              <QueuedMessageList
                messages={queuedMessages}
                hasProject={!!selectedProjectCwd}
                deletingId={deletingQueuedMessageId}
                onDelete={(id) => void deleteQueuedMessage(id)}
              />
            ) : null}
            {!showWelcome && !isTranscriptAtLatest ? (
              <button
                type="button"
                className={`scroll-to-latest-button ${queuedMessages.length > 0 ? "with-queue" : ""}`}
                title="定位到最新消息"
                aria-label="定位到最新消息"
                onClick={() => scrollTranscriptToLatest("smooth")}
              >
                <IconChevronDown />
              </button>
            ) : null}
            {selectedProjectCwd ? (
              <button
                type="button"
                className="composer-project-pill"
                title={`打开文件夹：${selectedProjectCwd}`}
                onClick={() => void openProjectFolder(selectedProjectCwd)}
              >
                <IconFolder />
                <span>{getFileLeafName(selectedProjectCwd)}</span>
              </button>
            ) : null}
            <div className="chat-composer">
              {composerAttachments.length > 0 ? (
                <div className="composer-attachments" aria-label="已添加到聊天的上下文">
                  {composerAttachments.map((attachment) => (
                    <ComposerAttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={() => removeComposerAttachment(attachment.id)}
                    />
                  ))}
                </div>
              ) : null}
              <textarea
                ref={composerRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                onPaste={(event) => {
                  if (event.clipboardData.files.length > 0) {
                    event.preventDefault();
                    void addDroppedFiles(event.clipboardData.files);
                  }
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (event.dataTransfer.files.length > 0) void addDroppedFiles(event.dataTransfer.files);
                }}
                placeholder="随心输入"
              />
              <div className="composer-toolbar">
                <div className="composer-toolbar-left">
                  <div
                    ref={gpaAnchorRef}
                    className="gpa-popover-anchor"
                  >
                    <button
                      className={`composer-icon-button ${gpaMenuOpen ? "is-open" : ""}`}
                      title="添加模式"
                      aria-haspopup="menu"
                      aria-expanded={gpaMenuOpen}
                      onClick={() => {
                        if (gpaMenuOpen) {
                          setGpaMenuOpen(false);
                          setGpaMenuPos(null);
                          setComposerAddMenuView("root");
                          return;
                        }
                        // 计算 popover 出现位置（fixed 坐标，向上展开）
                        const node = gpaAnchorRef.current;
                        if (node) {
                          const rect = node.getBoundingClientRect();
                          setGpaMenuPos({
                            left: rect.left,
                            top: rect.top - 8
                          });
                        }
                        setComposerAddMenuView("root");
                        setGpaMenuOpen(true);
                      }}
                    >
                      <IconPlus />
                    </button>
                  </div>
                  {gpaState.fullAccess ? (
                    <span className="composer-mode-chip composer-mode-chip-full-access" title="完全访问：执行时不再请求确认">
                      <IconShield />
                      <span>完全访问</span>
                      <button
                        className="composer-mode-chip-remove"
                        type="button"
                        title="移除完全访问"
                        aria-label="移除完全访问"
                        onClick={() => void setFullAccess(false)}
                      >
                        <IconClose />
                      </button>
                    </span>
                  ) : null}
                  {gpaState.knowledgeEnabled ? (
                    <span className="composer-mode-chip composer-mode-chip-knowledge" title="开启知识库：本对话可以检索本地知识库">
                      <IconKnowledge />
                      <span>开启知识库</span>
                      <button
                        className="composer-mode-chip-remove"
                        type="button"
                        title="关闭知识库"
                        aria-label="关闭知识库"
                        onClick={() => void setKnowledgeEnabled(false)}
                      >
                        <IconClose />
                      </button>
                    </span>
                  ) : null}
                  {gpaComposerSelected && gpaState.stage !== "off" ? (
                    <span className="composer-mode-chip composer-mode-chip-gpa" title={`GPA 当前阶段：${gpaModeLabel(gpaState.stage)}`}>
                      <IconGpa />
                      <span>开启 GPA</span>
                      <button
                        className="composer-mode-chip-remove"
                        type="button"
                        title="移除 GPA"
                        aria-label="移除 GPA"
                        onClick={() => void handleGpaStageSelect("off")}
                      >
                        <IconClose />
                      </button>
                    </span>
                  ) : null}
                </div>
                <div className="composer-toolbar-right">
                  <ComposerModelPicker
                    triggerLabel={currentModelTriggerLabel}
                    providers={composerProviderOptions}
                    modelGroups={composerModelGroups}
                    selectedProviderId={composerProviderId}
                    selectedModelId={composerModelId}
                    onSelectModel={handleComposerModelChange}
                    disabled={composerProviders.length === 0}
                  />
                  <ContextUsageControl
                    usage={contextUsage}
                    open={isContextReportOpen}
                    onToggle={() => setIsContextReportOpen((current) => !current)}
                    onClose={() => setIsContextReportOpen(false)}
                  />
                  <button
                    className={`send-button ${isActiveThreadExecuting ? "running" : ""}`}
                    onClick={() => void handleComposerPrimaryAction()}
                    disabled={composerPrimaryAction.disabled}
                    title={composerPrimaryAction.title}
                    aria-label={composerPrimaryAction.ariaLabel}
                  >
                    {isActiveThreadExecuting ? "停止" : "发送"}
                  </button>
                </div>
              </div>
            </div>
          </footer>
        </section>
      </main>

      {isTerminalOpen ? (
        <PanelResizeHandle
          pane="right-workspace"
          active={resizingPane === "right-workspace"}
          onPointerDown={() => setResizingPane("right-workspace")}
        />
      ) : null}

      {isTerminalOpen ? (
        <RightWorkspacePanel
          activeTab={rightWorkspaceTab}
          onTabChange={setRightWorkspaceTab}
          onHide={() => setIsTerminalOpen(false)}
          projectRoot={selectedThread?.cwd ?? ""}
          onAddAttachment={addComposerAttachment}
          projectFiles={projectFiles}
          projectFilesLoading={isProjectFilesLoading}
          previewTabs={previewTabs}
          selectedProjectFile={selectedProjectFile}
          projectFilePreview={projectFilePreview}
          onSelectProjectFile={openProjectPreview}
          onSelectPreviewTab={(path) => {
            if (!selectedThreadId) {
              return;
            }
            setActivePreviewPathByThread((current) => ({
              ...current,
              [selectedThreadId]: path
            }));
          }}
          onClosePreviewTab={(path) => {
            if (!selectedThreadId) {
              return;
            }
            let nextTabs: string[] = [];
            setPreviewTabsByThread((current) => ({
              ...current,
              [selectedThreadId]: (() => {
                nextTabs = (current[selectedThreadId] ?? []).filter((entry) => entry !== path);
                return nextTabs;
              })()
            }));
            setActivePreviewPathByThread((current) => {
              return {
                ...current,
                [selectedThreadId]:
                  current[selectedThreadId] === path ? nextTabs[nextTabs.length - 1] ?? null : current[selectedThreadId] ?? null
              };
            });
          }}
          browserTabs={snapshot?.browserTabs ?? []}
          onCloseBrowserTab={(tabId) => {
            if (!selectedThreadId) {
              return;
            }
            void window.codexh.closeBrowserTab({ threadId: selectedThreadId, tabId });
          }}
          threadId={selectedThreadId}
          terminalTabs={currentTerminalTabs}
          activeTerminalSessionId={activeTerminalSessionId}
          shell={activeTerminalSession?.shell ?? "PowerShell"}
          cwd={activeTerminalSession?.cwd ?? ""}
          output={activeTerminalSession?.output ?? ""}
          input={activeTerminalInput}
          scrollRef={terminalScrollRef}
          onInputChange={setActiveTerminalInput}
          onSubmit={submitTerminalInput}
          onSelectTerminalTab={(sessionId) => {
            if (!selectedThreadId) {
              return;
            }
            setActiveTerminalTabByThread((current) => ({
              ...current,
              [selectedThreadId]: sessionId
            }));
          }}
          onAddTerminalTab={() => {
            if (!selectedThreadId) {
              return;
            }
            const newId = globalThis.crypto.randomUUID();
            const nextTitle = `终端 ${currentTerminalTabs.length + 1}`;
            setTerminalTabsByThread((current) => ({
              ...current,
              [selectedThreadId]: [...(current[selectedThreadId] ?? []), { id: newId, title: nextTitle }]
            }));
            setActiveTerminalTabByThread((current) => ({
              ...current,
              [selectedThreadId]: newId
            }));
          }}
          onCloseTerminalTab={(sessionId) => {
            if (!selectedThreadId) {
              return;
            }
            const remaining = currentTerminalTabs.filter((tab) => tab.id !== sessionId);
            setTerminalTabsByThread((current) => ({
              ...current,
              [selectedThreadId]: remaining
            }));
            setActiveTerminalTabByThread((current) => ({
              ...current,
              [selectedThreadId]: remaining[remaining.length - 1]?.id ?? ""
            }));
            setTerminalInputsByThread((current) => {
              const nextSessions = { ...(current[selectedThreadId] ?? {}) };
              delete nextSessions[sessionId];
              return {
                ...current,
                [selectedThreadId]: nextSessions
              };
            });
            setTerminalSessionsByThread((current) => {
              const nextSessions = { ...(current[selectedThreadId] ?? {}) };
              delete nextSessions[sessionId];
              return {
                ...current,
                [selectedThreadId]: nextSessions
              };
            });
            void window.codexh.closeTerminal({ threadId: selectedThreadId, sessionId });
          }}
          hasThread={Boolean(selectedThreadId)}
        />
      ) : null}

      {isSettingsOpen ? (
        <div
          className="settings-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <div className="settings-dialog">
            <div className="settings-topbar">
              <h2>{settingsTitle}</h2>
              <button className="settings-close-button" onClick={() => setIsSettingsOpen(false)} title="关闭">
                <IconClose />
              </button>
            </div>

            <div className="settings-layout">
              <aside className="settings-sidebar">
                <div className="settings-tab-strip settings-tab-strip-vertical">
                  {SETTINGS_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      className={`settings-strip-tab ${settingsTab === tab.id ? "active" : ""}`}
                      onClick={() => setSettingsTab(tab.id)}
                      title={tab.hint}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </aside>

              <div className="settings-body">
              {settingsTab === "general" ? (
                <div className="settings-section">
                  <div className="summary-grid">
                    <article className="summary-card">
                      <span>Threads</span>
                      <strong>{threads.length}</strong>
                    </article>
                    <article className="summary-card">
                      <span>Skills</span>
                      <strong>{skills.length}</strong>
                    </article>
                    <article className="summary-card">
                      <span>Providers</span>
                      <strong>{config?.providers.length ?? 0}</strong>
                    </article>
                    <article className="summary-card">
                      <span>Models</span>
                      <strong>{config?.models.length ?? 0}</strong>
                    </article>
                  </div>

                  <div className="config-block">
                    <div className="section-copy">
                      <strong>当前默认配置</strong>
                      <span>这里展示当前应用正在使用的全局默认供应商、模型和桌面运行策略。</span>
                    </div>
                    <div className="stack-list">
                      <article className="stack-card compact">
                        <strong>默认供应商</strong>
                        <span>{config?.defaultProvider ?? "未配置"}</span>
                      </article>
                      <article className="stack-card compact">
                        <strong>默认模型</strong>
                        <span>{config?.defaultModel ?? "未配置"}</span>
                      </article>
                      <article className="stack-card compact">
                        <strong>审批模式</strong>
                        <span>{config?.desktop.approvals ?? "prompt"}</span>
                      </article>
                      <article className="stack-card compact">
                        <strong>内置浏览器</strong>
                        <span>{config?.desktop.inAppBrowser ? "已启用" : "已关闭"}</span>
                      </article>
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === "provider" ? (
                <div className="settings-section provider-settings-section">
                  {configDraft ? (
                    <div className="provider-settings-layout">
                      <aside className="provider-list-panel">
                        <div className="provider-list-header">
                          <strong className="provider-list-title">提供商</strong>
                          <button className="settings-add-provider" onClick={addCustomProvider}>
                            + 自定义
                          </button>
                        </div>
                        <div className="provider-list-scroll">
                          {configDraft.providers.map((provider) => (
                            <div key={provider.id} className="provider-list-card-row">
                              <button
                                className={`provider-list-card ${settingsProvider?.id === provider.id ? "selected" : ""}`}
                                onClick={() => {
                                  setSettingsProviderId(provider.id);
                                  setNewModelId("");
                                  setNewModelDisplayName("");
                                }}
                              >
                                <strong>{getProviderDisplayName(provider)}</strong>
                              </button>
                              <button
                                className="provider-remove-button"
                                onClick={() => removeProvider(provider.id)}
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
                              <label className="settings-field full">
                                <span>供应商</span>
                                <input
                                  value={settingsProvider.name ?? ""}
                                  onChange={(event) =>
                                    updateProviderDraft(settingsProvider.id, { name: event.target.value })
                                  }
                                  placeholder="例如 OpenAI / 英伟达 / 企业网关"
                                />
                              </label>

                              <label className="settings-field full">
                                <span>模式设置</span>
                                <select
                                  value={settingsProvider.type}
                                  onChange={(event) =>
                                    updateProviderDraft(settingsProvider.id, {
                                      type: event.target.value as ProviderType
                                    })
                                  }
                                >
                                  {PROVIDER_TYPE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </label>

                              <label className="settings-field">
                                <span>调用 URL</span>
                                <input
                                  value={settingsProvider.baseUrl ?? ""}
                                  onChange={(event) =>
                                    updateProviderDraft(settingsProvider.id, { baseUrl: event.target.value })
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
                                    setProviderSecretDrafts((current) => ({
                                      ...current,
                                      [settingsProvider.id]: event.target.value
                                    }))
                                  }
                                  placeholder="输入 API Key，留空则保留当前值"
                                />
                              </label>
                            </div>

                            <div className="provider-model-section">
                              <div className="section-copy section-copy-with-action">
                                <div>
                                  <strong>模型列表</strong>
                                  <span>保存后，聊天窗口会按这里的供应商和模型列表进行筛选。</span>
                                </div>
                                <button
                                  className="model-fetch-button"
                                  onClick={() => void fetchAndShowProviderModels(settingsProvider.id)}
                                  disabled={isFetchingModels || !settingsProvider.baseUrl?.trim()}
                                  title="从供应商接口拉取所有可用模型"
                                >
                                  {isFetchingModels ? "获取中…" : "获取模型"}
                                </button>
                              </div>

                              <div className="provider-model-box">
                                {settingsProviderModels.length > 0 ? (
                                  settingsProviderModels.map((model) => (
                                    <div key={model.id} className="provider-model-row">
                                      <div className="provider-model-copy">
                                        <strong>{model.id}</strong>
                                        {model.displayName !== model.id ? <span>{model.displayName}</span> : null}
                                        {modelTestResults[getModelProfileKey(settingsProvider.id, model.id)] ? (
                                          <span className="model-test-result">
                                            延迟 {formatLatency(modelTestResults[getModelProfileKey(settingsProvider.id, model.id)].latencyMs)}
                                            <i aria-hidden="true">·</i>
                                            输出 {modelTestResults[getModelProfileKey(settingsProvider.id, model.id)].outputTokens} Tokens
                                            <i aria-hidden="true">·</i>
                                            {formatTokensPerSecond(modelTestResults[getModelProfileKey(settingsProvider.id, model.id)].tokensPerSecond)}
                                          </span>
                                        ) : null}
                                        <span
                                          className={`model-agent-capability ${model.agentCapability ?? "unknown"}`}
                                          title={
                                            model.agentCapability === "verified"
                                              ? "已验证连接、原生工具调用、工具结果回传和最终回复。"
                                              : model.agentCapability === "unsupported"
                                                ? model.agentCapabilityReason ?? "该模型不适合 Agent 工具调用。"
                                                : "请先运行模型测试，验证 Agent 工具协议。"
                                          }
                                        >
                                          {model.agentCapability === "verified"
                                            ? "Agent 已验证"
                                            : model.agentCapability === "unsupported"
                                              ? "仅聊天"
                                              : "未验证 Agent"}
                                        </span>
                                      </div>
                                      <div className="provider-model-actions">
                                        <label className="model-capability-toggle" title="启用后，此模型可以接收文件、文件夹和图片附件。">
                                          <input
                                            type="checkbox"
                                            checked={model.supportsMultimodalInput}
                                            onChange={(event) =>
                                              updateModelDraft(model.id, { supportsMultimodalInput: event.target.checked })
                                            }
                                          />
                                          <span>支持多模态</span>
                                        </label>
                                        {(() => {
                                          const isTesting = testingModelKey === getModelProfileKey(settingsProvider.id, model.id);
                                          return (
                                            <button
                                              className={`settings-mini-button model-test-button${isTesting ? " is-testing" : ""}`}
                                              onClick={() => void checkProviderModel(settingsProvider, model)}
                                              disabled={isTesting}
                                              aria-busy={isTesting}
                                            >
                                              <span className="model-test-label">
                                                {isTesting ? "测试中" : "测试"}
                                                {isTesting ? <i aria-hidden="true" /> : null}
                                              </span>
                                            </button>
                                          );
                                        })()}
                                        <button
                                          className="settings-icon-button"
                                          onClick={() => removeModel(model.id)}
                                          title="删除模型"
                                        >
                                          <IconClose />
                                        </button>
                                      </div>
                                    </div>
                                  ))
                                ) : (
                                  <div className="provider-empty-state">
                                    当前供应商还没有模型，先在下方添加一个模型即可。
                                  </div>
                                )}

                                <div className="model-add-row">
                                  <input
                                    value={newModelId}
                                    onChange={(event) => setNewModelId(event.target.value)}
                                    placeholder="模型名称"
                                  />
                                  <input
                                    value={newModelDisplayName}
                                    onChange={(event) => setNewModelDisplayName(event.target.value)}
                                    placeholder="显示名称（可选）"
                                  />
                                  <button
                                    className="model-add-button"
                                    onClick={() => addModelToProvider(settingsProvider.id)}
                                    title="添加模型"
                                  >
                                    <IconPlus />
                                  </button>
                                </div>
                              </div>
                            </div>

                            <div className="settings-save-row">
                              <span className="subtle-inline">
                                当前默认：{configDraft.defaultProvider} / {configDraft.defaultModel}
                              </span>
                              <button className="button warm" onClick={() => void saveConfigDraft()}>
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
                          onClick={() => void refreshConfig()}
                        >
                          重试加载
                        </button>
                        <button
                          className="button ghost"
                          onClick={() => {
                            console.log("[renderer] current config", config);
                            console.log("[renderer] current configDraft", configDraft);
                            showNotice(`config=${config ? "ok" : "null"}, configDraft=${configDraft ? "ok" : "null"}`);
                          }}
                        >
                          检查状态
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {settingsTab === "multimodal" ? (
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
                          ? "手动添加后会出现在聊天下拉；可随时移除。"
                          : `从统一模型库中分配${role === "image" ? "图片" : "视频"}生成模型。`;
                        return (
                          <div key={role} className={`config-block multimodal-model-panel is-${role}`}>
                            <div className="section-copy section-copy-with-action">
                              <div>
                                <strong>{title}</strong>
                                <span>{hint}</span>
                              </div>
                              <button className="model-add-button" onClick={() => {
                                setMultimodalPickerRole(role);
                                setMultimodalPickerSelected([]);
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
                                  : false;
                                const provider = configDraft.providers.find((entry) => entry.id === model.providerId);
                                return (
                                  <div key={modelKey(model.providerId, model.id)} className="provider-model-row multimodal-list-row">
                                    <div className="provider-model-copy multimodal-list-main">
                                      <strong>{model.displayName}</strong>
                                      <span className="multimodal-list-meta">{provider ? getProviderDisplayName(provider) : model.providerId}</span>
                                      {role === "reasoning" ? <em className="mm-tag is-chat">聊天下拉</em> : null}
                                      {isDefault ? <em className="mm-tag is-default">默认</em> : null}
                                      {model.supportsMultimodalInput ? <em className="mm-tag is-mm">多模态</em> : null}
                                      {model.supportsVideoGeneration ? <em className="mm-tag is-video">视频</em> : null}
                                    </div>
                                    <div className="provider-model-actions">
                                      {kind && !isDefault ? <button className="settings-mini-button" onClick={() => setMultimodalDefault(kind, model.providerId, model.id)}>设为默认</button> : null}
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
                      })}

                      <div className="settings-save-row">
                        <span className="subtle-inline">
                          操作即保存 · 默认图片：{configDraft.multimodal.image.defaultModelId ?? "未设置"}
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
              ) : null}

              {settingsTab === "update" ? (
                <div className="settings-section">
                  <div className="config-block update-settings-panel">
                    <div className="section-copy section-copy-with-action">
                      <div>
                        <strong>CodeXH 更新</strong>
                        <span>启动时会静默检查；安装更新会保留本地聊天、项目、知识库和日志。</span>
                      </div>
                      <button
                        className="button ghost"
                        onClick={() => void checkForUpdates()}
                        disabled={updateState?.phase === "checking" || updateState?.phase === "downloading" || updateState?.phase === "installing"}
                      >
                        {updateState?.phase === "checking" ? "检查中" : "检查更新"}
                      </button>
                    </div>
                    <div className="update-version-row">
                      <span>当前版本</span>
                      <strong>{updateState?.currentVersion ?? "读取中"}</strong>
                      {updateState?.remoteVersion ? <><span>最新版本</span><strong>{updateState.remoteVersion}</strong></> : null}
                      {updateState ? <span className={`update-phase ${updateState.phase}`}>{formatUpdatePhase(updateState.phase)}</span> : null}
                    </div>
                    {updateState?.insecureTransport ? (
                      <div className="update-security-warning">当前更新源使用 HTTP。下载前会要求确认，建议服务端升级为 HTTPS。</div>
                    ) : null}
                    {updateState?.missingSha256 ? (
                      <div className="update-security-warning">更新清单未提供 sha256。下载前会要求确认，建议服务端补齐校验值。</div>
                    ) : null}
                    {updateState?.changelog ? <pre className="update-changelog">{updateState.changelog}</pre> : null}
                    {updateState?.phase === "downloading" ? (
                      <div className="update-progress"><span style={{ width: `${updateState.progress ?? 0}%` }} /></div>
                    ) : null}
                    {updateState?.error ? <div className="update-error">{updateState.error}</div> : null}
                    {updateState?.phase === "available" ? (
                      <div className="action-row">
                        <button className="button warm" onClick={() => void downloadAvailableUpdate()} disabled={!updateState.isPackaged}>
                          {updateState.isPackaged ? "下载更新" : "开发模式不可下载"}
                        </button>
                      </div>
                    ) : null}
                    {updateState?.phase === "downloaded" ? (
                      <div className="action-row">
                        <button className="button warm" onClick={() => void installDownloadedUpdate()}>立即安装并重启</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {settingsTab === "knowledge" ? (
                <div className="settings-section">
                  <div className="config-block">
                    <div className="section-copy">
                      <strong>导入知识库</strong>
                      <span>按行填写本地文档路径，导入后会生成 OKF Bundle 并绑定到当前线程。</span>
                    </div>
                    <input
                      value={knowledgeName}
                      onChange={(event) => setKnowledgeName(event.target.value)}
                      placeholder="知识库名称"
                    />
                    <select
                      value={knowledgeScope}
                      onChange={(event) => setKnowledgeScope(event.target.value as KnowledgeScope)}
                    >
                      <option value="global">全局知识库</option>
                      <option value="project">项目知识库</option>
                      <option value="imported">仅当前会话导入</option>
                    </select>
                    <div className="knowledge-source-list" aria-label="待导入附件">
                      {knowledgeSources.length ? knowledgeSources.map((source) => (
                        <div key={source.path} className={`knowledge-source-item ${source.kind}`}>
                          <span className="knowledge-source-icon" aria-hidden>
                            {source.kind === "folder" ? <IconFolder /> : <IconFile />}
                          </span>
                          <code title={source.path}>{source.path}</code>
                          <button
                            type="button"
                            className="knowledge-source-remove"
                            onClick={() => removeKnowledgeSource(source.path)}
                            title="移除附件"
                            aria-label={`移除 ${source.path}`}
                          >
                            <IconClose />
                          </button>
                        </div>
                      )) : (
                        <div className="knowledge-source-empty">选择文件或文件夹后会显示在这里。</div>
                      )}
                    </div>
                    {knowledgeScope === "project" && !canImportProjectKnowledge ? (
                      <div className="detail-empty">项目知识库需要先选中一个项目模式线程。</div>
                    ) : null}
                    <div className="action-row">
                      <button
                        className="button ghost"
                        onClick={() => void chooseKnowledgeSources("files")}
                      >
                        <IconFile />
                        选择文件
                      </button>
                      <button
                        className="button ghost"
                        onClick={() => void chooseKnowledgeSources("folders")}
                      >
                        <IconFolder />
                        选择文件夹
                      </button>
                      <button
                        className="button primary"
                        onClick={() => void importKnowledge()}
                        disabled={knowledgeScope === "project" && !canImportProjectKnowledge}
                      >
                        导入并生成 Bundle
                      </button>
                      {knowledgeScope === "project" && !canImportProjectKnowledge ? (
                        <span className="action-disabled-hint">需先切换到项目聊天</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="config-block">
                    <div className="section-copy">
                      <strong>当前线程已绑定</strong>
                      <span>这里显示当前线程可见的知识库集合。</span>
                    </div>
                    <div className="stack-list">
                      {snapshot?.knowledgeBases.length ? (
                        snapshot.knowledgeBases.map((knowledgeBase) => (
                          <article key={knowledgeBase.id} className="stack-card compact">
                            <strong>{knowledgeBase.displayName}</strong>
                            <span>
                              {knowledgeBase.scope} · {knowledgeBase.bundleRoot}
                            </span>
                          </article>
                        ))
                      ) : (
                        <div className="detail-empty">当前线程还没有绑定知识库。</div>
                      )}
                    </div>
                  </div>
                  <div className="config-block knowledge-management-panel">
                    <div className="section-copy section-copy-row">
                      <div>
                        <strong>知识库管理</strong>
                        <span>全局资料自动对所有聊天可见；项目资料仅对同一项目可见。</span>
                      </div>
                      <button className="button ghost compact-icon-button" onClick={() => void refreshKnowledgeBases()} title="刷新列表">
                        <IconRefresh />
                      </button>
                    </div>
                    <div className="knowledge-base-list">
                      {knowledgeBases.length ? knowledgeBases.map((knowledgeBase) => {
                        const documents = knowledgeDocuments[knowledgeBase.id];
                        const isBusy = knowledgeBusyId === knowledgeBase.id;
                        return (
                          <article key={knowledgeBase.id} className="knowledge-base-row">
                            <div className="knowledge-base-main">
                              <div className="knowledge-base-title">
                                <strong>{knowledgeBase.displayName}</strong>
                                <span className={`knowledge-scope-pill ${knowledgeBase.scope}`}>{formatKnowledgeScope(knowledgeBase.scope)}</span>
                                <span className={`knowledge-status ${knowledgeBase.status}`}>{formatKnowledgeStatus(knowledgeBase.status)}</span>
                              </div>
                              {knowledgeBase.scopeTargetLabel ? (
                                <span className={`knowledge-base-target ${knowledgeBase.scope}`} title={knowledgeBase.scopeTargetLabel}>
                                  {knowledgeBase.scopeTargetLabel}
                                </span>
                              ) : null}
                              <span className="knowledge-base-meta">
                                {knowledgeBase.documentCount} 个文档 · {knowledgeBase.chunkCount} 个片段 · {formatKnowledgeBytes(knowledgeBase.indexedBytes)} · 更新于 {formatRelativeTime(knowledgeBase.updatedAt)}
                              </span>
                            </div>
                            <div className="knowledge-base-actions">
                              <button className="button ghost" onClick={() => void toggleKnowledgeDocuments(knowledgeBase.id)}>
                                {documents ? "收起文档" : "查看文档"}
                              </button>
                              <button className="button ghost" onClick={() => void refreshKnowledgeBase(knowledgeBase.id)} disabled={isBusy}>
                                {isBusy ? "处理中" : "刷新"}
                              </button>
                              <button className="button ghost danger-icon-button" onClick={() => void deleteKnowledgeBase(knowledgeBase.id)} disabled={isBusy} title="删除知识库">
                                <IconTrash />
                              </button>
                            </div>
                            {documents ? (
                              <div className="knowledge-document-list">
                                {documents.map((document) => (
                                  <div key={document.id} className={`knowledge-document-row ${document.status}`}>
                                    <IconFile />
                                    <span title={document.sourcePath}>{document.title}</span>
                                    <small>{document.status === "missing" ? "源文件已删除" : document.status}</small>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </article>
                        );
                      }) : <div className="detail-empty">尚未导入本地知识库。</div>}
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === "skills" ? (
                <div className="settings-section">
                  <div className="config-block">
                    <div className="section-copy">
                      <strong>已加载 Skills</strong>
                      <span>展示当前应用可见的技能清单、作用域和实际路径。</span>
                    </div>
                    <div className="stack-list">
                      {skills.map((skill) => (
                        <article key={skill.id} className="stack-card">
                          <div className="stack-card-header">
                            <strong>{skill.displayName ?? skill.qualifiedName}</strong>
                            <div className="skill-metadata-pills">
                              <span className="pill">{skill.pluginId ? "插件" : skill.scope}</span>
                              {skill.scope === "user" && !skill.pluginId ? (
                                <span className="pill skill-domain-pill">领域：{skill.domain ?? "通用"}</span>
                              ) : null}
                            </div>
                          </div>
                          <p>{skill.description}</p>
                          <span>{skill.skillPath}</span>
                        </article>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === "mcp" && false ? (
                <div className="settings-section">
                  <div className="config-block">
                    <div className="section-copy">
                      <strong>MCP 服务</strong>
                      <span>启用后的服务可在聊天任务中被模型调用。</span>
                    </div>
                    <div className="stack-list">
                      {(configDraft?.mcpServers ?? []).length ? (
                        (configDraft?.mcpServers ?? []).map((server) => (
                          <article key={server.id} className="stack-card compact mcp-settings-card">
                            <div className="stack-card-header">
                              <strong>{server.name}</strong>
                              <label className="model-capability-toggle">
                                <input
                                  type="checkbox"
                                  checked={server.enabled}
                                  onChange={(event) =>
                                    setConfigDraft((current) => {
                                      if (!current) {
                                        return current;
                                      }
                                      const next = cloneConfig(current);
                                      next.mcpServers = next.mcpServers.map((item) =>
                                        item.id === server.id ? { ...item, enabled: event.target.checked } : item
                                      );
                                      return next;
                                    })
                                  }
                                />
                                <span>{server.enabled ? "已启用" : "已停用"}</span>
                              </label>
                            </div>
                            <span>{server.url ?? server.command ?? server.id}</span>
                          </article>
                        ))
                      ) : (
                        <div className="detail-empty">当前还没有配置 MCP 服务。</div>
                      )}
                    </div>
                  </div>
                  <div className="settings-save-row">
                    <span className="subtle-inline">保存后会同步到聊天运行时。</span>
                    <button className="button warm" onClick={() => void saveConfigDraft()} disabled={!configDraft}>
                      保存
                    </button>
                  </div>
                </div>
              ) : null}

              {settingsTab === "mcp" ? (
                <div className="settings-section">
                  <div className="config-block">
                    <div className="section-copy-with-action">
                      <div>
                        <strong>MCP 服务</strong>
                        <span>配置、测试和管理全局 MCP 服务。模型会在任务中动态发现已启用服务的工具。</span>
                      </div>
                      <button className="button primary" type="button" onClick={addMcpServer} disabled={!configDraft}>添加服务</button>
                    </div>
                    <div className="stack-list">
                      {configDraft?.mcpServers.length ? configDraft.mcpServers.map((server) => {
                        const runtime = mcpRuntimeServers.find((item) => item.id === server.id);
                        const isEditing = editingMcpServerId === server.id;
                        const testResult = mcpTestResults[server.id];
                        const isStdio = (server.transport ?? "stdio") === "stdio";
                        return (
                          <article key={server.id} className="stack-card mcp-settings-card">
                            <div className="stack-card-header">
                              <div className="mcp-server-heading">
                                <strong>{server.name || server.id}</strong>
                                {!isEditing ? <span>{server.command ?? server.url ?? server.id}</span> : null}
                              </div>
                              <div className="action-row">
                                <span className="pill">{runtime?.status.state ?? (server.enabled ? "idle" : "disabled")}</span>
                                <label className="model-capability-toggle">
                                  <input type="checkbox" checked={server.enabled} onChange={(event) => updateMcpServerDraft(server.id, { enabled: event.target.checked })} />
                                  <span>{server.enabled ? "启用" : "停用"}</span>
                                </label>
                              </div>
                            </div>
                            {runtime?.status.error ? <p className="mcp-error">{runtime.status.error}</p> : null}
                            {isEditing ? (
                              <div className="mcp-editor-grid">
                                <label className="settings-field"><span>名称</span><input value={server.name} onChange={(event) => updateMcpServerDraft(server.id, { name: event.target.value })} /></label>
                                <label className="settings-field"><span>ID</span><input value={server.id} onChange={(event) => updateMcpServerDraft(server.id, { id: event.target.value.trim() })} /></label>
                                <label className="settings-field"><span>传输方式</span><select value={server.transport ?? "stdio"} onChange={(event) => updateMcpServerDraft(server.id, { transport: event.target.value, command: event.target.value === "stdio" ? server.command : undefined, url: event.target.value === "stdio" ? undefined : server.url })}><option value="stdio">stdio</option><option value="sse">SSE</option><option value="streamable_http">HTTP</option></select></label>
                                {isStdio ? <>
                                  <label className="settings-field"><span>命令</span><input value={server.command ?? ""} placeholder="npx" onChange={(event) => updateMcpServerDraft(server.id, { command: event.target.value })} /></label>
                                  <label className="settings-field"><span>参数（每行一个）</span><textarea value={(server.args ?? []).join("\n")} onChange={(event) => updateMcpServerDraft(server.id, { args: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label>
                                  <label className="settings-field"><span>工作目录</span><input value={server.cwd ?? ""} onChange={(event) => updateMcpServerDraft(server.id, { cwd: event.target.value || undefined })} /></label>
                                  <label className="settings-field"><span>环境变量（KEY=VALUE，每行一个）</span><textarea value={Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n")} onChange={(event) => updateMcpServerDraft(server.id, { env: parseMcpEnvironment(event.target.value) })} /></label>
                                </> : <label className="settings-field"><span>服务 URL</span><input value={server.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => updateMcpServerDraft(server.id, { url: event.target.value })} /></label>}
                              </div>
                            ) : null}
                            <div className="action-row mcp-actions">
                              <button className="button secondary" type="button" onClick={() => setEditingMcpServerId(isEditing ? null : server.id)}>{isEditing ? "收起" : "编辑"}</button>
                              <button className="button secondary" type="button" disabled={testingMcpServerId === server.id} onClick={() => void testMcpServer(server)}>{testingMcpServerId === server.id ? "测试中" : "测试连接"}</button>
                              <button className="button ghost" type="button" onClick={() => removeMcpServer(server.id)}>删除</button>
                              {testResult ? <span className="subtle-inline">工具 {testResult.tools.length} · 资源 {testResult.resources.length} · 模板 {testResult.resourceTemplates.length}</span> : null}
                            </div>
                            {testResult ? <details className="mcp-test-details"><summary>查看发现的能力</summary><div>{testResult.tools.map((tool) => <span key={tool.name}>{tool.name} {tool.description}</span>)}</div><div>{testResult.resources.map((resource) => <span key={resource.uri}>{resource.name}: {resource.uri}</span>)}</div><div>{testResult.resourceTemplates.map((template) => <span key={template.uriTemplate}>{template.name}: {template.uriTemplate}</span>)}</div></details> : null}
                          </article>
                        );
                      }) : <div className="detail-empty">尚未配置 MCP 服务。</div>}
                    </div>
                  </div>
                  <div className="config-block">
                    <div className="section-copy"><strong>插件提供的 MCP 服务</strong><span>由插件清单管理，只能通过项目插件启用状态控制。</span></div>
                    <div className="stack-list">
                      {mcpRuntimeServers.filter((server) => server.source === "plugin").length ? mcpRuntimeServers.filter((server) => server.source === "plugin").map((server) => <article key={server.id} className="stack-card compact"><div className="stack-card-header"><strong>{server.name}</strong><span className="pill">{server.status.state}</span></div><span>{server.command ?? server.url ?? server.id}</span>{server.status.error ? <p className="mcp-error">{server.status.error}</p> : null}</article>) : <div className="detail-empty">没有插件提供的 MCP 服务。</div>}
                    </div>
                  </div>
                  <div className="settings-save-row"><span className="subtle-inline">保存后立即重建已变更的 MCP 连接。</span><button className="button warm" onClick={() => void saveConfigDraft()} disabled={!configDraft}>保存</button></div>
                </div>
              ) : null}

              {settingsTab === "agent" ? (
                <div className="settings-section">
                  <div className="config-block">
                    <div className="section-copy">
                      <strong>安装机器人工作流包</strong>
                      <span>支持从 GitHub 仓库地址安装，例如 `obra/superpowers`。</span>
                    </div>
                    <div className="action-row stretch">
                      <input
                        value={pluginSource}
                        onChange={(event) => setPluginSource(event.target.value)}
                        placeholder="GitHub 仓库地址或 owner/repo"
                      />
                      <button className="button primary" onClick={() => void installPlugin()}>
                        安装插件
                      </button>
                    </div>
                  </div>

                  <div className="config-block">
                    <div className="section-copy">
                      <strong>项目机器人</strong>
                      <span>只有项目模式线程可以启用项目级机器人 Workflow Pack。</span>
                    </div>
                    <div className="stack-list">
                      {plugins.map((plugin) => {
                        const binding =
                          workflowBindings.find((item) => item.plugin.id === plugin.id)?.binding ?? null;
                        const canToggle = selectedThread?.mode === "project";
                        const enabled = binding?.enabled ?? false;

                        return (
                          <article key={plugin.id} className="stack-card">
                            <div className="stack-card-header">
                              <strong>{plugin.name}</strong>
                              <span className="pill">{plugin.version}</span>
                            </div>
                            <p>{plugin.source}</p>
                            <span>{plugin.installPath}</span>
                            <div className="action-row">
                              <button
                                className="button secondary"
                                onClick={() =>
                                  selectedThreadId &&
                                  void window.codexh.setProjectPluginEnabled({
                                    threadId: selectedThreadId,
                                    pluginId: plugin.id,
                                    enabled: !enabled
                                  })
                                }
                                disabled={!canToggle}
                              >
                                {enabled ? "停用当前项目工作流" : "为当前项目启用"}
                              </button>
                              {!canToggle ? (
                                <span className="subtle-inline">仅项目模式线程可启用</span>
                              ) : null}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}

              {settingsTab === "mcp" && false ? (
                <div className="settings-section">
                  <div className="config-block">
                    <div className="section-copy">
                      <strong>MCP Server 列表</strong>
                      <span>这里展示当前配置文件中可见的 MCP 配置，便于核对 transport、命令和地址。</span>
                    </div>
                    <div className="stack-list">
                      {(configDraft?.mcpServers ?? config?.mcpServers ?? []).length > 0 ? (
                        (configDraft?.mcpServers ?? config?.mcpServers ?? []).map((server) => (
                          <article key={server.id} className="stack-card">
                            <div className="stack-card-header">
                              <strong>{server.name}</strong>
                              <span className="pill">{server.transport ?? "stdio"}</span>
                            </div>
                            <p>{server.command ?? server.url ?? "未配置命令或 URL"}</p>
                            <span>
                              {server.enabled === false ? "已禁用" : "已启用"} · {server.id}
                            </span>
                          </article>
                        ))
                      ) : (
                        <div className="detail-empty">当前还没有 MCP Server 配置。</div>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {isProjectCreateOpen ? (
        <div
          className="project-sheet-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setIsProjectCreateOpen(false);
            }
          }}
        >
          <div className="project-sheet">
            <div className="project-sheet-header">
              <div className="project-sheet-copy">
                <strong>新建项目</strong>
                <span>选择一个文件夹，此项目中的文件操作将限制在该文件夹内。</span>
              </div>
              <button
                className="project-sheet-close"
                onClick={() => setIsProjectCreateOpen(false)}
                title="关闭"
              >
                <IconClose />
              </button>
            </div>
            <label className="settings-field project-sheet-field">
              <span>项目文件夹</span>
              <div className="project-folder-picker">
                <output>{projectPathDraft || "尚未选择文件夹"}</output>
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => void chooseProjectFolder()}
                  disabled={isPickingProjectFolder}
                >
                  <IconFolder />
                  {isPickingProjectFolder ? "正在打开..." : "选择文件夹"}
                </button>
              </div>
            </label>
            <div className="project-sheet-actions">
              <button className="button ghost" onClick={() => setIsProjectCreateOpen(false)}>
                取消
              </button>
              <button
                className="button warm"
                onClick={() => void confirmProjectCreate()}
                disabled={!projectPathDraft || isPickingProjectFolder}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="app-notice-stack" aria-live="polite" aria-atomic="true">
          <section
            className={`app-notice ${notice.tone} ${exitingNoticeId === notice.id ? "is-leaving" : ""}`}
            onMouseEnter={() => setIsNoticeHovered(true)}
            onMouseLeave={() => setIsNoticeHovered(false)}
          >
            <div className="app-notice-copy">
              <strong>{notice.title}</strong>
              {notice.message ? <p>{notice.message}</p> : null}
            </div>
            <button className="app-notice-close" onClick={() => dismissNotice(notice.id)} title="关闭提示">
              <IconClose />
            </button>
          </section>
        </div>
      ) : null}

      {showFetchedModels ? createPortal(
        <div className="fetch-models-overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setShowFetchedModels(false);
          }
        }}>
          <div className="fetch-models-dialog" role="dialog" aria-label="选择要添加的模型">
            <div className="fetch-models-head">
              <strong>选择要添加的模型</strong>
              <button
                type="button"
                onClick={() => setShowFetchedModels(false)}
                title="关闭"
              >
                <IconClose />
              </button>
            </div>
            <div className="fetch-models-list">
              {fetchedModels.map((entry) => {
                const checked = selectedFetchedModelIds.includes(entry.id);
                const already = configDraft?.models.some((model) => model.id === entry.id) ?? false;
                return (
                  <label
                    key={entry.id}
                    className={`fetch-models-item ${checked ? "is-checked" : ""} ${already ? "is-existed" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleFetchedModelSelection(entry.id)}
                    />
                    <div className="fetch-models-copy">
                      <strong>{entry.id}</strong>
                      {entry.displayName && entry.displayName !== entry.id ? (
                        <span>{entry.displayName}</span>
                      ) : null}
                    </div>
                    {already ? <em>已存在</em> : null}
                  </label>
                );
              })}
            </div>
            <div className="fetch-models-actions">
              <button
                className="button ghost"
                onClick={() => {
                  setSelectedFetchedModelIds(
                    fetchedModels
                      .filter((entry) => {
                        return !configDraft?.models.some((model) => model.id === entry.id);
                      })
                      .map((entry) => entry.id)
                  );
                }}
              >
                全选
              </button>
              <button
                className="button ghost"
                onClick={() => setShowFetchedModels(false)}
              >
                取消
              </button>
              <button
                className="button warm"
                onClick={applyFetchedModels}
                disabled={selectedFetchedModelIds.length === 0}
              >
                添加到模型列表（{selectedFetchedModelIds.length}）
              </button>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {multimodalPickerRole && configDraft ? createPortal(
        <div className="fetch-models-overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setMultimodalPickerRole(null);
            setMultimodalPickerSelected([]);
          }
        }}>
          <div className="fetch-models-dialog multimodal-picker-dialog" role="dialog" aria-label="选择模型角色">
            <div className="fetch-models-head">
              <strong>添加到{multimodalPickerRole === "reasoning" ? "推理模型" : multimodalPickerRole === "image" ? "图片模型" : "视频模型"}</strong>
              <button type="button" onClick={() => { setMultimodalPickerRole(null); setMultimodalPickerSelected([]); }} title="关闭"><IconClose /></button>
            </div>
            <div className="fetch-models-list multimodal-picker-list">
              {configDraft.models
                .filter((model) => multimodalPickerRole === "reasoning"
                  ? !isReasoningModel(model)
                  : model.role !== multimodalPickerRole)
                .sort((left, right) => {
                  const score = (model: typeof left) => {
                    if (multimodalPickerRole === "video") return model.supportsVideoGeneration ? 2 : model.supportsMultimodalInput ? 1 : 0;
                    return model.supportsMultimodalInput ? 1 : 0;
                  };
                  return score(right) - score(left) || left.id.localeCompare(right.id);
                })
                .map((model) => {
                  const key = modelKey(model.providerId, model.id);
                  const checked = multimodalPickerSelected.includes(key);
                  const provider = configDraft.providers.find((entry) => entry.id === model.providerId);
                  const currentRoleLabel = model.role === "reasoning"
                    ? "已在推理"
                    : model.role === "video"
                      ? "已在视频"
                      : null;
                  return (
                    <label key={key} className={`fetch-models-item multimodal-picker-item ${checked ? "is-checked" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={() => setMultimodalPickerSelected((current) =>
                        current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
                      )} />
                      <div className="fetch-models-copy multimodal-picker-main">
                        <strong>{model.displayName}</strong>
                        <span className="multimodal-list-meta">{provider ? getProviderDisplayName(provider) : model.providerId}</span>
                        {model.supportsMultimodalInput ? <em className="mm-tag is-mm">多模态</em> : null}
                        {model.supportsVideoGeneration ? <em className="mm-tag is-video">视频</em> : null}
                        {currentRoleLabel ? <em className={`mm-tag is-muted is-role-${model.role}`}>{currentRoleLabel}</em> : null}
                      </div>
                    </label>
                  );
                })}
            </div>
            <div className="fetch-models-actions">
              <button className="button ghost" onClick={() => { setMultimodalPickerRole(null); setMultimodalPickerSelected([]); }}>取消</button>
              <button className="button warm" onClick={applyMultimodalPicker} disabled={multimodalPickerSelected.length === 0}>确认添加（{multimodalPickerSelected.length}）</button>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {gpaMenuOpen && gpaMenuPos
        ? createPortal(
            <>
              <div
                className="gpa-backdrop"
                onMouseDown={() => {
                  setGpaMenuOpen(false);
                  setGpaMenuPos(null);
                }}
              />
              <div
                className="gpa-popover"
                role="menu"
                onMouseEnter={clearComposerAddMenuCloseTimer}
                onMouseLeave={scheduleComposerAddMenuClose}
                style={{
                  position: "fixed",
                  left: gpaMenuPos.left,
                  top: gpaMenuPos.top,
                  transform: "translateY(-100%)"
                }}
              >
                <>
                    <button className="gpa-popover-item" role="menuitem" disabled={!composerSupportsMultimodalInput} title={!composerSupportsMultimodalInput ? "当前模型不支持多模态输入" : undefined} onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("root"); }} onClick={() => void chooseComposerFiles(false)}>
                      <span className="gpa-popover-item-icon" aria-hidden><IconFile /></span>
                      <span className="gpa-popover-item-copy">
                        <span className="gpa-popover-item-title">添加文件</span>
                        <span className="gpa-popover-item-hint">选择文件作为任务上下文</span>
                      </span>
                    </button>
                    <button className="gpa-popover-item" role="menuitem" disabled={!composerSupportsMultimodalInput} title={!composerSupportsMultimodalInput ? "当前模型不支持多模态输入" : undefined} onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("root"); }} onClick={() => void chooseComposerFiles(true)}>
                      <span className="gpa-popover-item-icon" aria-hidden><IconImage /></span>
                      <span className="gpa-popover-item-copy">
                        <span className="gpa-popover-item-title">添加图片</span>
                        <span className="gpa-popover-item-hint">选择图片作为视觉参考</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="gpa-popover-item composer-add-menu-parent"
                      role="menuitem"
                      data-composer-add-menu-view="skills"
                      aria-haspopup="menu"
                      aria-expanded={composerAddMenuView === "skills"}
                      onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("skills"); }}
                      onFocus={() => setComposerAddMenuView("skills")}
                    >
                      <span className="gpa-popover-item-icon" aria-hidden><IconSkills /></span>
                      <span className="gpa-popover-item-copy">
                        <span className="gpa-popover-item-title">Skills</span>
                        <span className="gpa-popover-item-hint">为本次任务添加专业技能</span>
                      </span>
                      <IconChevronRight />
                    </button>
                    <button
                      type="button"
                      className="gpa-popover-item composer-add-menu-parent"
                      role="menuitem"
                      data-composer-add-menu-view="mcp"
                      aria-haspopup="menu"
                      aria-expanded={composerAddMenuView === "mcp"}
                      onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("mcp"); }}
                      onFocus={() => setComposerAddMenuView("mcp")}
                    >
                      <span className="gpa-popover-item-icon" aria-hidden><IconMcp /></span>
                      <span className="gpa-popover-item-copy">
                        <span className="gpa-popover-item-title">MCP 服务</span>
                        <span className="gpa-popover-item-hint">指定本次任务优先使用的服务</span>
                      </span>
                      <IconChevronRight />
                    </button>
                    <div className="gpa-popover-divider" />
                </>
                {composerAddMenuView === "skills" ? (
                  <div className="composer-add-menu-submenu" data-composer-add-menu-view="skills" onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("skills"); }}>
                    <div className="composer-add-menu-submenu-title">Skills</div>
                    <div className="composer-add-menu-list">
                      {skills.length > 0 ? skills.map((skill) => (
                        <button
                          key={skill.id}
                          className="gpa-popover-item"
                          role="menuitem"
                          onClick={() => {
                            addComposerAttachment({
                              kind: "skill",
                              skillId: skill.id,
                              label: skill.displayName ?? skill.name,
                              description: skill.shortDescription ?? skill.description
                            });
                            setGpaMenuOpen(false);
                            setGpaMenuPos(null);
                          }}
                        >
                          <span className="gpa-popover-item-icon" aria-hidden><IconSkills /></span>
                          <span className="gpa-popover-item-copy">
                            <span className="gpa-popover-item-title">{skill.displayName ?? skill.name}</span>
                            <span className="gpa-popover-item-hint">{skill.shortDescription ?? skill.description}</span>
                          </span>
                        </button>
                      )) : <span className="composer-add-menu-empty">没有可用的 Skills</span>}
                    </div>
                  </div>
                ) : null}
                {composerAddMenuView === "mcp" ? (
                  <div className="composer-add-menu-submenu" data-composer-add-menu-view="mcp" onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("mcp"); }}>
                    <div className="composer-add-menu-submenu-title">MCP 服务</div>
                    <div className="composer-add-menu-list">
                      {(config?.mcpServers ?? []).filter((server) => server.enabled).map((server) => (
                        <button
                          key={server.id}
                          className="gpa-popover-item"
                          role="menuitem"
                          onClick={() => {
                            addComposerAttachment({
                              kind: "mcp",
                              serverId: server.id,
                              label: server.name,
                              description: server.url ?? server.command ?? server.id
                            });
                            setGpaMenuOpen(false);
                            setGpaMenuPos(null);
                          }}
                        >
                          <span className="gpa-popover-item-icon" aria-hidden><IconMcp /></span>
                          <span className="gpa-popover-item-copy">
                            <span className="gpa-popover-item-title">{server.name}</span>
                            <span className="gpa-popover-item-hint">{server.url ?? server.command ?? server.id}</span>
                          </span>
                        </button>
                      ))}
                      {(config?.mcpServers ?? []).filter((server) => server.enabled).length === 0 ? <span className="composer-add-menu-empty">没有已启用的 MCP 服务</span> : null}
                    </div>
                  </div>
                ) : null}
                <button
                  className={`gpa-popover-item gpa-popover-item-full-access ${gpaState.fullAccess ? "is-active" : ""}`}
                  role="menuitem"
                  onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("root"); }}
                  disabled={gpaState.fullAccess}
                  onClick={() => void setFullAccess(true)}
                >
                  <span className="gpa-popover-item-icon" aria-hidden><IconShield /></span>
                  <span className="gpa-popover-item-copy">
                    <span className="gpa-popover-item-title">完全访问</span>
                    <span className="gpa-popover-item-hint">最大权限，执行时无需确认</span>
                  </span>
                  {gpaState.fullAccess ? <span className="gpa-popover-item-check">已开启</span> : null}
                </button>
                <button
                  className={`gpa-popover-item gpa-popover-item-knowledge ${gpaState.knowledgeEnabled ? "is-active" : ""}`}
                  role="menuitem"
                  onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("root"); }}
                  disabled={gpaState.knowledgeEnabled}
                  onClick={() => void setKnowledgeEnabled(true)}
                >
                  <span className="gpa-popover-item-icon" aria-hidden><IconKnowledge /></span>
                  <span className="gpa-popover-item-copy">
                    <span className="gpa-popover-item-title">开启知识库</span>
                    <span className="gpa-popover-item-hint">允许本对话检索本地知识库</span>
                  </span>
                  {gpaState.knowledgeEnabled ? <span className="gpa-popover-item-check">已开启</span> : null}
                </button>
                <button
                  className={`gpa-popover-item gpa-popover-item-gpa ${gpaState.stage !== "off" ? "is-active" : ""}`}
                  role="menuitem"
                  onMouseEnter={() => { clearComposerAddMenuCloseTimer(); setComposerAddMenuView("root"); }}
                  disabled={!composerSupportsAgentTools || gpaState.stage !== "off"}
                  title={!composerSupportsAgentTools ? "当前模型不支持或已被标记为不兼容 Agent 工具调用，请在设置中测试或切换模型。" : undefined}
                  onClick={() => void enableGpaMode()}
                >
                  <span className="gpa-popover-item-icon" aria-hidden><IconGpa /></span>
                  <span className="gpa-popover-item-copy">
                    <span className="gpa-popover-item-title">开启 GPA</span>
                    <span className="gpa-popover-item-hint">目标、计划、执行三阶段工作流</span>
                  </span>
                  {gpaState.stage !== "off" ? <span className="gpa-popover-item-check">已开启</span> : null}
                </button>
              </div>
            </>,
            document.body
          )
        : null}
    </div>
  );
}

function PanelResizeHandle({
  pane,
  active,
  onPointerDown
}: {
  pane: ResizePane;
  active: boolean;
  onPointerDown: () => void;
}) {
  return (
    <div
      className={`panel-resize-handle ${pane} ${active ? "is-active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={pane === "sidebar" ? "调整侧边栏宽度" : "调整右侧工作区宽度"}
      onPointerDown={(event) => {
        event.preventDefault();
        onPointerDown();
      }}
    />
  );
}

function RightWorkspacePanel({
  activeTab,
  onTabChange,
  onHide,
  projectRoot,
  onAddAttachment,
  projectFiles,
  projectFilesLoading,
  previewTabs,
  selectedProjectFile,
  projectFilePreview,
  onSelectProjectFile,
  onSelectPreviewTab,
  onClosePreviewTab,
  browserTabs,
  onCloseBrowserTab,
  threadId,
  terminalTabs,
  activeTerminalSessionId,
  shell,
  cwd,
  output,
  input,
  scrollRef,
  onInputChange,
  onSubmit,
  onSelectTerminalTab,
  onAddTerminalTab,
  onCloseTerminalTab,
  hasThread
}: {
  activeTab: RightWorkspaceTab;
  onTabChange: (tab: RightWorkspaceTab) => void;
  onHide: () => void;
  projectRoot: string;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
  projectFiles: ProjectFileEntry[];
  projectFilesLoading: boolean;
  previewTabs: string[];
  selectedProjectFile: string | null;
  projectFilePreview: PreviewCacheEntry | null;
  onSelectProjectFile: (path: string) => void;
  onSelectPreviewTab: (path: string) => void;
  onClosePreviewTab: (path: string) => void;
  browserTabs: RuntimeThreadSnapshot["browserTabs"];
  onCloseBrowserTab: (tabId: string) => void;
  threadId: string | null;
  terminalTabs: TerminalWorkspaceTab[];
  activeTerminalSessionId: string | null;
  shell: string;
  cwd: string;
  output: string;
  input: string;
  scrollRef: React.RefObject<HTMLPreElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onSelectTerminalTab: (sessionId: string) => void;
  onAddTerminalTab: () => void;
  onCloseTerminalTab: (sessionId: string) => void;
  hasThread: boolean;
}) {
  return (
    <aside className="right-workspace-panel" aria-label="右侧工作区">
      <header className="right-workspace-header">
        <nav className="right-workspace-tabs" aria-label="工作区标签">
          <WorkspaceTabButton active={activeTab === "files"} label="文件夹" onClick={() => onTabChange("files")}>
            <IconFolder />
          </WorkspaceTabButton>
          <WorkspaceTabButton active={activeTab === "preview"} label="查看" onClick={() => onTabChange("preview")}>
            <IconEye />
          </WorkspaceTabButton>
          <WorkspaceTabButton active={activeTab === "terminal"} label="终端" onClick={() => onTabChange("terminal")}>
            <IconTerminal />
          </WorkspaceTabButton>
          <WorkspaceTabButton active={activeTab === "browser"} label="浏览器" onClick={() => onTabChange("browser")}>
            <IconGlobe />
          </WorkspaceTabButton>
        </nav>
        <button
          type="button"
          className="right-workspace-hide-button"
          title="向右隐藏工作区"
          aria-label="向右隐藏工作区"
          onClick={onHide}
        >
          <IconChevronRight />
        </button>
      </header>

      <div className="right-workspace-content">
        {activeTab === "preview" ? (
          <ProjectPreviewWorkspace
            tabs={previewTabs}
            selectedPath={selectedProjectFile}
            preview={projectFilePreview}
            loading={projectFilesLoading}
            onSelectTab={onSelectPreviewTab}
            onCloseTab={onClosePreviewTab}
            onAddAttachment={onAddAttachment}
          />
        ) : null}
        {activeTab === "terminal" ? (
          <TerminalWorkspace
            tabs={terminalTabs}
            activeSessionId={activeTerminalSessionId}
            shell={shell}
            cwd={cwd}
            output={output}
            input={input}
            scrollRef={scrollRef}
            onInputChange={onInputChange}
            onSubmit={onSubmit}
            onSelectTab={onSelectTerminalTab}
            onAddTab={onAddTerminalTab}
            onCloseTab={onCloseTerminalTab}
            hasThread={hasThread}
          />
        ) : null}
        {activeTab === "browser" ? (
          <BrowserWorkspace
            tabs={browserTabs}
            threadId={threadId}
            onCloseTab={onCloseBrowserTab}
          />
        ) : null}
        {activeTab === "files" ? (
          <ProjectFilesWorkspace
            files={projectFiles}
            loading={projectFilesLoading}
            selectedPath={selectedProjectFile}
            onSelect={onSelectProjectFile}
            projectRoot={projectRoot}
            onAddAttachment={onAddAttachment}
          />
        ) : null}
      </div>
    </aside>
  );
}

function WorkspaceTabButton({
  active,
  label,
  children,
  onClick
}: {
  active: boolean;
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`right-workspace-tab ${active ? "active" : ""}`} onClick={onClick}>
      {children}
      <span>{label}</span>
    </button>
  );
}

function WorkspaceSubtabStrip({
  items,
  addLabel,
  onAdd
}: {
  items: Array<{
    id: string;
    label: string;
    title?: string;
    active: boolean;
    icon: ReactNode;
    onClick: () => void;
    onClose?: () => void;
  }>;
  addLabel?: string;
  onAdd?: () => void;
}) {
  return (
    <div className="workspace-subtab-strip" role="tablist">
      {items.map((item) => (
        <div key={item.id} className={`workspace-subtab ${item.active ? "active" : ""}`} title={item.title}>
          <button
            type="button"
            className="workspace-subtab-main"
            role="tab"
            aria-selected={item.active}
            onClick={item.onClick}
          >
            <span className="workspace-subtab-icon" aria-hidden="true">{item.icon}</span>
            <span className="workspace-subtab-label">{item.label}</span>
          </button>
          {item.onClose ? (
            <button
              type="button"
              className="workspace-subtab-close"
              aria-label={`关闭 ${item.label}`}
              title={`关闭 ${item.label}`}
              onClick={(event) => {
                event.stopPropagation();
                item.onClose?.();
              }}
            >
              <IconClose />
            </button>
          ) : null}
        </div>
      ))}
      {onAdd ? (
        <button type="button" className="workspace-subtab-add" title={addLabel} aria-label={addLabel} onClick={onAdd}>
          <IconPlus />
        </button>
      ) : null}
    </div>
  );
}

function WorkspaceContextMenu({
  x,
  y,
  actions,
  onClose
}: {
  x: number;
  y: number;
  actions: WorkspaceContextMenuAction[];
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 188);
  const top = Math.min(y, window.innerHeight - Math.max(54, actions.length * 38 + 12));

  return createPortal(
    <div
      className="workspace-context-menu"
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          onClick={() => {
            action.onSelect();
            onClose();
          }}
        >
          <span aria-hidden="true">{action.icon}</span>
          {action.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

function ComposerAttachmentChip({
  attachment,
  onRemove
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const detail =
    attachment.kind === "code"
      ? `${attachment.path} · ${attachment.content.split(/\r?\n/).length} 行`
      : attachment.kind === "skill" || attachment.kind === "mcp"
        ? attachment.description
        : attachment.kind === "folder"
          ? "文件夹"
          : attachment.kind === "image"
            ? "图片"
            : "文件";
  const icon =
    attachment.kind === "folder" ? <IconFolder />
      : attachment.kind === "code" ? <IconCode />
        : attachment.kind === "image" ? <IconImage />
          : attachment.kind === "skill" ? <IconSkills />
            : attachment.kind === "mcp" ? <IconMcp />
              : <IconFile />;

  return (
    <div
      className={`composer-attachment-chip ${attachment.kind}`}
      title={attachment.kind === "code" ? attachment.content : attachment.kind === "skill" || attachment.kind === "mcp" ? attachment.description : attachment.path}
    >
      <span className="composer-attachment-icon" aria-hidden="true">{icon}</span>
      {attachment.kind === "image" && attachment.previewUrl ? (
        <img className="composer-attachment-thumbnail" src={attachment.previewUrl} alt="" />
      ) : null}
      <span className="composer-attachment-copy">
        <strong>
          <span>{attachment.label}</span>
          {attachment.kind === "skill" ? <em className="composer-attachment-kind">Skill</em> : null}
        </strong>
        <small>{detail}</small>
      </span>
      <button type="button" title="移除" aria-label={`移除 ${attachment.label}`} onClick={onRemove}>
        <IconClose />
      </button>
    </div>
  );
}

function LegacyTerminalWorkspace({
  tabs,
  activeSessionId,
  shell,
  cwd,
  output,
  input,
  scrollRef,
  onInputChange,
  onSubmit,
  onSelectTab,
  onAddTab,
  onCloseTab,
  hasThread
}: {
  tabs: TerminalWorkspaceTab[];
  activeSessionId: string | null;
  shell: string;
  cwd: string;
  output: string;
  input: string;
  scrollRef: React.RefObject<HTMLPreElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onSelectTab: (sessionId: string) => void;
  onAddTab: () => void;
  onCloseTab: (sessionId: string) => void;
  hasThread: boolean;
}) {
  return (
    <section className="terminal-workspace" aria-label="终端">
      <div className="terminal-heading">
        <span className="terminal-heading-icon" aria-hidden="true"><IconTerminal /></span>
        <div>
          <strong>{shell}</strong>
          <span title={cwd}>{cwd || "正在连接终端"}</span>
        </div>
      </div>
      <pre ref={scrollRef} className="terminal-output" aria-live="polite">
        {hasThread ? output || " " : "选择一个任务后即可使用终端。"}
      </pre>
      <div className="terminal-composer">
        <span className="terminal-prompt" aria-hidden="true">&gt;</span>
        <input
          value={input}
          disabled={!hasThread}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={hasThread ? "输入命令" : "请选择任务"}
          aria-label="终端命令"
          spellCheck={false}
        />
      </div>
    </section>
  );
}

function LegacyProjectPreviewWorkspace({
  selectedPath,
  preview,
  loading
}: {
  selectedPath: string | null;
  preview: { content: string; truncated: boolean } | null;
  loading: boolean;
}) {
  if (!selectedPath) {
    return loading ? (
      <WorkspaceEmptyState icon={<IconSpinner />} message="正在读取项目文件..." />
    ) : (
      <WorkspaceEmptyState icon={<IconFolder />} title="打开文件" message="从工作区目录树中选择文件" />
    );
  }

  return (
    <section className="project-preview-workspace" aria-label="文件查看">
      <header className="project-preview-header" title={selectedPath}>
        <IconFile />
        <span>{selectedPath}</span>
      </header>
      {preview ? (
        <>
          <pre className="project-preview-code">{preview.content}</pre>
          {preview.truncated ? <div className="project-preview-note">文件内容过长，仅显示前 512 KB。</div> : null}
        </>
      ) : (
        <WorkspaceEmptyState icon={<IconSpinner />} message="正在读取文件..." />
      )}
    </section>
  );
}

function ProjectFilesWorkspace({
  files,
  loading,
  selectedPath,
  onSelect,
  projectRoot,
  onAddAttachment
}: {
  files: ProjectFileEntry[];
  loading: boolean;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  projectRoot: string;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: ProjectFileTreeNode } | null>(null);
  const tree = useMemo(() => buildProjectFileTree(files), [files]);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    setExpandedPaths(new Set(tree.filter((node) => node.kind === "directory").map((node) => node.path)));
  }, [tree]);

  if (loading) {
    return <WorkspaceEmptyState icon={<IconSpinner />} message="正在读取项目文件..." />;
  }

  if (files.length === 0) {
    return <WorkspaceEmptyState icon={<IconFolder />} message="当前项目文件夹没有可显示的文件" />;
  }

  return (
    <section className="project-files-workspace" aria-label="项目文件夹">
      <label className="project-files-filter">
        <IconSearch />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选文件..."
          aria-label="筛选项目文件"
          spellCheck={false}
        />
      </label>
      <div className="project-files-list" role="tree" aria-label="项目文件">
        <ProjectFileTreeRows
          nodes={tree}
          depth={0}
          query={normalizedQuery}
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          onToggle={(path) => {
            setExpandedPaths((current) => {
              const next = new Set(current);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          onSelect={onSelect}
          onContextMenu={(event, node) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY, node });
          }}
        />
      </div>
      {contextMenu ? (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          actions={[
            {
              id: "copy-path",
              label: "复制路径",
              icon: <IconCopy />,
              onSelect: () => void navigator.clipboard.writeText(resolveProjectFilePath(projectRoot, contextMenu.node.path))
            },
            {
              id: "add-file-to-chat",
              label: "添加到聊天",
              icon: <IconCompose />,
              onSelect: () => {
                const target = resolveProjectFilePath(projectRoot, contextMenu.node.path);
                onAddAttachment({
                  kind: contextMenu.node.kind === "directory" ? "folder" : "file",
                  path: target,
                  label: contextMenu.node.name
                });
              }
            }
          ]}
        />
      ) : null}
    </section>
  );
}

function ProjectFileTreeRows({
  nodes,
  depth,
  query,
  expandedPaths,
  selectedPath,
  onToggle,
  onSelect,
  onContextMenu
}: {
  nodes: ProjectFileTreeNode[];
  depth: number;
  query: string;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>, node: ProjectFileTreeNode) => void;
}): ReactNode {
  return nodes.map((node) => {
    const matches = projectFileNodeMatches(node, query);
    if (!matches) {
      return null;
    }

    const isDirectory = node.kind === "directory";
    const isExpanded = query.length > 0 || expandedPaths.has(node.path);
    return (
      <div key={`${node.kind}:${node.path}`} className="project-file-tree-item">
        <button
          type="button"
          className={`project-file-row ${isDirectory ? "directory" : "file"} ${selectedPath === node.path ? "selected" : ""}`}
          style={{ "--project-file-depth": depth } as React.CSSProperties}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDirectory ? isExpanded : undefined}
          aria-selected={isDirectory ? undefined : selectedPath === node.path}
          onClick={() => isDirectory ? onToggle(node.path) : onSelect(node.path)}
          onContextMenu={(event) => onContextMenu(event, node)}
          title={node.path}
        >
          {isDirectory ? (
            <span className={`project-file-disclosure ${isExpanded ? "is-expanded" : ""}`} aria-hidden><IconChevronRight /></span>
          ) : <span className="project-file-disclosure-placeholder" aria-hidden />}
          <span className={`project-file-glyph ${getProjectFileGlyphClass(node)}`} aria-hidden>
            {isDirectory ? <IconFolder /> : <IconFile />}
          </span>
          <span>{node.name}</span>
        </button>
        {isDirectory && isExpanded ? (
          <ProjectFileTreeRows
            nodes={node.children}
            depth={depth + 1}
            query={query}
            expandedPaths={expandedPaths}
            selectedPath={selectedPath}
            onToggle={onToggle}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          />
        ) : null}
      </div>
    );
  });
}

export function buildProjectFileTree(files: ProjectFileEntry[]): ProjectFileTreeNode[] {
  const root: ProjectFileTreeNode = { path: "", name: "", kind: "directory", children: [] };

  for (const entry of files) {
    const segments = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let children = root.children;
    let parentPath = "";
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      parentPath = parentPath ? `${parentPath}/${name}` : name;
      const isLeaf = index === segments.length - 1;
      const kind = isLeaf ? entry.kind : "directory";
      let node = children.find((candidate) => candidate.name === name);
      if (!node) {
        node = { path: parentPath, name, kind, children: [] };
        children.push(node);
      } else if (isLeaf) {
        node.kind = kind;
      }
      children = node.children;
    }
  }

  const sortNodes = (nodes: ProjectFileTreeNode[]): ProjectFileTreeNode[] =>
    nodes
      .map((node) => ({ ...node, children: sortNodes(node.children) }))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true });
      });

  return sortNodes(root.children);
}

function projectFileNodeMatches(node: ProjectFileTreeNode, query: string): boolean {
  if (!query) return true;
  return node.name.toLocaleLowerCase().includes(query) || node.children.some((child) => projectFileNodeMatches(child, query));
}

function getProjectFileGlyphClass(node: ProjectFileTreeNode): string {
  if (node.kind === "directory") return "folder";
  const extension = node.name.split(".").pop()?.toLocaleLowerCase();
  if (extension === "json") return "json";
  if (extension === "ts" || extension === "tsx" || extension === "js" || extension === "jsx") return "script";
  if (extension === "css" || extension === "scss") return "style";
  if (extension === "md") return "markdown";
  if (node.name.startsWith(".")) return "config";
  return "default";
}

export function resolveProjectFilePath(projectRoot: string, relativePath: string): string {
  if (!projectRoot) {
    return relativePath;
  }
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const root = projectRoot.replace(/[\\/]+$/, "");
  const relative = relativePath.replace(/[\\/]+/g, separator);
  return relative ? `${root}${separator}${relative}` : root;
}

export function formatComposerAttachments(attachments: ComposerAttachment[]): string {
  return attachments
    .map((attachment) => {
      if (attachment.kind === "code") {
        const instruction = attachment.intent === "edit" ? "Edit the following selected code" : "Reference the following selected code";
        return `${instruction} from ${attachment.path}:\n\`\`\`\n${attachment.content}\n\`\`\``;
      }
      if (attachment.kind === "skill") {
        return `[Selected Skill]\n${attachment.label}: ${attachment.description}`;
      }
      if (attachment.kind === "mcp") {
        return `[Selected MCP server]\n${attachment.label}: ${attachment.description}. Prefer this server when its tools are relevant.`;
      }
      if (attachment.kind === "image") {
        return `[Attached image]\n${attachment.path}\nUse the image attachment as visual reference when the selected model supports image input.`;
      }
      return attachment.kind === "file" ? `[Attached file]\n${attachment.path}` : `[Attached folder]\n${attachment.path}`;
    })
    .join("\n\n");
}

export function buildContextUsage(input: {
  contextWindow: number;
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  gpaStage: GpaStage;
  selectedSkillCount: number;
  mcpServerCount: number;
  pendingInput: string;
}): ContextUsage {
  const conversationText = [
    ...input.messages.map((message) => message.content),
    ...input.toolCalls.map((toolCall) => `${toolCall.argumentsJson}\n${toolCall.resultJson ?? ""}`),
    input.pendingInput
  ].join("\n");
  const segments: ContextUsageSegment[] = [
    { id: "system", label: "系统提示", tokens: 1_200, color: "#a8a8a8" },
    { id: "tools", label: "工具定义", tokens: 900 + input.mcpServerCount * 240, color: "#9988ef" },
    { id: "rules", label: "规则", tokens: input.gpaStage === "off" ? 240 : 980, color: "#4fba7b" },
    { id: "skills", label: "技能", tokens: input.selectedSkillCount * 520, color: "#efb35c" },
    { id: "mcp", label: "MCP 与动态工具", tokens: input.mcpServerCount * 360, color: "#bf98bd" },
    { id: "conversation", label: "对话与工具结果", tokens: Math.max(1, estimateContextTokens(conversationText)), color: "#e28b85" }
  ];
  const usedTokens = segments.reduce((total, segment) => total + segment.tokens, 0);
  const contextWindow = Math.max(1, input.contextWindow);
  return {
    contextWindow,
    usedTokens,
    percentage: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
    segments
  };
}

function estimateContextTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }
  return Math.ceil(Array.from(normalized).length / 2.8);
}

function formatTokenCount(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}K` : String(tokens);
}

function LegacyBrowserWorkspace({
  tabs,
  threadId
}: {
  tabs: RuntimeThreadSnapshot["browserTabs"];
  threadId: string | null;
}) {
  const activeTab = tabs.find((tab) => tab.isActive) ?? tabs[0];
  if (!activeTab || !threadId) {
    return <WorkspaceEmptyState icon={<IconGlobe />} message="任务打开的网页会显示在这里" />;
  }

  return (
    <section className="browser-workspace" aria-label="浏览器">
      <div className="browser-tab-strip" role="tablist" aria-label="浏览器标签">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`browser-tab ${tab.id === activeTab.id ? "active" : ""}`}
            role="tab"
            aria-selected={tab.id === activeTab.id}
            title={tab.url}
            onClick={() => void window.codexh.focusBrowserTab({ threadId, tabId: tab.id })}
          >
            <IconGlobe />
            <span>{tab.title || tab.url}</span>
          </button>
        ))}
      </div>
      <div className="browser-location" title={activeTab.url}>{activeTab.url}</div>
      <iframe
        key={`${activeTab.id}:${activeTab.url}`}
        className="browser-frame"
        src={activeTab.url}
        title={activeTab.title || "任务浏览器"}
      />
    </section>
  );
}

function TerminalWorkspace({
  tabs,
  activeSessionId,
  shell,
  cwd,
  output,
  input,
  scrollRef,
  onInputChange,
  onSubmit,
  onSelectTab,
  onAddTab,
  onCloseTab,
  hasThread
}: {
  tabs: TerminalWorkspaceTab[];
  activeSessionId: string | null;
  shell: string;
  cwd: string;
  output: string;
  input: string;
  scrollRef: React.RefObject<HTMLPreElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onSelectTab: (sessionId: string) => void;
  onAddTab: () => void;
  onCloseTab: (sessionId: string) => void;
  hasThread: boolean;
}) {
  if (!hasThread) {
    return <WorkspaceEmptyState icon={<IconTerminal />} message="选择一个任务后即可使用终端。" />;
  }

  if (tabs.length === 0) {
    return (
      <section className="terminal-workspace" aria-label="终端">
        <WorkspaceSubtabStrip items={[]} addLabel="新建终端" onAdd={onAddTab} />
        <WorkspaceEmptyState icon={<IconTerminal />} message="新建一个终端后即可开始输入命令。" />
      </section>
    );
  }

  return (
    <section className="terminal-workspace" aria-label="终端">
      <WorkspaceSubtabStrip
        items={tabs.map((tab) => ({
          id: tab.id,
          label: tab.title,
          title: tab.title,
          active: tab.id === activeSessionId,
          icon: <IconTerminal />,
          onClick: () => onSelectTab(tab.id),
          onClose: () => onCloseTab(tab.id)
        }))}
        addLabel="新建终端"
        onAdd={onAddTab}
      />
      <div className="terminal-heading">
        <span className="terminal-heading-icon" aria-hidden="true"><IconTerminal /></span>
        <div>
          <strong>{shell}</strong>
          <span title={cwd}>{cwd || "正在连接终端"}</span>
        </div>
      </div>
      <pre ref={scrollRef} className="terminal-output" aria-live="polite">
        {output || " "}
      </pre>
      <div className="terminal-composer">
        <span className="terminal-prompt" aria-hidden="true">&gt;</span>
        <input
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="输入命令"
          aria-label="终端命令"
          spellCheck={false}
        />
      </div>
    </section>
  );
}

function ProjectPreviewWorkspace({
  tabs,
  selectedPath,
  preview,
  loading,
  onSelectTab,
  onCloseTab,
  onAddAttachment
}: {
  tabs: string[];
  selectedPath: string | null;
  preview: PreviewCacheEntry | null;
  loading: boolean;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onAddAttachment: (attachment: ComposerAttachmentInput) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  if (tabs.length === 0) {
    return loading ? (
      <WorkspaceEmptyState icon={<IconSpinner />} message="正在读取项目文件..." />
    ) : (
      <WorkspaceEmptyState icon={<IconFolder />} title="打开文件" message="从工作区目录树中选择文件" />
    );
  }

  const currentPath = selectedPath ?? tabs[0];
  if (!currentPath) {
    return <WorkspaceEmptyState icon={<IconFolder />} title="打开文件" message="从工作区目录树中选择文件" />;
  }

  return (
    <section className="project-preview-workspace" aria-label="文件查看">
      <WorkspaceSubtabStrip
        items={tabs.map((path) => ({
          id: path,
          label: path.split(/[\\/]/).pop() || path,
          title: path,
          active: path === currentPath,
          icon: <IconFile />,
          onClick: () => onSelectTab(path),
          onClose: () => onCloseTab(path)
        }))}
      />
      <header className="project-preview-header project-preview-breadcrumb" title={currentPath}>
        <IconFile />
        {currentPath.split(/[\\/]/).map((segment, index, segments) => (
          <span key={`${segment}-${index}`} className={index === segments.length - 1 ? "is-current" : ""}>
            {index > 0 ? <i aria-hidden><IconChevronRight /></i> : null}
            {segment}
          </span>
        ))}
      </header>
      {preview ? (
        <>
          <ol
            className="project-preview-code"
            aria-label={`${currentPath} 代码内容`}
            onContextMenu={(event) => {
              const selection = window.getSelection()?.toString().trim() ?? "";
              if (!selection) {
                return;
              }
              event.preventDefault();
              setContextMenu({ x: event.clientX, y: event.clientY, selection });
            }}
          >
            {preview.content.split(/\r?\n/).map((line, index) => (
              <li key={`${currentPath}-line-${index}`}>
                <code>{renderCodePreviewLine(line, `${currentPath}-${index}`)}</code>
              </li>
            ))}
          </ol>
          {preview.truncated ? <div className="project-preview-note">文件内容过长，仅显示前 512 KB。</div> : null}
          {contextMenu ? (
            <WorkspaceContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={() => setContextMenu(null)}
              actions={[
                {
                  id: "add-selection-to-chat",
                  label: "添加到聊天",
                  icon: <IconCompose />,
                  onSelect: () => onAddAttachment({
                    kind: "code",
                    path: currentPath,
                    content: contextMenu.selection,
                    label: "已选代码段",
                    intent: "reference"
                  })
                },
                {
                  id: "edit-selection",
                  label: "编辑",
                  icon: <IconCompose />,
                  onSelect: () => {
                    onAddAttachment({
                    kind: "code",
                    path: currentPath,
                    content: contextMenu.selection,
                    label: "待编辑代码段",
                    intent: "edit"
                  });
                  }
                }
              ]}
            />
          ) : null}
        </>
      ) : (
        <WorkspaceEmptyState icon={<IconSpinner />} message="正在读取文件..." />
      )}
    </section>
  );
}

function renderCodePreviewLine(line: string, keyPrefix: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const tokenPattern = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|(\/\/.*$|#.*$)|\b(true|false|null|undefined|const|let|var|function|return|import|from|export|type|interface|async|await|if|else)\b|\b(-?\d+(?:\.\d+)?)\b/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(line)) !== null) {
    if (match.index > cursor) {
      tokens.push(<span key={`${keyPrefix}-text-${index}`}>{line.slice(cursor, match.index)}</span>);
      index += 1;
    }
    const className = match[1]
      ? "code-preview-key"
      : match[2]
        ? "code-preview-string"
        : match[3]
          ? "code-preview-comment"
          : match[4]
            ? "code-preview-keyword"
            : "code-preview-number";
    tokens.push(<span key={`${keyPrefix}-token-${index}`} className={className}>{match[0]}</span>);
    cursor = tokenPattern.lastIndex;
    index += 1;
  }

  if (cursor < line.length) {
    tokens.push(<span key={`${keyPrefix}-tail-${index}`}>{line.slice(cursor)}</span>);
  }

  return tokens;
}

function BrowserWorkspace({
  tabs,
  threadId,
  onCloseTab
}: {
  tabs: RuntimeThreadSnapshot["browserTabs"];
  threadId: string | null;
  onCloseTab: (tabId: string) => void;
}) {
  const activeTab = tabs.find((tab) => tab.isActive) ?? tabs[0];
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  useEffect(() => {
    const view = webviewRef.current;
    if (!view || !activeTab || !threadId) return;

    const register = () => {
      const webContentsId = view.getWebContentsId();
      void window.codexh.registerBrowserWebContents({ threadId, tabId: activeTab.id, webContentsId })
        .then(() => window.codexh.syncBrowserWebContents({ threadId, tabId: activeTab.id }))
        .catch(() => undefined);
    };
    const sync = () => void window.codexh.syncBrowserWebContents({ threadId, tabId: activeTab.id }).catch(() => undefined);
    view.addEventListener("dom-ready", register);
    view.addEventListener("did-navigate", sync);
    view.addEventListener("did-navigate-in-page", sync);
    view.addEventListener("page-title-updated", sync);
    return () => {
      view.removeEventListener("dom-ready", register);
      view.removeEventListener("did-navigate", sync);
      view.removeEventListener("did-navigate-in-page", sync);
      view.removeEventListener("page-title-updated", sync);
    };
  }, [activeTab?.id, activeTab?.url, threadId]);
  if (!activeTab || !threadId) {
    return <WorkspaceEmptyState icon={<IconGlobe />} message="任务打开的网页会显示在这里" />;
  }

  return (
    <section className="browser-workspace" aria-label="浏览器">
      <WorkspaceSubtabStrip
        items={tabs.map((tab) => ({
          id: tab.id,
          label: tab.title || tab.url,
          title: tab.url,
          active: tab.id === activeTab.id,
          icon: <IconGlobe />,
          onClick: () => void window.codexh.focusBrowserTab({ threadId, tabId: tab.id }),
          onClose: () => onCloseTab(tab.id)
        }))}
      />
      <div className="browser-location" title={activeTab.url}>{activeTab.url}</div>
      {createElement("webview", {
        key: `${activeTab.id}:${activeTab.url}`,
        ref: webviewRef,
        className: "browser-frame",
        src: activeTab.url,
        webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
        title: activeTab.title || "任务浏览器"
      })}
    </section>
  );
}

function WorkspaceEmptyState({ icon, title, message }: { icon: ReactNode; title?: string; message: string }) {
  return (
    <div className={`right-workspace-empty-state ${title ? "open-file" : ""}`}>
      <span aria-hidden="true">{icon}</span>
      {title ? <strong>{title}</strong> : null}
      <p>{message}</p>
    </div>
  );
}

function formatMessageAttachments(attachments: MessageAttachment[]): string {
  return attachments
    .map((attachment) => attachment.kind === "image"
      ? `[Attached image]\n${attachment.name}\nUse this image as visual reference.`
      : `[Attached file]\n${attachment.absolutePath}`)
    .join("\n\n");
}

function TerminalPanel({
  shell,
  cwd,
  output,
  input,
  scrollRef,
  onInputChange,
  onSubmit,
  onHide,
  hasThread
}: {
  shell: string;
  cwd: string;
  output: string;
  input: string;
  scrollRef: React.RefObject<HTMLPreElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onHide: () => void;
  hasThread: boolean;
}) {
  return (
    <aside className="terminal-panel" aria-label="终端">
      <header className="terminal-header">
        <div className="terminal-heading">
          <span className="terminal-heading-icon" aria-hidden="true">
            <IconTerminal />
          </span>
          <div>
            <strong>{shell}</strong>
            <span title={cwd}>{cwd || "正在连接终端"}</span>
          </div>
        </div>
        <button
          type="button"
          className="terminal-hide-button"
          title="向右隐藏终端"
          aria-label="向右隐藏终端"
          onClick={onHide}
        >
          <IconChevronRight />
        </button>
      </header>

      <pre ref={scrollRef} className="terminal-output" aria-live="polite">
        {hasThread ? output || " " : "选择一个任务后即可使用终端。"}
      </pre>

      <div className="terminal-composer">
        <span className="terminal-prompt" aria-hidden="true">&gt;</span>
        <input
          value={input}
          disabled={!hasThread}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={hasThread ? "输入命令" : "请选择任务"}
          aria-label="终端命令"
          spellCheck={false}
        />
      </div>
    </aside>
  );
}

function ComposerSelect({
  value,
  options,
  onChange,
  placeholder,
  disabled = false
}: {
  value: string;
  options: ComposerSelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? null;

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
    }
  }, [disabled, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className={`composer-select ${isOpen ? "open" : ""} ${disabled ? "disabled" : ""}`}>
      <button
        type="button"
        className="composer-select-trigger"
        onClick={() => {
          if (!disabled) {
            setIsOpen((current) => !current);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
      >
        <span className="composer-select-value">{selectedOption?.label ?? placeholder}</span>
        <span className="composer-select-chevron">
          <IconChevronRight />
        </span>
      </button>

      {isOpen ? (
        <div className="composer-select-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`composer-select-option ${option.value === value ? "selected" : ""}`}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              role="option"
              aria-selected={option.value === value}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type ComposerModelGroup = {
  providerId: string;
  providerLabel: string;
  models: Array<{ id: string; label: string; supportsMultimodalInput: boolean }>;
};

function ContextUsageControl({
  usage,
  open,
  onToggle,
  onClose
}: {
  usage: ContextUsage;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => onClose();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  return (
    <div className="context-usage-anchor" onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`context-usage-button ${open ? "is-open" : ""}`}
        aria-label="查看上下文占用"
        aria-expanded={open}
        title={`上下文占用：约 ${usage.percentage}%`}
        onClick={onToggle}
      >
        <span
          className="context-usage-ring"
          style={{ "--context-usage-angle": `${Math.max(3, usage.percentage * 3.6)}deg` } as React.CSSProperties}
        >
          <span>{usage.percentage}%</span>
        </span>
      </button>
      {open ? <ContextUsageReport usage={usage} onClose={onClose} /> : null}
    </div>
  );
}

function ContextUsageReport({ usage, onClose }: { usage: ContextUsage; onClose: () => void }) {
  return (
    <section className="context-usage-report" aria-label="上下文占用详情">
      <header>
        <div>
          <strong>上下文占用</strong>
          <span>本地估算</span>
        </div>
        <button type="button" title="关闭" aria-label="关闭上下文详情" onClick={onClose}>
          <IconClose />
        </button>
      </header>
      <div className="context-usage-summary">
        <span>{usage.percentage}% 已用</span>
        <strong>约 {formatTokenCount(usage.usedTokens)} / {formatTokenCount(usage.contextWindow)} tokens</strong>
      </div>
      <div className="context-usage-bar" aria-hidden="true">
        {usage.segments.map((segment) => (
          <i
            key={segment.id}
            style={{
              width: `${Math.max(usage.contextWindow ? (segment.tokens / usage.contextWindow) * 100 : 0, 0.8)}%`,
              background: segment.color
            }}
          />
        ))}
      </div>
      <div className="context-usage-segments">
        {usage.segments.map((segment) => (
          <div key={segment.id}>
            <span style={{ background: segment.color }} aria-hidden="true" />
            <strong>{segment.label}</strong>
            <em>{formatTokenCount(segment.tokens)}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function ComposerModelPicker({
  triggerLabel,
  providers,
  modelGroups,
  selectedProviderId,
  selectedModelId,
  onSelectModel,
  disabled
}: {
  triggerLabel: string;
  providers: ComposerSelectOption[];
  modelGroups: ComposerModelGroup[];
  selectedProviderId: string;
  selectedModelId: string;
  onSelectModel: (providerId: string, modelId: string) => void;
  disabled: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [hoveredProviderId, setHoveredProviderId] = useState<string | null>(null);
  const [modelsOpenRight, setModelsOpenRight] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
      setActiveProviderId(null);
    }
  }, [disabled, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }
    const node = rootRef.current;
    if (!node) {
      return;
    }
    const triggerRect = node.getBoundingClientRect();
    const MODEL_PANEL_WIDTH = 264;
    setModelsOpenRight(triggerRect.left < MODEL_PANEL_WIDTH + 16);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleResize = () => {
      const node = rootRef.current;
      if (!node) {
        return;
      }
      const triggerRect = node.getBoundingClientRect();
      const MODEL_PANEL_WIDTH = 264;
      setModelsOpenRight(triggerRect.left < MODEL_PANEL_WIDTH + 16);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isOpen]);

  useEffect(() => {
    return () => {
      clearHoverTimer();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      clearHoverTimer();
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        setActiveProviderId(null);
        setHoveredProviderId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        setActiveProviderId(null);
        setHoveredProviderId(null);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const handleMove = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const providerItem = target.closest<HTMLElement>(".composer-model-picker-provider");
      if (providerItem) {
        const providerId = providerItem.dataset.providerId;
        if (providerId) {
          handleProviderHover(providerId);
          return;
        }
      }
      const modelItem = target.closest<HTMLElement>(".composer-model-picker-model");
      if (modelItem) {
        clearHoverTimer();
        return;
      }
    };
    root.addEventListener("mousemove", handleMove);
    return () => {
      root.removeEventListener("mousemove", handleMove);
    };
  }, [isOpen]);

  if (providers.length === 0) {
    return (
      <div ref={rootRef} className="composer-model-picker disabled">
        <span className="composer-model-picker-label">选择模型</span>
      </div>
    );
  }

  const openMenu = (initialProviderId: string | null) => {
    clearHoverTimer();
    setIsOpen(true);
    setActiveProviderId(initialProviderId);
    setHoveredProviderId(null);
  };

  const handleProviderHover = (providerId: string) => {
    clearHoverTimer();
    setHoveredProviderId(providerId);
  };

  const handleProviderLeave = () => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setHoveredProviderId(null);
    }, 160);
  };

  const handleModelPanelEnter = () => {
    clearHoverTimer();
  };

  const handleModelPanelLeave = () => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setHoveredProviderId(null);
    }, 180);
  };

  const visibleSecondaryProviderId = hoveredProviderId ?? activeProviderId;

  return (
    <div
      ref={rootRef}
      className={`composer-model-picker ${isOpen ? "open" : ""} ${disabled ? "disabled" : ""} ${modelsOpenRight ? "models-open-right" : ""}`}
    >
      <button
        type="button"
        className="composer-model-picker-trigger"
        onClick={() => {
          if (disabled) {
            return;
          }
          if (isOpen) {
            setIsOpen(false);
            setActiveProviderId(null);
            setHoveredProviderId(null);
            return;
          }
          openMenu(null);
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        title="选择模型"
      >
        <span className="composer-model-picker-label">{triggerLabel}</span>
        <span className="composer-select-chevron">
          <IconChevronRight />
        </span>
      </button>

      {isOpen ? (
        <div className="composer-model-picker-menu" role="listbox">
          <ul
            className="composer-model-picker-providers"
            onMouseLeave={handleProviderLeave}
          >
            {providers.map((provider) => (
              <li key={provider.value}>
                <button
                  type="button"
                  data-provider-id={provider.value}
                  className={`composer-model-picker-provider ${visibleSecondaryProviderId === provider.value ? "is-active" : ""}`}
                  onClick={() => {
                    setActiveProviderId(provider.value);
                    handleProviderHover(provider.value);
                  }}
                  onMouseEnter={() => handleProviderHover(provider.value)}
                  onFocus={() => setActiveProviderId(provider.value)}
                  role="option"
                  aria-selected={selectedProviderId === provider.value}
                >
                  <span>{provider.label}</span>
                  <span className="composer-model-picker-chevron">
                    <IconChevronRight />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {visibleSecondaryProviderId ? (
            <ul
              className="composer-model-picker-models"
              onMouseEnter={handleModelPanelEnter}
              onMouseLeave={handleModelPanelLeave}
            >
              <li className="composer-model-picker-models-title">模型</li>
              {modelGroups
                .find((group) => group.providerId === visibleSecondaryProviderId)
                ?.models.map((model) => (
                  <li key={model.id}>
                    <button
                      type="button"
                      className={`composer-model-picker-model ${selectedProviderId === visibleSecondaryProviderId && selectedModelId === model.id ? "is-selected" : ""}`}
                      onClick={() => {
                        if (visibleSecondaryProviderId) {
                          onSelectModel(visibleSecondaryProviderId, model.id);
                        }
                        setIsOpen(false);
                        setActiveProviderId(null);
                        setHoveredProviderId(null);
                      }}
                      role="option"
                      aria-selected={selectedProviderId === visibleSecondaryProviderId && selectedModelId === model.id}
                    >
                      <span className="composer-model-picker-model-label">
                        {model.supportsMultimodalInput ? (
                          <span className="composer-model-picker-multimodal" title="支持多模态输入" aria-label="支持多模态输入">
                            <IconImage />
                          </span>
                        ) : null}
                        <span>{model.label}</span>
                      </span>
                      {selectedProviderId === visibleSecondaryProviderId && selectedModelId === model.id ? (
                        <span className="composer-model-picker-check" aria-hidden="true">✓</span>
                      ) : null}
                    </button>
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function buildTimelineEntries(
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[],
  artifacts: ArtifactRecord[],
  workspaceRoot?: string | null,
  threadStatus?: ThreadRecord["status"] | null
): TimelineEntry[] {
  const filesByTurn = collectFileChangesByTurn(toolCalls, workspaceRoot);
  for (const artifact of artifacts) {
    if (artifact.artifactKind !== "generated-image" && artifact.artifactKind !== "generated-video") continue;
    const turnRunId = artifact.turnRunId ?? `artifact-${artifact.id}`;
    const isVideo = artifact.artifactKind === "generated-video";
    filesByTurn.set(turnRunId, [
      ...(filesByTurn.get(turnRunId) ?? []),
      {
        path: artifact.relativePath ?? artifact.displayName,
        absolutePath: artifact.absolutePath,
        action: "created",
        additions: 0,
        deletions: 0,
        kind: isVideo ? "generated-video" : "generated-image",
        description: isVideo ? "生成的视频" : "生成的图片"
      }
    ]);
  }
  const messageEntries: TimelineEntry[] = [];

  for (const message of messages) {
    if (message.role === "tool" || isPatchAssistantMessage(message.content)) {
      continue;
    }

    messageEntries.push({
      kind: "message",
      id: `message-${message.id}`,
      createdAt: message.createdAt,
      message
    });

  }

  const toolEntries: TimelineEntry[] = toolCalls
    .filter((toolCall) => !isFileWriteTool(toolCall.toolName))
    .map((toolCall) => ({
      kind: "tool",
      id: `tool-${toolCall.id}`,
      createdAt: toolCall.startedAt,
      toolCall
    }));

  const fileSummaryEntries: TimelineEntry[] = isTaskExecutionFinished(threadStatus)
    ? [...filesByTurn.entries()].map(([turnRunId, files]) => ({
        kind: "file-summary",
        id: `file-summary-${turnRunId}`,
        createdAt: getTurnSummaryCreatedAt(turnRunId, messages, toolCalls),
        files
      }))
    : [];
  const sortedEntries = [...messageEntries, ...toolEntries, ...fileSummaryEntries].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
  );
  return collapseDirectoryReadMessages(sortedEntries);
}

function isTaskExecutionFinished(status: ThreadRecord["status"] | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

function getTurnSummaryCreatedAt(
  turnRunId: string,
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[]
): string {
  const timestamps = [
    ...messages
      .filter((message) => message.turnRunId === turnRunId && !isPatchAssistantMessage(message.content))
      .map((message) => Date.parse(message.createdAt)),
    ...toolCalls
      .filter((toolCall) => toolCall.turnRunId === turnRunId)
      .map((toolCall) => Date.parse(toolCall.completedAt ?? toolCall.startedAt))
  ].filter(Number.isFinite);
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
  return new Date(latest + 1).toISOString();
}

export function isFileWriteTool(toolName: string): boolean {
  return toolName === "apply_patch" || toolName === "fs.write_file";
}

export function isPatchAssistantMessage(content: string): boolean {
  return /^\s*(?:```(?:diff|patch)?\s*)?\*\*\* Begin Patch\b/m.test(content);
}

function collapseDirectoryReadMessages(entries: TimelineEntry[]): TimelineEntry[] {
  const collapsed: TimelineEntry[] = [];

  for (let index = 0; index < entries.length; ) {
    const entry = entries[index];
    if (entry.kind !== "message") {
      collapsed.push(entry);
      index += 1;
      continue;
    }
    const directory = getReadDirectory(entry.message);
    if (!directory) {
      collapsed.push(entry);
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < entries.length) {
      const candidate = entries[end];
      if (
        candidate.kind !== "message" ||
        candidate.message.turnRunId !== entry.message.turnRunId ||
        getReadDirectory(candidate.message) !== directory
      ) {
        break;
      }
      end += 1;
    }

    const count = end - index;
    if (count === 1) {
      collapsed.push(entry);
    } else {
      collapsed.push({
        kind: "directory-read-group",
        id: `directory-read-${entry.message.id}`,
        createdAt: entry.createdAt,
        directory,
        count
      });
    }
    index = end;
  }

  return collapsed;
}

function getReadDirectory(message: MessageRecord): string | null {
  if (message.role !== "assistant") {
    return null;
  }
  const match = message.content.match(/(?:检查|读取)\s*`?([^`\s]+)`?\s*目录(?:内容)?/);
  return match?.[1]?.trim() || null;
}

function collectFileChangesByTurn(
  toolCalls: ToolCallRecord[],
  workspaceRoot?: string | null
): Map<string, FileChangeSummaryItem[]> {
  const changesByTurn = new Map<string, Map<string, FileChangeSummaryItem>>();

  for (const toolCall of toolCalls) {
    if (!toolCallSucceeded(toolCall)) {
      continue;
    }

    const files = getToolFileChanges(toolCall, workspaceRoot);
    if (files.length === 0) {
      continue;
    }

    const turnChanges = changesByTurn.get(toolCall.turnRunId) ?? new Map<string, FileChangeSummaryItem>();
    for (const file of files) {
      const existing = turnChanges.get(file.path);
      turnChanges.set(file.path, mergeFileChange(existing, file));
    }
    changesByTurn.set(toolCall.turnRunId, turnChanges);
  }

  return new Map(
    [...changesByTurn.entries()].map(([turnRunId, files]) => [turnRunId, [...files.values()]])
  );
}

function toolCallSucceeded(toolCall: ToolCallRecord) {
  if (toolCall.status !== "completed") {
    return false;
  }

  return parseTimelineJson(toolCall.resultJson).ok !== false;
}

function getToolFileChanges(
  toolCall: ToolCallRecord,
  workspaceRoot?: string | null
): FileChangeSummaryItem[] {
  const input = parseTimelineJson(toolCall.argumentsJson);

  const result = parseTimelineJson(toolCall.resultJson);
  const resultJson = result.json as Record<string, unknown> | undefined;
  if (toolCall.toolName === "apply_patch") {
    const changes = parsePatchFileChanges(String(input.patch ?? ""), workspaceRoot);
    const touched = Array.isArray(resultJson?.touched)
      ? resultJson.touched
      : Array.isArray(result.touched) ? result.touched : [];
    return changes.map((change, index) => ({
      ...change,
      absolutePath: typeof touched[index] === "string" ? touched[index] : undefined
    }));
  }

  if (toolCall.toolName === "fs.write_file") {
    const path = typeof input.path === "string" ? input.path : "";
    const absolutePath = typeof resultJson?.path === "string"
      ? resultJson.path
      : typeof result.path === "string" ? result.path : undefined;
    return path
      ? [{ path: toWorkspaceRelativePath(path, workspaceRoot), absolutePath, action: "modified", additions: 0, deletions: 0 }]
      : [];
  }

  return [];
}

function parsePatchFileChanges(patch: string, workspaceRoot?: string | null): FileChangeSummaryItem[] {
  const files: FileChangeSummaryItem[] = [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let current: FileChangeSummaryItem | null = null;

  for (const line of lines) {
    const fileMatch = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (fileMatch) {
      current = {
        path: toWorkspaceRelativePath(fileMatch[2], workspaceRoot),
        action: fileMatch[1] === "Add" ? "created" : fileMatch[1] === "Delete" ? "deleted" : "modified",
        additions: 0,
        deletions: 0
      };
      files.push(current);
      continue;
    }

    if (!current || line.startsWith("*** ") || line.startsWith("@@")) {
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }

  return files;
}

function mergeFileChange(existing: FileChangeSummaryItem | undefined, next: FileChangeSummaryItem): FileChangeSummaryItem {
  if (!existing) {
    return next;
  }

  return {
    path: next.path,
    absolutePath: next.absolutePath ?? existing.absolutePath,
    action: existing.action === "created" && next.action === "modified" ? "created" : next.action,
    additions: existing.additions + next.additions,
    deletions: existing.deletions + next.deletions
  };
}

function toWorkspaceRelativePath(filePath: string, workspaceRoot?: string | null) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedRoot = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");

  if (normalizedRoot && normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath;
}

function FileChangeSummary({
  files,
  onOpenFolder
}: {
  files: FileChangeSummaryItem[];
  onOpenFolder: (filePath: string) => void;
}) {
  const generatedFiles = files.filter((file) => file.kind === "generated-image" || file.kind === "generated-video");
  const otherFiles = files.filter((file) => file.kind !== "generated-image" && file.kind !== "generated-video");
  const additions = otherFiles.reduce((total, file) => total + file.additions, 0);
  const deletions = otherFiles.reduce((total, file) => total + file.deletions, 0);
  const hasLineCounts = additions > 0 || deletions > 0;

  return (
    <>
      {generatedFiles.length > 0 ? (
        <section className="generated-file-list" aria-label="主要改动文件">
          <h3 className="generated-file-list-title">主要改动文件</h3>
          <ul className="generated-file-list-items">
            {generatedFiles.map((file) => (
              <li key={file.path} className="generated-file-list-item">
                <button
                  type="button"
                  className="generated-file-path"
                  onClick={() => onOpenFolder(file.absolutePath ?? file.path)}
                  title="打开所在文件夹"
                >
                  {file.path}
                </button>
                <span className="generated-file-sep" aria-hidden="true">—</span>
                <span className="generated-file-desc">{file.description ?? (file.kind === "generated-video" ? "生成的视频" : "生成的图片")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {otherFiles.length > 0 ? (
        <section className="file-change-summary" aria-label={`已编辑 ${otherFiles.length} 个文件`}>
          <div className="file-change-summary-head">
            <span className="file-change-summary-icon" aria-hidden><IconFileChanges /></span>
            <div className="file-change-summary-title">
              <strong>已编辑 {otherFiles.length} 个文件</strong>
              {hasLineCounts ? (
                <span className="file-change-summary-counts">
                  <b>+{additions}</b>
                  <i>-{deletions}</i>
                </span>
              ) : null}
            </div>
          </div>
          <div className="file-change-summary-list">
            {otherFiles.map((file) => (
              <div key={file.path} className="file-change-summary-row">
                <span className="file-change-row-icon" aria-hidden><IconFile /></span>
                <div className="file-change-row-copy">
                  <strong>{getFileLeafName(file.path)}</strong>
                  <code>{getFileParentPath(file.path)}</code>
                </div>
                <div className="file-change-row-meta">
                  <span className={`file-change-row-badge ${getFileChangeActionClass(file.action)}`}>
                    {formatFileChangeAction(file.action)}
                  </span>
                  {file.additions || file.deletions ? (
                    <span className="file-change-row-counts">
                      {file.additions ? <b>+{file.additions}</b> : null}
                      {file.deletions ? <i>-{file.deletions}</i> : null}
                    </span>
                  ) : null}
                  <button
                    className="file-change-open-folder"
                    onClick={() => onOpenFolder(file.absolutePath ?? file.path)}
                    title="打开所在文件夹"
                    aria-label={`打开 ${file.path} 所在文件夹`}
                  >
                    <IconFolder />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function buildConversationTurnItems(
  messages: MessageRecord[],
  toolCalls: ToolCallRecord[],
  workspaceRoot?: string | null
): ConversationTurnItem[] {
  const filesByTurn = collectFileChangesByTurn(toolCalls, workspaceRoot);

  return messages
    .filter((message) => message.role === "user" && !message.content.startsWith("[internal:"))
    .map((message) => ({
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      files: message.turnRunId ? filesByTurn.get(message.turnRunId) ?? [] : []
    }));
}

function ConversationTurnRail({ turns }: { turns: ConversationTurnItem[] }) {
  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null);

  if (turns.length === 0) {
    return null;
  }

  const latestTurnId = turns.at(-1)?.id;

  return (
    <nav className="conversation-turn-rail" aria-label="问话轨迹">
      {turns.map((turn) => {
        const preview = getConversationTurnPreview(turn.content);
        const isHovered = hoveredTurnId === turn.id;
        const isLatest = latestTurnId === turn.id;

        return (
          <button
            key={turn.id}
            type="button"
            className={`conversation-turn-marker ${isHovered ? "is-hovered" : ""} ${isLatest ? "is-latest" : ""}`}
            aria-label={`问话：${preview}`}
            onClick={() => document.getElementById(`transcript-message-${turn.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
            onMouseEnter={() => setHoveredTurnId(turn.id)}
            onMouseLeave={() => setHoveredTurnId(null)}
            onFocus={() => setHoveredTurnId(turn.id)}
            onBlur={() => setHoveredTurnId(null)}
          >
            <span className="conversation-turn-marker-line" style={{ width: getConversationTurnMarkerWidth(turn.content) }} />
            <span className="conversation-turn-preview" role="tooltip">
              <span className="conversation-turn-preview-copy">{preview}</span>
              {turn.files.length > 0 ? (
                <span className="conversation-turn-preview-files">
                  {turn.files.slice(0, 3).map((file) => <code key={file.path}>{file.path}</code>)}
                  {turn.files.length > 3 ? <em>+{turn.files.length - 3}</em> : null}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function getConversationTurnPreview(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 119)}...` : normalized || "空白问话";
}

function getConversationTurnMarkerWidth(content: string) {
  const length = content.trim().length;
  return Math.min(28, Math.max(7, 6 + Math.round(Math.sqrt(length) * 2.1)));
}

function formatFileChangeAction(action: FileChangeAction) {
  switch (action) {
    case "created":
      return "已生成";
    case "deleted":
      return "已删除";
    default:
      return "已编辑";
  }
}

function getFileChangeActionClass(action: FileChangeAction) {
  switch (action) {
    case "created":
      return "is-created";
    case "deleted":
      return "is-deleted";
    default:
      return "is-modified";
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片预览。"));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("无法读取图片预览。"));
    reader.readAsDataURL(file);
  });
}

function getFileLeafName(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function getFileParentPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "./" : normalized.slice(0, index + 1);
}

function PlanTimeline({ state }: { state: GpaState }) {
  const phases: Array<{ id: Exclude<GpaStage, "off">; label: string }> = [
    { id: "goal", label: "Inspect and clarify the goal" },
    { id: "plan", label: "Build an executable plan" },
    { id: "act", label: "Implement and verify changes" }
  ];
  const order: Record<Exclude<GpaStage, "off">, number> = { goal: 0, plan: 1, act: 2 };
  const current = order[state.stage as Exclude<GpaStage, "off">] ?? 0;
  const items: Array<{ id: string; label: string; status: "pending" | "in_progress" | "completed" }> = state.planTasks.length
    ? state.planTasks.map((task) => ({ id: task.id, label: task.title, status: task.done ? "completed" : "pending" as const }))
    : phases.map((phase, index) => ({
        id: phase.id,
        label: phase.label,
        status: index < current ? "completed" : index === current ? "in_progress" : "pending" as const
      }));

  return (
    <section className="plan-timeline" aria-label="Updated Plan">
      <div className="plan-timeline-title"><span>●</span><strong>Updated Plan</strong></div>
      <div className="plan-timeline-list">
        {items.map((item) => <PlanItem key={item.id} label={item.label} status={item.status} />)}
      </div>
    </section>
  );
}

export function getToolProcessingLabel(toolName: string): string {
  if (toolName === "fs.read_file" || toolName === "knowledge.read" || toolName === "read_mcp_resource") {
    return "正在读取文件";
  }
  if (toolName === "fs.read_directory" || toolName === "list_mcp_resources" || toolName === "list_mcp_resource_templates") {
    return "正在读取目录";
  }
  if (toolName === "fs.write_file" || toolName === "apply_patch") {
    return "正在写入文件";
  }
  if (toolName === "code.search" || toolName === "knowledge.search") {
    return "正在搜索代码";
  }
  if (toolName === "web_search.search_query") {
    return "正在搜索网络";
  }
  if (toolName.startsWith("browser.") || toolName === "web_search.open_page") {
    return "正在操作浏览器";
  }
  if (toolName.startsWith("git.")) {
    return toolName === "git.commit" ? "正在创建提交" : "正在检查 Git 状态";
  }
  if (toolName === "shell.exec") {
    return "正在执行命令";
  }
  if (toolName === "multi_agents.spawn") {
    return "正在启动子任务";
  }
  return "正在调用工具";
}

function RuntimeActivityPanel({
  label,
  entries,
  expanded,
  onToggle
}: {
  label: string;
  entries: RuntimeActivityEntry[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const latestStatus = [...entries].reverse().find((entry) => entry.kind === "status");
  const detailEntries = [...entries].reverse();
  return (
    <section className={`runtime-activity-panel ${expanded ? "expanded" : ""}`} aria-live="polite">
      <button
        type="button"
        className="runtime-activity-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="task-processing-dots" aria-hidden="true"><i /><i /><i /></span>
        <span>{label}</span>
        <span className="runtime-activity-chevron" aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="runtime-activity-details">
          {detailEntries.length > 0 ? detailEntries.map((entry) => {
            if (entry.kind === "tool") {
              return <ToolActivityRow key={entry.id} toolCall={entry.toolCall} compact />;
            }
            if (entry.kind === "output") {
              return <RuntimeActivityOutputRow key={entry.id} label={entry.label} content={entry.content} />;
            }
            return (
              <div key={entry.id} className="runtime-activity-status-row">
                <span className="runtime-activity-status-dot" aria-hidden="true" />
                <span>{entry.label}</span>
              </div>
            );
          }) : (
            <div className="runtime-activity-status-row current">
              <span className="runtime-activity-status-dot" aria-hidden="true" />
              <span>{latestStatus?.label ?? label}</span>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function RuntimeActivityOutputRow({ label, content }: { label: string; content: string }) {
  return (
    <details className="runtime-activity-output">
      <summary>
        <span className="runtime-activity-output-icon" aria-hidden><IconTerminal /></span>
        <strong>{label}</strong>
        <span>查看输出</span>
      </summary>
      <pre>{content}</pre>
    </details>
  );
}

function QueuedMessageList({
  messages,
  hasProject,
  deletingId,
  onDelete
}: {
  messages: QueuedMessageRecord[];
  hasProject: boolean;
  deletingId: string | null;
  onDelete: (id: string) => void;
}) {
  return (
    <section className={`composer-queue ${hasProject ? "has-project" : ""}`} aria-label="排队消息">
      {messages.map((message) => (
        <div key={message.id} className="composer-queue-item">
          <span className="composer-queue-label">排队中</span>
          <span className="composer-queue-preview" title={message.displayContent}>{message.displayContent}</span>
          {message.attachments.length > 0 ? <span className="composer-queue-attachments">{message.attachments.length} 个附件</span> : null}
          <button
            type="button"
            className="composer-queue-delete"
            title="删除排队消息"
            aria-label="删除排队消息"
            disabled={deletingId === message.id}
            onClick={() => onDelete(message.id)}
          >
            <IconClose />
          </button>
        </div>
      ))}
    </section>
  );
}

function GpaConfirmationCard({
  stage,
  disabled,
  isEditing,
  revisionDraft,
  revisionRef,
  onConfirm,
  onRevise,
  onRevisionChange,
  onRevisionCancel,
  onRevisionSubmit
}: {
  stage: Exclude<GpaStage, "off" | "act">;
  disabled: boolean;
  isEditing: boolean;
  revisionDraft: string;
  revisionRef: React.RefObject<HTMLTextAreaElement | null>;
  onConfirm: () => void;
  onRevise: () => void;
  onRevisionChange: (value: string) => void;
  onRevisionCancel: () => void;
  onRevisionSubmit: () => void;
}) {
  const isPlan = stage === "plan";
  const title = isPlan ? "确认计划" : "确认目标";
  const description = isPlan
    ? "计划确认后将直接进入执行阶段。"
    : "目标确认后将生成可执行的任务计划。";
  const confirmLabel = isPlan ? "确认并开始执行" : "确认并生成计划";

  if (isEditing) {
    return (
      <section className="gpa-confirmation editing" aria-label="修改计划">
        <div className="gpa-confirmation-copy">
          <strong>修改计划</strong>
          <span>说明需要调整的范围、顺序或验收条件。</span>
        </div>
        <textarea
          ref={revisionRef}
          className="gpa-revision-input"
          value={revisionDraft}
          onChange={(event) => onRevisionChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              onRevisionSubmit();
            }
          }}
          placeholder="例如：先完成基础玩法，再加入难度选择；验收时补充单元测试。"
          disabled={disabled}
        />
        <div className="gpa-revision-footer">
          <span>Ctrl / Cmd + Enter 提交</span>
          <div className="gpa-confirmation-actions">
            <button className="gpa-confirmation-button secondary" type="button" onClick={onRevisionCancel} disabled={disabled}>
              取消
            </button>
            <button className="gpa-confirmation-button primary" type="button" onClick={onRevisionSubmit} disabled={disabled || !revisionDraft.trim()}>
              提交修改
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="gpa-confirmation" aria-label={title}>
      <div className="gpa-confirmation-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="gpa-confirmation-actions">
        <button className="gpa-confirmation-button secondary" type="button" onClick={onRevise} disabled={disabled}>
          修改
        </button>
        <button className="gpa-confirmation-button primary" type="button" onClick={onConfirm} disabled={disabled}>
          {confirmLabel}
        </button>
      </div>
    </section>
  );
}

function PlanItem({ label, status }: { label: string; status: "pending" | "in_progress" | "completed" }) {
  return (
    <div className={`plan-timeline-item ${status}`}>
      <span className="plan-tree">└─</span>
      <StatusIcon status={status} />
      <span className="plan-timeline-label">{label}</span>
    </div>
  );
}

function StatusIcon({ status }: { status: "pending" | "in_progress" | "completed" | "failed" }) {
  const glyph = status === "completed" ? "✔" : status === "in_progress" ? "◐" : status === "failed" ? "✕" : "□";
  return <span className={`timeline-status-icon ${status}`}>{glyph}</span>;
}

function DirectoryReadGroup({ directory, count }: { directory: string; count: number }) {
  return (
    <section className="directory-read-group">
      <span className="directory-read-group-dot" aria-hidden="true" />
      <span>检查 <code>{directory}</code> 目录内容</span>
      <span className="directory-read-group-count">{count} 次</span>
    </section>
  );
}

function ExecutionStep({ toolCall }: { toolCall: ToolCallRecord }) {
  const input = parseTimelineJson(toolCall.argumentsJson);
  const result = parseTimelineJson(toolCall.resultJson);
  const command = getTimelineCommand(toolCall.toolName, input);
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const failed = toolCall.status === "failed" || toolCall.status === "denied";
  const status = isRunning ? "in_progress" : failed ? "failed" : "completed";
  const duration = toolCall.completedAt
    ? Math.max(0, Date.parse(toolCall.completedAt) - Date.parse(toolCall.startedAt))
    : null;
  const output = getTimelineOutput(result);
  const localUrl = typeof result.localUrl === "string" ? result.localUrl : null;

  return (
    <details className={`execution-step ${status}`}>
      <summary className="execution-step-head">
        <StatusIcon status={status} />
        <strong>{isRunning ? "Running" : failed ? "Command failed" : "Ran command"}</strong>
        <span className="execution-tool-name">{formatToolName(toolCall.toolName)}</span>
        {duration !== null ? <span className="execution-duration">{formatDuration(duration)}</span> : null}
      </summary>
      <div className="execution-step-details">
        <code className="execution-command">$ {command}</code>
        {localUrl ? <LocalServerPreview url={localUrl} /> : null}
        {output ? (
          <details className="execution-output" open={failed}>
            <summary>{failed ? "View error output" : "View output"}</summary>
            <pre>{output}</pre>
            <MessageDetectedMediaGallery content={output} />
          </details>
        ) : isRunning ? <div className="execution-progress">Working…</div> : null}
      </div>
    </details>
  );
}

function ToolActivityGroup({ toolCalls }: { toolCalls: ToolCallRecord[] }) {
  const runningCall = toolCalls.find((toolCall) => toolCall.status === "running" || toolCall.status === "pending");
  const failed = toolCalls.some((toolCall) => toolCall.status === "failed" || toolCall.status === "denied");
  const status = runningCall ? "in_progress" : failed ? "failed" : "completed";
  const summary = getToolActivitySummary(toolCalls, runningCall);

  return (
    <details className={`tool-activity-group ${status}`} open={failed}>
      <summary className="tool-activity-summary">
        <span className="tool-activity-summary-icon" aria-hidden><ToolActivityIcon toolName={runningCall?.toolName ?? toolCalls[0]?.toolName ?? ""} /></span>
        <span className="tool-activity-summary-copy">
          <strong>{summary.title}</strong>
          {summary.detail ? <span>{summary.detail}</span> : null}
        </span>
        {runningCall ? <span className="tool-activity-running">进行中</span> : null}
        <span className="tool-activity-chevron" aria-hidden />
      </summary>
      <div className="tool-activity-details">
        {toolCalls.map((toolCall) => <ToolActivityRow key={toolCall.id} toolCall={toolCall} />)}
      </div>
    </details>
  );
}

function ToolActivityRow({ toolCall, compact = false }: { toolCall: ToolCallRecord; compact?: boolean }) {
  const input = parseTimelineJson(toolCall.argumentsJson);
  const result = parseTimelineJson(toolCall.resultJson);
  const command = getTimelineCommand(toolCall.toolName, input);
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const failed = toolCall.status === "failed" || toolCall.status === "denied";
  const status = isRunning ? "in_progress" : failed ? "failed" : "completed";
  const duration = toolCall.completedAt
    ? Math.max(0, Date.parse(toolCall.completedAt) - Date.parse(toolCall.startedAt))
    : null;
  const output = getTimelineOutput(result);
  const localUrl = typeof result.localUrl === "string" ? result.localUrl : null;
  const target = isFileWriteTool(toolCall.toolName) ? getFileWriteTarget(input) : command;

  if (compact) {
    return (
      <details className={`tool-activity-row compact ${status}`}>
        <summary className="tool-activity-compact-summary">
          <span className="tool-activity-row-icon" aria-hidden><ToolActivityIcon toolName={toolCall.toolName} /></span>
          <strong>{getToolActivityLabel(toolCall.toolName)}</strong>
          <code title={target}>{target}</code>
          <span className="tool-activity-compact-status">{isRunning ? "执行中" : failed ? "失败" : "完成"}</span>
          {duration !== null ? <time>{formatDuration(duration)}</time> : null}
        </summary>
        <div className="tool-activity-compact-details">
          <code>$ {command}</code>
          {localUrl ? <LocalServerPreview url={localUrl} /> : null}
          {output ? (
            <details className="tool-activity-output">
              <summary>{failed ? "查看错误输出" : "查看输出"}</summary>
              <pre>{output}</pre>
              <MessageDetectedMediaGallery content={output} />
            </details>
          ) : isRunning ? <span className="tool-activity-row-progress">等待工具返回...</span> : null}
        </div>
      </details>
    );
  }

  return (
    <article className={`tool-activity-row ${status}`}>
      <span className="tool-activity-row-icon" aria-hidden><ToolActivityIcon toolName={toolCall.toolName} /></span>
      <div className="tool-activity-row-copy">
        <div className="tool-activity-row-head">
          <strong>{getToolActivityLabel(toolCall.toolName)}</strong>
          <span>{isRunning ? "正在执行" : failed ? "执行失败" : "已完成"}</span>
          {duration !== null ? <time>{formatDuration(duration)}</time> : null}
        </div>
        <code>{isFileWriteTool(toolCall.toolName) ? getFileWriteTarget(input) : `$ ${command}`}</code>
        {localUrl ? <LocalServerPreview url={localUrl} /> : null}
        {output ? (
          <details className="tool-activity-output" open={failed}>
            <summary>{failed ? "查看错误输出" : "查看输出"}</summary>
            <pre>{output}</pre>
            <MessageDetectedMediaGallery content={output} />
          </details>
        ) : isRunning ? <span className="tool-activity-row-progress">等待工具返回...</span> : null}
      </div>
    </article>
  );
}

function ToolActivityIcon({ toolName }: { toolName: string }) {
  if (toolName === "shell.exec" || toolName === "execute_command") return <IconTerminal />;
  if (isFileWriteTool(toolName)) return <IconFileChanges />;
  if (toolName === "fs.read_file") return <IconFile />;
  if (toolName === "fs.read_directory") return <IconFolder />;
  if (toolName === "code.search" || toolName === "knowledge.search") return <IconSearch />;
  if (toolName.startsWith("browser.") || toolName.startsWith("web_search.")) return <IconGlobe />;
  return <IconTerminal />;
}

function getToolActivitySummary(toolCalls: ToolCallRecord[], runningCall?: ToolCallRecord) {
  if (runningCall) {
    const input = parseTimelineJson(runningCall.argumentsJson);
    return {
      title: getToolProcessingLabel(runningCall.toolName),
      detail: isFileWriteTool(runningCall.toolName) ? getFileWriteTarget(input) : getTimelineCommand(runningCall.toolName, input)
    };
  }

  const commandCount = toolCalls.filter((toolCall) => toolCall.toolName === "shell.exec" || toolCall.toolName === "execute_command").length;
  const fileCount = toolCalls.filter((toolCall) => isFileWriteTool(toolCall.toolName)).length;
  const failed = toolCalls.some((toolCall) => toolCall.status === "failed" || toolCall.status === "denied");

  if (failed) return { title: "部分步骤执行失败", detail: `${toolCalls.length} 个操作` };
  if (fileCount && commandCount) return { title: `编辑了 ${fileCount} 个文件，运行了 ${commandCount} 个命令` };
  if (commandCount) return { title: commandCount === 1 ? "运行了 1 个命令" : `运行了 ${commandCount} 个命令` };
  if (fileCount) return { title: fileCount === 1 ? "编辑了 1 个文件" : `编辑了 ${fileCount} 个文件` };
  return { title: toolCalls.length === 1 ? getToolActivityLabel(toolCalls[0]?.toolName ?? "") : `调用了 ${toolCalls.length} 个工具` };
}

function getToolActivityLabel(toolName: string) {
  if (toolName === "shell.exec" || toolName === "execute_command") return "运行命令";
  if (toolName === "fs.read_file") return "读取文件";
  if (toolName === "fs.read_directory") return "读取目录";
  if (isFileWriteTool(toolName)) return "写入文件";
  if (toolName === "code.search" || toolName === "knowledge.search") return "搜索代码";
  if (toolName.startsWith("browser.")) return "操作浏览器";
  return formatToolName(toolName);
}

function getFileWriteTarget(input: Record<string, unknown>) {
  const path = input.path ?? input.filePath;
  if (typeof path === "string" && path.trim()) return path;
  const patch = input.patch;
  if (typeof patch === "string") {
    const match = patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
    if (match?.[1]) return match[1];
  }
  return "文件变更";
}

function LocalServerPreview({ url }: { url: string }) {
  return (
    <section className="local-server-preview">
      <span className="local-server-preview-icon" aria-hidden="true"><IconGlobe /></span>
      <span className="local-server-preview-copy">
        <strong>网页预览</strong>
        <span>{url}</span>
      </span>
      <button type="button" onClick={() => void window.codexh.openExternal(url)}>
        打开网页
      </button>
    </section>
  );
}

function ApprovalCard({
  approval,
  resolving,
  onResolve
}: {
  approval: ApprovalRequest;
  resolving: boolean;
  onResolve: (decision: "approved" | "denied", mode?: "once" | "session" | "remember") => void;
}) {
  return (
    <section className="approval-card" aria-label={`审批请求: ${approval.title}`}>
      <div className="approval-card-copy">
        <span className="approval-card-label">需要审批</span>
        <strong>{approval.title}</strong>
        <p>{approval.description}</p>
      </div>
      <div className="approval-card-actions">
        <button type="button" className="approval-deny-button" disabled={resolving} onClick={() => onResolve("denied")}>
          拒绝
        </button>
        <button type="button" className="approval-session-button" disabled={resolving} onClick={() => onResolve("approved", "session")}>
          本会话允许
        </button>
        <button type="button" className="approval-remember-button" disabled={resolving} onClick={() => onResolve("approved", "remember")}>
          允许且不再询问
        </button>
        <button type="button" className="approval-allow-button" disabled={resolving} onClick={() => onResolve("approved", "once")}>
          {resolving ? "处理中..." : "允许并继续"}
        </button>
      </div>
    </section>
  );
}

function UserInputPromptCard({
  prompt,
  resolving,
  canAnswer,
  onAnswer
}: {
  prompt: UserInputPrompt;
  resolving: boolean;
  canAnswer: boolean;
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const pending = prompt.status === "pending";
  const canSubmit = prompt.questions.every((question) => {
    const hasOptions = (question.options?.length ?? 0) > 0;
    return !hasOptions || !!selected[question.id] || !!notes[question.id]?.trim();
  });

  if (!pending) {
    const skipped = Object.values(prompt.answers ?? {}).includes("__skip__");
    const firstQuestion = prompt.questions[0];
    const rawAnswer = firstQuestion ? prompt.answers?.[firstQuestion.id] ?? "" : "";
    const selectedLabel = firstQuestion?.options?.find((option) => option.id === rawAnswer)?.label;
    const summary = selectedLabel ?? rawAnswer.replace(/^__custom__:/, "");
    return (
      <section className="user-input-prompt-card resolved" aria-label={`${prompt.title} 已处理`}>
        <span className="user-input-prompt-resolved-mark" aria-hidden><IconCheck /></span>
        <span>{prompt.kind === "gpa_plan_clarification" ? "计划澄清已选择" : "已提供输入"}</span>
        <strong>{skipped ? "保持原计划" : summary || "已提交"}</strong>
      </section>
    );
  }

  if (!canAnswer) {
    return (
      <section className="user-input-prompt-card resolved interrupted" aria-label={`${prompt.title} 已中断`}>
        <span className="user-input-prompt-resolved-mark" aria-hidden><IconClose /></span>
        <span>该问题所属任务已中断</span>
        <strong>请重新开始后再决定</strong>
      </section>
    );
  }

  return (
    <section id={`user-input-prompt-${prompt.id}`} className={`user-input-prompt-card ${prompt.kind}`} aria-label={prompt.title}>
      <header className="user-input-prompt-head">
        <span className="user-input-prompt-icon" aria-hidden><IconHelpCircle /></span>
        <strong>{prompt.title}</strong>
      </header>
      <div className="user-input-prompt-questions">
        {prompt.questions.map((question, index) => (
          <fieldset key={question.id} className="user-input-question" disabled={resolving}>
            <legend>{prompt.questions.length > 1 ? `${index + 1}. ${question.label}` : question.label}</legend>
            <p>{question.prompt}</p>
            {question.options?.length ? (
              <div className="user-input-options">
                {question.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`user-input-option ${selected[question.id] === option.id ? "selected" : ""}`}
                    onClick={() => setSelected((current) => ({ ...current, [question.id]: option.id }))}
                  >
                    <span className="user-input-option-marker" aria-hidden>{selected[question.id] === option.id ? "●" : "○"}</span>
                    <span className="user-input-option-copy">
                      <strong>{option.label}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                    {option.recommended ? <em>推荐</em> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {(question.allowFreeText || !question.options?.length) ? (
              <textarea
                value={notes[question.id] ?? ""}
                onChange={(event) => setNotes((current) => ({ ...current, [question.id]: event.target.value }))}
                placeholder="补充你的决定或其他方案"
                rows={2}
              />
            ) : null}
          </fieldset>
        ))}
      </div>
      <footer className="user-input-prompt-actions">
        {prompt.allowSkip ? (
          <button type="button" className="user-input-skip" disabled={resolving} onClick={() => onAnswer({ [prompt.questions[0]?.id ?? "decision"]: "__skip__" })}>
            跳过
          </button>
        ) : <span />}
        <button
          type="button"
          className="user-input-submit"
          disabled={resolving || !canSubmit}
          onClick={() => {
            const answers: Record<string, string> = {};
            for (const question of prompt.questions) {
              const note = notes[question.id]?.trim();
              answers[question.id] = selected[question.id] || (note ? `__custom__:${note}` : "");
              if (note && selected[question.id]) answers[`${question.id}__note`] = `__note__:${note}`;
            }
            onAnswer(answers);
          }}
        >
          {resolving ? "提交中..." : "确认选择"}
        </button>
      </footer>
    </section>
  );
}

function parseTimelineJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function getTimelineCommand(toolName: string, input: Record<string, unknown>): string {
  const command = input.command ?? input.filePath ?? input.path ?? input.query;
  return typeof command === "string" && command.trim() ? command : toolName;
}

function getTimelineOutput(result: Record<string, unknown>): string {
  const content = result.content;
  if (typeof content === "string") return content;
  return Object.keys(result).length > 0 ? JSON.stringify(result, null, 2) : "";
}

function formatToolName(name: string): string {
  return name.replace(/[._-]+/g, " ");
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function renderRole(role: string, assistantLabel = "Assistant") {
  switch (role) {
    case "assistant":
      return assistantLabel;
    case "user":
      return "User";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return role;
  }
}

type UserMessageActions = {
  editingMessage: { id: string; content: string } | null;
  onEditDraftChange: (content: string) => void;
  onCopy: (content: string) => void;
  onEdit: (message: MessageRecord) => void;
  onEditCancel: () => void;
  onEditSubmit: () => void;
};

function renderTranscriptMessage(
  message: MessageRecord,
  assistantLabel: string,
  userMessageActions: UserMessageActions
) {
  const displayContent = getDisplayMessageContent(message);
  if (message.role === "assistant" && !displayContent.trim()) {
    return null;
  }

  if (message.role === "user") {
    return (
      <article id={`transcript-message-${message.id}`} key={message.id} className="message-card user">
        {renderMessageContent(message, displayContent, userMessageActions)}
      </article>
    );
  }

  return (
    <article id={`transcript-message-${message.id}`} key={message.id} className={`message-card ${message.role}`}>
      <div className="message-header">
        <span className={`message-author ${message.role}`}>{renderRole(message.role, assistantLabel)}</span>
        <span className="timestamp">{formatRelativeTime(message.createdAt)}</span>
      </div>
      <div className="message-flat-body">{renderMessageContent(message, displayContent)}</div>
    </article>
  );
}

function renderMessageContent(
  message: MessageRecord,
  content = message.content,
  userMessageActions?: UserMessageActions
) {
  const attachments = getMessageAttachments(message);
  if (message.role === "user") {
    if (!userMessageActions) {
      return (
        <div className="message-user-content">
          <div className="message-user-bubble">
            {content ? <div className="message-user-text">{content}</div> : null}
            <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
          </div>
        </div>
      );
    }

    const editingMessage =
      userMessageActions.editingMessage?.id === message.id ? userMessageActions.editingMessage : null;
    return (
      <div className={`message-user-content ${editingMessage ? "is-editing" : ""}`}>
        <div className="message-user-bubble">
          {editingMessage ? (
            <>
              <textarea
                className="message-user-edit-input"
                value={editingMessage.content}
                onChange={(event) => userMessageActions.onEditDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    userMessageActions.onEditSubmit();
                  }
                }}
                aria-label="编辑已发送的消息"
                autoFocus
              />
              <div className="message-user-edit-actions">
                <button type="button" className="message-user-edit-button" onClick={userMessageActions.onEditCancel}>
                  取消
                </button>
                <button
                  type="button"
                  className="message-user-edit-button primary"
                  onClick={userMessageActions.onEditSubmit}
                  disabled={!editingMessage.content.trim()}
                >
                  发送
                </button>
              </div>
            </>
          ) : (
            <>
              {content ? <div className="message-user-text">{content}</div> : null}
              <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
              <div className="message-user-actions" aria-label="消息操作">
                <button
                  type="button"
                  title="复制消息"
                  aria-label="复制消息"
                  onClick={() => userMessageActions.onCopy(content)}
                >
                  <IconCopy />
                </button>
                <button
                  type="button"
                  title="重新编辑消息"
                  aria-label="重新编辑消息"
                  onClick={() => userMessageActions.onEdit(message)}
                >
                  <IconCompose />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const eventBlocks = parseMessageEventBlocks({ ...message, content });
  const knowledgeSources = message.role === "assistant" ? getMessageKnowledgeSources(message) : [];
  const browserSources = message.role === "assistant" ? getMessageBrowserSources(message) : [];
  if (!eventBlocks || eventBlocks.length === 0) {
    return <>
      {renderMarkdownDocument(content, `${message.id}-markdown`, "message-markdown")}
      {message.role === "assistant" ? <MessageDetectedMediaGallery content={content} /> : null}
      <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
      <MessageKnowledgeSources sources={knowledgeSources} />
      <MessageBrowserSources sources={browserSources} />
    </>;
  }

  return (
    <div className="message-event-stream">
      {eventBlocks.map((block, index) => renderEventBlock(block, `${message.id}-${block.type}-${index}`))}
      {message.role === "assistant" ? <MessageDetectedMediaGallery content={content} /> : null}
      <MessageAttachmentGallery threadId={message.threadId} attachments={attachments} />
      <MessageKnowledgeSources sources={knowledgeSources} />
      <MessageBrowserSources sources={browserSources} />
    </div>
  );
}

function getMessageKnowledgeSources(message: MessageRecord): MessageKnowledgeSource[] {
  try {
    const sources = JSON.parse(message.metadataJson ?? "{}").knowledgeSources;
    if (!Array.isArray(sources)) return [];
    return sources.filter((source): source is MessageKnowledgeSource =>
      Boolean(source) &&
      typeof source.knowledgeBaseId === "string" &&
      typeof source.knowledgeBaseName === "string" &&
      typeof source.sourcePath === "string"
    );
  } catch {
    return [];
  }
}

function MessageKnowledgeSources({ sources }: { sources: MessageKnowledgeSource[] }) {
  if (sources.length === 0) return null;
  const byKnowledgeBase = new Map<string, MessageKnowledgeSource[]>();
  for (const source of sources) {
    byKnowledgeBase.set(source.knowledgeBaseId, [...(byKnowledgeBase.get(source.knowledgeBaseId) ?? []), source]);
  }
  return (
    <div className="message-knowledge-sources" aria-label="知识库来源">
      {[...byKnowledgeBase.values()].map((entries) => {
        const [source] = entries;
        const locations = entries.map((item) => `${item.sourcePath}${item.locator ? ` (${item.locator})` : ""}`).join("\n");
        return (
          <span key={source.knowledgeBaseId} className="message-knowledge-source" title={`知识库来源\n${locations}`}>
            <IconKnowledge />
            <span>知识库来源 · {source.knowledgeBaseName}</span>
          </span>
        );
      })}
    </div>
  );
}

function getMessageBrowserSources(message: MessageRecord): MessageBrowserSource[] {
  try {
    const sources = JSON.parse(message.metadataJson ?? "{}").browserSources;
    if (!Array.isArray(sources)) return [];
    return sources.filter((source): source is MessageBrowserSource =>
      Boolean(source) &&
      typeof source.title === "string" &&
      typeof source.url === "string" &&
      /^https?:\/\//i.test(source.url)
    );
  } catch {
    return [];
  }
}

function MessageBrowserSources({ sources }: { sources: MessageBrowserSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="message-browser-sources" aria-label="网页来源">
      {sources.map((source) => (
        <a
          key={source.url}
          className="message-browser-source"
          href={source.url}
          title={`网页来源\n${source.title}\n${source.url}`}
          onClick={(event) => {
            event.preventDefault();
            void window.codexh.openExternal(source.url);
          }}
        >
          <IconGlobe />
          <span>网页来源 · {source.title}</span>
        </a>
      ))}
    </div>
  );
}

function getMessageAttachments(message: MessageRecord): MessageAttachment[] {
  try {
    const attachments = JSON.parse(message.metadataJson ?? "{}").attachments;
    return Array.isArray(attachments) ? attachments as MessageAttachment[] : [];
  } catch {
    return [];
  }
}

type MessageMediaPreview = {
  source: string;
  name: string;
  kind: "image" | "video";
  localPath?: string;
  url?: string;
};

function isVideoAttachment(attachment: MessageAttachment): boolean {
  if (attachment.kind === "video") return true;
  if (attachment.mimeType?.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|mkv)$/i.test(attachment.name || attachment.absolutePath || "");
}

function MessageAttachmentGallery({ threadId, attachments }: { threadId: string; attachments: MessageAttachment[] }) {
  const [preview, setPreview] = useState<MessageMediaPreview | null>(null);
  if (attachments.length === 0) return null;
  const mediaCount = attachments.filter((attachment) => attachment.kind === "image" || isVideoAttachment(attachment)).length;
  return (
    <>
      <div className={`message-attachment-gallery ${mediaCount > 1 ? "image-grid" : ""}`}>
        {attachments.map((attachment) => {
          if (attachment.kind === "image") {
            return (
              <MessageAttachmentImage
                key={attachment.id}
                threadId={threadId}
                attachment={attachment}
                onPreview={(source) => setPreview({
                  source,
                  name: attachment.name,
                  kind: "image",
                  localPath: attachment.absolutePath
                })}
              />
            );
          }
          if (isVideoAttachment(attachment)) {
            return (
              <MessageAttachmentVideo
                key={attachment.id}
                threadId={threadId}
                attachment={attachment}
                onExpand={(source) => setPreview({
                  source,
                  name: attachment.name,
                  kind: "video",
                  localPath: attachment.absolutePath
                })}
              />
            );
          }
          return (
            <button
              key={attachment.id}
              type="button"
              className="message-file-attachment"
              title={`打开文件：${attachment.absolutePath}`}
              onClick={() => void window.codexh.openPath(attachment.absolutePath)}
            >
              <IconFile />{attachment.name}
            </button>
          );
        })}
      </div>
      {preview ? <MessageMediaLightbox preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

function MessageAttachmentImage({
  threadId,
  attachment,
  onPreview
}: {
  threadId: string;
  attachment: MessageAttachment;
  onPreview: (source: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.codexh.previewAttachment({ threadId, absolutePath: attachment.absolutePath })
      .then((value) => { if (!cancelled) setSource(value); })
      .catch(() => { if (!cancelled) setSource(null); });
    return () => { cancelled = true; };
  }, [attachment.absolutePath, threadId]);
  return (
    <button className="message-image-attachment" type="button" title={`查看原图：${attachment.name}`} onClick={() => source && onPreview(source)}>
      {source ? <img src={source} alt={attachment.name} /> : <span><IconImage />{attachment.name}</span>}
    </button>
  );
}

function MessageAttachmentVideo({
  threadId,
  attachment,
  onExpand
}: {
  threadId: string;
  attachment: MessageAttachment;
  onExpand: (source: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.codexh.getAttachmentMediaUrl({ threadId, absolutePath: attachment.absolutePath })
      .then((value) => {
        if (cancelled) return;
        if (value.kind !== "video") {
          setError("无法预览该视频");
          return;
        }
        setSource(value.url);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [attachment.absolutePath, threadId]);

  if (error) {
    return (
      <button
        type="button"
        className="message-file-attachment"
        title={error}
        onClick={() => void window.codexh.openPath(attachment.absolutePath)}
      >
        <IconVideo />{attachment.name}
      </button>
    );
  }

  return (
    <div className="message-video-attachment">
      <div className="message-video-attachment-head">
        <span title={attachment.name}><IconVideo />{attachment.name}</span>
        <div>
          <button
            type="button"
            title="放大播放"
            aria-label="放大播放"
            disabled={!source}
            onClick={() => source && onExpand(source)}
          >
            <IconEye />
          </button>
          <button
            type="button"
            title="打开本地文件"
            aria-label="打开本地文件"
            onClick={() => void window.codexh.openPath(attachment.absolutePath)}
          >
            <IconFolder />
          </button>
        </div>
      </div>
      {source ? (
        <video className="message-video-player" src={source} controls playsInline preload="metadata" />
      ) : (
        <div className="message-video-loading">正在加载视频…</div>
      )}
    </div>
  );
}

function MessageMediaLightbox({ preview, onClose }: { preview: MessageMediaPreview; onClose: () => void }) {
  return createPortal(
    <div className="message-image-lightbox" role="dialog" aria-modal="true" aria-label={preview.name} onClick={onClose}>
      <div className="message-image-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <div className="message-image-lightbox-head">
          <span title={preview.name}>{preview.name}</span>
          <div>
            {preview.localPath ? (
              <button type="button" title="打开本地文件" aria-label="打开本地文件" onClick={() => void window.codexh.openPath(preview.localPath!)}><IconFolder /></button>
            ) : null}
            {preview.url ? (
              <button type="button" title="打开网页" aria-label="打开网页" onClick={() => void window.codexh.openExternal(preview.url!)}><IconGlobe /></button>
            ) : null}
            <button type="button" title="关闭" aria-label="关闭" onClick={onClose}><IconClose /></button>
          </div>
        </div>
        {preview.kind === "video" ? (
          <video className="message-video-lightbox-player" src={preview.source} controls autoPlay playsInline />
        ) : (
          <img src={preview.source} alt={preview.name} />
        )}
      </div>
    </div>,
    document.body
  );
}

type MessageMediaReference = { source: string; kind: "local" | "url" };

function MessageDetectedMediaGallery({ content }: { content: string }) {
  const references = extractMessageMediaReferences(content);
  const [preview, setPreview] = useState<MessageMediaPreview | null>(null);
  if (references.length === 0) return null;
  return (
    <>
      <div className={`message-attachment-gallery detected-media ${references.length > 1 ? "image-grid" : ""}`}>
        {references.map((reference) => (
          <DetectedMessageImage
            key={reference.source}
            reference={reference}
            onPreview={(source) => setPreview({
              source,
              name: getFileLeafName(reference.source),
              kind: "image",
              ...(reference.kind === "local" ? { localPath: reference.source } : { url: reference.source })
            })}
          />
        ))}
      </div>
      {preview ? <MessageMediaLightbox preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}

function DetectedMessageImage({ reference, onPreview }: { reference: MessageMediaReference; onPreview: (source: string) => void }) {
  const [source, setSource] = useState<string | null>(reference.kind === "url" ? reference.source : null);
  useEffect(() => {
    if (reference.kind === "url") {
      setSource(reference.source);
      return;
    }
    let cancelled = false;
    void window.codexh.previewLocalImage({ absolutePath: reference.source })
      .then((value) => { if (!cancelled) setSource(value); })
      .catch(() => { if (!cancelled) setSource(null); });
    return () => { cancelled = true; };
  }, [reference]);
  if (!source) return null;
  return (
    <button className="message-image-attachment" type="button" title={`查看原图：${getFileLeafName(reference.source)}`} onClick={() => onPreview(source)}>
      <img src={source} alt={getFileLeafName(reference.source)} />
    </button>
  );
}

function extractMessageMediaReferences(content: string): MessageMediaReference[] {
  const matches: MessageMediaReference[] = [];
  const seen = new Set<string>();
  const add = (source: string, kind: MessageMediaReference["kind"]) => {
    const normalized = source.replace(/[),.;，。；]+$/, "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    matches.push({ source: normalized, kind });
  };
  const localPattern = /[a-zA-Z]:[\\/][^\r\n<>"|?*]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;
  const urlPattern = /https?:\/\/[^\s<>()]+?\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s<>()]*)?/gi;
  for (const match of content.matchAll(localPattern)) add(match[0], "local");
  for (const match of content.matchAll(urlPattern)) add(match[0], "url");
  return matches;
}

function parseMessageEventBlocks(message: MessageRecord): ChatEventBlock[] | null {
  if (message.role === "tool") {
    return buildToolEventBlocks(message);
  }

  if (message.role === "assistant" || message.role === "system") {
    return parseStructuredEventBlocks(message.content);
  }

  return null;
}

function renderEventBlock(block: ChatEventBlock, key: string) {
  if (block.type === "commentary") {
    return (
      <section key={key} className="event-block commentary">
        <div className="event-commentary-shell">
          <span className={`event-badge ${block.type}`}>{block.type}</span>
          <div className="event-commentary-copy">
            {renderMarkdownDocument(block.content, `${key}-markdown`, "event-commentary-markdown")}
          </div>
        </div>
      </section>
    );
  }

  if (block.type === "final") {
    return (
      <section key={key} className="event-block final">
        <div className="event-block-head">
          <span className={`event-badge ${block.type}`}>{block.type}</span>
          <span className="event-title">{block.title ?? "Outcome"}</span>
        </div>
        <div className="event-final-shell">
          {renderMarkdownDocument(block.content, `${key}-markdown`, "event-final-markdown")}
        </div>
      </section>
    );
  }

  const meta = collectEventMeta(block);

  return (
    <section key={key} className={`event-block ${block.type}`}>
      <div className="event-block-head">
        <span className={`event-badge ${block.type}`}>{block.type}</span>
        <span className="event-title">{getEventPrimaryTitle(block)}</span>
        {meta.length > 0 ? (
          <div className="event-meta-row">
            {meta.map((item) => (
              <span key={`${key}-${item.label}`} className={`event-meta-pill ${item.tone}`}>
                {item.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {renderEventDetails(block, key)}
    </section>
  );
}

function parseStructuredEventBlocks(content: string): ChatEventBlock[] | null {
  const xmlBlocks = parseXmlEventBlocks(content);
  if (xmlBlocks && xmlBlocks.length > 0) {
    return xmlBlocks;
  }

  return parseLabeledEventBlocks(content);
}

function renderStreamingAssistant(content: string, keyPrefix: string): ReactNode {
  const eventBlocks = parseStreamingEventBlocks(content);
  if (!eventBlocks || eventBlocks.length === 0) {
    return renderMarkdownDocument(content, keyPrefix, "event-final-markdown");
  }
  return <div className="message-event-stream">{eventBlocks.map((block, index) =>
    renderEventBlock(block, `${keyPrefix}-${block.type}-${index}`)
  )}</div>;
}

function parseStreamingEventBlocks(content: string): ChatEventBlock[] | null {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const openPattern = /<event\b([^>]*)>/gi;
  const closePattern = /<\/event\s*>/gi;
  const blocks: ChatEventBlock[] = [];
  let sawEvent = false;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = openPattern.exec(normalized)) !== null) {
    sawEvent = true;
    const before = normalized.slice(cursor, match.index).trim();
    if (before) blocks.push({ type: "commentary", content: before });

    const attributes = parseEventAttributes(match[1] ?? "");
    const type = normalizeEventType(attributes.type) ?? "commentary";
    const contentStart = match.index + match[0].length;
    closePattern.lastIndex = contentStart;
    const closingTag = closePattern.exec(normalized);
    const contentEnd = closingTag?.index ?? normalized.length;
    blocks.push({
      type,
      content: normalized.slice(contentStart, contentEnd).trim(),
      title: attributes.title,
      name: attributes.name,
      status: attributes.status,
      path: attributes.path,
      action: attributes.action,
      startLine: parseNumericAttribute(attributes.start_line),
      durationMs: parseNumericAttribute(attributes.duration_ms),
      exitCode: parseNumericAttribute(attributes.exit_code),
      ok: parseBooleanAttribute(attributes.ok)
    });

    if (!closingTag) return blocks;
    cursor = closingTag.index + closingTag[0].length;
    openPattern.lastIndex = cursor;
  }

  if (!sawEvent) {
    const incompleteTagAt = normalized.search(/<event\b[^>]*$/i);
    return incompleteTagAt >= 0
      ? (normalized.slice(0, incompleteTagAt).trim() ? [{ type: "commentary", content: normalized.slice(0, incompleteTagAt).trim() }] : [])
      : null;
  }

  const after = normalized.slice(cursor).trim();
  const incompleteTagAt = after.search(/<event\b[^>]*$/i);
  const visibleAfter = (incompleteTagAt >= 0 ? after.slice(0, incompleteTagAt) : after).trim();
  if (visibleAfter) blocks.push({ type: "commentary", content: visibleAfter });
  return blocks;
}

function parseXmlEventBlocks(content: string): ChatEventBlock[] | null {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const eventPattern = /<event\b([^>]*)>([\s\S]*?)<\/event>/gi;
  const blocks: ChatEventBlock[] = [];
  let matched = false;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = eventPattern.exec(normalized)) !== null) {
    matched = true;
    const before = normalized.slice(lastIndex, match.index).trim();
    if (before) {
      blocks.push({ type: "commentary", content: before });
    }

    const attributes = parseEventAttributes(match[1] ?? "");
    const type = normalizeEventType(attributes.type);
    if (type) {
      blocks.push({
        type,
        content: match[2].trim(),
        title: attributes.title,
        name: attributes.name,
        status: attributes.status,
        path: attributes.path,
        action: attributes.action,
        startLine: parseNumericAttribute(attributes.start_line),
        durationMs: parseNumericAttribute(attributes.duration_ms),
        exitCode: parseNumericAttribute(attributes.exit_code),
        ok: parseBooleanAttribute(attributes.ok)
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (!matched) {
    return null;
  }

  const after = normalized.slice(lastIndex).trim();
  if (after) {
    blocks.push({ type: "commentary", content: after });
  }

  return blocks;
}

function parseLabeledEventBlocks(content: string): ChatEventBlock[] | null {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: ChatEventBlock[] = [];
  let current: { type: ChatEventType; lines: string[]; explicit: boolean } | null = null;
  let sawExplicitEvent = false;
  let inCodeFence = false;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    const nextContent = current.lines.join("\n").trim();
    if (nextContent || current.explicit) {
      blocks.push({
        type: current.type,
        content: nextContent
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      if (!current) {
        current = { type: "commentary", lines: [rawLine], explicit: false };
      } else {
        current.lines.push(rawLine);
      }
      continue;
    }

    const match =
      !inCodeFence &&
      trimmed.match(/^(commentary|tool_call|tool_result|file_view|file_change|test_result|final)(?:\s*[:|-]\s*(.*))?$/i);

    if (match) {
      sawExplicitEvent = true;
      pushCurrent();
      current = {
        type: match[1].toLowerCase() as ChatEventType,
        lines: match[2]?.trim() ? [match[2].trim()] : [],
        explicit: true
      };
      continue;
    }

    if (!current) {
      current = { type: "commentary", lines: [rawLine], explicit: false };
      continue;
    }

    current.lines.push(rawLine);
  }

  pushCurrent();

  return sawExplicitEvent ? blocks : null;
}

function buildToolEventBlocks(message: MessageRecord): ChatEventBlock[] {
  const normalized = message.content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  const title = lines[0]?.trim() || "tool";
  const resultContent = lines.slice(1).join("\n").trim();

  return [
    {
      type: "tool_call",
      title,
      name: title,
      status: "completed",
      content: ""
    },
    {
      type: "tool_result",
      name: title,
      status: "completed",
      content: resultContent || "Tool completed."
    }
  ];
}

function usesMonospaceEventBody(type: ChatEventType): boolean {
  return type === "tool_call" || type === "file_view" || type === "file_change";
}

function renderEventDetails(block: ChatEventBlock, key: string) {
  if (!block.content) {
    return null;
  }

  switch (block.type) {
    case "tool_call":
      return renderMonoShell(block.content, key, "event-mono");
    case "tool_result":
      return renderToolResultBody(block, key);
    case "file_view":
      return renderFileViewBody(block, key);
    case "file_change":
      return renderFileChangeBody(block, key);
    case "test_result":
      return renderTestResultBody(block, key);
    default:
      return usesMonospaceEventBody(block.type)
        ? renderMonoShell(block.content, key, "event-mono")
        : renderMarkdownDocument(block.content, `${key}-markdown`, "event-markdown");
  }
}

function renderToolResultBody(block: ChatEventBlock, key: string) {
  const sections = parseNamedSections(block.content);
  const content = sections.preview ?? sections.body;
  const remainder = sections.preview ? sections.body : "";

  return (
    <div className="event-stack">
      {content
        ? looksLikeStructuredOutput(content)
          ? renderMonoShell(content, `${key}-preview`, "event-mono")
          : renderMarkdownDocument(content, `${key}-preview`, "event-markdown")
        : null}
      {remainder ? renderMarkdownDocument(remainder, `${key}-body`, "event-markdown") : null}
    </div>
  );
}

function renderFileViewBody(block: ChatEventBlock, key: string) {
  return (
    <div className="event-stack">
      {block.path ? (
        <div className="event-path-row">
          <code>{block.path}</code>
          {typeof block.startLine === "number" ? <span className="event-inline-line">Line {block.startLine}</span> : null}
        </div>
      ) : null}
      {renderMonoShell(block.content, `${key}-file-view`, "event-mono event-code")}
    </div>
  );
}

function renderFileChangeBody(block: ChatEventBlock, key: string) {
  const sections = parseNamedSections(block.content);
  let summary = sections.summary ?? "";
  let diff = sections.diff ?? "";
  let remainder = sections.body;

  if (!diff) {
    const extracted = splitDiffFromContent(remainder);
    summary = summary || extracted.summary;
    diff = extracted.diff;
    remainder = extracted.remainder;
  }

  return (
    <div className="event-stack">
      {summary ? renderMarkdownDocument(summary, `${key}-summary`, "event-markdown event-summary-markdown") : null}
      {remainder ? renderMarkdownDocument(remainder, `${key}-details`, "event-markdown") : null}
      {diff ? renderMonoShell(diff, `${key}-diff`, "event-mono event-diff") : null}
    </div>
  );
}

function renderTestResultBody(block: ChatEventBlock, key: string) {
  const sections = parseNamedSections(block.content);
  const summary = sections.summary || sections.body;
  const details = sections.details;

  return (
    <div className="event-stack">
      {summary ? renderMarkdownDocument(summary, `${key}-summary`, "event-markdown") : null}
      {details ? renderMonoShell(details, `${key}-details`, "event-mono") : null}
    </div>
  );
}

function renderMonoShell(content: string, key: string, className: string) {
  return (
    <div key={key} className="event-mono-shell">
      <CopyTextButton content={content} />
      <pre className={className}>{content}</pre>
    </div>
  );
}

function getEventPrimaryTitle(block: ChatEventBlock) {
  switch (block.type) {
    case "tool_call":
    case "tool_result":
    case "test_result":
      return block.name ?? block.title ?? "Task event";
    case "file_view":
    case "file_change":
      return block.path ?? block.title ?? "Workspace file";
    default:
      return block.title ?? block.type;
  }
}

function collectEventMeta(block: ChatEventBlock): Array<{ label: string; tone: string }> {
  const meta: Array<{ label: string; tone: string }> = [];

  if (block.action) {
    meta.push({ label: formatEventAction(block.action), tone: "action" });
  }

  if (block.status) {
    meta.push({ label: block.status, tone: mapStatusTone(block.status) });
  }

  if (typeof block.ok === "boolean") {
    meta.push({ label: block.ok ? "ok" : "failed", tone: block.ok ? "success" : "danger" });
  }

  if (typeof block.exitCode === "number") {
    meta.push({ label: `exit ${block.exitCode}`, tone: block.exitCode === 0 ? "neutral" : "danger" });
  }

  if (typeof block.durationMs === "number") {
    meta.push({ label: `${block.durationMs} ms`, tone: "neutral" });
  }

  if (typeof block.startLine === "number" && !block.path) {
    meta.push({ label: `L${block.startLine}`, tone: "neutral" });
  }

  return meta;
}

function formatEventAction(action: string) {
  switch (action.trim().toLowerCase()) {
    case "create":
    case "created":
      return "Created";
    case "update":
    case "updated":
    case "modify":
    case "modified":
      return "Modified";
    case "delete":
    case "deleted":
      return "Deleted";
    case "move":
    case "moved":
      return "Moved";
    default:
      return action;
  }
}

function mapStatusTone(status: string) {
  switch (status.trim().toLowerCase()) {
    case "running":
    case "queued":
    case "in_progress":
      return "running";
    case "completed":
    case "success":
      return "success";
    case "failed":
    case "error":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

function parseEventAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const attributePattern = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(source)) !== null) {
    attributes[match[1].toLowerCase()] = match[2];
  }

  return attributes;
}

function normalizeEventType(value?: string): ChatEventType | null {
  switch ((value ?? "").trim().toLowerCase().replace(/-/g, "_")) {
    case "commentary":
      return "commentary";
    case "tool_call":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    case "file_view":
      return "file_view";
    case "file_change":
      return "file_change";
    case "test_result":
      return "test_result";
    case "final":
      return "final";
    default:
      return null;
  }
}

function parseBooleanAttribute(value?: string) {
  if (!value) {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function parseNumericAttribute(value?: string) {
  if (!value) {
    return undefined;
  }

  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
}

function parseNamedSections(content: string) {
  const sections = new Map<string, string[]>();
  let current = "body";

  const pushLine = (key: string, value: string) => {
    const bucket = sections.get(key) ?? [];
    bucket.push(value);
    sections.set(key, bucket);
  };

  for (const line of content.split("\n")) {
    const match = line.match(/^(summary|preview|diff|details|notes):\s*(.*)$/i);
    if (match) {
      current = match[1].toLowerCase();
      if (match[2]) {
        pushLine(current, match[2]);
      } else if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }

    pushLine(current, line);
  }

  return {
    body: (sections.get("body") ?? []).join("\n").trim(),
    summary: (sections.get("summary") ?? []).join("\n").trim(),
    preview: (sections.get("preview") ?? []).join("\n").trim(),
    diff: (sections.get("diff") ?? []).join("\n").trim(),
    details: (sections.get("details") ?? []).join("\n").trim(),
    notes: (sections.get("notes") ?? []).join("\n").trim()
  };
}

function splitDiffFromContent(content: string) {
  const lines = content.split("\n");
  const diffIndex = lines.findIndex((line) => /^(@@|\+\+\+|---)/.test(line.trim()));

  if (diffIndex < 0) {
    return {
      summary: "",
      diff: "",
      remainder: content.trim()
    };
  }

  return {
    summary: lines.slice(0, diffIndex).join("\n").trim(),
    diff: lines.slice(diffIndex).join("\n").trim(),
    remainder: ""
  };
}

function looksLikeStructuredOutput(content: string) {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```")) {
    return true;
  }

  if (trimmed.includes("\n")) {
    return true;
  }

  return /^([A-Z]:\\|\/|@@|\+\+\+|---|\$ |\> )/.test(trimmed);
}

function filterTranscriptMessages(messages: MessageRecord[], threadStatus?: ThreadRecord["status"] | null) {
  if (messages.length === 0) {
    return messages;
  }

  const activeTurnRunId = isThreadExecutionInProgress(threadStatus ?? null)
    ? [...messages].reverse().find((message) => message.turnRunId)?.turnRunId ?? null
    : null;
  const turnIdsWithOutcome = new Set<string>();
  let hasStandaloneOutcome = false;

  for (const message of messages) {
    if (!isOutcomeTranscriptMessage(message)) {
      continue;
    }

    if (message.turnRunId) {
      turnIdsWithOutcome.add(message.turnRunId);
    } else {
      hasStandaloneOutcome = true;
    }
  }

  const hasAnyOutcome = hasStandaloneOutcome || turnIdsWithOutcome.size > 0;

  const filteredMessages = messages.filter((message) => {
    if (message.content.startsWith("[internal:gpa-confirm]")) {
      return false;
    }

    if (!isCommentaryOnlyTranscriptMessage(message)) {
      return true;
    }

    if (message.turnRunId) {
      if (activeTurnRunId && message.turnRunId === activeTurnRunId) {
        return true;
      }

      return !turnIdsWithOutcome.has(message.turnRunId);
    }

    return !hasAnyOutcome;
  });

  const visibleAssistantMessages = new Set<string>();
  return filteredMessages.filter((message) => {
    if (message.role !== "assistant" || !message.turnRunId) {
      return true;
    }

    const fingerprint = message.content.replace(/\s+/g, " ").trim();
    if (!fingerprint || visibleAssistantMessages.has(`${message.turnRunId}:${fingerprint}`)) {
      return !fingerprint;
    }

    visibleAssistantMessages.add(`${message.turnRunId}:${fingerprint}`);
    return true;
  });
}

function formatUpdatePhase(phase: UpdateState["phase"]): string {
  switch (phase) {
    case "checking": return "正在检查";
    case "up-to-date": return "已是最新";
    case "available": return "发现新版本";
    case "downloading": return "正在下载";
    case "downloaded": return "已验证，可安装";
    case "installing": return "正在安装";
    case "error": return "更新失败";
    default: return "等待检查";
  }
}

function isCommentaryOnlyTranscriptMessage(message: MessageRecord) {
  if (message.role !== "assistant" && message.role !== "system") {
    return false;
  }

  const eventBlocks = parseMessageEventBlocks(message);
  return Boolean(eventBlocks && eventBlocks.length > 0 && eventBlocks.every((block) => block.type === "commentary"));
}

function isOutcomeTranscriptMessage(message: MessageRecord) {
  if (message.role === "tool") {
    return true;
  }

  if (message.role !== "assistant" && message.role !== "system") {
    return false;
  }

  const eventBlocks = parseMessageEventBlocks(message);
  if (!eventBlocks || eventBlocks.length === 0) {
    return Boolean(message.content.trim());
  }

  return eventBlocks.some((block) => block.type !== "commentary");
}

function renderMarkdownDocument(content: string, keyPrefix: string, className: string) {
  const blocks = parseMarkdownBlocks(content);
  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      {blocks.map((block, index) => renderMarkdownBlock(block, `${keyPrefix}-${index}`))}
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, key: string) {
  switch (block.kind) {
    case "heading": {
      const content = renderMarkdownInline(block.text, `${key}-inline`);
      switch (Math.min(6, Math.max(1, block.level))) {
        case 1:
          return <h1 key={key}>{content}</h1>;
        case 2:
          return <h2 key={key}>{content}</h2>;
        case 3:
          return <h3 key={key}>{content}</h3>;
        case 4:
          return <h4 key={key}>{content}</h4>;
        case 5:
          return <h5 key={key}>{content}</h5>;
        default:
          return <h6 key={key}>{content}</h6>;
      }
    }
    case "paragraph":
      return <p key={key}>{renderMarkdownInline(block.text, `${key}-inline`)}</p>;
    case "unordered-list":
      return (
        <ul key={key}>
          {block.items.map((item, index) => (
            <li key={`${key}-item-${index}`}>{renderMarkdownInline(item, `${key}-item-inline-${index}`)}</li>
          ))}
        </ul>
      );
    case "ordered-list":
      return (
        <ol key={key}>
          {block.items.map((item, index) => (
            <li key={`${key}-item-${index}`}>{renderMarkdownInline(item, `${key}-item-inline-${index}`)}</li>
          ))}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote key={key}>
          {block.lines.map((line, index) => (
            <p key={`${key}-quote-${index}`}>{renderMarkdownInline(line, `${key}-quote-inline-${index}`)}</p>
          ))}
        </blockquote>
      );
    case "code":
      return (
        <div key={key} className="markdown-code-block">
          <CopyTextButton content={block.content} />
          {block.language ? <div className="markdown-code-label">{block.language}</div> : null}
          <pre>
            <code>{block.content}</code>
          </pre>
        </div>
      );
    case "table":
      return (
        <div key={key} className="markdown-table-wrap">
          <table className="markdown-table">
            <thead>
              <tr>
                {block.headers.map((header, index) => (
                  <th key={`${key}-header-${index}`}>{renderMarkdownInline(header, `${key}-header-${index}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {block.headers.map((_, columnIndex) => (
                    <td key={`${key}-cell-${rowIndex}-${columnIndex}`}>
                      {renderMarkdownInline(row[columnIndex] ?? "", `${key}-cell-${rowIndex}-${columnIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

function CopyTextButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={`copy-text-button ${copied ? "is-copied" : ""}`}
      title={copied ? "已复制" : "复制内容"}
      aria-label={copied ? "已复制" : "复制内容"}
      onClick={() => void copy()}
    >
      <IconCopy />
    </button>
  );
}

function renderMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /!\[([^\]]*)\]\(([^)]+)\)|`([^`\n]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0;
  let tokenIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(...renderPlainTextReferences(text.slice(cursor, match.index), `${keyPrefix}-text-${tokenIndex}`));
      tokenIndex += 1;
    }

    if (match[1] && match[2]) {
      const source = match[2];
      nodes.push((isSafeMarkdownImageSource(source) || isAbsoluteLocalPath(source))
        ? <MarkdownMessageImage key={`${keyPrefix}-image-${tokenIndex}`} source={source} alt={match[1]} />
        : <span key={`${keyPrefix}-image-${tokenIndex}`}>{match[1] || source}</span>);
    } else if (match[3]) {
      nodes.push(<code key={`${keyPrefix}-code-${tokenIndex}`}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      const linkLabel = match[4];
      const linkTarget = match[5];
      nodes.push(<OpenableMessageReference key={`${keyPrefix}-link-${tokenIndex}`} target={linkTarget} label={linkLabel} />);
    } else if (match[6]) {
      nodes.push(<strong key={`${keyPrefix}-strong-${tokenIndex}`}>{match[6]}</strong>);
    } else if (match[7]) {
      nodes.push(<em key={`${keyPrefix}-em-${tokenIndex}`}>{match[7]}</em>);
    }

    cursor = tokenPattern.lastIndex;
    tokenIndex += 1;
  }

  if (cursor < text.length) {
    nodes.push(...renderPlainTextReferences(text.slice(cursor), `${keyPrefix}-tail-${tokenIndex}`));
  }

  return nodes;
}

function renderPlainTextReferences(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const referencePattern = /https?:\/\/[^\s<>()]+|[a-zA-Z]:[\\/][^\s<>"|?*]+/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = referencePattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(<span key={`${keyPrefix}-text-${index}`}>{text.slice(cursor, match.index)}</span>);
    const reference = match[0].replace(/[),.;，。；]+$/, "");
    const trailing = match[0].slice(reference.length);
    nodes.push(<OpenableMessageReference key={`${keyPrefix}-reference-${index}`} target={reference} label={reference} />);
    if (trailing) nodes.push(<span key={`${keyPrefix}-trailing-${index}`}>{trailing}</span>);
    cursor = match.index + match[0].length;
    index += 1;
  }
  if (cursor < text.length || nodes.length === 0) nodes.push(<span key={`${keyPrefix}-tail`}>{text.slice(cursor)}</span>);
  return nodes;
}

function OpenableMessageReference({ target, label }: { target: string; label: string }) {
  const localPath = isAbsoluteLocalPath(target);
  return (
    <span className={`message-reference ${localPath ? "local" : ""}`}>
      <a
        href={target}
        className={`markdown-link ${localPath || isFileReferenceLink(target) ? "file" : ""}`}
        title={target}
        onClick={(event) => {
          event.preventDefault();
          if (/^https?:\/\//i.test(target)) void window.codexh.openExternal(target);
          else if (localPath) void window.codexh.openPath(target);
        }}
      >
        {label}
      </a>
      {localPath ? (
        <button type="button" title="打开所在文件夹" aria-label="打开所在文件夹" onClick={() => void window.codexh.openFolder(target)}>
          <IconFolder />
        </button>
      ) : null}
    </span>
  );
}

function MarkdownMessageImage({ source, alt }: { source: string; alt: string }) {
  const isLocal = isAbsoluteLocalPath(source);
  const [previewSource, setPreviewSource] = useState<string | null>(isLocal ? null : source);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    if (!isLocal) return;
    let cancelled = false;
    void window.codexh.previewLocalImage({ absolutePath: source })
      .then((value) => { if (!cancelled) setPreviewSource(value); })
      .catch(() => { if (!cancelled) setPreviewSource(null); });
    return () => { cancelled = true; };
  }, [isLocal, source]);
  if (!previewSource) return <span>{alt || source}</span>;
  return <>
    <button className="markdown-image-button" type="button" onClick={() => setPreviewOpen(true)} title={`查看原图：${alt || getFileLeafName(source)}`}>
      <img className="markdown-image" src={previewSource} alt={alt} />
    </button>
    {previewOpen ? (
      <MessageMediaLightbox
        preview={{
          source: previewSource,
          name: alt || getFileLeafName(source),
          kind: "image",
          ...(isLocal ? { localPath: source } : { url: source })
        }}
        onClose={() => setPreviewOpen(false)}
      />
    ) : null}
  </>;
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const blocks: MarkdownBlock[] = [];
  const lines = normalized.split("\n");
  let paragraphLines: string[] = [];
  let listState: { ordered: boolean; items: string[] } | null = null;
  let quoteLines: string[] = [];
  let codeFence: { language?: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ").trim() });
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listState || listState.items.length === 0) {
      listState = null;
      return;
    }
    blocks.push({
      kind: listState.ordered ? "ordered-list" : "unordered-list",
      items: [...listState.items]
    });
    listState = null;
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) {
      return;
    }
    blocks.push({ kind: "blockquote", lines: [...quoteLines] });
    quoteLines = [];
  };

  const flushTextualState = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();

    if (codeFence) {
      if (trimmed.startsWith("```")) {
        blocks.push({
          kind: "code",
          language: codeFence.language,
          content: codeFence.lines.join("\n")
        });
        codeFence = null;
      } else {
        codeFence.lines.push(rawLine);
      }
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushTextualState();
      codeFence = {
        language: trimmed.slice(3).trim() || undefined,
        lines: []
      };
      continue;
    }

    if (!trimmed) {
      flushTextualState();
      continue;
    }

    const nextLine = lines[lineIndex + 1]?.trim();
    if (isMarkdownTableRow(trimmed) && nextLine && isMarkdownTableDivider(nextLine)) {
      flushTextualState();
      const headers = splitMarkdownTableRow(trimmed);
      const rows: string[][] = [];
      lineIndex += 2;
      while (lineIndex < lines.length && isMarkdownTableRow(lines[lineIndex].trim())) {
        rows.push(normalizeMarkdownTableRow(splitMarkdownTableRow(lines[lineIndex].trim()), headers.length));
        lineIndex += 1;
      }
      lineIndex -= 1;
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushTextualState();
      blocks.push({
        kind: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2]
      });
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushQuote();
      if (!listState || listState.ordered) {
        flushList();
        listState = { ordered: false, items: [] };
      }
      listState.items.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      if (!listState || !listState.ordered) {
        flushList();
        listState = { ordered: true, items: [] };
      }
      listState.items.push(orderedMatch[1]);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraphLines.push(trimmed);
  }

  flushTextualState();

  if (codeFence) {
    blocks.push({
      kind: "code",
      language: codeFence.language,
      content: codeFence.lines.join("\n")
    });
  }

  return blocks;
}

function isMarkdownTableRow(line: string): boolean {
  return /^\|?.+\|.+\|?$/.test(line);
}

function isMarkdownTableDivider(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function normalizeMarkdownTableRow(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function isFileReferenceLink(href: string) {
  return /^[a-zA-Z]:[\\/]/.test(href) || href.startsWith("/") || href.startsWith(".\\") || href.startsWith("./");
}

function getWorkspaceLabel(thread: ThreadRecord | null) {
  const target = thread?.cwd?.trim();
  if (!target) {
    return "workagent";
  }

  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "workagent";
}

function formatRelativeTime(isoTime: string) {
  const target = new Date(isoTime).getTime();
  const diffMs = Date.now() - target;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

  if (diffMinutes < 1) {
    return "刚刚";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} 天前`;
}

function cloneConfig(config: AppConfig): AppConfig {
  const multimodal = config.multimodal ?? {
    image: { enabled: true },
    video: { enabled: true }
  };
  return {
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
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
      }
    },
    desktop: { ...config.desktop },
    mcpServers: config.mcpServers.map((server) => ({
      ...server,
      args: server.args ? [...server.args] : undefined,
      env: server.env ? { ...server.env } : undefined
    }))
  };
}

function normalizeDraftConfig(config: AppConfig): AppConfig {
  const next = cloneConfig(config);
  next.models = next.models.filter((model) =>
    next.providers.some((provider) => provider.id === model.providerId)
  );

  next.models = next.models.map((model) => ({
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

function resolveSelectionFromConfig(
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

function resolveSettingsProviderId(config: AppConfig, preferredProviderId?: string | null): string | null {
  if (preferredProviderId && config.providers.some((provider) => provider.id === preferredProviderId)) {
    return preferredProviderId;
  }

  return (
    config.providers.find((provider) => getModelsForProvider(config, provider.id).length > 0)?.id ??
    config.providers[0]?.id ??
    null
  );
}

function getModelsForProvider(config: Pick<AppConfig, "models">, providerId: string): ModelProfile[] {
  return config.models.filter((model) => model.providerId === providerId);
}

function isReasoningModel(model: ModelProfile): boolean {
  return model.role === "reasoning";
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function getReasoningModelsForProvider(config: Pick<AppConfig, "models">, providerId: string): ModelProfile[] {
  return getModelsForProvider(config, providerId).filter(isReasoningModel);
}

function isSafeMarkdownImageSource(source: string): boolean {
  return /^https:\/\//i.test(source) || /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(source);
}

function isAbsoluteLocalPath(source: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(source) || /^\\\\/.test(source);
}

function formatKnowledgeScope(scope: KnowledgeScope): string {
  if (scope === "global") return "全局";
  if (scope === "project") return "项目";
  return "会话";
}

function formatKnowledgeStatus(status: KnowledgeBaseSummary["status"]): string {
  if (status === "ready") return "可用";
  if (status === "importing") return "索引中";
  return "失败";
}

function formatKnowledgeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getModelProfileKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function formatLatency(latencyMs: number): string {
  return latencyMs >= 1_000 ? `${(latencyMs / 1_000).toFixed(2)} s` : `${latencyMs} ms`;
}

function formatTokensPerSecond(tokensPerSecond: number): string {
  return `${tokensPerSecond.toFixed(tokensPerSecond >= 10 ? 1 : 2)} Tokens/s`;
}

function getProviderDisplayName(provider: ProviderDefinition): string {
  return provider.name?.trim() || provider.id;
}

function getProviderTransportLabel(type: ProviderType): string {
  return PROVIDER_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

function getProviderSubtitle(provider: ProviderDefinition): string {
  return provider.baseUrl?.trim() || getProviderTransportLabel(provider.type);
}

function hasStoredSecret(provider: ProviderDefinition): boolean {
  return Boolean(provider.apiKey || provider.apiKeyEnv);
}

function createEmptyProvider(existingProviders: ProviderDefinition[]): ProviderDefinition {
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

function parseMcpEnvironment(value: string): Record<string, string> | undefined {
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

function createModelProfile(providerId: string, modelId: string, displayName: string): ModelProfile {
  const normalizedId = modelId.trim();
  const normalizedDisplayName = displayName.trim() || normalizedId;

  return {
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
  };
}

function buildConfigToSave(
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

function gpaModeLabel(mode: GpaStage): string {
  switch (mode) {
    case "goal":
      return "目标 GOAL";
    case "plan":
      return "计划 PLAN";
    case "act":
      return "执行 ACT";
    default:
      return "GPA";
  }
}


function SvgIcon({
  children,
  size = 18,
  className
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function IconSidebar() {
  return (
    <SvgIcon>
      <rect x="3.5" y="4" width="17" height="16" rx="4" />
      <path d="M9 4v16" />
    </SvgIcon>
  );
}

function IconChevronLeft() {
  return (
    <SvgIcon>
      <path d="m14.5 6.5-5 5 5 5" />
    </SvgIcon>
  );
}

function IconChevronRight() {
  return (
    <SvgIcon>
      <path d="m9.5 6.5 5 5-5 5" />
    </SvgIcon>
  );
}

function IconChevronDown() {
  return (
    <SvgIcon>
      <path d="m6.5 9.5 5.5 5 5.5-5" />
    </SvgIcon>
  );
}

function getDisplayMessageContent(message: MessageRecord): string {
  if (message.role !== "assistant") {
    return message.content;
  }

  return stripAssistantToolMarkup(message.content);
}

function stripAssistantToolMarkup(content: string): string {
  const visible = content
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls\s*>/gi, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result\s*>/gi, "")
    .replace(/<tool_calls\b[^>]*>[\s\S]*$/i, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*$/i, "")
    .replace(/<\/tool_(?:calls|result)\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n");
  const tagStart = visible.lastIndexOf("<");
  if (tagStart === -1) {
    return visible;
  }

  const trailing = visible.slice(tagStart).toLowerCase();
  return "<tool_calls".startsWith(trailing) || "<tool_result".startsWith(trailing)
    ? visible.slice(0, tagStart)
    : visible;
}

function IconTerminal() {
  return (
    <SvgIcon>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="m7.5 9 3 3-3 3" />
      <path d="M13.5 15h3" />
    </SvgIcon>
  );
}

function IconGlobe() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4" />
      <path d="M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5C9.8 18.2 8.7 15.4 8.7 12S9.8 5.8 12 3.5z" />
    </SvgIcon>
  );
}

function IconSearch() {
  return (
    <SvgIcon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </SvgIcon>
  );
}

function IconCompose() {
  return (
    <SvgIcon>
      <path d="M12 20h8" />
      <path d="m16.5 3.5 4 4-11 11-5 1 1-5z" />
    </SvgIcon>
  );
}

function IconCopy() {
  return (
    <SvgIcon>
      <rect x="8" y="8" width="10" height="11" rx="1.5" />
      <path d="M6 16.5H5.5A1.5 1.5 0 0 1 4 15V5.5A1.5 1.5 0 0 1 5.5 4H14a1.5 1.5 0 0 1 1.5 1.5V6" />
    </SvgIcon>
  );
}

function IconCheck() {
  return (
    <SvgIcon>
      <path d="m6 12.5 3.8 3.8L18 8.2" />
    </SvgIcon>
  );
}

function IconPin() {
  return (
    <SvgIcon>
      <path d="m9 4 6 6" />
      <path d="m7 9 8 8" />
      <path d="M14.5 4.5 19 9l-3 1.5-3.5 3.5L11 17l-4-4 3-1.5 3.5-3.5z" />
      <path d="m7 17-3 3" />
    </SvgIcon>
  );
}

function IconCode() {
  return (
    <SvgIcon>
      <path d="m9.25 7-4 5 4 5" />
      <path d="m14.75 7 4 5-4 5" />
      <path d="m13.25 5.5-2.5 13" />
    </SvgIcon>
  );
}

function IconImage() {
  return (
    <SvgIcon>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m5.5 17 4.5-4 3 2.5 2.5-2 3 3.5" />
    </SvgIcon>
  );
}

function IconVideo() {
  return (
    <SvgIcon>
      <rect x="3.5" y="6" width="12" height="12" rx="2" />
      <path d="m15.5 10 5-2.5v9L15.5 14z" />
    </SvgIcon>
  );
}

function IconSkills() {
  return (
    <SvgIcon>
      <path d="M12 3.5 14 8l4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2z" />
      <path d="m18 15 .8 1.7L20.5 18l-1.7.8L18 20.5l-.8-1.7-1.7-.8 1.7-.8z" />
    </SvgIcon>
  );
}

function IconMcp() {
  return (
    <SvgIcon>
      <circle cx="7" cy="8" r="2.5" />
      <circle cx="17" cy="7" r="2.5" />
      <circle cx="13" cy="17" r="2.5" />
      <path d="m9.2 8.2 5.5-.8M8.6 10l3.1 4.8m4.2-5.3-1.8 5" />
    </SvgIcon>
  );
}

function IconFolder() {
  return (
    <SvgIcon>
      <path d="M3.5 8.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </SvgIcon>
  );
}

function IconFile() {
  return (
    <SvgIcon>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13.5 3.5v4h4" />
    </SvgIcon>
  );
}

function IconEye() {
  return (
    <SvgIcon>
      <path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5z" />
      <circle cx="12" cy="12" r="2.5" />
    </SvgIcon>
  );
}

function IconFileChanges() {
  return (
    <SvgIcon size={18}>
      <rect x="5" y="4.5" width="12" height="14" rx="2.5" />
      <path d="M8.5 2.5h8a2 2 0 0 1 2 2v10" />
      <path d="M8 11.5h6" />
      <path d="M11 8.5v6" />
    </SvgIcon>
  );
}

function IconPlus() {
  return (
    <SvgIcon>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </SvgIcon>
  );
}

function IconTrash() {
  return (
    <SvgIcon size={16}>
      <path d="M7.5 7.25h9" />
      <path d="M10 5.5h4" />
      <path d="M9.25 8.5v7.25c0 .69.56 1.25 1.25 1.25h3c.69 0 1.25-.56 1.25-1.25V8.5" />
      <path d="M11 10.25v4.5" />
      <path d="M13 10.25v4.5" />
    </SvgIcon>
  );
}

function IconRefresh() {
  return (
    <SvgIcon size={16}>
      <path d="M19 8.5V4.5l-1.7 1.7A7.1 7.1 0 0 0 5.6 8.1" />
      <path d="M5 15.5v4l1.7-1.7a7.1 7.1 0 0 0 11.7-1.9" />
    </SvgIcon>
  );
}

function IconSpinner() {
  return (
    <SvgIcon size={16}>
      <circle cx="12" cy="12" r="6.75" opacity="0.22" />
      <path d="M18.75 12a6.75 6.75 0 0 0-6.75-6.75" />
    </SvgIcon>
  );
}

function IconClose() {
  return (
    <SvgIcon>
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </SvgIcon>
  );
}

function IconGear() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 0 1-4 0v-.1a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.1a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 0 1 4 0v.1a1 1 0 0 0 .6.9h.1a1 1 0 0 0 1.1-.2l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6H20a2 2 0 0 1 0 4h-.1a1 1 0 0 0-.9.6z" />
    </SvgIcon>
  );
}

function IconHelpCircle() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.75 9.25a2.45 2.45 0 0 1 4.6 1.2c0 1.6-1.85 2.1-1.85 3.35" />
      <path d="M12 17h.01" />
    </SvgIcon>
  );
}

function IconSinglePanel() {
  return (
    <SvgIcon>
      <rect x="4" y="5" width="16" height="14" rx="3" />
    </SvgIcon>
  );
}

function IconSplitPanel() {
  return (
    <SvgIcon>
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <path d="M12 5v14" />
    </SvgIcon>
  );
}

function IconCodexMark() {
  return (
    <SvgIcon size={38} className="codex-mark-icon">
      <path d="M12 4.5c2.4 0 4 1.6 4.6 3.4 2 .1 3.9 1.7 3.9 4.1 0 1.8-1.1 3.2-2.7 3.9-.5 2.3-2.2 4.1-4.8 4.1-2.1 0-3.4-1-4.3-2.3-2.5.2-4.8-1.5-4.8-4.2 0-1.9 1.2-3.5 3-4.1.1-2.8 2.2-4.9 5.1-4.9z" />
      <path d="M9 15.5 11.5 8l3 8" />
      <path d="M8 12h8" />
    </SvgIcon>
  );
}

function IconExplore() {
  return (
    <SvgIcon>
      <path d="M14.5 9.5 19 5" />
      <path d="M9 13 5 17" />
      <path d="m14.5 14.5 4 4" />
      <path d="M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z" />
    </SvgIcon>
  );
}

function IconBuild() {
  return (
    <SvgIcon>
      <path d="m5 19 6.5-6.5" />
      <path d="m14 6 4 4" />
      <path d="m12.5 4.5 1.5 1.5-6 6L6.5 10z" />
      <path d="M13.5 10.5 19 16" />
    </SvgIcon>
  );
}

function IconReview() {
  return (
    <SvgIcon>
      <path d="M6 8a6 6 0 0 1 10-2.7L18 7" />
      <path d="M18 7V3.5" />
      <path d="M18 16a6 6 0 0 1-10 2.7L6 17" />
      <path d="M6 17v3.5" />
    </SvgIcon>
  );
}

function IconFix() {
  return (
    <SvgIcon>
      <path d="M10 4v5l-4.5 7.5a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3L14 9V4" />
      <path d="M9 4h6" />
      <path d="M9 13h6" />
    </SvgIcon>
  );
}

function IconArrowUp() {
  return (
    <SvgIcon>
      <path d="M12 18V6" />
      <path d="m7 11 5-5 5 5" />
    </SvgIcon>
  );
}

function IconStop() {
  return (
    <SvgIcon size={18}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.75" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

function IconShield() {
  return (
    <SvgIcon>
      <path d="M12 3.5 19 6v5.2c0 4.4-2.9 7.8-7 9.3-4.1-1.5-7-4.9-7-9.3V6z" />
      <path d="m9.5 12 1.7 1.7 3.5-3.8" />
    </SvgIcon>
  );
}

function IconKnowledge() {
  return (
    <SvgIcon>
      <path d="M5 4.5h9a3 3 0 0 1 3 3V20H8a3 3 0 0 0-3 3z" />
      <path d="M5 4.5v18.5" />
      <path d="M8.5 9h5" />
      <path d="M8.5 13h5" />
    </SvgIcon>
  );
}

function IconGpa() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="7.5" />
      <path d="m9.5 12 1.6 1.6 3.7-3.9" />
    </SvgIcon>
  );
}
