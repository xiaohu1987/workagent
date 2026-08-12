import { Fragment, createElement, memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";
import "./timeline.css";
import type {
  AppConfig,
  AssistantDraftPhase,
  ApprovalRequest,
  ArtifactRecord,
  ContextCompactionRecord,
  ContextMeasurementRecord,
  GpaStage,
  GpaState,
  GitActionResult,
  GitFileChange,
  GitSnapshot,
  GptReasoningEffort,
  MessageAttachment,
  MultiAgentMode,
  MessageRecord,
  ModelProfile,
  QueuedMessageRecord,
  PendingResumeThread,
  PluginRecord,
  ProviderType,
  RuntimeEvent,
  RuntimeThreadSnapshotCursor,
  RuntimeThreadSnapshot,
  SkillMetadata,
  SkillUsageStats,
  ThreadRecord,
  ToolCallRecord,
  UserInputPrompt
} from "@shared-types";
import { DEFAULT_RESPONSE_TONE, GPT_REASONING_EFFORTS, createEmptyTokenUsage, isConfigurableGptReasoningModel, withGptReasoningCapabilities } from "@shared-types";
import { IMAGE_GENERATION_PROTOCOL_LABELS, imageGenerationProtocolForModel, providerSupportsMediaGeneration } from "../../../../packages/provider-adapters/src/models/media-protocol";
import {
  canDeleteThread,
  getComposerPrimaryActionState,
  getDeleteThreadBlockedMessage,
  invalidateThreadSnapshotForFullRefresh,
  isThreadExecutionInProgress,
  normalizeGpaStateForThread,
  shouldPreservePreparingRuntime,
  shouldShowTaskProcessing
} from "./core/thread-ui-state";
import { useMotionPresence } from "./core/motion-presence";
import {
  PROVIDER_TYPE_OPTIONS,
  buildConfigToSave,
  cloneConfig,
  getModelsForProvider,
  getProviderDisplayName,
  getReasoningModelsForProvider,
  hasStoredSecret,
  isReasoningModel,
  modelKey,
  normalizeDraftConfig,
  normalizeProviderProtocol,
  parseMcpEnvironment,
  resolveSelectionFromConfig,
  serializeMcpJsonConfig
} from "./lib/config-utils";
import {
  ActiveToolCall,
  AssistantDraft,
  ChatEventBlock,
  ChatEventType,
  ComposerAttachment,
  ComposerAttachmentInput,
  ComposerBinaryAttachment,
  ContextUsage,
  ConversationTurnItem,
  FileChangeSummaryItem,
  TimelineEntry,
  buildContextUsage,
  buildConversationTurnSections,
  buildPlanTimelineItems,
  buildTimelineEntries,
  collectFileChangesByTurn,
  composerAttachmentKey,
  createOptimisticThreadSnapshot,
  filterTranscriptMessages,
  formatComposerAttachments,
  getActivePlanTimelineItem,
  getActiveSubagents,
  getAssistantDraftDisplayContent,
  getDefaultCollapsedConversationTurnIds,
  getDisplayMessageContent,
  getFileWriteTarget,
  getGeneratedFileDescription,
  getGpaPlanMessageId,
  getMessageDisplayKind,
  getSubagentWaitLabel,
  getThreadDeleteFailureMessage,
  getToolActivityKind,
  getToolActivityPresentation,
  getToolActivityTarget,
  getToolProcessingLabel,
  isAssistantDraftPhase,
  isFileWriteTool,
  isInternalAgentProtocolMessage,
  isPersistentComposerContextKind,
  isSubagentWaitTool,
  mergeSnapshotRecords,
  parseMessageEventBlocks,
  reconcileAssistantDraftCompletion,
  reconcileAssistantDraftUpdate,
  reconcilePendingUserMessages,
  reconcilePendingUserMessagesDetailed,
  resolveLatestThreadRecord,
  replaceConversationMessagesFromEdit,
  selectActiveAssistantDraft,
  shouldKeepAssistantDraft,
  shouldShowRuntimeActivityPanel,
  type SkillNameMap
} from "./lib/conversation-utils";
import {
  ProjectFileEntry,
  buildFileSnapshotDiffPreview,
  getFileSnapshotDiffMarker
} from "./lib/project-files";
import {
  ComposerSelect,
  ComposerSelectOption
} from "./workspace/composer-select";
import {
  FilePreviewDialog,
  renderCodePreviewLine
} from "./workspace/file-preview";
import {
  GitChangesWorkspace
} from "./workspace/git-changes";
import {
  MEMORY_LIST_PAGE_SIZE,
  MemoryPagination,
  getMemoryLastPageIndex,
} from "./workspace/memory-pagination";
import {
  PanelResizeHandle,
  ResizePane,
  WorkspaceAccordionSection,
  WorkspaceEmptyState,
  WorkspaceSubtabStrip
} from "./workspace/panels";
import {
  ProjectFilesWorkspace
} from "./workspace/project-files";
import { ProjectCreateSheet } from "./workspace/project-create-sheet";
import { GpaPlanResumeSheet } from "./workspace/gpa-plan-resume-sheet";
import { ConfirmationSheet } from "./workspace/confirmation-sheet";
import {
  UsageStatisticsPanel
} from "./workspace/usage-stats";
import { TokenUsagePopover } from "./workspace/token-usage-popover";
import { ApiCardFavoritesPanel } from "./workspace/api-card-favorites";
import {
  filterApiCardFavorites,
  subscribeApiCardFavoriteNotices,
  useApiCardFavorites,
  type ApiCardFavorite
} from "./api-card-favorites";
import {
  findActiveNotification,
  isFinishedNotification,
  resolveRuntimeNotificationThreadId,
  sortNotificationItems,
  type NotificationCenterItem
} from "./core/notification-center";
import {
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconChart,
  IconCheck,
  IconChecklist,
  IconChevronDown,
  IconChevronLeft,
  IconClose,
  IconCode,
  IconCodexMark,
  IconComment,
  IconCompose,
  IconCopy,
  IconDownload,
  IconEraser,
  IconEye,
  IconFileChanges,
  IconFolder,
  IconGpa,
  IconGuide,
  IconHelpCircle,
  IconImage,
  IconKnowledge,
  IconNotificationStatus,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShield,
  IconSidebar,
  IconSkills,
  IconSpinner,
  IconSplitPanel,
  IconStop,
  IconTerminal,
  IconTrash,
  IconUndo,
  IconUpload,
  IconVideo,
  SvgIcon
} from "./icons";
import {
  CopyTextButton,
  MessageMediaLightbox,
  copyTextToClipboard,
  escapeHtml,
  getFileLeafName,
  hljs,
  renderMarkdownDocument,
  type MessageMediaPreview
} from "./markdown";
import {
  getChatBackgroundSurfaceStyleVars,
  CHAT_BACKGROUND_SURFACE_OPTIONS,
  type ChatBackgroundMode,
} from "./chat-background";
import { SettingsUsagePage } from "./settings/usage-page";
import { SettingsUpdatePage } from "./settings/update-page";
import { SettingsDialog } from "./settings/settings-dialog";
import { McpCreateSheet } from "./settings/mcp-create-sheet";
import { UserSkillGenerationDialog as UserSkillGenerationDialogView } from "./settings/user-skill-generation-dialog";
import { FetchedModelsDialog } from "./settings/fetched-models-dialog";
import { MultimodalPickerDialog } from "./settings/multimodal-picker-dialog";
import { AppearanceSettingsPage } from "./settings/pages/application/appearance-page";
import { MultimodalSettingsPage } from "./settings/pages/models/multimodal-page";
import { ProviderSettingsPage } from "./settings/pages/models/provider-page";
import { ApiFavoritesPage } from "./settings/pages/knowledge/api-favorites-page";
import { KnowledgePage } from "./settings/pages/knowledge/knowledge-page";
import { MemoryPage } from "./settings/pages/knowledge/memory-page";
import { ResponseTonePage } from "./settings/pages/general/response-tone-page";
import { RuntimeOverviewPage } from "./settings/pages/general/runtime-overview-page";
import { DatabasePage } from "./settings/pages/connections/database-page";
import { McpPage } from "./settings/pages/connections/mcp-page";
import { CapabilitiesPage } from "./settings/pages/capabilities/capabilities-page";
import { SkillsPage } from "./settings/pages/capabilities/skills-page";
import { PluginsPage } from "./settings/pages/capabilities/plugins-page";
import { UserSkillsPage } from "./settings/pages/capabilities/user-skills-page";
import { SkillLabPage } from "./settings/pages/capabilities/skill-lab-page";
import { TerminalPanel } from "./workspace/terminal-panel";
import { TerminalWorkspace, type TerminalWorkspaceTab } from "./workspace/terminal-workspace";
import { useTerminalSessions } from "./hooks/use-terminal-sessions";
import { useQuickNotes } from "./hooks/use-quick-notes";
import { useHistorySearch } from "./hooks/use-history-search";
import { useChatBackground } from "./hooks/use-chat-background";
import { useRealtimeEnhancement } from "./hooks/use-realtime-enhancement";
import { useAppUpdate } from "./hooks/use-app-update";
import { useFetchedProviderModels } from "./hooks/use-fetched-provider-models";
import { useMultimodalSettings } from "./hooks/use-multimodal-settings";
import { useProviderModelTesting } from "./hooks/use-provider-model-testing";
import { useProviderDraftEditor } from "./hooks/use-provider-draft-editor";
import { useKnowledgeImport } from "./hooks/use-knowledge-import";
import { useDatabaseConnections } from "./hooks/use-database-connections";
import { useMcpServerActions } from "./hooks/use-mcp-server-actions";
import { useMcpDraftEditor } from "./hooks/use-mcp-draft-editor";
import { useRuntimeLogMaintenance } from "./hooks/use-runtime-log-maintenance";
import { useUsageAnalytics } from "./hooks/use-usage-analytics";
import { useKnowledgeBases } from "./hooks/use-knowledge-bases";
import { useUserSkillGeneration } from "./hooks/use-user-skill-generation";
import { useSelfImprovementMemories } from "./hooks/use-self-improvement-memories";
import { useErrorSolutions } from "./hooks/use-error-solutions";
import { useSettingsDialogState } from "./hooks/use-settings-dialog-state";
import { useSkillLab } from "./hooks/use-skill-lab";
import { useNotificationUiState } from "./hooks/use-notification-ui-state";
import { useThreadNotifications } from "./hooks/use-thread-notifications";
import { useAppNotice } from "./hooks/use-app-notice";
import { useProjectFilePreview } from "./hooks/use-project-file-preview";
import { useStableEvent } from "./hooks/use-stable-event";
import { DATABASE_PERMISSION_OPTIONS, getSkillSortLabel, RESPONSE_TONE_OPTIONS, SKILL_SORT_OPTIONS } from "./settings/settings-options";
import { reregisterBrowserWebviews } from "./workspace/browser-workspace";
import { RightWorkspacePanel, type RightWorkspaceTab } from "./workspace/right-workspace";
import { NotificationCenter } from "./workspace/notification-center";
import { HelpSheet } from "./workspace/help-sheet";
import { QuickNotesSheet } from "./workspace/quick-notes-sheet";
import { HistorySearchDialog } from "./history/history-search-dialog";
import { HistorySidebar } from "./history/history-sidebar";
import { ChatWelcome } from "./chat/chat-welcome";
import { CHAT_WELCOME_CARDS, PROJECT_WELCOME_CARDS } from "./chat/welcome-cards";
import { ComposerAttachments } from "./composer/composer-attachments";
import { ComposerAddMenu } from "./composer/composer-add-menu";
import { AppBackgroundLayer } from "./workspace/app-background-layer";
import { RealtimeBackgroundLayer } from "./workspace/realtime-background-layer";
import { RealtimeCharacterLayer } from "./workspace/realtime-character-layer";
import { WorkspaceControls } from "./workspace/workspace-controls";
import { ComposerModelPicker, ContextUsageControl, FloatingSideMenu, ReasoningEffortPicker, type ComposerModelGroup } from "./composer/model-controls";
import { ComposerSubmissionStatus, GpaConfirmationCard, GpaPlanResumeRetryConfirmationCard, PendingResumeCard, PlanItem, QueuedMessageList, RuntimeActivityOutputRow, RuntimeActivityPanel } from "./cards/runtime-cards";
import { PlanTimeline, getRuntimeActivityStartedAt } from "./composer/plan-timeline";
import { buildConversationTurnItems, ConversationTurnRail } from "./timeline/conversation-rail";
import { TimelineEntries } from "./timeline/timeline-entries";
import { ApprovalCard, AssistantDraftMessage, getConciseToolActivityLabel, getMessageAttachments, reuseEquivalentRecordArray, ToolActivityGroup, ToolActivityIcon, UserInputPromptCard, type UserMessageActions } from "./timeline/transcript";
export { extractMessageMediaReferences } from "./timeline/transcript";
import {
  HISTORY_COLLAPSED_GROUPS_STORAGE_KEY,
  normalizeHistoryGroupKey,
  readStoredStringSet,
  writeStoredStringSet
} from "./history/history-utils";
import {
  isGeneratedUserSkill,
  type AppNotice,
  type AppNoticeTone,
  type ComposerSubmission,
  type GpaPlanResumeDialogState,
  type GpaPlanResumePreview,
  type GpaPlanResumeRetryPrompt,
  type ManagedRemoval,
  type McpRuntimeServer,
  type RuntimeActivity,
  type RuntimeActivityEntry,
  type RuntimeProgress,
  type SettingsTab,
} from "./core/app-types";

const MAX_RUNTIME_ACTIVITY_ENTRIES = 120;

function trimRuntimeActivityEntries(entries: RuntimeActivityEntry[]): RuntimeActivityEntry[] {
  if (entries.length <= MAX_RUNTIME_ACTIVITY_ENTRIES) return entries;
  const recentEntries = entries.slice(-MAX_RUNTIME_ACTIVITY_ENTRIES);
  const retainedIds = new Set(recentEntries.map((entry) => entry.id));
  for (const entry of entries) {
    if (entry.kind === "tool" && (entry.toolCall.status === "pending" || entry.toolCall.status === "running")) {
      retainedIds.add(entry.id);
    }
  }
  return entries.filter((entry) => retainedIds.has(entry.id));
}
import {
  formatKnowledgeBytes,
  formatKnowledgeScope,
  formatKnowledgeStatus,
  formatLatency,
  formatNotificationElapsed,
  formatRelativeTime,
  formatTokensPerSecond,
  getErrorSolutionRecallStatus,
  getNotificationStatusLabel,
  gpaModeLabel
} from "./core/app-formatters";
import {
  formatFileChangeAction,
  formatStorageBytes,
  formatUpdateDownloadSize,
  formatUpdatePhase,
  getFileChangeActionClass,
  getFileParentPath,
  getGpaTaskProgress,
  getSidebarUpdateReminder,
  getWorkspaceLabel,
  knowledgeSourceKey,
  readFileAsDataUrl
} from "./core/app-helpers";

export { isGeneratedUserSkill } from "./core/app-types";
export { getSidebarUpdateReminder } from "./core/app-helpers";

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

type TerminalSessionState = {
  output: string;
  cwd: string;
  shell: string;
};

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_RIGHT_WORKSPACE_WIDTH = 300;
const MAX_RIGHT_WORKSPACE_WIDTH = 720;
const MIN_CHAT_WIDTH = 380;
const ASSISTANT_FINAL_MESSAGE_FADE_DURATION_MS = 240;
const THREAD_SNAPSHOT_CACHE_LIMIT = 8;

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
  const threadsRef = useRef<ThreadRecord[]>([]);
  const threadStatusRef = useRef<Map<string, ThreadRecord["status"]>>(new Map());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isRightWorkspaceOpen, setIsRightWorkspaceOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    getStoredPanelWidth("codexh.sidebar-width", 288, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  );
  const [rightWorkspaceWidth, setRightWorkspaceWidth] = useState(() =>
    getStoredPanelWidth("codexh.right-workspace-width", 410, MIN_RIGHT_WORKSPACE_WIDTH, MAX_RIGHT_WORKSPACE_WIDTH)
  );
  const [resizingPane, setResizingPane] = useState<ResizePane | null>(null);
  const [rightWorkspaceTab, setRightWorkspaceTab] = useState<RightWorkspaceTab>("files");
  const [rightWorkspaceExpandedTab, setRightWorkspaceExpandedTab] = useState<RightWorkspaceTab | null>("files");
  const {
    tabs: currentTerminalTabs,
    activeSessionId: activeTerminalSessionId,
    activeSession: activeTerminalSession,
    input: activeTerminalInput,
    ensureTab: ensureTerminalTab,
    setInput: setActiveTerminalInput,
    selectTab: selectTerminalTab,
    addTab: addTerminalTab,
    closeTab: closeTerminalTab,
    queueOutput: queueTerminalOutput,
    updateSession: updateTerminalSessionState,
    clearThread: clearTerminalThread
  } = useTerminalSessions(selectedThreadId);
  const assistantDraftFramesRef = useRef<
    Record<string, { draft: AssistantDraft; frame: number }>
  >({});
  const [projectFiles, setProjectFiles] = useState<ProjectFileEntry[]>([]);
  const [gitSnapshot, setGitSnapshot] = useState<GitSnapshot | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitActionBusy, setGitActionBusy] = useState(false);
  const [gitActionMessage, setGitActionMessage] = useState<string | null>(null);
  const [gitRefreshRevision, setGitRefreshRevision] = useState(0);
  const {
    selectedProjectFileByThread,
    filePreviewPath,
    setFilePreviewPath,
    projectFilePreviewsByThread,
    selectProjectFile,
    openProjectPreview,
    closeProjectPreview,
    saveProjectPreview,
    reconcileSelectedFile,
    clearSelectedFile
  } = useProjectFilePreview({ selectedThreadId, onSaved: () => setGitRefreshRevision((current) => current + 1) });
  const [isProjectFilesLoading, setIsProjectFilesLoading] = useState(false);
  const selectedThreadIdRef = useRef<string | null>(null);
  const pendingUserMessagesRef = useRef<Record<string, MessageRecord[]>>({});
  // Bridges the gap between submitting a turn and receiving its runtime status.
  const pendingRuntimeStartsRef = useRef<Set<string>>(new Set());
  const interruptingThreadIdsRef = useRef<Set<string>>(new Set());
  const pendingOneShotSkillRemovalsRef = useRef<Record<string, string[]>>({});
  const snapshotRequestIdsRef = useRef<Record<string, number>>({});
  const latestRuntimeThreadsRef = useRef<Record<string, ThreadRecord>>({});
  const persistedRuntimeMessagesRef = useRef<Record<string, Map<string, MessageRecord>>>({});
  const snapshotRefreshInFlightRef = useRef<Record<string, Promise<void>>>({});
  const snapshotRefreshPendingRef = useRef<Record<string, boolean>>({});
  /** After Stop, ignore late runtime events that would revive the "执行中" UI. */
  const suppressRuntimeProgressRef = useRef<Record<string, boolean>>({});
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeThreadSnapshot | null>(null);
  const [isThreadSwitching, setIsThreadSwitching] = useState(false);
  const snapshotThreadIdRef = useRef<string | null>(null);
  const snapshotCursorByThreadRef = useRef<Record<string, RuntimeThreadSnapshotCursor>>({});
  const snapshotCacheByThreadRef = useRef<Map<string, RuntimeThreadSnapshot>>(new Map());
  const threadTokenUsageRefreshTimerRef = useRef<number | null>(null);
  const pluginToggleQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pluginEnabledStateRef = useRef<Map<string, boolean>>(new Map());
  const [browserTabsByThread, setBrowserTabsByThread] = useState<Record<string, RuntimeThreadSnapshot["browserTabs"]>>({});
  const [assistantDrafts, setAssistantDrafts] = useState<Record<string, AssistantDraft>>({});
  const [finalizingAssistantMessageIds, setFinalizingAssistantMessageIds] = useState<Set<string>>(() => new Set());
  const finalMessageFadeTimersRef = useRef<Record<string, number>>({});
  const [activeToolCall, setActiveToolCall] = useState<ActiveToolCall | null>(null);
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress | null>(null);
  const [composerSubmission, setComposerSubmission] = useState<ComposerSubmission | null>(null);
  const [runtimeActivities, setRuntimeActivities] = useState<Record<string, RuntimeActivity>>({});
  const [completedTurnTimers, setCompletedTurnTimers] = useState<Record<string, { startedAt: string; completedAt: string }>>({});
  const [input, setInput] = useState("");
  const apiCardFavorites = useApiCardFavorites();
  // + 菜单"接口卡片"子菜单搜索
  const [apiCardMenuQuery, setApiCardMenuQuery] = useState("");
  const apiCardMenuMatches = useMemo(
    () => filterApiCardFavorites(apiCardFavorites, apiCardMenuQuery).slice(0, 20),
    [apiCardFavorites, apiCardMenuQuery]
  );
  // 收藏/取消收藏时弹出全局提醒
  const { notice, isNoticeHovered, setIsNoticeHovered, exitingNoticeId, showNotice, dismissNotice } = useAppNotice();
  useEffect(() => {
    return subscribeApiCardFavoriteNotices((notice) => {
      if (notice.action === "added") {
        showNotice("已收藏接口卡片", { tone: "success", message: `「${notice.name}」已加入收藏,在输入框输入 / 可快速唤出。` });
      } else {
        showNotice("已取消收藏", { tone: "success", message: `「${notice.name}」已从收藏中移除。` });
      }
    });
  }, []);
  const quickNotesState = useQuickNotes(showNotice);
  const {
    isOpen: isQuickNotesOpen,
    setIsOpen: setIsQuickNotesOpen,
    notes: quickNotes,
    selectedId: selectedQuickNoteId,
    title: quickNoteTitle,
    content: quickNoteContent,
    saving: quickNoteSaving,
    status: quickNoteStatus,
    renamingId: renamingQuickNoteId,
    setRenamingId: setRenamingQuickNoteId,
    renameDraft: quickNoteRenameDraft,
    setRenameDraft: setQuickNoteRenameDraft,
    listMenu: quickNoteListMenu,
    setListMenu: setQuickNoteListMenu,
    deleteConfirm: quickNoteDeleteConfirm,
    setDeleteConfirm: setQuickNoteDeleteConfirm,
    open: openQuickNotes,
    select: selectQuickNote,
    create: createQuickNote,
    changeContent: changeQuickNoteContent,
    save: saveQuickNote,
    rename: renameQuickNote,
    remove: deleteQuickNote
  } = quickNotesState;
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const historySearch = useHistorySearch(showNotice);
  const {
    isOpen: isHistorySearchOpen,
    setIsOpen: setIsHistorySearchOpen,
    query: historySearchQuery,
    setQuery: setHistorySearchQuery,
    results: historySearchResults,
    loading: isHistorySearchLoading,
    open: openHistorySearch
  } = historySearch;
  const [collapsedHistoryGroups, setCollapsedHistoryGroups] = useState<Set<string>>(() =>
    readStoredStringSet(HISTORY_COLLAPSED_GROUPS_STORAGE_KEY)
  );
  const [expandedHistoryThreadGroups, setExpandedHistoryThreadGroups] = useState<Set<string>>(() => new Set());
  const [renamingHistoryThread, setRenamingHistoryThread] = useState<{ id: string; title: string } | null>(null);
  const skipHistoryRenameCommitRef = useRef(false);
  const [editingUserMessage, setEditingUserMessage] = useState<{ id: string; content: string } | null>(null);
  const [collapsedConversationTurns, setCollapsedConversationTurns] = useState<Record<string, Set<string>>>({});
  const initializedConversationTurnsByThreadRef = useRef<Record<string, Set<string>>>({});
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [removingComposerAttachmentId, setRemovingComposerAttachmentId] = useState<string | null>(null);
  const [isContextReportOpen, setIsContextReportOpen] = useState(false);
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [skillUsageStats, setSkillUsageStats] = useState<SkillUsageStats[]>([]);
  const [skillsSearchQuery, setSkillsSearchQuery] = useState("");
  const [skillsSortMode, setSkillsSortMode] = useState<"name" | "calls" | "success">("name");
  const [skillsSortOpen, setSkillsSortOpen] = useState(false);
  const skillsSortMenuRef = useRef<HTMLDivElement | null>(null);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [managedRemoval, setManagedRemoval] = useState<ManagedRemoval | null>(null);
  const [removingManagedItem, setRemovingManagedItem] = useState(false);
  const [gpaState, setGpaState] = useState<GpaState>({
    ...normalizeGpaStateForThread("chat", null)
  });
  const [gpaComposerSelected, setGpaComposerSelected] = useState(false);
  const [composerMediaIntent, setComposerMediaIntent] = useState<"image" | "video" | null>(null);
  const [multiAgentMode, setMultiAgentMode] = useState<MultiAgentMode>("proactive");
  const [gpaMenuOpen, setGpaMenuOpen] = useState(false);
  const [composerAddMenuView, setComposerAddMenuView] = useState<"root" | "skills" | "mcp" | "database" | "apiCards">("root");
  const [skillsMenuQuery, setSkillsMenuQuery] = useState("");
  const [composerAddSubmenuAnchor, setComposerAddSubmenuAnchor] = useState<HTMLElement | null>(null);
  const [gpaMenuPos, setGpaMenuPos] = useState<{ left: number; top: number } | null>(null);
  const gpaAnchorRef = useRef<HTMLDivElement | null>(null);
  const composerAddMenuCloseTimerRef = useRef<number | null>(null);
  const [gpaRevisionOpen, setGpaRevisionOpen] = useState(false);
  const [gpaRevisionDraft, setGpaRevisionDraft] = useState("");
  const [gpaRevisionSubmitting, setGpaRevisionSubmitting] = useState(false);
  const [gpaConfirmationSubmitting, setGpaConfirmationSubmitting] = useState(false);
  const [gpaPlanResumeDialog, setGpaPlanResumeDialog] = useState<GpaPlanResumeDialogState | null>(null);
  const [gpaPlanResumeBusy, setGpaPlanResumeBusy] = useState(false);
  const [gpaPlanResumeRetryPrompt, setGpaPlanResumeRetryPrompt] = useState<GpaPlanResumeRetryPrompt | null>(null);
  const gpaSameSessionAutoResumeRef = useRef<Set<string>>(new Set());
  const gpaPlanResumeDismissedRef = useRef<Set<string>>(new Set());
  const gpaPlanResumeAttemptRef = useRef<Map<string, GpaPlanResumePreview>>(new Map());
  const gpaPlanResumeRetryRequiredRef = useRef<Set<string>>(new Set());
  const gpaRevisionRef = useRef<HTMLTextAreaElement | null>(null);
  const gpaConfirmationPendingStageRef = useRef<Exclude<GpaStage, "off" | "act"> | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<AppConfig | null>(null);
  const providerDraftEditor = useProviderDraftEditor({ configDraft, setConfigDraft, showNotice });
  const {
    settingsProviderId,
    setSettingsProviderId,
    providerSecretDrafts,
    setProviderSecretDrafts,
    newModelId,
    setNewModelId,
    newModelDisplayName,
    setNewModelDisplayName,
    settingsProvider,
    settingsProviderModels,
    reset: resetProviderDraft,
    updateProviderDraft,
    addCustomProvider,
    removeProvider,
    addModelToProvider,
    updateModelDraft,
    removeModel
  } = providerDraftEditor;
  const databaseConnections = useDatabaseConnections({
    config,
    setConfig,
    configDraft,
    setConfigDraft,
    providerSecretDrafts,
    saveConfigDraft,
    showNotice
  });
  const {
    passwordDrafts: databasePasswordDrafts,
    setPasswordDrafts: setDatabasePasswordDrafts,
    savedCredentialIds: savedDatabaseCredentialIds,
    setSavedCredentialIds: setSavedDatabaseCredentialIds,
    editingId: editingDatabaseConnectionId,
    setEditingId: setEditingDatabaseConnectionId,
    testingId: testingDatabaseConnectionId,
    savingCredentialId: savingDatabaseCredentialId,
    changingEnabledId: changingDatabaseEnabledId,
    catalogs: databaseCatalogs,
    updateDraft: updateDatabaseDraft,
    setEnabled: setDatabaseConnectionEnabled,
    add: addDatabaseConnection,
    remove: removeDatabaseConnection,
    test: testDatabaseConnection,
    save: saveDatabaseConnection
  } = databaseConnections;
  const mcpDraftEditor = useMcpDraftEditor({ configDraft, setConfigDraft, showNotice });
  const {
    editingServerId: editingMcpServerId,
    setEditingServerId: setEditingMcpServerId,
    isCreateOpen: isMcpCreateOpen,
    createMode: mcpCreateMode,
    setCreateMode: setMcpCreateMode,
    createDraft: mcpCreateDraft,
    setCreateDraft: setMcpCreateDraft,
    createError: mcpCreateError,
    setCreateError: setMcpCreateError,
    jsonDraft: mcpJsonDraft,
    setJsonDraft: setMcpJsonDraft,
    jsonError: mcpJsonError,
    setJsonError: setMcpJsonError,
    updateServerDraft: updateMcpServerDraft,
    addServer: addMcpServer,
    closeCreateSheet: closeMcpCreateSheet,
    confirmCreate: confirmMcpCreate,
    removeServer: removeMcpServer
  } = mcpDraftEditor;
  const runtimeLogMaintenance = useRuntimeLogMaintenance(formatStorageBytes, showNotice);
  const {
    stats: runtimeLogStats,
    isLoading: isRuntimeLogStatsLoading,
    isClearConfirmOpen: isClearLogsConfirmOpen,
    setIsClearConfirmOpen: setIsClearLogsConfirmOpen,
    isClearing: isClearingLogs,
    refresh: refreshRuntimeLogStats,
    confirmClear: confirmClearRuntimeLogs
  } = runtimeLogMaintenance;
  const usageAnalytics = useUsageAnalytics(showNotice);
  const {
    rangeDays: usageStatisticsRangeDays,
    setRangeDays: setUsageStatisticsRangeDays,
    granularity: usageStatisticsGranularity,
    setGranularity: setUsageStatisticsGranularity,
    summary: usageStatistics,
    isLoading: isUsageStatisticsLoading,
    refresh: refreshUsageStatistics
  } = usageAnalytics;
  const knowledgeBaseState = useKnowledgeBases(selectedThreadId, refreshSnapshot, showNotice);
  const {
    bases: knowledgeBases,
    documents: knowledgeDocuments,
    busyId: knowledgeBusyId,
    refreshBases: refreshKnowledgeBases,
    toggleDocuments: toggleKnowledgeDocuments,
    refreshBase: refreshKnowledgeBase,
    deleteBase: deleteKnowledgeBase
  } = knowledgeBaseState;
  const userSkillGeneration = useUserSkillGeneration(refreshUserSkills, refreshSkills, showNotice);
  const {
    dialog: userSkillGenerationDialog,
    setDialog: setUserSkillGenerationDialog,
    isGenerating: isGeneratingUserSkill,
    open: openUserSkillGenerationDialog,
    generate: generateUserSkill
  } = userSkillGeneration;
  const selfImprovementMemoryState = useSelfImprovementMemories(showNotice);
  const {
    memories: selfImprovementMemories,
    isRefreshing: isRefreshingSelfImprovementMemories,
    page: selfImprovementMemoryPage,
    setPage: setSelfImprovementMemoryPage,
    isClearConfirmOpen: isClearSelfImprovementConfirmOpen,
    setIsClearConfirmOpen: setIsClearSelfImprovementConfirmOpen,
    isClearing: isClearingSelfImprovement,
    refresh: refreshSelfImprovementMemories,
    refreshNow: refreshSelfImprovementNow,
    remove: deleteSelfImprovementMemory,
    confirmClear: confirmClearSelfImprovementMemories
  } = selfImprovementMemoryState;
  const errorSolutionState = useErrorSolutions(config, showNotice);
  const {
    solutions: errorSolutions,
    page: errorSolutionPage,
    setPage: setErrorSolutionPage,
    busyId: errorSolutionBusyId,
    modelFilter: errorSolutionModelFilter,
    setModelFilter: setErrorSolutionModelFilter,
    isClearConfirmOpen: isClearErrorSolutionsConfirmOpen,
    setIsClearConfirmOpen: setIsClearErrorSolutionsConfirmOpen,
    isClearing: isClearingErrorSolutions,
    expandedIds: expandedErrorSolutionIds,
    refresh: refreshErrorSolutions,
    remove: deleteErrorSolution,
    confirmClear: confirmClearErrorSolutions,
    toggle: toggleErrorSolutionExpanded
  } = errorSolutionState;
  const {
    testResults: mcpTestResults,
    testingServerId: testingMcpServerId,
    authBusyId: mcpAuthBusyId,
    testServer: testMcpServer,
    login: loginMcpServer,
    logout: logoutMcpServer,
    refreshToolDirectory: refreshMcpToolDirectory
  } = useMcpServerActions(refreshMcpServers, showNotice);
  const chatBackground = useChatBackground({ appShellRef, showNotice });
  const {
    images: chatBackgroundImages,
    activeImageIndex: activeChatBackgroundIndex,
    setActiveImageIndex: setActiveChatBackgroundIndex,
    settings: chatBackgroundSettings,
    inputRef: chatBackgroundInputRef,
    imageUrl: chatBackgroundUrl,
    isDragging: isChatBackgroundDragging,
    importFiles: importChatBackgroundFiles,
    moveImage: moveChatBackgroundImage,
    removeImage: removeChatBackgroundImage,
    updateSettings: updateChatBackgroundSettings,
    updateSurface: updateChatBackgroundSurface,
    beginDrag: beginChatBackgroundDrag,
    moveDrag: moveChatBackground,
    endDrag: endChatBackgroundDrag,
    resetSurfaces: resetChatBackgroundSurfaces,
    clear: clearChatBackground
  } = chatBackground;
  const realtimeEnhancement = useRealtimeEnhancement({
    threadId: selectedThreadId,
    defaultEnabled: true,
    onInterrupt: () => interruptActiveThread()
  });
  const backgroundMode: ChatBackgroundMode = realtimeEnhancement.enabled
    ? "dynamic"
    : chatBackgroundUrl && chatBackgroundSettings.enabled
      ? "image"
      : "none";

  function setBackgroundMode(mode: ChatBackgroundMode) {
    if (mode === "dynamic") {
      updateChatBackgroundSettings({ enabled: false });
      realtimeEnhancement.setEnabled(true);
      return;
    }

    realtimeEnhancement.setEnabled(false);
    updateChatBackgroundSettings({
      enabled: mode === "image" && Boolean(chatBackgroundUrl)
    });
  }
  const appUpdate = useAppUpdate(showNotice);
  const {
    state: updateState,
    confirmDialog: updateConfirmDialog,
    setConfirmDialog: setUpdateConfirmDialog,
    check: checkForUpdates,
    download: downloadAvailableUpdate,
    install: installDownloadedUpdate,
    confirm: confirmUpdateDialog
  } = appUpdate;
  const [pendingResumeThreads, setPendingResumeThreads] = useState<PendingResumeThread[]>([]);
  const [mcpRuntimeServers, setMcpRuntimeServers] = useState<McpRuntimeServer[]>([]);
  const [composerProviderId, setComposerProviderId] = useState("");
  const [composerModelId, setComposerModelId] = useState("");
  const [isUpdatingReasoningEffort, setIsUpdatingReasoningEffort] = useState(false);
  const [userSkills, setUserSkills] = useState<SkillMetadata[]>([]);
  const {
    isSettingsOpen,
    setIsSettingsOpen,
    settingsTab,
    setSettingsTab,
    capabilityTab,
    setCapabilityTab
  } = useSettingsDialogState();
  const [settingsContentReady, setSettingsContentReady] = useState(false);
  const [isProjectCreateOpen, setIsProjectCreateOpen] = useState(false);
  const [projectPathDraft, setProjectPathDraft] = useState("");
  const [isPickingProjectFolder, setIsPickingProjectFolder] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [resolvingPromptId, setResolvingPromptId] = useState<string | null>(null);
  const skillLabModelOptions = (config?.models ?? [])
    .filter((model) => model.role === "reasoning" && model.supportsToolCalling && model.agentCapability !== "unsupported")
    .map((model) => {
      const provider = config?.providers.find((entry) => entry.id === model.providerId);
      return provider ? {
        value: modelKey(provider.id, model.id),
        label: `${getProviderDisplayName(provider)} / ${model.displayName?.trim() || model.id}`
      } : null;
    })
    .filter((option): option is ComposerSelectOption => option !== null);
  const {
    skillLabMode,
    setSkillLabMode,
    skillLabTargetSkillId,
    setSkillLabTargetSkillId,
    skillLabModelSelection,
    setSkillLabModelSelection,
    skillLabLastRunMode,
    skillLabPrompt,
    setSkillLabPrompt,
    skillLabName,
    setSkillLabName,
    skillLabIterations,
    setSkillLabIterations,
    skillLabTotalIterations,
    skillLabProgress,
    skillLabStatus,
    skillLabError,
    skillLabResult,
    skillLabApproval,
    skillLabClarification,
    setSkillLabClarification,
    skillLabActivityLog,
    skillLabElapsedSeconds,
    isSkillLabBusy,
    startSkillLab,
    cancelSkillLab,
    resolveSkillLabApproval,
    submitSkillLabClarification
  } = useSkillLab({
    userSkills,
    modelOptions: skillLabModelOptions,
    refreshSkills,
    refreshUserSkills,
    onEvent: (event) => updateSkillLabNotification(event),
    onStartNotification: (jobId, title, totalIterations) => startSkillLabNotification(jobId, title, totalIterations)
  });
  const {
    notificationCenterState,
    notificationCenterStateRef,
    isNotificationCenterOpen,
    setIsNotificationCenterOpen,
    isTokenUsagePanelOpen,
    setIsTokenUsagePanelOpen,
    threadTokenUsage,
    setThreadTokenUsage,
    highlightedNotificationTarget,
    setHighlightedNotificationTarget,
    notificationNow,
    setNotificationNow,
    notificationCenterRef,
    notificationButtonRef,
    tokenUsagePanelRef,
    tokenUsageButtonRef,
    dispatchNotificationCenter
  } = useNotificationUiState();
  const {
    updateThreadNotification,
    setThreadNotificationAttention,
    resumeThreadNotification,
    applyThreadStatusNotification,
    syncThreadNotifications: syncThreadNotificationsFromThreads,
    updateSkillLabNotification,
    startSkillLabNotification
  } = useThreadNotifications({
    threadsRef,
    threadStatusRef,
    notificationStateRef: notificationCenterStateRef,
    dispatch: dispatchNotificationCenter
  });
  const [isTranscriptAtLatest, setIsTranscriptAtLatest] = useState(true);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [historyThreadDeleteConfirmation, setHistoryThreadDeleteConfirmation] = useState<ThreadRecord | null>(null);
  const [deletingQueuedMessageId, setDeletingQueuedMessageId] = useState<string | null>(null);
  const [isClearChatConfirmOpen, setIsClearChatConfirmOpen] = useState(false);
  const [isClearingChat, setIsClearingChat] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatTranscriptRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollRef = useRef<HTMLPreElement | null>(null);
  const selfImprovementMemoryListRef = useRef<HTMLDivElement | null>(null);
  const errorSolutionListRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(false);
  const pendingLatestScrollThreadIdRef = useRef<string | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollReleaseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => () => {
    for (const pending of Object.values(assistantDraftFramesRef.current)) {
      window.cancelAnimationFrame(pending.frame);
    }
    assistantDraftFramesRef.current = {};
    for (const timer of Object.values(finalMessageFadeTimersRef.current)) {
      window.clearTimeout(timer);
    }
    finalMessageFadeTimersRef.current = {};
    if (threadTokenUsageRefreshTimerRef.current !== null) {
      window.clearTimeout(threadTokenUsageRefreshTimerRef.current);
      threadTokenUsageRefreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    threadsRef.current = threads;
    for (const thread of threads) {
      if (!threadStatusRef.current.has(thread.id)) threadStatusRef.current.set(thread.id, thread.status);
    }
  }, [threads]);

  useEffect(() => window.codexh.onOpenNotificationCenter((target) => {
    syncThreadNotificationsFromThreads(threadsRef.current);
    dispatchNotificationCenter({ type: "mark-all-read" });
    setHighlightedNotificationTarget(`${target.source}:${target.targetId}`);
    setIsNotificationCenterOpen(true);
  }), []);

  useEffect(() => {
    if (!isNotificationCenterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (notificationCenterRef.current?.contains(target) || notificationButtonRef.current?.contains(target)) return;
      setIsNotificationCenterOpen(false);
      setHighlightedNotificationTarget(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsNotificationCenterOpen(false);
      setHighlightedNotificationTarget(null);
      notificationButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isNotificationCenterOpen]);

  useEffect(() => {
    if (!isTokenUsagePanelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (tokenUsagePanelRef.current?.contains(target) || tokenUsageButtonRef.current?.contains(target)) return;
      setIsTokenUsagePanelOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsTokenUsagePanelOpen(false);
      tokenUsageButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isTokenUsagePanelOpen]);

  useEffect(() => {
    if (!isNotificationCenterOpen || !notificationCenterState.items.some((item) => item.status === "running" || item.status === "attention")) {
      return;
    }
    setNotificationNow(Date.now());
    const timer = window.setInterval(() => setNotificationNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isNotificationCenterOpen, notificationCenterState.items]);

  useEffect(() => {
    if (!selectedThreadId) {
      setThreadTokenUsage({ turn: createEmptyTokenUsage(), thread: createEmptyTokenUsage(), turnRunId: null });
      return;
    }
    let cancelled = false;
    void window.codexh.getThreadTokenUsage(selectedThreadId).then((usage) => {
      if (!cancelled) setThreadTokenUsage(usage);
    }).catch(() => {
      if (!cancelled) {
        setThreadTokenUsage({ turn: createEmptyTokenUsage(), thread: createEmptyTokenUsage(), turnRunId: null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId]);

  useEffect(() => {
    let cancelled = false;
    void window.codexh.listPendingResume().then((pending) => {
      if (!cancelled) setPendingResumeThreads(pending);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Do not carry a collapsed/hidden state into a new app session.
    setIsSidebarCollapsed(false);
    setIsTerminalOpen(false);
    setIsRightWorkspaceOpen(false);
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
    void window.codexh.setLiveEditPreviewActiveThread(selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    if (!config?.desktop.llmLogViewer) return;
    void window.codexh.setConversationLogWindowThread(selectedThreadId);
  }, [config?.desktop.llmLogViewer, selectedThreadId]);

  useEffect(() => {
    window.localStorage.setItem("codexh.sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem("codexh.right-workspace-width", String(rightWorkspaceWidth));
  }, [rightWorkspaceWidth]);

  useEffect(() => {
    writeStoredStringSet(HISTORY_COLLAPSED_GROUPS_STORAGE_KEY, collapsedHistoryGroups);
  }, [collapsedHistoryGroups]);

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
    const previousThreadId = selectedThreadIdRef.current;
    if (previousThreadId !== nextThreadId) {
      // A slow response for the previous transcript must never win after the
      // sidebar selection has moved. The next thread reloads from a full
      // snapshot so a stale incremental cursor cannot hide its history.
      if (previousThreadId) invalidateSnapshotRequest(previousThreadId);
      if (nextThreadId) delete snapshotCursorByThreadRef.current[nextThreadId];
    }
    const select = () => {
      selectedThreadIdRef.current = nextThreadId;
      setSelectedThreadId(nextThreadId);
      setFilePreviewPath(null);
    };
    if (selectedThreadIdRef.current === nextThreadId) {
      select();
      return;
    }
    select();
  }

  function cacheThreadSnapshot(nextSnapshot: RuntimeThreadSnapshot) {
    const cache = snapshotCacheByThreadRef.current;
    cache.delete(nextSnapshot.thread.id);
    cache.set(nextSnapshot.thread.id, nextSnapshot);
    while (cache.size > THREAD_SNAPSHOT_CACHE_LIMIT) {
      const oldestThreadId = cache.keys().next().value;
      if (!oldestThreadId) break;
      cache.delete(oldestThreadId);
      delete snapshotCursorByThreadRef.current[oldestThreadId];
    }
  }

  function invalidateSnapshotRequest(threadId: string) {
    snapshotRequestIdsRef.current[threadId] = (snapshotRequestIdsRef.current[threadId] ?? 0) + 1;
  }

  function reconcileSnapshotWithRuntimeEvents(
    nextSnapshot: RuntimeThreadSnapshot,
    consumedOptimisticIds?: ReadonlySet<string>
  ): RuntimeThreadSnapshot {
    const threadId = nextSnapshot.thread.id;
    const runtimeThread = latestRuntimeThreadsRef.current[threadId];
    const thread = runtimeThread
      ? resolveLatestThreadRecord(nextSnapshot.thread, runtimeThread)
      : nextSnapshot.thread;
    const snapshotMessages = consumedOptimisticIds?.size
      ? nextSnapshot.messages.filter((message) => !consumedOptimisticIds.has(message.id))
      : nextSnapshot.messages;
    const runtimeMessages = Array.from(persistedRuntimeMessagesRef.current[threadId]?.values() ?? []);
    const messages = runtimeMessages.length > 0
      ? mergeSnapshotRecords(snapshotMessages, runtimeMessages, (message) => message.createdAt)
      : snapshotMessages;
    const messageCount = Math.max(nextSnapshot.messageCount, messages.length);
    if (thread === nextSnapshot.thread && messages === nextSnapshot.messages && messageCount === nextSnapshot.messageCount) {
      return nextSnapshot;
    }
    return { ...nextSnapshot, thread, messages, messageCount };
  }

  function reconcileCachedAndSelectedSnapshot(threadId: string, consumedOptimisticIds?: ReadonlySet<string>) {
    const cached = snapshotCacheByThreadRef.current.get(threadId);
    if (cached) {
      cacheThreadSnapshot(reconcileSnapshotWithRuntimeEvents(cached, consumedOptimisticIds));
    }
    setSnapshot((current) => {
      if (!current || current.thread.id !== threadId) return current;
      return reconcileSnapshotWithRuntimeEvents(current, consumedOptimisticIds);
    });
  }

  function restoreCachedThreadSnapshot(threadId: string): boolean {
    const cached = snapshotCacheByThreadRef.current.get(threadId);
    if (!cached) return false;
    cacheThreadSnapshot(cached);
    snapshotThreadIdRef.current = threadId;
    // Mount the cached transcript as a transition: the selection highlight and
    // sidebar stay responsive while React renders the (potentially large)
    // message list, and the render can be interrupted by a newer switch.
    startTransition(() => {
      setSnapshot((current) => selectedThreadIdRef.current === threadId
        ? reconcileSnapshotWithRuntimeEvents(cached)
        : current);
      setBrowserTabsByThread((current) => ({ ...current, [threadId]: cached.browserTabs }));
      if (selectedThreadIdRef.current === threadId) {
        const cachedGpa = normalizeGpaStateForThread(cached.thread.mode, cached.gpa);
        setGpaState(cachedGpa);
        setGpaComposerSelected(cachedGpa.stage !== "off");
        setIsThreadSwitching(false);
      }
    });
    return true;
  }

  const selectedProjectFile = selectedThreadId ? selectedProjectFileByThread[selectedThreadId] ?? null : null;
  const filePreviewPresence = useMotionPresence(filePreviewPath, 180);
  const visibleFilePreviewPath = filePreviewPath ?? filePreviewPresence.value;
  const projectFilePreview =
    selectedThreadId && visibleFilePreviewPath
      ? projectFilePreviewsByThread[selectedThreadId]?.[visibleFilePreviewPath] ?? null
      : null;
  const projectToolCalls = snapshot?.thread.id === selectedThreadId ? snapshot.toolCalls : [];

  function flushAssistantDraft(draftId: string) {
    const pending = assistantDraftFramesRef.current[draftId];
    if (!pending) return;

    window.cancelAnimationFrame(pending.frame);
    delete assistantDraftFramesRef.current[draftId];
    setAssistantDrafts((current) => reconcileAssistantDraftUpdate(current, pending.draft));
  }

  function discardQueuedAssistantDraft(draftId: string) {
    const pending = assistantDraftFramesRef.current[draftId];
    if (!pending) return;
    window.cancelAnimationFrame(pending.frame);
    delete assistantDraftFramesRef.current[draftId];
  }

  function discardQueuedAssistantDraftsForThread(threadId: string) {
    for (const [draftId, pending] of Object.entries(assistantDraftFramesRef.current)) {
      if (pending.draft.threadId === threadId) {
        discardQueuedAssistantDraft(draftId);
      }
    }
  }

  const fadeInFinalAssistantMessage = useCallback((messageId: string) => {
    setFinalizingAssistantMessageIds((current) => {
      if (current.has(messageId)) return current;
      const next = new Set(current);
      next.add(messageId);
      return next;
    });
    const previousTimer = finalMessageFadeTimersRef.current[messageId];
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    finalMessageFadeTimersRef.current[messageId] = window.setTimeout(() => {
      delete finalMessageFadeTimersRef.current[messageId];
      setFinalizingAssistantMessageIds((current) => {
        if (!current.has(messageId)) return current;
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }, ASSISTANT_FINAL_MESSAGE_FADE_DURATION_MS);
  }, []);

  function queueAssistantDraft(draft: AssistantDraft) {
    const pending = assistantDraftFramesRef.current[draft.draftId];
    if (pending) {
      pending.draft = draft;
      return;
    }

    assistantDraftFramesRef.current[draft.draftId] = {
      draft,
      frame: window.requestAnimationFrame(() => flushAssistantDraft(draft.draftId))
    };
  }

  useEffect(() => {
    setGpaState(normalizeGpaStateForThread("chat", null));
    setGpaComposerSelected(false);
    setGpaMenuOpen(false);
    setGpaMenuPos(null);
    setGpaRevisionOpen(false);
    setGpaRevisionDraft("");
    setGpaConfirmationSubmitting(false);
    setGpaPlanResumeDialog(null);
    setGpaPlanResumeRetryPrompt(null);
    gpaConfirmationPendingStageRef.current = null;
    if (!selectedThreadId) {
      return;
    }
    ensureTerminalTab(selectedThreadId);
  }, [selectedThreadId]);

  useEffect(() => {
    if (!config) return;
    const defaultSelection = modelKey(config.defaultProvider, config.defaultModel);
    const fallbackSelection = skillLabModelOptions.some((option) => option.value === defaultSelection)
      ? defaultSelection
      : skillLabModelOptions[0]?.value ?? "";
    setSkillLabModelSelection((current) =>
      skillLabModelOptions.some((option) => option.value === current) ? current : fallbackSelection
    );
  }, [config]);

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
    setCompletedTurnTimers((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    setRuntimeActivities((current) => ({
      ...current,
      [threadId]: {
        threadId,
        startedAt: createdAt,
        // Show the same label users expect under the message immediately on send,
        // instead of waiting for the later message.created runtime event.
        entries: [{ id: `submitted-${createdAt}`, kind: "status", label: "正在理解任务", createdAt }]
      }
    }));
  }

  function appendRuntimeStatus(threadId: string, label: string, createdAt = new Date().toISOString()) {
    // Background tasks can emit many recovery events. Their detail is persisted
    // in the snapshot; only the visible task needs live transcript activity.
    if (threadId !== selectedThreadIdRef.current) return;
    setRuntimeActivities((current) => {
      const activity = current[threadId] ?? { threadId, startedAt: createdAt, entries: [] };
      const last = activity.entries.at(-1);
      if (last?.kind === "status" && last.label === label) return current;
      return {
        ...current,
        [threadId]: {
          ...activity,
          startedAt: activity.startedAt ?? createdAt,
          entries: trimRuntimeActivityEntries([
            ...activity.entries,
            { id: `status-${createdAt}-${label}`, kind: "status", label, createdAt }
          ])
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
    if (threadId !== selectedThreadIdRef.current) return;
    setRuntimeActivities((current) => {
      const activity = current[threadId] ?? { threadId, startedAt: createdAt, entries: [] };
      return {
        ...current,
        [threadId]: {
          ...activity,
          startedAt: activity.startedAt ?? createdAt,
          entries: trimRuntimeActivityEntries([
            ...activity.entries,
            { id: `output-${createdAt}`, kind: "output", label, content, createdAt }
          ])
        }
      };
    });
  }

  function upsertRuntimeTool(threadId: string, toolCall: ToolCallRecord) {
    if (threadId !== selectedThreadIdRef.current) return;
    setRuntimeActivities((current) => {
      const activity = current[threadId] ?? {
        threadId,
        startedAt: toolCall.startedAt || new Date().toISOString(),
        entries: []
      };
      const existingIndex = activity.entries.findIndex((entry) => entry.kind === "tool" && entry.toolCall.id === toolCall.id);
      const entries = existingIndex < 0
        ? [...activity.entries, { id: `tool-${toolCall.id}`, kind: "tool" as const, toolCall }]
        : activity.entries.map((entry, index) => index === existingIndex
          ? { id: entry.id, kind: "tool" as const, toolCall }
          : entry
        );
      return {
        ...current,
        [threadId]: {
          ...activity,
          startedAt: activity.startedAt ?? toolCall.startedAt ?? new Date().toISOString(),
          entries: trimRuntimeActivityEntries(entries)
        }
      };
    });
  }

  function completeRuntimeTool(
    threadId: string,
    toolCallId: string,
    status: Extract<ToolCallRecord["status"], "completed" | "failed" | "blocked">,
    resultJson: string | null,
    completedAt: string
  ) {
    if (threadId !== selectedThreadIdRef.current) return;
    setRuntimeActivities((current) => {
      const activity = current[threadId];
      if (!activity) return current;
      return {
        ...current,
        [threadId]: {
          ...activity,
          entries: trimRuntimeActivityEntries(activity.entries.map((entry) => entry.kind === "tool" && entry.toolCall.id === toolCallId
            ? { ...entry, toolCall: { ...entry.toolCall, status, resultJson, completedAt } }
            : entry
          ))
        }
      };
    });
  }

  function appendRuntimeDecisionStatusAfterTool(threadId: string, createdAt = new Date().toISOString()) {
    if (threadId !== selectedThreadIdRef.current) return;
    setRuntimeActivities((current) => {
      const activity = current[threadId] ?? { threadId, startedAt: createdAt, entries: [] };
      const completedTools = activity.entries
        .filter((entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> =>
          entry.kind === "tool" && entry.toolCall.status === "completed"
        );
      const latestTool = completedTools.at(-1)?.toolCall;
      const action = latestTool
        ? getToolProcessingLabel(latestTool.toolName, latestTool.argumentsJson, skillNames).replace(/^正在/, "")
        : "工具结果";
      const label = completedTools.length > 1
        ? `已完成 ${completedTools.length} 项操作，正在${action}`
        : `正在${action}`;
      const last = activity.entries.at(-1);
      if (last?.kind === "status" && last.label === label) return current;
      return {
        ...current,
        [threadId]: {
          ...activity,
          startedAt: activity.startedAt ?? createdAt,
          entries: trimRuntimeActivityEntries([
            ...activity.entries,
            { id: `status-${createdAt}-${label}`, kind: "status", label, createdAt }
          ])
        }
      };
    });
  }

  function clearRuntimeActivity(threadId: string) {
    let captured: RuntimeActivity | undefined;
    setRuntimeActivities((current) => {
      captured = current[threadId];
      if (!captured) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    if (captured) {
      const startedAt = captured.startedAt || getRuntimeActivityStartedAt(captured.entries);
      if (startedAt) {
        setCompletedTurnTimers((timers) => ({
          ...timers,
          [threadId]: { startedAt, completedAt: new Date().toISOString() }
        }));
      }
    }
  }

  function scheduleThreadTokenUsageRefresh(threadId: string) {
    if (selectedThreadIdRef.current !== threadId) return;
    if (threadTokenUsageRefreshTimerRef.current !== null) {
      window.clearTimeout(threadTokenUsageRefreshTimerRef.current);
    }
    threadTokenUsageRefreshTimerRef.current = window.setTimeout(() => {
      threadTokenUsageRefreshTimerRef.current = null;
      if (selectedThreadIdRef.current !== threadId) return;
      void window.codexh.getThreadTokenUsage(threadId)
        .then((usage) => {
          if (selectedThreadIdRef.current === threadId) setThreadTokenUsage(usage);
        })
        .catch(() => undefined);
    }, 180);
  }

  useEffect(() => {
    const dispose = window.codexh.onBrowserReregisterRequest(({ threadId, tabId }) => {
      reregisterBrowserWebviews(threadId, tabId);
    });
    return dispose;
  }, []);

  useEffect(() => {
    let runtimeRefreshTimer: number | null = null;
    let shouldRefreshSelectedSnapshot = false;
    const scheduleRuntimeRefresh = (threadId?: string) => {
      if (!threadId || threadId === selectedThreadIdRef.current) {
        shouldRefreshSelectedSnapshot = true;
      }
      if (runtimeRefreshTimer !== null) window.clearTimeout(runtimeRefreshTimer);
      runtimeRefreshTimer = window.setTimeout(() => {
        runtimeRefreshTimer = null;
        const snapshotThreadId = shouldRefreshSelectedSnapshot ? selectedThreadIdRef.current : null;
        shouldRefreshSelectedSnapshot = false;
        void refreshThreads({ refreshSelectedSnapshot: false });
        if (snapshotThreadId) {
          void refreshSnapshot(snapshotThreadId);
        }
      }, 120);
    };
    const dispose = window.codexh.onRuntimeEvent((event) => {
      const runtimeEvent = event as RuntimeEvent;
      const typed = event as {
        threadId?: string;
        type: string;
        createdAt?: string;
        payload?: {
          gpa?: GpaState;
          turnRunId?: string;
          draftId?: string;
          sequence?: number;
          phase?: AssistantDraftPhase;
          discarded?: boolean;
          delta?: string;
          content?: string;
          title?: string;
          attempt?: number;
          maxAttempts?: number;
          overageBytes?: number;
          reason?: string;
          detail?: string;
          messageId?: string;
          toolCallId?: string;
          toolName?: string;
          argumentsJson?: string;
          resultJson?: string;
          prompt?: UserInputPrompt;
          approval?: ApprovalRequest;
          riskLevel?: ToolCallRecord["riskLevel"];
          approvalMode?: ToolCallRecord["approvalMode"];
          status?: ToolCallRecord["status"];
          startedAt?: string;
          completedAt?: string;
          message?: MessageRecord;
          thread?: ThreadRecord;
          childThread?: ThreadRecord;
          pluginChanged?: { pluginId: string; enabled: boolean };
          modelId?: string;
          providerId?: string;
          agentCapability?: ModelProfile["agentCapability"];
          agentCapabilityCheckedAt?: string;
          agentCapabilityReason?: string;
          data?: string;
          sessionId?: string;
          contextWindow?: number;
          beforeTokens?: number;
          afterTokens?: number;
          messagesBefore?: number;
          messagesAfter?: number;
          viewport?: { width?: number; height?: number };
          passed?: boolean;
          tabs?: RuntimeThreadSnapshot["browserTabs"];
        };
      };
      const notificationThreadId = resolveRuntimeNotificationThreadId(runtimeEvent);
      const currentSelectedThreadId = selectedThreadIdRef.current;
      const isPluginStateUpdate = typed.type === "thread.updated" && !!typed.payload?.pluginChanged;
      if (typed.type === "terminal.output" && typed.threadId) {
        if (typed.threadId !== selectedThreadIdRef.current) {
          return;
        }
        const sessionId = typeof typed.payload?.sessionId === "string" ? typed.payload.sessionId : "default";
        ensureTerminalTab(typed.threadId, sessionId);
        queueTerminalOutput(typed.threadId, sessionId, typed.payload?.data ?? "");
        return;
      }
      if (typed.type === "gpa.updated" && typed.payload?.gpa) {
        if (typed.threadId === currentSelectedThreadId) {
          if (
            gpaConfirmationPendingStageRef.current &&
            typed.payload.gpa.awaitingConfirmation !== gpaConfirmationPendingStageRef.current
          ) {
            gpaConfirmationPendingStageRef.current = null;
            setGpaConfirmationSubmitting(false);
          }
          const currentThreadMode = threadsRef.current.find((thread) => thread.id === currentSelectedThreadId)?.mode ?? "project";
          const gpa = normalizeGpaStateForThread(currentThreadMode, typed.payload.gpa);
          setGpaState(gpa);
          setGpaComposerSelected(gpa.stage !== "off");
        }
        if (notificationThreadId && typed.payload.gpa.awaitingConfirmation) {
          setThreadNotificationAttention(
            notificationThreadId,
            typed.payload.gpa.awaitingConfirmation === "goal" ? "需要确认任务目标。" : "需要确认 GPA 计划后继续。",
            "gpa",
            undefined,
            typed.createdAt
          );
        } else if (notificationThreadId) {
          const active = findActiveNotification(notificationCenterStateRef.current.items, "thread", notificationThreadId);
          if (active?.attentionKind === "gpa") resumeThreadNotification(notificationThreadId, "确认完成，任务继续运行。", typed.createdAt);
        }
        return;
      }
      if (typed.type === "user-input.resolved" && typed.threadId && typed.payload?.prompt) {
        const resolvedPrompt = typed.payload.prompt as UserInputPrompt;
        setSnapshot((current) => {
          if (!current || current.thread.id !== typed.threadId) {
            return current;
          }
          return {
            ...current,
            prompts: current.prompts.map((prompt) =>
              prompt.id === resolvedPrompt.id
                ? { ...prompt, ...resolvedPrompt, status: "answered" as const }
                : prompt
            )
          };
        });
        if (notificationThreadId) {
          resumeThreadNotification(notificationThreadId, "信息已补充，任务继续运行。", typed.createdAt);
        }
      }
      if (typed.type === "model.capability.updated" && typed.payload?.modelId && typed.payload?.providerId) {
        const modelId = typed.payload.modelId;
        const providerId = typed.payload.providerId;
        const patch = {
          agentCapability: typed.payload.agentCapability,
          agentCapabilityCheckedAt: typed.payload.agentCapabilityCheckedAt,
          agentCapabilityReason: typed.payload.agentCapabilityReason
        };
        const updateCapability = (current: AppConfig | null) => current
          ? {
              ...current,
              models: current.models.map((model) =>
                model.id === modelId && model.providerId === providerId ? { ...model, ...patch } : model
              )
            }
          : current;
        setConfig(updateCapability);
        setConfigDraft(updateCapability);
      }
      if (typed.type === "browser.verification_started" && typed.threadId) {
        const viewport = typed.payload?.viewport as { width?: number; height?: number } | undefined;
        const mode = (viewport?.width ?? 1440) <= 500 ? "手机" : "桌面";
        appendRuntimeStatus(typed.threadId, `正在验证页面 · ${mode} ${viewport?.width ?? 1440}×${viewport?.height ?? 900}`, typed.createdAt);
        setRuntimeProgress({ threadId: typed.threadId, phase: "tool", runtimeObserved: true });
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, `正在验证页面 · ${mode}`, typed.createdAt);
        }
        return;
      }
      if (typed.type === "approval.requested" && notificationThreadId && typed.payload?.approval) {
        setThreadNotificationAttention(
          notificationThreadId,
          typed.payload.approval.title || "任务正在等待你的操作确认。",
          "approval",
          typed.payload.approval.id,
          typed.createdAt
        );
      }
      if (typed.type === "user-input.requested" && notificationThreadId && typed.payload?.prompt) {
        setThreadNotificationAttention(
          notificationThreadId,
          typed.payload.prompt.title || "任务正在等待你补充信息。",
          "input",
          typed.payload.prompt.id,
          typed.createdAt
        );
      }
      if (typed.type === "approval.resolved" && typed.threadId) {
        const approvalPayload = typed.payload as unknown as {
          approvalId?: string;
          approved?: boolean;
          source?: "user" | "timeout";
        };
        if (approvalPayload.approvalId) {
          setSnapshot((current) => {
            if (!current || current.thread.id !== typed.threadId) return current;
            return {
              ...current,
              approvals: current.approvals.map((approval) => approval.id === approvalPayload.approvalId
                ? {
                    ...approval,
                    status: approvalPayload.approved ? "approved" : "denied",
                    resolutionSource: approvalPayload.source ?? "user",
                    resolvedAt: typed.createdAt ?? new Date().toISOString()
                  }
                : approval)
            };
          });
          if (approvalPayload.source === "timeout" && !suppressRuntimeProgressRef.current[typed.threadId]) {
            appendRuntimeStatus(typed.threadId, "审批超时，已自动拒绝", typed.createdAt);
          }
        }
        if (notificationThreadId) {
          resumeThreadNotification(
            notificationThreadId,
            approvalPayload.approved ? "操作已确认，任务继续运行。" : "操作已拒绝，任务继续处理。",
            typed.createdAt
          );
        }
        return;
      }
      if (typed.type === "browser.assertion_completed" && typed.threadId) {
        appendRuntimeStatus(typed.threadId, typed.payload?.passed === false ? "页面断言未通过，正在修复" : "页面断言已通过", typed.createdAt);
        return;
      }
      if (typed.type === "browser.screenshot_attached" && typed.threadId) {
        appendRuntimeStatus(typed.threadId, "页面截图已保存，正在检查视觉结果", typed.createdAt);
        return;
      }
      if (typed.type === "agent.tool_call_preparing" && typed.threadId && typed.payload?.toolName) {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        const argumentsJson = typeof typed.payload.argumentsJson === "string" ? typed.payload.argumentsJson : "{}";
        const preparingLabel = getToolProcessingLabel(typed.payload.toolName, argumentsJson, skillNames)
          .replace(/^正在/, "准备");
        if (typed.threadId !== selectedThreadIdRef.current) {
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, preparingLabel, typed.createdAt);
          }
          return;
        }
        appendRuntimeStatus(typed.threadId, preparingLabel, typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, preparingLabel, typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (
        typed.type === "tool.started" &&
        typed.threadId &&
        typed.payload?.toolCallId &&
        typed.payload?.toolName
      ) {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        if (typed.threadId !== selectedThreadIdRef.current) {
          if (notificationThreadId) {
            updateThreadNotification(
              notificationThreadId,
              getToolProcessingLabel(
                typed.payload.toolName,
                typeof typed.payload.argumentsJson === "string" ? typed.payload.argumentsJson : "{}"
              ),
              typed.createdAt
            );
          }
          return;
        }
        setActiveToolCall({
          threadId: typed.threadId,
          toolCallId: typed.payload.toolCallId,
          toolName: typed.payload.toolName,
          argumentsJson: typeof typed.payload.argumentsJson === "string" ? typed.payload.argumentsJson : "{}"
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
        setSnapshot((current) => {
          if (!current || current.thread.id !== typed.threadId) return current;
          const startedTool: ToolCallRecord = {
            id: typed.payload?.toolCallId ?? "",
            threadId: typed.threadId ?? "",
            turnRunId: typeof typed.payload?.turnRunId === "string" ? typed.payload.turnRunId : "",
            toolName: typed.payload?.toolName ?? "",
            argumentsJson: typeof typed.payload?.argumentsJson === "string" ? typed.payload.argumentsJson : "{}",
            resultJson: null,
            status: "running",
            riskLevel: typed.payload?.riskLevel ?? "medium",
            approvalMode: typed.payload?.approvalMode ?? "prompt",
            startedAt: typeof typed.payload?.startedAt === "string" ? typed.payload.startedAt : typed.createdAt ?? new Date().toISOString(),
            completedAt: null
          };
          return {
            ...current,
            toolCalls: [...current.toolCalls.filter((tool) => tool.id !== startedTool.id), startedTool]
          };
        });
        appendRuntimeStatus(
          typed.threadId,
          getToolProcessingLabel(
            typed.payload.toolName,
            typeof typed.payload.argumentsJson === "string" ? typed.payload.argumentsJson : "{}"
          ),
          typed.createdAt
        );
        if (notificationThreadId) {
          updateThreadNotification(
            notificationThreadId,
            getToolProcessingLabel(
              typed.payload.toolName,
              typeof typed.payload.argumentsJson === "string" ? typed.payload.argumentsJson : "{}"
            ),
            typed.createdAt
          );
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "tool", runtimeObserved: true });
        return;
      }
      if (typed.type === "tool.completed" && typed.payload?.toolCallId) {
        if (typed.threadId && typed.threadId !== selectedThreadIdRef.current) {
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, "工具已完成，正在继续处理。", typed.createdAt);
          }
          return;
        }
        setActiveToolCall((current) =>
          current?.toolCallId === typed.payload?.toolCallId ? null : current
        );
        if (typed.threadId) {
          const runtimeThreadId = typed.threadId;
          completeRuntimeTool(
            runtimeThreadId,
            typed.payload.toolCallId,
            typed.payload.status === "failed" ? "failed" : typed.payload.status === "blocked" ? "blocked" : "completed",
            typeof typed.payload.resultJson === "string" ? typed.payload.resultJson : null,
            typeof typed.payload.completedAt === "string" ? typed.payload.completedAt : typed.createdAt ?? new Date().toISOString()
          );
          setSnapshot((current) => {
            if (!current || current.thread.id !== runtimeThreadId) return current;
            return {
              ...current,
              toolCalls: current.toolCalls.map((tool) => tool.id === typed.payload?.toolCallId
                ? {
                    ...tool,
                    status: typed.payload?.status === "failed" ? "failed" : typed.payload?.status === "blocked" ? "blocked" : "completed",
                    resultJson: typeof typed.payload?.resultJson === "string" ? typed.payload.resultJson : null,
                    completedAt: typeof typed.payload?.completedAt === "string"
                      ? typed.payload.completedAt
                      : typed.createdAt ?? new Date().toISOString()
                  }
                : tool
              )
            };
          });
          if (!suppressRuntimeProgressRef.current[runtimeThreadId]) {
            appendRuntimeDecisionStatusAfterTool(runtimeThreadId, typed.createdAt);
            if (notificationThreadId) {
              updateThreadNotification(notificationThreadId, "工具已完成，正在继续处理。", typed.createdAt);
            }
            setRuntimeProgress((current) =>
              current?.threadId === runtimeThreadId
                ? { ...current, phase: "thinking", runtimeObserved: true }
                : current
            );
          }
        }
        return;
      }
      if (typed.type === "agent.awaiting_model" && typed.threadId) {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        const reason = typeof typed.payload?.reason === "string" ? typed.payload.reason : "recovery";
        const gpaTask = (typed.payload as { gpaTask?: { id?: unknown; title?: unknown } } | undefined)?.gpaTask;
        const statusLabel = reason === "turn_start"
          ? typeof gpaTask?.id === "string" && typeof gpaTask?.title === "string"
            ? `正在执行 ${gpaTask.id}：${gpaTask.title}，等待模型生成下一项工具操作`
            : "正在分析任务并规划下一步"
          : null;
        if (typed.threadId !== selectedThreadIdRef.current) {
          if (notificationThreadId && reason === "after_tools") {
            updateThreadNotification(notificationThreadId, "工具已完成，正在继续处理。", typed.createdAt);
          } else if (notificationThreadId && statusLabel) {
            updateThreadNotification(notificationThreadId, `${statusLabel}。`, typed.createdAt);
          }
          return;
        }
        if (reason === "after_tools") {
          appendRuntimeDecisionStatusAfterTool(typed.threadId, typed.createdAt);
        } else if (statusLabel) {
          appendRuntimeStatus(typed.threadId, statusLabel, typed.createdAt);
        }
        if (notificationThreadId && reason === "after_tools") {
          updateThreadNotification(
            notificationThreadId,
            "工具已完成，正在继续处理。",
            typed.createdAt
          );
        } else if (notificationThreadId && statusLabel) {
          updateThreadNotification(notificationThreadId, `${statusLabel}。`, typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "assistant.draft.updated" && typed.threadId && typed.payload?.turnRunId && typed.payload?.draftId) {
        const threadId = typed.threadId;
        const payload = typed.payload;
        const turnRunId = payload.turnRunId as string;
        const draftId = payload.draftId as string;
        const phase = isAssistantDraftPhase(payload.phase) ? payload.phase : "generating";
        if (suppressRuntimeProgressRef.current[threadId]) {
          discardQueuedAssistantDraft(draftId);
          return;
        }
        if (threadId !== selectedThreadIdRef.current) {
          return;
        }
        queueAssistantDraft({
          draftId,
          sequence: typeof payload.sequence === "number" ? payload.sequence : 0,
          threadId,
          turnRunId,
          content: typeof payload.content === "string" ? payload.content : "",
          phase,
          startedAt: typeof payload.startedAt === "string" ? payload.startedAt : typed.createdAt ?? new Date().toISOString(),
          completed: false
        });
        setRuntimeProgress({ threadId, phase: "generating", runtimeObserved: true });
        return;
      }
      if (typed.type === "assistant.execution_output" && typed.threadId && typed.payload?.content) {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        appendRuntimeStatus(typed.threadId, "正在校验模型输出", typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, "正在校验模型输出。", typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "model_timeout") {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
        const maxAttempts = typeof typed.payload.maxAttempts === "number" ? typed.payload.maxAttempts : 0;
        const attemptLabel = maxAttempts > 0 ? ` (${attempt}/${maxAttempts})` : `（第 ${attempt} 次）`;
        appendRuntimeStatus(typed.threadId, `模型响应超时，正在自动重试${attemptLabel}`, typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, `模型响应超时，正在自动重试${attemptLabel}。`, typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "model_rate_limit") {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
        const maxAttempts = typeof typed.payload.maxAttempts === "number" ? typed.payload.maxAttempts : 0;
        const attemptLabel = maxAttempts > 0 ? ` (${attempt}/${maxAttempts})` : `（第 ${attempt} 次）`;
        appendRuntimeStatus(typed.threadId, `模型请求受限(429)，正在自动重试${attemptLabel}`, typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, `模型请求受限，正在自动重试${attemptLabel}。`, typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "network_error") {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
        appendRuntimeStatus(typed.threadId, `网络连接中断，正在自动重试（第 ${attempt} 次）`, typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, `网络连接中断，正在自动重试（第 ${attempt} 次）。`, typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "model_rate_limit_continued") {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        appendRuntimeStatus(typed.threadId, "已确认继续，正在再次重试模型请求", typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, "已确认继续，正在再次重试。", typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "upstream_service_unavailable") {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
          appendRuntimeStatus(typed.threadId, `服务暂时不可用，正在等待后重试（第 ${attempt} 次）`, typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, `服务暂时不可用，正在等待后重试（第 ${attempt} 次）。`, typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        }
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "provider_output_limit") {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
          const maxAttempts = typeof typed.payload.maxAttempts === "number" ? typed.payload.maxAttempts : 0;
          const attemptLabel = maxAttempts > 0 ? ` (${attempt}/${maxAttempts})` : "";
          appendRuntimeStatus(typed.threadId, `模型输出被截断，正在请求精简结果${attemptLabel}`, typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, `模型输出被截断，正在请求精简结果${attemptLabel}。`, typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        }
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && (
        typed.payload?.reason === "completion_validation" || typed.payload?.reason === "completion_audit"
      )) {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
        const maxAttempts = typeof typed.payload.maxAttempts === "number" ? typed.payload.maxAttempts : 0;
        const attemptLabel = maxAttempts > 0 ? ` (${attempt}/${maxAttempts})` : "";
        appendRuntimeStatus(typed.threadId, `发现最终结果缺少执行证据，正在继续完成${attemptLabel}`, typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, `正在补齐执行步骤${attemptLabel}`, typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "browser_workspace_silent_fallback") {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          appendRuntimeStatus(typed.threadId, "浏览器工作区不可用，正在改用静默网页读取", typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, "正在改用静默网页读取。", typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        }
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "function_call_protocol_compatibility") {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          appendRuntimeStatus(typed.threadId, "模型服务工具调用不兼容，正在切换兼容模式重试", typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, "正在切换兼容模式重试。", typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        }
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "agent_decision_protocol") {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
          const detail = typeof typed.payload.detail === "string" ? typed.payload.detail : "";
          const status = `模型返回的 Agent 决策无法解析，正在自动重试（第 ${attempt} 次）${detail ? `：${detail}` : ""}`;
          appendRuntimeStatus(typed.threadId, status, typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, `${status}。`, typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        }
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "provider_request_limit") {
        if (suppressRuntimeProgressRef.current[typed.threadId]) {
          return;
        }
        const attempt = typeof typed.payload.attempt === "number" ? typed.payload.attempt : 1;
        const overageBytes = typeof typed.payload.overageBytes === "number" ? typed.payload.overageBytes : 0;
        const label = `模型请求超过限制 ${overageBytes} 字节，正在缩减上下文和工具后自动重试（第 ${attempt} 次）`;
        appendRuntimeStatus(typed.threadId, label, typed.createdAt);
        if (notificationThreadId) {
          updateThreadNotification(notificationThreadId, label, typed.createdAt);
        }
        setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && typed.payload?.reason === "native_tool_text_fallback") {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          const status = "模型返回的工具调用格式不兼容，已切换兼容模式后自动重试";
          appendRuntimeStatus(typed.threadId, status, typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, `${status}。`, typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        }
        return;
      }
      if (typed.type === "agent.retrying" && typed.threadId && (
        typed.payload?.reason === "tool_arguments_invalid" || typed.payload?.reason === "tool_arguments_truncated"
      )) {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          const toolName = typeof typed.payload.toolName === "string" ? typed.payload.toolName : "工具";
          const truncated = typed.payload.reason === "tool_arguments_truncated";
          const status = truncated
            ? `模型返回的 ${toolName} 参数被截断，正在要求模型补全后重试`
            : `模型返回的 ${toolName} 参数无法解析，正在要求模型修正后重试`;
          appendRuntimeStatus(typed.threadId, status, typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, `${status}。`, typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
        }
        return;
      }
      if (typed.type === "agent.context_compacted" && typed.threadId) {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          const completedTaskCompaction = (typed.payload as { trigger?: unknown } | undefined)?.trigger === "task_completed";
          appendRuntimeStatus(
            typed.threadId,
            completedTaskCompaction ? "任务完成，已自动压缩上下文" : "上下文已自动压缩，继续分析中",
            typed.createdAt
          );
          if (notificationThreadId) {
            updateThreadNotification(
              notificationThreadId,
              completedTaskCompaction ? "任务完成，上下文已压缩。" : "上下文已压缩，继续分析。",
              typed.createdAt
            );
          }
        }
      }
      if (typed.type === "agent.repository_exploration" && typed.threadId) {
        if (!suppressRuntimeProgressRef.current[typed.threadId]) {
          const explorationPayload = typed.payload as unknown as {
            status?: "paged" | "narrowing" | "narrowed";
            page?: number;
            returnedCount?: number;
          };
          const status = explorationPayload.status;
          const page = typeof explorationPayload.page === "number" ? explorationPayload.page : 1;
          const returned = typeof explorationPayload.returnedCount === "number" ? explorationPayload.returnedCount : null;
          if (status === "paged") {
            appendRuntimeStatus(
              typed.threadId,
              `结果已分页（第 ${page} 页${returned === null ? "" : `，${returned} 项`}），正在缩小范围`,
              typed.createdAt
            );
          } else if (status === "narrowing") {
            appendRuntimeStatus(typed.threadId, "正在缩小检索范围并定位相关文件", typed.createdAt);
          } else {
            appendRuntimeStatus(typed.threadId, "已定位相关路径，继续分析中", typed.createdAt);
          }
          setRuntimeProgress({ threadId: typed.threadId, phase: "thinking", runtimeObserved: true });
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, "正在检索并定位相关文件。", typed.createdAt);
          }
        }
      }
      if (
        typed.type === "message.created" &&
        typed.threadId &&
        (typed.payload?.message?.role === "user" || typed.payload?.message?.role === "assistant")
      ) {
        // A queued user message may be persisted after the optimistic bubble is
        // intentionally omitted. Merge the runtime event immediately; waiting
        // for the next snapshot refresh leaves a blank transcript until reload.
        const runtimeThreadId = typed.threadId;
        const message = typed.payload.message as MessageRecord;
        let consumedOptimisticIds: ReadonlySet<string> | undefined;
        if (message.role === "user") {
          const pending = pendingUserMessagesRef.current[runtimeThreadId] ?? [];
          const reconciliation = reconcilePendingUserMessagesDetailed(pending, [message]);
          consumedOptimisticIds = reconciliation.consumedIds;
          if (reconciliation.remaining.length > 0) {
            pendingUserMessagesRef.current[runtimeThreadId] = reconciliation.remaining;
          } else {
            delete pendingUserMessagesRef.current[runtimeThreadId];
          }
        }
        const messages = persistedRuntimeMessagesRef.current[runtimeThreadId] ?? new Map<string, MessageRecord>();
        messages.set(message.id, message);
        persistedRuntimeMessagesRef.current[runtimeThreadId] = messages;
        invalidateSnapshotRequest(runtimeThreadId);
        reconcileCachedAndSelectedSnapshot(runtimeThreadId, consumedOptimisticIds);
      }
      if (
        typed.type === "message.created" &&
        typed.threadId &&
        typed.payload?.message?.role === "user" &&
        getMessageDisplayKind(typed.payload.message as MessageRecord) !== "api-card"
      ) {
        const runtimeThreadId = typed.threadId;
        if (!suppressRuntimeProgressRef.current[runtimeThreadId]) {
          appendRuntimeStatus(runtimeThreadId, "正在理解任务", typed.createdAt);
          if (notificationThreadId) {
            updateThreadNotification(notificationThreadId, "正在理解任务。", typed.createdAt);
          }
          setRuntimeProgress((current) =>
            current?.threadId === runtimeThreadId
              ? { ...current, phase: "thinking", runtimeObserved: true }
              : current
          );
        }
      }
      if (typed.type === "agent.context_measured" && typed.threadId) {
        const contextMeasurement: ContextMeasurementRecord = {
          ...(typed.payload as unknown as Omit<ContextMeasurementRecord, "createdAt">),
          createdAt: runtimeEvent.createdAt
        };
        const cached = snapshotCacheByThreadRef.current.get(typed.threadId);
        if (cached) cacheThreadSnapshot({ ...cached, contextMeasurement });
        setSnapshot((current) => {
          if (!current || current.thread.id !== typed.threadId) return current;
          return { ...current, contextMeasurement };
        });
      }
      if (!isPluginStateUpdate && typed.type === "thread.updated" && typed.threadId && typed.payload?.thread) {
        applyThreadStatusNotification(runtimeEvent);
        const runtimeThreadId = typed.threadId;
        const runtimeThread = latestRuntimeThreadsRef.current[runtimeThreadId]
          ? resolveLatestThreadRecord(latestRuntimeThreadsRef.current[runtimeThreadId], typed.payload.thread)
          : typed.payload.thread;
        latestRuntimeThreadsRef.current[runtimeThreadId] = runtimeThread;
        invalidateSnapshotRequest(runtimeThreadId);
        setThreads((current) => {
          let found = false;
          const next = current.map((thread) => {
            if (thread.id !== runtimeThreadId) return thread;
            found = true;
            return resolveLatestThreadRecord(thread, runtimeThread);
          });
          return found ? next : [runtimeThread, ...next];
        });
        reconcileCachedAndSelectedSnapshot(runtimeThreadId);
        const status = runtimeThread.status;
        const resumePlan = gpaPlanResumeAttemptRef.current.get(runtimeThreadId);
        if (status === "failed") {
          if (resumePlan) {
            gpaPlanResumeAttemptRef.current.delete(runtimeThreadId);
          }
          gpaPlanResumeRetryRequiredRef.current.add(runtimeThreadId);
          void promptGpaPlanRetryAfterFailure(runtimeThreadId);
        } else if (status === "completed" && resumePlan) {
          gpaPlanResumeAttemptRef.current.delete(runtimeThreadId);
          gpaPlanResumeRetryRequiredRef.current.delete(runtimeThreadId);
        }
        setRuntimeProgress((current) => {
          if (!current || current.threadId !== runtimeThreadId) return current;
          if (suppressRuntimeProgressRef.current[runtimeThreadId]) {
            return null;
          }
          if (status === "running" || status === "waiting") {
            return { ...current, phase: "thinking", runtimeObserved: true };
          }
          return null;
        });
        // A stopped task returns to idle. Leaving this marker behind makes the
        // next user message look like it must wait behind an active runtime,
        // so it is queued without an optimistic message bubble until restart.
        pendingRuntimeStartsRef.current.delete(runtimeThreadId);
        if (status !== "running" && status !== "waiting") {
          discardQueuedAssistantDraftsForThread(runtimeThreadId);
          setAssistantDrafts((current) => {
            const remaining = Object.entries(current).filter(([, entry]) =>
              entry.threadId !== runtimeThreadId || (entry.completed && Boolean(entry.messageId))
            );
            return remaining.length === Object.keys(current).length
              ? current
              : Object.fromEntries(remaining);
          });
          clearRuntimeActivity(runtimeThreadId);
          const pendingSkillIds = pendingOneShotSkillRemovalsRef.current[runtimeThreadId] ?? [];
          if (pendingSkillIds.length > 0) {
            delete pendingOneShotSkillRemovalsRef.current[runtimeThreadId];
            for (const skillId of pendingSkillIds) {
              void window.codexh.removeThreadSkill({ threadId: runtimeThreadId, skillId }).catch(() => undefined);
            }
          }
          if (runtimeThreadId === currentSelectedThreadId) {
            setGitRefreshRevision((current) => current + 1);
            scheduleThreadTokenUsageRefresh(runtimeThreadId);
          }
        }
      }
      if (typed.type === "assistant.completed" && typed.payload?.turnRunId) {
        const { turnRunId, draftId, messageId, discarded } = typed.payload;
        const suppressed = !!typed.threadId && suppressRuntimeProgressRef.current[typed.threadId];
        if (typeof draftId === "string") {
          if (discarded === true || suppressed) {
            discardQueuedAssistantDraft(draftId);
          } else {
            flushAssistantDraft(draftId);
          }
        }
        setAssistantDrafts((current) => reconcileAssistantDraftCompletion(current, {
          turnRunId: String(turnRunId),
          draftId: typeof draftId === "string" ? draftId : undefined,
          messageId,
          discarded: discarded === true,
          suppressed
        }));
      }
      if (typed.type === "turn.usage" && typed.threadId) {
        if (currentSelectedThreadId && notificationThreadId === currentSelectedThreadId) {
          scheduleThreadTokenUsageRefresh(currentSelectedThreadId);
        }
      }
      if (!isPluginStateUpdate && (
        typed.type === "thread.updated" ||
        typed.type === "queue.updated" ||
        typed.type === "message.created" ||
        typed.type === "assistant.completed" ||
        typed.type === "browser.updated" ||
        typed.type === "knowledge.imported"
      )) {
        scheduleRuntimeRefresh(typed.threadId);
      }
      if (typed.type === "knowledge.imported") {
        void refreshSkills();
      }
    });
    return () => {
      if (runtimeRefreshTimer !== null) window.clearTimeout(runtimeRefreshTimer);
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!isTerminalOpen || !selectedThreadId || !activeTerminalSessionId) {
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
  }, [activeTerminalSessionId, isTerminalOpen, selectedThreadId]);

  useEffect(() => {
    const node = terminalScrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [activeTerminalSession?.output]);

  useEffect(() => {
    if (!isRightWorkspaceOpen || !selectedThreadId || rightWorkspaceTab !== "files") {
      return;
    }

    let cancelled = false;
    setIsProjectFilesLoading(true);
    void window.codexh.listProjectFiles(selectedThreadId).then((entries) => {
      if (cancelled || selectedThreadIdRef.current !== selectedThreadId) {
        return;
      }
      setProjectFiles(entries);
      reconcileSelectedFile(selectedThreadId, entries);
    }).catch(() => {
      if (!cancelled) {
        setProjectFiles([]);
        clearSelectedFile(selectedThreadId);
      }
    }).finally(() => {
      if (!cancelled) {
        setIsProjectFilesLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [clearSelectedFile, isRightWorkspaceOpen, reconcileSelectedFile, rightWorkspaceTab, selectedThreadId]);

  useEffect(() => {
    if (!isRightWorkspaceOpen || rightWorkspaceTab !== "changes" || !selectedThreadId) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setGitLoading(true);
      void window.codexh.getGitSnapshot(selectedThreadId).then((next) => {
        if (!cancelled && selectedThreadIdRef.current === selectedThreadId) {
          setGitSnapshot(next as GitSnapshot);
        }
      }).catch((error: unknown) => {
        if (!cancelled) {
          setGitSnapshot({
            available: false,
            message: error instanceof Error ? error.message : String(error),
            ahead: 0,
            behind: 0,
            canCreatePullRequest: false,
            files: []
          });
        }
      }).finally(() => {
        if (!cancelled) setGitLoading(false);
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [gitRefreshRevision, isRightWorkspaceOpen, rightWorkspaceTab, selectedThreadId]);

  useEffect(() => {
    if (!isSettingsOpen && !isProjectCreateOpen && !gpaPlanResumeDialog && !updateConfirmDialog && !historyThreadDeleteConfirmation && !isClearChatConfirmOpen && !isClearErrorSolutionsConfirmOpen && !isClearSelfImprovementConfirmOpen && !isClearLogsConfirmOpen && !notice && !filePreviewPath && !isHelpOpen && !isQuickNotesOpen && !quickNoteDeleteConfirm && !quickNoteListMenu) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (filePreviewPath) {
          closeProjectPreview();
          return;
        }

        if (notice) {
          dismissNotice(notice.id);
          return;
        }

        if (quickNoteDeleteConfirm) {
          setQuickNoteDeleteConfirm(null);
          return;
        }

        if (quickNoteListMenu) {
          setQuickNoteListMenu(null);
          return;
        }

        if (isQuickNotesOpen) {
          setIsQuickNotesOpen(false);
          return;
        }

        if (isHelpOpen) {
          setIsHelpOpen(false);
          return;
        }

        if (isClearChatConfirmOpen && !isClearingChat) {
          setIsClearChatConfirmOpen(false);
          return;
        }

        if (isClearErrorSolutionsConfirmOpen && !isClearingErrorSolutions) {
          setIsClearErrorSolutionsConfirmOpen(false);
          return;
        }

        if (isClearSelfImprovementConfirmOpen && !isClearingSelfImprovement) {
          setIsClearSelfImprovementConfirmOpen(false);
          return;
        }

        if (isClearLogsConfirmOpen && !isClearingLogs) {
          setIsClearLogsConfirmOpen(false);
          return;
        }

        if (historyThreadDeleteConfirmation && !deletingThreadId) {
          setHistoryThreadDeleteConfirmation(null);
          return;
        }

        if (updateConfirmDialog) {
          setUpdateConfirmDialog(null);
          return;
        }

        if (gpaPlanResumeDialog && !gpaPlanResumeBusy) {
          void dismissGpaPlanResumeDialog();
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
  }, [deletingThreadId, filePreviewPath, gpaPlanResumeBusy, gpaPlanResumeDialog, historyThreadDeleteConfirmation, isClearChatConfirmOpen, isClearingChat, isClearErrorSolutionsConfirmOpen, isClearingErrorSolutions, isClearSelfImprovementConfirmOpen, isClearingSelfImprovement, isClearLogsConfirmOpen, isClearingLogs, isHelpOpen, isProjectCreateOpen, isQuickNotesOpen, isSettingsOpen, notice, quickNoteDeleteConfirm, quickNoteListMenu, updateConfirmDialog]);

  const selectedThread = useMemo(
    () => (snapshot?.thread.id === selectedThreadId ? snapshot.thread : null) ??
      threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId, snapshot?.thread]
  );
  useEffect(() => {
    snapshotThreadIdRef.current = snapshot?.thread.id ?? null;
  }, [snapshot?.thread.id]);
  const selectedProjectCwd = selectedThread?.mode === "project" ? selectedThread.cwd ?? null : null;

  useEffect(() => {
    if (selectedThread) {
      setMultiAgentMode(selectedThread.multiAgentMode === "proactive" ? "proactive" : "disabled");
    } else {
      setMultiAgentMode("proactive");
    }
  }, [selectedThread?.id, selectedThread?.multiAgentMode]);

  async function updateMultiAgentMode(mode: MultiAgentMode) {
    setMultiAgentMode(mode);
    if (!selectedThreadId) return;
    try {
      await window.codexh.setThreadMultiAgentMode({ threadId: selectedThreadId, mode });
      await refreshSnapshot(selectedThreadId);
    } catch (error) {
      showNotice("多智能体模式更新失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => {
    if (isSettingsOpen && settingsTab === "capabilities") {
      void Promise.all([refreshSkills(), refreshUserSkills(), refreshPlugins()]);
    } else {
      void refreshSkills();
    }
  }, [isSettingsOpen, settingsTab, selectedThread?.cwd]);

  const skillNames = useMemo<SkillNameMap>(() => {
    const names = new Map<string, string>();
    for (const skill of skills) {
      const displayName = skill.displayName?.trim() || skill.qualifiedName?.trim() || skill.name?.trim();
      if (displayName) names.set(skill.id, displayName);
    }
    return names;
  }, [skills]);

  const skillUsageStatsByKey = useMemo(() => {
    const statsByKey = new Map<string, SkillUsageStats>();
    for (const stats of skillUsageStats) {
      statsByKey.set(stats.skillId, stats);
    }
    return statsByKey;
  }, [skillUsageStats]);
  const resolveSkillUsageStats = (skill: SkillMetadata): SkillUsageStats =>
    skillUsageStatsByKey.get(skill.id) ??
    skillUsageStatsByKey.get(skill.qualifiedName) ??
    skillUsageStatsByKey.get(skill.name) ?? {
      skillId: skill.id,
      callCount: 0,
      successCount: 0,
      successRate: 0,
      lastUsedAt: null
    };
  const pluginCallCounts = useMemo(() => {
    const callCounts = new Map<string, number>();
    for (const skill of skills) {
      if (!skill.pluginId) continue;
      callCounts.set(skill.pluginId, (callCounts.get(skill.pluginId) ?? 0) + resolveSkillUsageStats(skill).callCount);
    }
    return callCounts;
  }, [skillUsageStatsByKey, skills]);

  const visibleSkills = useMemo(() => {
    const query = skillsSearchQuery.trim().toLowerCase();

    const filtered = skills.filter((skill) => {
      // Plugin-owned Skills are managed with their plugin, not as standalone Skills.
      // Skills extracted from chat history are managed in the User Skills tab.
      if (skill.pluginId || isGeneratedUserSkill(skill)) return false;
      if (!query) return true;
      const haystack = [
        skill.displayName ?? "",
        skill.qualifiedName,
        skill.name,
        skill.domain ?? "",
        skill.description
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    return filtered
      .map((skill) => ({ skill, stats: resolveSkillUsageStats(skill) }))
      .sort((left, right) => {
        if (skillsSortMode === "calls") {
          if (right.stats.callCount !== left.stats.callCount) {
            return right.stats.callCount - left.stats.callCount;
          }
          if (left.stats.callCount === 0 && right.stats.callCount === 0) {
            return (left.skill.displayName ?? left.skill.qualifiedName).localeCompare(
              right.skill.displayName ?? right.skill.qualifiedName
            );
          }
        }
        if (skillsSortMode === "success") {
          const leftRate = left.stats.callCount > 0 ? left.stats.successRate : -1;
          const rightRate = right.stats.callCount > 0 ? right.stats.successRate : -1;
          if (rightRate !== leftRate) {
            return rightRate - leftRate;
          }
          if (right.stats.callCount !== left.stats.callCount) {
            return right.stats.callCount - left.stats.callCount;
          }
        }
        return (left.skill.displayName ?? left.skill.qualifiedName).localeCompare(
          right.skill.displayName ?? right.skill.qualifiedName
        );
      });
  }, [skillUsageStatsByKey, skills, skillsSearchQuery, skillsSortMode]);

  useEffect(() => {
    if (!skillsSortOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!skillsSortMenuRef.current?.contains(event.target as Node)) {
        setSkillsSortOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [skillsSortOpen]);

  useEffect(() => {
    if (isSettingsOpen && settingsTab === "knowledge") void refreshKnowledgeBases();
    if (isSettingsOpen && settingsTab === "memory") {
      void refreshSelfImprovementMemories();
      void refreshErrorSolutions();
    }
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
  const timelinePrompts = useMemo(
    () =>
      userInputPrompts.filter(
        (prompt) => !pendingPrompts.some((pending) => pending.id === prompt.id)
      ),
    [pendingPrompts, userInputPrompts]
  );
  const canImportProjectKnowledge = selectedThread?.mode === "project" && !!selectedThread.cwd;
  const knowledgeImport = useKnowledgeImport({
    selectedThreadId,
    canImportProjectKnowledge,
    refreshSnapshot,
    refreshKnowledgeBases,
    showNotice
  });
  const {
    sources: knowledgeSources,
    urlInput: knowledgeUrlInput,
    setUrlInput: setKnowledgeUrlInput,
    isUrlEditorOpen: isKnowledgeUrlEditorOpen,
    setIsUrlEditorOpen: setIsKnowledgeUrlEditorOpen,
    name: knowledgeName,
    setName: setKnowledgeName,
    scope: knowledgeScope,
    setScope: setKnowledgeScope,
    isImporting: isKnowledgeImporting,
    importKnowledge,
    chooseSources: chooseKnowledgeSources,
    removeSource: removeKnowledgeSource,
    addUrls: addKnowledgeUrls,
    getSourceKey: knowledgeSourceKey
  } = knowledgeImport;
  const workflowBindings = snapshot?.projectPlugins ?? [];
  const enabledPluginIds = useMemo(() => {
    if (selectedThread?.mode === "project") {
      return new Set(workflowBindings.filter((item) => item.binding?.enabled).map((item) => item.plugin.id));
    }
    return new Set(selectedThread?.selectedPluginIds ?? []);
  }, [selectedThread?.id, selectedThread?.mode, selectedThread?.selectedPluginIds, workflowBindings]);
  const visibleComposerSkills = useMemo(
    () => skills
      .filter((skill) => !skill.pluginId || enabledPluginIds.has(skill.pluginId))
      .sort((left, right) => {
        const userSkillOrder = Number(isGeneratedUserSkill(right)) - Number(isGeneratedUserSkill(left));
        if (userSkillOrder !== 0) return userSkillOrder;
        return (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name);
      }),
    [enabledPluginIds, skills]
  );
  const filteredComposerSkills = useMemo(() => {
    const keyword = skillsMenuQuery.trim().toLocaleLowerCase();
    if (!keyword) return visibleComposerSkills;
    return visibleComposerSkills.filter((skill) =>
      (skill.displayName ?? skill.name).toLocaleLowerCase().includes(keyword) ||
      (skill.shortDescription ?? skill.description ?? "").toLocaleLowerCase().includes(keyword)
    );
  }, [visibleComposerSkills, skillsMenuQuery]);
  useEffect(() => {
    if (!selectedThreadId) return;
    for (const plugin of plugins) {
      pluginEnabledStateRef.current.set(`${selectedThreadId}:${plugin.id}`, enabledPluginIds.has(plugin.id));
    }
  }, [enabledPluginIds, plugins, selectedThreadId]);
  const selectedThreadStatus = activeSnapshotThreadStatus ?? selectedThread?.status ?? null;
  // During a history switch the old snapshot stays visible briefly. Keep its
  // workspace context until the replacement snapshot arrives to avoid an
  // unnecessary full timeline rebuild using the newly selected thread's path.
  const snapshotWorkspaceRoot = snapshot?.thread.cwd ?? null;
  const selectedMessages = snapshot?.messages ?? [];
  const queuedMessages = snapshot?.queuedMessages ?? [];
  const visibleMessages = useMemo(
    () => filterTranscriptMessages(selectedMessages, activeSnapshotThreadStatus),
    [activeSnapshotThreadStatus, selectedMessages]
  );
  const gpaPlanMessageId = useMemo(
    () => getGpaPlanMessageId(visibleMessages, gpaState),
    [gpaState, visibleMessages]
  );
  const timelineEntries = useMemo(
    () =>
      buildTimelineEntries(
        visibleMessages,
        snapshot?.toolCalls ?? [],
        snapshot?.artifacts ?? [],
        snapshotWorkspaceRoot,
        selectedThreadStatus,
        timelinePrompts,
        snapshot?.contextCompaction
      ),
    [
      snapshotWorkspaceRoot,
      selectedThreadStatus,
      snapshot?.artifacts,
      snapshot?.contextCompaction,
      snapshot?.toolCalls,
      timelinePrompts,
      visibleMessages
    ]
  );
  const conversationTurnSections = useMemo(
    () => buildConversationTurnSections(timelineEntries),
    [timelineEntries]
  );
  const timelineTurnByEntryId = useMemo(
    () => new Map(conversationTurnSections.flatMap((section) => section.entryIds.map((entryId) => [entryId, section] as const))),
    [conversationTurnSections]
  );
  const conversationTurns = useMemo(
    () => buildConversationTurnItems(visibleMessages, snapshot?.toolCalls ?? [], snapshotWorkspaceRoot),
    [snapshotWorkspaceRoot, snapshot?.toolCalls, visibleMessages]
  );
  const currentSubagents = useMemo(
    () => snapshot?.subagents ?? [],
    [snapshot?.subagents]
  );
  const queuedSubagentIds = useMemo(
    () => new Set(snapshot?.queuedSubagentIds ?? []),
    [snapshot?.queuedSubagentIds]
  );
  const activeAssistantDraft = useMemo(() => {
    return selectActiveAssistantDraft(
      Object.values(assistantDrafts),
      activeSnapshotThreadId,
      activeSnapshotThreadStatus,
      visibleMessages
    );
  }, [activeSnapshotThreadId, activeSnapshotThreadStatus, assistantDrafts, visibleMessages]);
  const activeDraftContent = activeAssistantDraft
    ? getAssistantDraftDisplayContent(activeAssistantDraft)
    : "";
  const composerPrimaryAction = getComposerPrimaryActionState(
    selectedThreadStatus,
    input.trim() || composerAttachments.some((attachment) => !isPersistentComposerContextKind(attachment.kind)) ? "content" : ""
  );
  const isActiveThreadExecuting = composerPrimaryAction.kind === "interrupt";
  const activeRuntimeThreadId = activeSnapshotThreadId ?? selectedThreadId;
  const localRuntimeProgress = runtimeProgress?.threadId === activeRuntimeThreadId
    ? runtimeProgress
    : null;
  const activeRuntimeActivity = activeRuntimeThreadId ? runtimeActivities[activeRuntimeThreadId] ?? null : null;
  const completedTurnTimer = activeRuntimeThreadId ? completedTurnTimers[activeRuntimeThreadId] ?? null : null;
  const isPreparingRuntime = !!localRuntimeProgress && !localRuntimeProgress.runtimeObserved;
  // Do not keep "执行中" alive from stale runtimeProgress after stop/complete.
  const isTaskProcessing = shouldShowTaskProcessing(selectedThreadStatus, isPreparingRuntime);
  // Active-task submissions stay in the queue until the runtime reaches the
  // next safe decision boundary instead of appearing as already sent messages.
  // Queued items must remain available while the current turn runs so they
  // can be reviewed, guided, or removed before dispatch.
  const displayedQueuedMessages = queuedMessages;
  // A model may be deciding between tool calls. Keep the same live heartbeat
  // until the runtime explicitly completes the turn, rather than freezing the
  // elapsed timer at the last completed tool call.
  const showRuntimeActivityPanel = shouldShowRuntimeActivityPanel(
    isTaskProcessing
  );
  const latestConversationTurn = conversationTurnSections.at(-1) ?? null;
  const completedCurrentTurnTools = useMemo(() => {
    const currentTurnStartedAt = Date.parse(latestConversationTurn?.startedAt ?? "");
    if (!activeRuntimeThreadId || !Number.isFinite(currentTurnStartedAt)) return [];
    return (snapshot?.toolCalls ?? []).filter((toolCall) =>
      toolCall.threadId === activeRuntimeThreadId &&
      toolCall.status === "completed" &&
      Date.parse(toolCall.completedAt ?? toolCall.startedAt) >= currentTurnStartedAt
    );
  }, [activeRuntimeThreadId, latestConversationTurn?.startedAt, snapshot?.toolCalls]);
  const currentTurnDecisionLabel = useMemo(() => {
    const latestTool = completedCurrentTurnTools.at(-1);
    if (!latestTool) return "正在分析任务并规划下一步";
    const action = getToolProcessingLabel(latestTool.toolName, latestTool.argumentsJson, skillNames).replace(/^正在/, "");
    return completedCurrentTurnTools.length > 1
      ? `已完成 ${completedCurrentTurnTools.length} 项操作，正在${action}`
      : `正在${action}`;
  }, [completedCurrentTurnTools, skillNames]);
  const currentGpaTask = useMemo(
    () => gpaState.planTasks.find((task) => !task.done) ?? null,
    [gpaState.planTasks]
  );
  const currentGpaTaskLabel = currentGpaTask
    ? `正在执行 ${currentGpaTask.id}：${currentGpaTask.title}，等待模型生成下一项工具操作`
    : "正在分析任务并规划下一步";
  // Apply the default collapse synchronously on the very first render of a
  // thread. Previously the default was written by the effect below, so the
  // first paint after switching rendered EVERY turn expanded — full markdown
  // parsing plus per-line hljs highlighting for the whole history — and only
  // then collapsed. That first paint was the visible switch jank.
  const collapsedTurnIds = useMemo(() => {
    if (!activeSnapshotThreadId) return new Set<string>();
    const stored = collapsedConversationTurns[activeSnapshotThreadId];
    const collapsed = stored !== undefined || initializedConversationTurnsByThreadRef.current[activeSnapshotThreadId]
      ? new Set(stored ?? [])
      : new Set(
          getDefaultCollapsedConversationTurnIds(
            conversationTurnSections,
            latestConversationTurn?.id ?? null,
            isTaskProcessing
          )
        );
    if (isTaskProcessing && latestConversationTurn) {
      collapsed.delete(latestConversationTurn.id);
    }
    return collapsed;
  }, [activeSnapshotThreadId, collapsedConversationTurns, conversationTurnSections, latestConversationTurn?.id, isTaskProcessing]);
  useEffect(() => {
    if (!activeSnapshotThreadId) return;
    const initializedTurnIds = initializedConversationTurnsByThreadRef.current[activeSnapshotThreadId] ?? new Set<string>();
    const turnIdsToCollapse = getDefaultCollapsedConversationTurnIds(
      conversationTurnSections,
      latestConversationTurn?.id ?? null,
      isTaskProcessing
    ).filter((turnId) => !initializedTurnIds.has(turnId));
    if (turnIdsToCollapse.length === 0) return;

    initializedConversationTurnsByThreadRef.current[activeSnapshotThreadId] = new Set([
      ...initializedTurnIds,
      ...turnIdsToCollapse
    ]);
    setCollapsedConversationTurns((current) => {
      const currentIds = current[activeSnapshotThreadId] ?? new Set<string>();
      return {
        ...current,
        [activeSnapshotThreadId]: new Set([...currentIds, ...turnIdsToCollapse])
      };
    });
  }, [activeSnapshotThreadId, conversationTurnSections, isTaskProcessing, latestConversationTurn?.id]);
  useEffect(() => {
    if (!activeSnapshotThreadId || !isTaskProcessing || !latestConversationTurn) return;
    setCollapsedConversationTurns((current) => {
      const currentIds = current[activeSnapshotThreadId];
      if (!currentIds?.has(latestConversationTurn.id)) return current;
      const nextIds = new Set(currentIds);
      nextIds.delete(latestConversationTurn.id);
      return { ...current, [activeSnapshotThreadId]: nextIds };
    });
  }, [activeSnapshotThreadId, isTaskProcessing, latestConversationTurn]);
  const latestRootRuntimeTool = useMemo(
    () => [...(activeRuntimeActivity?.entries ?? [])].reverse().find(
      (entry): entry is Extract<RuntimeActivityEntry, { kind: "tool" }> => entry.kind === "tool"
    )?.toolCall ?? null,
    [activeRuntimeActivity?.entries]
  );
  const deferredRuntimeToolGroup = useMemo(() => {
    if (!isTaskProcessing || !latestRootRuntimeTool) {
      return null;
    }
    const group = timelineEntries.find(
      (entry): entry is Extract<TimelineEntry, { kind: "tool-group" }> =>
        entry.kind === "tool-group" && entry.toolCalls.some((toolCall) => toolCall.id === latestRootRuntimeTool.id)
    );
    if (!group) return null;

    const groupCompletedAt = Math.max(...group.toolCalls.map((toolCall) => Date.parse(toolCall.completedAt ?? toolCall.startedAt)));
    const hasReplacementReply = visibleMessages.some((message) =>
      message.role === "assistant" &&
      !isInternalAgentProtocolMessage(message.content) &&
      Date.parse(message.createdAt) > groupCompletedAt
    );
    return hasReplacementReply ? null : group.toolCalls;
  }, [isTaskProcessing, latestRootRuntimeTool, timelineEntries, visibleMessages]);
  const completedDeferredRuntimeToolGroup = deferredRuntimeToolGroup &&
    !getToolActivityPresentation(deferredRuntimeToolGroup).runningCall
    ? deferredRuntimeToolGroup
    : null;
  const activeSubagents = useMemo(
    () => getActiveSubagents(currentSubagents, queuedSubagentIds),
    [currentSubagents, queuedSubagentIds]
  );
  const shouldRenderRuntimeTailPanel = Boolean(
    showRuntimeActivityPanel &&
    !(latestConversationTurn && collapsedTurnIds.has(latestConversationTurn.id))
  );
  const subagentWaitLabel = getSubagentWaitLabel(currentSubagents, queuedSubagentIds);
  const isWaitingForSubagents = Boolean(
    isTaskProcessing &&
    subagentWaitLabel &&
    latestRootRuntimeTool &&
    isSubagentWaitTool(latestRootRuntimeTool.toolName)
  );
  const taskProcessingLabel = useMemo(
    () =>
      isWaitingForSubagents && subagentWaitLabel
        ? subagentWaitLabel
        : activeToolCall?.threadId === activeSnapshotThreadId
        ? getToolProcessingLabel(activeToolCall.toolName, activeToolCall.argumentsJson, skillNames)
        : activeAssistantDraft
          ? "正在生成回复"
        : isPreparingRuntime
            ? "正在理解任务"
            : localRuntimeProgress?.phase === "thinking"
              ? currentGpaTask && completedCurrentTurnTools.length === 0
                ? currentGpaTaskLabel
                : currentTurnDecisionLabel
              : "正在分析任务并规划下一步",
    [
      activeSnapshotThreadId,
      activeAssistantDraft,
      activeToolCall,
      skillNames,
      isWaitingForSubagents,
      isPreparingRuntime,
      localRuntimeProgress?.phase,
      currentTurnDecisionLabel,
      currentGpaTask,
      currentGpaTaskLabel,
      completedCurrentTurnTools.length,
      subagentWaitLabel
    ]
  );
  const workspaceLabel = useMemo(() => getWorkspaceLabel(selectedThread), [selectedThread]);
  const showWelcome = timelineEntries.length === 0;
  const showDefaultHome = !selectedThreadId;
  const isThreadSwitchPlaceholderVisible = isThreadSwitching && selectedThreadId !== activeSnapshotThreadId;
  const pendingResumeThread = useMemo(
    () => pendingResumeThreads.find((entry) => entry.threadId === activeSnapshotThreadId) ?? null,
    [pendingResumeThreads, activeSnapshotThreadId]
  );
  const isGpaResumeFlow = Boolean(
    gpaState.stage !== "off" ||
    gpaPlanResumeRetryPrompt?.threadId === activeSnapshotThreadId ||
    gpaPlanResumeDialog?.threadId === activeSnapshotThreadId
  );
  const showPendingResumeCard = Boolean(
    pendingResumeThread &&
    !showWelcome &&
    !isGpaResumeFlow &&
    activeSnapshotThreadStatus !== "running" &&
    activeSnapshotThreadStatus !== "waiting"
  );
  const isProjectWelcome = selectedThread?.mode === "project";
  const welcomeCards = isProjectWelcome ? PROJECT_WELCOME_CARDS : CHAT_WELCOME_CARDS;
  const latestVisibleMessageId = timelineEntries[timelineEntries.length - 1]?.id ?? null;
  function toggleConversationTurnCollapsed(turnId: string) {
    const threadId = activeSnapshotThreadId;
    if (!threadId) return;
    setCollapsedConversationTurns((current) => {
      const nextIds = new Set(current[threadId] ?? []);
      if (nextIds.has(turnId)) nextIds.delete(turnId);
      else nextIds.add(turnId);
      return { ...current, [threadId]: nextIds };
    });
  }
  const transcriptUserMessageActions = useMemo<UserMessageActions>(() => ({
    editingMessage: editingUserMessage,
    onEditDraftChange: (content) =>
      setEditingUserMessage((current) => current ? { ...current, content } : current),
    onCopy: (content) => void copyUserMessage(content),
    onEdit: beginUserMessageEdit,
    onEditCancel: cancelUserMessageEdit,
    onEditSubmit: () => void submitUserMessageEdit()
  }), [editingUserMessage, isActiveThreadExecuting, isPreparingRuntime, selectedThreadId]);
  const fetchedProviderModels = useFetchedProviderModels({
    configDraft,
    setConfigDraft,
    settingsProvider,
    providerSecretDrafts,
    showNotice
  });
  const {
    fetchedModels,
    selectedFetchedModelIds,
    setSelectedFetchedModelIds,
    showFetchedModels,
    setShowFetchedModels,
    isFetchingModels,
    fetchAndShowProviderModels,
    toggleFetchedModelSelection,
    applyFetchedModels
  } = fetchedProviderModels;
  const multimodalSettings = useMultimodalSettings({
    config,
    setConfig,
    configDraft,
    setConfigDraft,
    providerSecretDrafts,
    settingsProviderId,
    refreshConfig,
    showNotice
  });
  const {
    pickerRole: multimodalPickerRole,
    setPickerRole: setMultimodalPickerRole,
    pickerSelected: multimodalPickerSelected,
    setPickerSelected: setMultimodalPickerSelected,
    resetPicker: resetMultimodalPicker,
    setMultimodalDefault,
    setReasoningDefault,
    setMultimodalEnabled,
    removeFromMultimodalRole,
    applyPicker: applyMultimodalPicker,
    clearInputDefault: clearMultimodalInputDefault
  } = multimodalSettings;
  const {
    testingModelKey,
    modelTestResults,
    checkProviderModel
  } = useProviderModelTesting({
    providerSecretDrafts,
    setConfig,
    updateModelDraft,
    formatLatency,
    showNotice
  });
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
  const showReasoningEffortPicker = selectedComposerModel
    ? isConfigurableGptReasoningModel(selectedComposerModel)
    : false;
  const composerSupportsMultimodalInput = selectedComposerModel?.supportsMultimodalInput ?? false;
  const multimodalInputFallbackReady = useMemo(() => {
    const input = config?.multimodal?.input;
    if (!config || !input || input.enabled === false) return false;
    if (!input.defaultProviderId || !input.defaultModelId) return false;
    return config.models.some(
      (model) =>
        model.providerId === input.defaultProviderId &&
        model.id === input.defaultModelId &&
        model.supportsMultimodalInput
    );
  }, [config]);
  const composerCanAttachMultimodal = composerSupportsMultimodalInput || multimodalInputFallbackReady;
  // 生成图片/视频入口仅在「设置 → 多模态」配置了对应默认模型且未关闭时出现。
  const composerMediaGenerationReady = useMemo(() => {
    const resolve = (role: "image" | "video") => {
      const modality = config?.multimodal?.[role];
      if (!config || !modality || modality.enabled === false) return false;
      if (!modality.defaultProviderId || !modality.defaultModelId) return false;
      return config.models.some(
        (model) =>
          model.providerId === modality.defaultProviderId &&
          model.id === modality.defaultModelId &&
          model.role === role
      );
    };
    return { image: resolve("image"), video: resolve("video") };
  }, [config]);
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
  const errorSolutionModelOptions = useMemo<ComposerSelectOption[]>(() => {
    const modelMap = new Map<string, string>();
    for (const model of config?.models ?? []) {
      modelMap.set(
        model.id,
        model.displayName === model.id ? model.id : `${model.displayName} (${model.id})`
      );
    }
    for (const solution of errorSolutions) {
      if (solution.modelId && !modelMap.has(solution.modelId)) {
        modelMap.set(solution.modelId, solution.modelId);
      }
    }
    return [
      { value: "all", label: "全部模型" },
      ...[...modelMap.entries()]
        .sort((left, right) => left[1].localeCompare(right[1], "zh-CN"))
        .map(([value, label]) => ({ value, label }))
    ];
  }, [config?.models, errorSolutions]);
  const selfImprovementMemoryPageCount = Math.max(
    1,
    Math.ceil(selfImprovementMemories.length / MEMORY_LIST_PAGE_SIZE)
  );
  const errorSolutionPageCount = Math.max(
    1,
    Math.ceil(errorSolutions.length / MEMORY_LIST_PAGE_SIZE)
  );
  const safeSelfImprovementMemoryPage = Math.min(
    selfImprovementMemoryPage,
    selfImprovementMemoryPageCount - 1
  );
  const safeErrorSolutionPage = Math.min(
    errorSolutionPage,
    errorSolutionPageCount - 1
  );
  const visibleSelfImprovementMemories = useMemo(
    () => selfImprovementMemories.slice(
      safeSelfImprovementMemoryPage * MEMORY_LIST_PAGE_SIZE,
      (safeSelfImprovementMemoryPage + 1) * MEMORY_LIST_PAGE_SIZE
    ),
    [selfImprovementMemories, safeSelfImprovementMemoryPage]
  );
  const visibleErrorSolutions = useMemo(
    () => errorSolutions.slice(
      safeErrorSolutionPage * MEMORY_LIST_PAGE_SIZE,
      (safeErrorSolutionPage + 1) * MEMORY_LIST_PAGE_SIZE
    ),
    [errorSolutions, safeErrorSolutionPage]
  );
  const subagentDefaultModelOptions = useMemo<ComposerSelectOption[]>(() => [
    { value: "__inherit__", label: "跟随当前模型（默认）" },
    ...(configDraft?.models ?? [])
      .filter(isReasoningModel)
      .map((model) => ({
        value: modelKey(model.providerId, model.id),
        label: `${getProviderDisplayName(configDraft!.providers.find((provider) => provider.id === model.providerId) ?? { id: model.providerId, type: "openai-compatible" })} / ${model.displayName || model.id}`
      }))
  ], [configDraft]);
  const subagentDefaultModelValue = useMemo(() => {
    const settings = configDraft?.multiAgent;
    if (!settings?.defaultModelId) return "__inherit__";
    const model = (configDraft?.models ?? []).find((item) =>
      item.id === settings.defaultModelId &&
      (!settings.defaultProviderId || item.providerId === settings.defaultProviderId)
    );
    return model ? modelKey(model.providerId, model.id) : "__inherit__";
  }, [configDraft]);
  const resolveErrorSolutionModelLabel = useCallback((modelId: string) => {
    if (!modelId) return "未知模型";
    const model = config?.models.find((entry) => entry.id === modelId);
    if (!model) return modelId;
    return model.displayName === model.id ? model.id : model.displayName;
  }, [config?.models]);
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
  const defaultHomeModelLabel = useMemo(() => {
    if (!config) {
      return "未配置";
    }
    const targetProviderId = composerProviderId ?? config.defaultProvider;
    const targetModelId = composerModelId ?? config.defaultModel;
    const targetModel = config.models.find(
      (model) => model.id === targetModelId && model.providerId === targetProviderId
    ) ?? null;
    const provider = composerProviders.find((item) => item.id === targetProviderId);
    const providerLabel = provider ? getProviderDisplayName(provider) : null;
    const resolvedModelLabel = targetModel?.displayName?.trim() || targetModel?.id || targetModelId || null;
    if (!resolvedModelLabel) {
      return "未配置";
    }
    return providerLabel ? `${providerLabel} · ${resolvedModelLabel}` : resolvedModelLabel;
  }, [config, composerModelId, composerProviderId, composerProviders]);
  const activeAssistantLabel = useMemo(() => {
    if (!config) {
      return "Assistant";
    }

    const targetProviderId = selectedThread?.providerId ?? composerProviderId ?? config.defaultProvider;
    const targetModelId = selectedThread?.modelId ?? composerModelId ?? config.defaultModel;
    const targetModel = config.models.find(
      (model) => model.id === targetModelId && model.providerId === targetProviderId
    ) ?? null;

    if (!targetModel) {
      return targetModelId || "Assistant";
    }

    return targetModel.displayName?.trim() || targetModel.id;
  }, [config, composerModelId, composerProviderId, selectedThread]);
  const activeContextCompaction = snapshot?.contextCompaction ?? null;
  const contextUsage = useMemo(() => {
    const targetProviderId = selectedThread?.providerId ?? composerProviderId ?? config?.defaultProvider;
    const targetModelId = selectedThread?.modelId ?? composerModelId ?? config?.defaultModel;
    const contextWindow = config?.models.find(
      (model) => model.id === targetModelId && model.providerId === targetProviderId
    )?.contextWindow ?? 128_000;
    const contextMeasurement = snapshot?.contextMeasurement;
    const matchingMeasurement = contextMeasurement?.modelId === targetModelId && contextMeasurement.providerId === targetProviderId
      ? contextMeasurement
      : null;
    return buildContextUsage({
      contextWindow,
      messages: selectedMessages,
      toolCalls: snapshot?.toolCalls ?? [],
      gpaStage: gpaState.stage,
      selectedSkillCount: selectedThread?.selectedSkillIds.length ?? 0,
      mcpServerCount: config?.mcpServers.length ?? 0,
      pendingInput: `${input}\n${formatComposerAttachments(composerAttachments)}`,
      compaction: activeContextCompaction,
      measurement: matchingMeasurement
    });
  }, [activeContextCompaction, composerAttachments, composerModelId, composerProviderId, config, gpaState.stage, input, selectedMessages, selectedThread, snapshot?.contextMeasurement, snapshot?.toolCalls]);

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
      const targetTop = Math.max(0, node.scrollHeight - node.clientHeight);
      if (behavior === "auto" && Math.abs(node.scrollTop - targetTop) < 1) {
        return;
      }
      node.scrollTo({
        top: targetTop,
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

    for (const draft of Object.values(assistantDrafts)) {
      if (!draft.completed || !draft.messageId || draft.threadId !== snapshot.thread.id) continue;
      if (snapshot.messages.some((message) => message.id === draft.messageId && message.role === "assistant")) {
        fadeInFinalAssistantMessage(draft.messageId);
      }
    }

    setAssistantDrafts((current) => {
      let changed = false;
      const next = { ...current };

      for (const [draftId, entry] of Object.entries(current)) {
        if (entry.threadId !== snapshot.thread.id) {
          continue;
        }

        if (!shouldKeepAssistantDraft(entry, snapshot.messages, snapshot.thread.status)) {
          delete next[draftId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [assistantDrafts, fadeInFinalAssistantMessage, snapshot]);

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

    // Runtime updates can arrive several times per second. Following them
    // smoothly restarts the scroll animation and makes the transcript jitter.
    scrollTranscriptToLatest();
    settleAutoScroll(activeSnapshotThreadStatus);
  }, [
    activeSnapshotThreadId,
    activeSnapshotThreadStatus,
    activeAssistantDraft?.content,
    latestVisibleMessageId,
    showRuntimeActivityPanel,
    showWelcome,
    visibleMessages.length
  ]);

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
    if (!config) {
      return;
    }

    const nextSelection = selectedThread
      ? resolveSelectionFromConfig(config, selectedThread.providerId, selectedThread.modelId)
      : resolveSelectionFromConfig(config);

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

  async function refreshThreads(options?: { refreshSelectedSnapshot?: boolean; fallbackToFirst?: boolean }) {
    const listedThreads = (await window.codexh.listThreads()) as ThreadRecord[];
    const nextThreads = listedThreads.map((thread) => {
      const runtimeThread = latestRuntimeThreadsRef.current[thread.id];
      return runtimeThread ? resolveLatestThreadRecord(runtimeThread, thread) : thread;
    });
    setThreads(nextThreads);
    syncThreadNotificationsFromThreads(nextThreads);

    // Runtime listeners are registered once, so read the current selection from the ref
    // instead of the render that created the listener.
    const currentSelectedThreadId = selectedThreadIdRef.current;
    const targetThreadId =
      currentSelectedThreadId && nextThreads.some((thread) => thread.id === currentSelectedThreadId)
        ? currentSelectedThreadId
        : currentSelectedThreadId && snapshotThreadIdRef.current === currentSelectedThreadId
          ? currentSelectedThreadId
          : options?.fallbackToFirst === false
            ? null
            : nextThreads[0]?.id ?? null;

    if (targetThreadId === currentSelectedThreadId) {
      if (options?.refreshSelectedSnapshot !== false) {
        await refreshSnapshot(targetThreadId);
      }
      return;
    }

    selectThreadId(targetThreadId);
    if (targetThreadId) {
      if (restoreCachedThreadSnapshot(targetThreadId)) {
        if (options?.refreshSelectedSnapshot !== false) {
          void refreshSnapshot(targetThreadId);
        }
      } else {
        await refreshSnapshot(targetThreadId);
      }
    }
  }

  async function refreshSnapshot(threadId: string | null) {
    if (!threadId) {
      snapshotCursorByThreadRef.current = {};
      snapshotCacheByThreadRef.current.clear();
      setSnapshot(null);
      return;
    }

    const inFlight = snapshotRefreshInFlightRef.current[threadId];
    if (inFlight) {
      snapshotRefreshPendingRef.current[threadId] = true;
      await inFlight;
      return;
    }

    let refreshPromise!: Promise<void>;
    refreshPromise = (async () => {
      try {
        do {
          snapshotRefreshPendingRef.current[threadId] = false;
          await refreshSnapshotOnce(threadId);
        } while (snapshotRefreshPendingRef.current[threadId]);
      } finally {
        if (snapshotRefreshInFlightRef.current[threadId] === refreshPromise) {
          delete snapshotRefreshInFlightRef.current[threadId];
        }
        delete snapshotRefreshPendingRef.current[threadId];
      }
    })();
    snapshotRefreshInFlightRef.current[threadId] = refreshPromise;
    await refreshPromise;
  }

  async function refreshSnapshotOnce(threadId: string) {
    const requestId = (snapshotRequestIdsRef.current[threadId] ?? 0) + 1;
    snapshotRequestIdsRef.current[threadId] = requestId;
    try {
      const cursor = snapshotCacheByThreadRef.current.has(threadId)
        ? snapshotCursorByThreadRef.current[threadId]
        : undefined;
      const next = (await window.codexh.getThreadSnapshot(threadId, cursor)) as RuntimeThreadSnapshot;
      if (snapshotRequestIdsRef.current[threadId] !== requestId) {
        return;
      }
      if (next.snapshotCursor) {
        snapshotCursorByThreadRef.current[threadId] = next.snapshotCursor;
      }
      const pending = pendingUserMessagesRef.current[threadId] ?? [];
      const remaining = reconcilePendingUserMessages(pending, next.messages);
      if (remaining.length > 0) {
        pendingUserMessagesRef.current[threadId] = remaining;
      } else {
        delete pendingUserMessagesRef.current[threadId];
      }
      const nextMessages = remaining.length > 0 ? [...next.messages, ...remaining] : next.messages;
      const cached = snapshotCacheByThreadRef.current.get(threadId);
      const base = cached ?? (snapshotThreadIdRef.current === threadId ? snapshot : null);
      const messages = next.snapshotMode === "delta" && base
        ? mergeSnapshotRecords(
            base.messages.filter((message) =>
              !message.id.startsWith("optimistic-") || remaining.some((item) => item.id === message.id)
            ),
            nextMessages,
            (message) => message.createdAt
          )
        : nextMessages;
      const toolCalls = next.snapshotMode === "delta" && base
        ? mergeSnapshotRecords(base.toolCalls, next.toolCalls, (toolCall) => toolCall.startedAt)
        : next.toolCalls;
      const artifacts = next.snapshotMode === "delta" && base
        ? mergeSnapshotRecords(base.artifacts, next.artifacts, (artifact) => artifact.createdAt, "descending")
        : next.artifacts;
      const mergedSnapshot = reconcileSnapshotWithRuntimeEvents({
        ...next,
        messages: base ? reuseEquivalentRecordArray(base.messages, messages) : messages,
        toolCalls: base ? reuseEquivalentRecordArray(base.toolCalls, toolCalls) : toolCalls,
        artifacts: base ? reuseEquivalentRecordArray(base.artifacts, artifacts) : artifacts,
        queuedMessages: base ? reuseEquivalentRecordArray(base.queuedMessages, next.queuedMessages) : next.queuedMessages,
        approvals: base ? reuseEquivalentRecordArray(base.approvals, next.approvals) : next.approvals,
        prompts: base ? reuseEquivalentRecordArray(base.prompts, next.prompts) : next.prompts
      });
      cacheThreadSnapshot(mergedSnapshot);
      if (selectedThreadIdRef.current === threadId) {
        snapshotThreadIdRef.current = threadId;
        // The merged snapshot can carry hundreds of messages; commit it as a
        // transition so urgent interactions (clicks, another switch) are not
        // blocked behind the transcript render.
        startTransition(() => {
          setSnapshot((current) => selectedThreadIdRef.current === threadId
            ? reconcileSnapshotWithRuntimeEvents(mergedSnapshot)
            : current);
          if (selectedThreadIdRef.current !== threadId) return;
          const gpa = normalizeGpaStateForThread(mergedSnapshot.thread.mode, mergedSnapshot.gpa);
          setGpaState(gpa);
          setGpaComposerSelected(gpa.stage !== "off");
          // Keep the switch placeholder visible until the replacement snapshot
          // and its thread-scoped controls commit together.
          setIsThreadSwitching(false);
        });
      }
      setThreads((current) => current.map((thread) =>
        thread.id === mergedSnapshot.thread.id
          ? resolveLatestThreadRecord(thread, mergedSnapshot.thread)
          : thread
      ));
      setBrowserTabsByThread((current) => ({ ...current, [threadId]: next.browserTabs }));
      if (!isThreadExecutionInProgress(mergedSnapshot.thread.status)) {
        // Snapshot refresh can win a race where the queue already drained but the
        // thread has not flipped to running yet. Keep the local preparing
        // heartbeat so the chat does not go blank after send.
        let preserveLocalPreparing = false;
        setRuntimeProgress((current) => {
          if (current?.threadId !== threadId) return current;
          if (!current.runtimeObserved) {
            preserveLocalPreparing = shouldPreservePreparingRuntime(
              mergedSnapshot.thread.status,
              next.queuedMessages.length,
              false
            );
            return preserveLocalPreparing ? current : null;
          }
          return shouldPreservePreparingRuntime(
            mergedSnapshot.thread.status,
            next.queuedMessages.length,
            current.runtimeObserved
          ) ? current : null;
        });
        if (!preserveLocalPreparing) {
          // A refresh can observe completion before its final runtime event reaches
          // the renderer. Do not let an old activity record keep the thinking UI alive.
          clearRuntimeActivity(threadId);
          setActiveToolCall((current) => current?.threadId === threadId ? null : current);
        }
      }
    } catch (error) {
      if (selectedThreadIdRef.current === threadId) {
        setIsThreadSwitching(false);
      }
      const message = error instanceof Error ? error.message : String(error);
      showNotice("加载聊天记录失败。", { message });
    }
  }

  function appendOptimisticUserMessage(threadId: string, content: string, attachments: MessageAttachment[] = []): MessageRecord {
    const optimisticMessage: MessageRecord = {
      id: `optimistic-${globalThis.crypto.randomUUID()}`,
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
    // The snapshot append forces the whole timeline derivation chain
    // (visibleMessages -> timelineEntries -> turn sections -> ...) to recompute
    // synchronously for long conversations. Mark it as a transition so the
    // same-batch lightweight states (submission status, "正在理解任务"
    // heartbeat) paint FIRST — the send click must never appear frozen while
    // the message bubble render catches up.
    startTransition(() => {
      setSnapshot((current) => {
        if (!current || current.thread.id !== threadId) {
          return current;
        }
        return {
          ...current,
          messages: [...current.messages, optimisticMessage]
        };
      });
    });
    return optimisticMessage;
  }

  function replaceConversationTailWithOptimisticUserMessage(
    threadId: string,
    messageId: string,
    content: string,
    attachments: MessageAttachment[]
  ): MessageRecord {
    const optimisticMessage: MessageRecord = {
      id: `optimistic-${globalThis.crypto.randomUUID()}`,
      threadId,
      turnRunId: null,
      role: "user",
      content,
      metadataJson: attachments.length > 0 ? JSON.stringify({ attachments }) : null,
      createdAt: new Date().toISOString()
    };

    // The main process rewinds everything from the edited message onward. Do
    // the same locally before that transaction completes, so an old answer
    // cannot sit below the replacement message during the handoff.
    pendingUserMessagesRef.current[threadId] = [optimisticMessage];
    setSnapshot((current) => {
      if (!current || current.thread.id !== threadId) return current;
      return {
        ...current,
        messages: replaceConversationMessagesFromEdit(current.messages, messageId, optimisticMessage),
        queuedMessages: [],
        approvals: [],
        prompts: []
      };
    });
    return optimisticMessage;
  }

  function removeOptimisticUserMessage(threadId: string, messageId: string) {
    const remaining = (pendingUserMessagesRef.current[threadId] ?? [])
      .filter((message) => message.id !== messageId);
    if (remaining.length > 0) {
      pendingUserMessagesRef.current[threadId] = remaining;
    } else {
      delete pendingUserMessagesRef.current[threadId];
    }
    setSnapshot((current) => current?.thread.id === threadId
      ? { ...current, messages: current.messages.filter((message) => message.id !== messageId) }
      : current
    );
  }

  function updateOptimisticUserMessageAttachments(
    threadId: string,
    messageId: string,
    attachments: MessageAttachment[]
  ) {
    if (attachments.length === 0) return;
    const metadataJson = JSON.stringify({ attachments });
    pendingUserMessagesRef.current[threadId] = (pendingUserMessagesRef.current[threadId] ?? []).map((message) =>
      message.id === messageId ? { ...message, metadataJson } : message
    );
    setSnapshot((current) => {
      if (!current || current.thread.id !== threadId) return current;
      return {
        ...current,
        messages: current.messages.map((message) =>
          message.id === messageId ? { ...message, metadataJson } : message
        )
      };
    });
  }

  function seedOptimisticThreadSnapshot(thread: ThreadRecord) {
    snapshotThreadIdRef.current = thread.id;
    delete snapshotCursorByThreadRef.current[thread.id];
    const nextSnapshot = createOptimisticThreadSnapshot(thread);
    cacheThreadSnapshot(nextSnapshot);
    setSnapshot(nextSnapshot);
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
    setIsThreadSwitching(false);
  }

  function activateNewThread(thread: ThreadRecord) {
    selectThreadId(thread.id);
    seedOptimisticThreadSnapshot(thread);
    // The composer is usable from the optimistic state. Fetch everything else
    // after paint so slow skills or MCP refreshes never delay the first prompt.
    void refreshThreads({ refreshSelectedSnapshot: false });
    void refreshSnapshot(thread.id);
  }

  async function openThread(threadId: string, options?: { scrollToLatest?: boolean }) {
    const isSwitchingThread = selectedThreadIdRef.current !== threadId;
    if (options?.scrollToLatest) {
      cancelPendingAutoScrollFrame();
      clearAutoScrollReleaseTimer();
      shouldAutoScrollRef.current = true;
      pendingLatestScrollThreadIdRef.current = threadId;
    }

    const hasCachedSnapshot = snapshotCacheByThreadRef.current.has(threadId);
    if (isSwitchingThread) {
      // A busy transcript can continuously schedule normal-priority updates.
      // Commit selection and unmount the old transcript in the click itself so
      // a history switch is never queued behind a running task's activity.
      flushSync(() => {
        setIsThreadSwitching(true);
        selectThreadId(threadId);
        if (!hasCachedSnapshot) {
          snapshotThreadIdRef.current = null;
          setSnapshot(null);
        }
      });
    } else {
      selectThreadId(threadId);
    }
    if (restoreCachedThreadSnapshot(threadId)) {
      // Paint the previous transcript first, then verify it incrementally.
      void refreshSnapshot(threadId);
    } else {
      await refreshSnapshot(threadId);
      // Safety net: never leave the switch skeleton up once the load settled,
      // regardless of which in-flight/pending branch handled the refresh.
      if (selectedThreadIdRef.current === threadId) {
        setIsThreadSwitching(false);
      }
    }
    // Switching chats must never auto-start GPA. Same-session incomplete plans only
    // restore the GPA chip/timeline; the user continues explicitly via GPA or send.
    await softRestoreSameSessionGpaPlan(threadId);
  }

  async function softRestoreSameSessionGpaPlan(threadId: string): Promise<void> {
    const plan = (await window.codexh.getProjectGpaPlan(threadId)) as GpaPlanResumePreview | null;
    if (!plan?.sameSession || selectedThreadIdRef.current !== threadId) {
      return;
    }
    const snapshotGpa = (await window.codexh.getGpaState(threadId)) as GpaState;
    if (selectedThreadIdRef.current !== threadId) {
      return;
    }
    if (snapshotGpa.stage !== "off" && snapshotGpa.planTasks.length > 0) {
      setGpaComposerSelected(true);
      return;
    }
    const restored = (await window.codexh.restoreProjectGpaPlan(threadId)) as GpaState;
    if (selectedThreadIdRef.current !== threadId) {
      return;
    }
    setGpaState(restored);
    setGpaComposerSelected(true);
    await refreshSnapshot(threadId);
  }

  async function resumeGpaPlanExecution(threadId: string, plan: GpaPlanResumePreview) {
    const restored = (await window.codexh.restoreProjectGpaPlan(threadId)) as GpaState;
    if (selectedThreadIdRef.current !== threadId) {
      return;
    }
    setGpaState(restored);
    setGpaComposerSelected(true);
    await refreshSnapshot(threadId);
    if (selectedThreadIdRef.current !== threadId) {
      return;
    }
    if (plan.status === "in_progress" && plan.pendingCount > 0) {
      gpaPlanResumeAttemptRef.current.set(threadId, plan);
      await sendMessage(
        "[internal:gpa-resume] Continue the remaining incomplete GPA plan tasks from .codexh/gpa-plan.md. Do not restart GOAL/PLAN analysis. Execute the next unfinished task and keep updating completed_task_ids.",
        restored.stage === "act" ? "act" : undefined,
        {
          internal: true,
          displayContent: `继续执行剩余的 GPA 计划任务（还剩 ${plan.pendingCount} 项）`
        }
      );
    }
  }

  async function maybeHandleIncompleteGpaPlan(
    threadId: string,
    options?: { preferAutoSameSession?: boolean; forcePrompt?: boolean }
  ): Promise<boolean> {
    const plan = (await window.codexh.getProjectGpaPlan(threadId)) as GpaPlanResumePreview | null;
    if (!plan) {
      return false;
    }
    const [snapshotGpa, threadSnapshot] = await Promise.all([
      window.codexh.getGpaState(threadId) as Promise<GpaState>,
      window.codexh.getThreadSnapshot(threadId) as Promise<RuntimeThreadSnapshot>
    ]);
    const dismissKey = `${threadId}:${plan.updatedAt}`;
    if (!options?.forcePrompt && gpaPlanResumeDismissedRef.current.has(dismissKey)) {
      return false;
    }
    const failedWithPendingGpaPlan =
      threadSnapshot.thread.status === "failed" &&
      plan.status === "in_progress" &&
      plan.pendingCount > 0;
    if (gpaPlanResumeRetryRequiredRef.current.has(threadId) || failedWithPendingGpaPlan) {
      gpaPlanResumeRetryRequiredRef.current.add(threadId);
      setGpaPlanResumeDialog((current) => current?.threadId === threadId ? null : current);
      setGpaPlanResumeRetryPrompt({ threadId, plan });
      return true;
    }
    if (snapshotGpa.stage !== "off" && snapshotGpa.planTasks.length > 0) {
      setGpaComposerSelected(true);
      return false;
    }
    if (plan.sameSession && options?.preferAutoSameSession) {
      await resumeGpaPlanExecution(threadId, plan);
      showNotice("已继续未完成的 GPA 计划", {
        message: `剩余 ${plan.pendingCount} 项任务，已自动开启 GPA。`,
        tone: "success"
      });
      return true;
    }
    setGpaPlanResumeDialog({ step: "ask", plan, threadId });
    return true;
  }

  async function promptGpaPlanRetryAfterFailure(threadId: string): Promise<void> {
    try {
      const plan = (await window.codexh.getProjectGpaPlan(threadId)) as GpaPlanResumePreview | null;
      if (!plan || plan.status !== "in_progress" || plan.pendingCount === 0) {
        return;
      }
      gpaPlanResumeRetryRequiredRef.current.add(threadId);
      setGpaPlanResumeDialog((current) => current?.threadId === threadId ? null : current);
      setGpaPlanResumeRetryPrompt({ threadId, plan });
    } catch {
      // Failure recovery must never hide the original runtime error.
    }
  }

  async function refreshSkills() {
    const [nextSkills, nextStats] = await Promise.all([
      window.codexh.listSkills(selectedThread?.cwd) as Promise<SkillMetadata[]>,
      window.codexh.getSkillUsageStats() as Promise<SkillUsageStats[]>
    ]);
    setSkills(nextSkills);
    setSkillUsageStats(nextStats);
  }

  async function refreshUserSkills() {
    setUserSkills(await window.codexh.listUserSkills());
  }

  async function refreshPlugins() {
    setPlugins((await window.codexh.listPlugins()) as PluginRecord[]);
  }

  async function refreshConfig(preferredProviderId?: string | null) {
    try {
      const nextConfig = (await window.codexh.getConfig()) as AppConfig;
      setConfig(nextConfig);
      resetConfigDraft(nextConfig, preferredProviderId);
      try {
        setSavedDatabaseCredentialIds(new Set(await window.codexh.listDatabaseCredentialConnectionIds()));
      } catch {
        setSavedDatabaseCredentialIds(new Set());
      }
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
    activateNewThread(thread);
  }

  async function createThreadRecord(
    mode: "project" | "chat",
    cwdInput?: string,
    options?: { useComposerSelection?: boolean }
  ) {
    const title = mode === "project" ? "新建项目" : "新建任务";
    const cwd = mode === "project" && cwdInput?.trim() ? cwdInput.trim() : undefined;
    const selection = config
      ? options?.useComposerSelection
        ? resolveSelectionFromConfig(config, composerProviderId, composerModelId)
        : resolveSelectionFromConfig(config)
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
    activateNewThread(thread);
    void maybeHandleIncompleteGpaPlan(thread.id, { preferAutoSameSession: false }).catch((error) => {
      showNotice("检查 GPA 计划失败", { message: error instanceof Error ? error.message : String(error) });
    });
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

  function removePendingResumeThread(threadId: string) {
    setPendingResumeThreads((current) => current.filter((entry) => entry.threadId !== threadId));
  }

  async function handleResumePendingThread(threadId: string) {
    removePendingResumeThread(threadId);
    try {
      await window.codexh.resumePendingResume(threadId);
    } catch (error) {
      showNotice("恢复任务失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleDismissPendingThread(threadId: string) {
    removePendingResumeThread(threadId);
    try {
      await window.codexh.dismissPendingResume(threadId);
    } catch {
      // The card is already hidden locally; marker cleanup is best-effort.
    }
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

    setHistoryThreadDeleteConfirmation(thread);
  }

  async function confirmDeleteHistoryThread() {
    const thread = historyThreadDeleteConfirmation;
    if (!thread || deletingThreadId) {
      return;
    }

    setDeletingThreadId(thread.id);
    try {
      const isSelectedThread = selectedThreadIdRef.current === thread.id;
      await window.codexh.deleteThread(thread.id);
      snapshotCacheByThreadRef.current.delete(thread.id);
      delete snapshotCursorByThreadRef.current[thread.id];
      delete latestRuntimeThreadsRef.current[thread.id];
      delete persistedRuntimeMessagesRef.current[thread.id];
      setHistoryThreadDeleteConfirmation(null);
      if (isSelectedThread) {
        selectThreadId(null);
        setSnapshot(null);
        await refreshThreads({ fallbackToFirst: false });
      } else {
        await refreshThreads();
      }
      showNotice("任务已删除。", { tone: "success" });
    } catch (error) {
      showNotice("暂时无法删除任务。", {
        message: getThreadDeleteFailureMessage(error)
      });
    } finally {
      setDeletingThreadId((current) => (current === thread.id ? null : current));
    }
  }

  function requestClearCurrentChat() {
    if (!selectedThreadId) {
      return;
    }
    if (isThreadExecutionInProgress(selectedThreadStatus)) {
      showNotice("任务正在执行，请先停止任务再清空聊天记录。");
      return;
    }
    setIsClearChatConfirmOpen(true);
  }

  async function confirmClearCurrentChat() {
    const threadId = selectedThreadId;
    if (!threadId || isClearingChat) {
      return;
    }

    setIsClearingChat(true);
    try {
      await window.codexh.clearThreadConversation(threadId);
      delete pendingUserMessagesRef.current[threadId];
      delete snapshotCursorByThreadRef.current[threadId];
      delete latestRuntimeThreadsRef.current[threadId];
      delete persistedRuntimeMessagesRef.current[threadId];
      snapshotCacheByThreadRef.current.delete(threadId);
      delete suppressRuntimeProgressRef.current[threadId];
      discardQueuedAssistantDraftsForThread(threadId);
      gpaSameSessionAutoResumeRef.current.delete(threadId);
      gpaPlanResumeDismissedRef.current.delete(threadId);
      gpaPlanResumeAttemptRef.current.delete(threadId);
      gpaPlanResumeRetryRequiredRef.current.delete(threadId);
      setAssistantDrafts((current) =>
        Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.threadId !== threadId))
      );
      setRuntimeActivities((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      setCompletedTurnTimers((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      clearTerminalThread(threadId);
      setBrowserTabsByThread((current) => ({ ...current, [threadId]: [] }));
      setActiveToolCall((current) => current?.threadId === threadId ? null : current);
      setRuntimeProgress((current) => current?.threadId === threadId ? null : current);
      setComposerSubmission(null);
      setEditingUserMessage(null);
      setGpaPlanResumeRetryPrompt(null);
      setIsTerminalOpen(false);
      setIsClearChatConfirmOpen(false);
      setThreadTokenUsage({ turn: createEmptyTokenUsage(), thread: createEmptyTokenUsage(), turnRunId: null });
      await refreshThreads();
      showNotice("聊天记录已清空。", { tone: "success" });
      window.setTimeout(() => composerRef.current?.focus(), 0);
    } catch (error) {
      showNotice("暂时无法清空聊天记录。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    } finally {
      setIsClearingChat(false);
    }
  }

  async function sendMessage(
    forcedContent?: string,
    stageOverride?: GpaStage,
    options?: { internal?: boolean; displayContent?: string }
  ) {
    const inputContent = (forcedContent ?? input.trim()).trim();
    const submittedAttachments = forcedContent ? [] : [...composerAttachments];
    const submittedMediaIntent = forcedContent ? null : composerMediaIntent;
    const hasOneShotAttachment = submittedAttachments.some((attachment) => !isPersistentComposerContextKind(attachment.kind));
    if (!inputContent && (forcedContent || !hasOneShotAttachment)) {
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
      const hasMultimodalAttachment = submittedAttachments.some(
        (attachment) => attachment.kind === "file" || attachment.kind === "image"
      );
      if (hasMultimodalAttachment && !selectedComposerModel?.supportsMultimodalInput && !multimodalInputFallbackReady) {
        unsupportedMultimodalInput = true;
      }
    }

    if (!options?.internal) {
      setComposerSubmission({ content: inputContent, startedAt: new Date().toISOString() });
    }

    let threadId = selectedThreadId;
    if (!threadId) {
      const thread = await createThreadRecord("chat", undefined, { useComposerSelection: true });
      threadId = thread.id;
      selectThreadId(thread.id);
      seedOptimisticThreadSnapshot(thread);
      void refreshThreads();
      void refreshSnapshot(thread.id);
    }

    if (unsupportedMultimodalInput) {
      await window.codexh.rejectUnsupportedMultimodal({ threadId, content: inputContent });
      setComposerSubmission(null);
      setInput("");
      setComposerAttachments([]);
      setGpaComposerSelected(false);
      showNotice("此模型不支持多模态", {
        message: "已在对话中返回原因。请切换到支持多模态输入的模型，或在设置 → 多模态中配置默认多模态识别模型后再重试。"
      });
      await refreshThreads();
      await refreshSnapshot(threadId);
      return;
    }

    let realtimeInterruptedForSubmission = false;
    const shouldInterruptForRealtime = realtimeEnhancement.enabled &&
      !options?.internal &&
      threadId === (activeSnapshotThreadId ?? selectedThreadId) &&
      (isThreadExecutionInProgress(selectedThreadStatus) || realtimeEnhancement.controller.isActive);
    if (shouldInterruptForRealtime) {
      await realtimeEnhancement.interrupt();
      realtimeInterruptedForSubmission = true;
    }

    const displayContent = options?.displayContent
      ?? (options?.internal && (forcedContent ?? inputContent).trim().startsWith("[internal:")
        ? "继续"
        : forcedContent ?? inputContent);
    const queueingBehindActiveTask =
      !realtimeInterruptedForSubmission &&
      !interruptingThreadIdsRef.current.has(threadId) && (
        isThreadExecutionInProgress(selectedThreadStatus) ||
        isPreparingRuntime ||
        pendingRuntimeStartsRef.current.has(threadId)
      );
    let startedLocalRuntime = false;
    const optimisticMessage = !options?.internal && !queueingBehindActiveTask
      ? appendOptimisticUserMessage(threadId, displayContent)
      : null;
    // Start the under-message heartbeat immediately so send never looks like a
    // silent no-op while attachments/skills/runtime wake are still in flight.
    if (!options?.internal && !queueingBehindActiveTask) {
      suppressRuntimeProgressRef.current[threadId] = false;
      pendingRuntimeStartsRef.current.add(threadId);
      startRuntimeActivity(threadId);
      setRuntimeProgress({ threadId, phase: "preparing", runtimeObserved: false });
      startedLocalRuntime = true;
    } else if (!options?.internal) {
      setComposerSubmission(null);
    }

    // Release the composer as soon as the submission is accepted locally. All
    // remaining work uses the captured attachment list so it cannot delay UI feedback.
    if (!forcedContent) {
      setInput("");
      setComposerAttachments([]);
      setComposerMediaIntent(null);
    }

    try {
      const stage = stageOverride ?? gpaState.stage;
      if (stage !== "off") {
        const targetThread = threads.find((thread) => thread.id === threadId) ?? selectedThread;
        if (targetThread?.mode !== "project") {
          showNotice("GPA 仅支持项目模式", {
            message: "当前不是项目对话，已按普通聊天发送；请新建项目后再开启 GPA。"
          });
          setGpaComposerSelected(false);
          if (gpaState.stage !== "off") {
            setGpaState((prev) => ({ ...prev, stage: "off", awaitingConfirmation: null, planTasks: [] }));
          }
        } else {
          await window.codexh.setGpaStage({ threadId, stage });
        }
      }
    } catch (error) {
      if (optimisticMessage) removeOptimisticUserMessage(threadId, optimisticMessage.id);
      setComposerSubmission(null);
      if (!forcedContent) {
        setInput((current) => current.trim() ? current : inputContent);
        setComposerAttachments((current) => current.length > 0 ? current : submittedAttachments);
        setComposerMediaIntent((current) => current ?? submittedMediaIntent);
      }
      if (startedLocalRuntime) {
        pendingRuntimeStartsRef.current.delete(threadId);
        clearRuntimeActivity(threadId);
        setRuntimeProgress((current) => current?.threadId === threadId ? null : current);
      }
      showNotice("GPA 配置失败", { message: error instanceof Error ? error.message : String(error) });
      return;
    }

    let importedAttachments: MessageAttachment[] = [];
    try {
      if (!forcedContent) {
        const skillIds = submittedAttachments
          .filter((attachment): attachment is Extract<ComposerAttachment, { kind: "skill" }> => attachment.kind === "skill")
          .map((attachment) => attachment.skillId);
        for (const skillId of new Set(skillIds)) {
          await window.codexh.addThreadSkill({ threadId, skillId });
        }
        importedAttachments = await importComposerAttachments(threadId, submittedAttachments);
      }
    } catch (error) {
      if (optimisticMessage) removeOptimisticUserMessage(threadId, optimisticMessage.id);
      setComposerSubmission(null);
      setInput((current) => current.trim() ? current : inputContent);
      setComposerAttachments((current) => current.length > 0 ? current : submittedAttachments);
      if (startedLocalRuntime) {
        pendingRuntimeStartsRef.current.delete(threadId);
        clearRuntimeActivity(threadId);
        setRuntimeProgress((current) => current?.threadId === threadId ? null : current);
      }
      showNotice("添加附件失败", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const oneShotSkillIds = !forcedContent
      ? [...new Set(
          submittedAttachments
            .filter((attachment): attachment is Extract<ComposerAttachment, { kind: "skill" }> => attachment.kind === "skill")
            .map((attachment) => attachment.skillId)
        )]
      : [];
    const raw = (forcedContent ?? [inputContent, formatComposerAttachments(submittedAttachments.filter((attachment) => attachment.kind !== "file" && attachment.kind !== "image"))]
      .filter(Boolean).join("\n\n")).trim();
    if (optimisticMessage) {
      updateOptimisticUserMessageAttachments(threadId, optimisticMessage.id, importedAttachments);
    }
    if (!options?.internal) {
      setComposerSubmission(null);
    }
    let realtimeSubmissionStarted = false;
    try {
      if (realtimeEnhancement.enabled) {
        await realtimeEnhancement.submitText(inputContent, threadId);
        realtimeSubmissionStarted = true;
      }
      await window.codexh.sendMessage({ threadId, content: raw, displayContent, attachments: importedAttachments, mediaIntent: submittedMediaIntent });
    } catch (error) {
      if (realtimeSubmissionStarted) realtimeEnhancement.reset();
      if (optimisticMessage) {
        removeOptimisticUserMessage(threadId, optimisticMessage.id);
      }
      setComposerSubmission(null);
      if (!forcedContent) {
        setInput((current) => current.trim() ? current : inputContent);
        setComposerAttachments((current) => current.length > 0 ? current : submittedAttachments);
        setComposerMediaIntent((current) => current ?? submittedMediaIntent);
      }
      setRuntimeProgress((current) => current?.threadId === threadId ? null : current);
      pendingRuntimeStartsRef.current.delete(threadId);
      clearRuntimeActivity(threadId);
      showNotice("发送消息失败", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!forcedContent) {
      if (oneShotSkillIds.length > 0) {
        pendingOneShotSkillRemovalsRef.current[threadId] = [
          ...new Set([
            ...(pendingOneShotSkillRemovalsRef.current[threadId] ?? []),
            ...oneShotSkillIds
          ])
        ];
      }
    }
    clearAutoScrollReleaseTimer();
    shouldAutoScrollRef.current = true;
    window.setTimeout(() => {
      void refreshSnapshot(threadId);
    }, 120);
  }

  async function copyUserMessage(content: string) {
    try {
      const copied = await copyTextToClipboard(content);
      if (!copied) throw new Error("剪贴板未接受复制内容。");
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
    const editingMessage = editingUserMessage;
    const content = editingMessage?.content.trim();
    if (!editingMessage || !content) {
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

    const threadId = selectedThreadId;
    const messageId = editingMessage.id;
    if (!threadId) return;

    const previousSnapshot = snapshot?.thread.id === threadId ? snapshot : null;
    const previousPendingMessages = pendingUserMessagesRef.current[threadId];
    const previousRuntimeThread = latestRuntimeThreadsRef.current[threadId];
    const previousRuntimeMessages = persistedRuntimeMessagesRef.current[threadId];
    const originalMessage = previousSnapshot?.messages.find((message) => message.id === messageId);
    const attachments = originalMessage ? getMessageAttachments(originalMessage) : [];

    // Match normal sending: provide the new message and a visible execution
    // state before the main process finishes truncating a potentially long
    // conversation history.
    setEditingUserMessage(null);
    delete snapshotCursorByThreadRef.current[threadId];
    snapshotCacheByThreadRef.current.delete(threadId);
    delete latestRuntimeThreadsRef.current[threadId];
    delete persistedRuntimeMessagesRef.current[threadId];
    const optimisticMessage = replaceConversationTailWithOptimisticUserMessage(
      threadId,
      messageId,
      content,
      attachments
    );
    suppressRuntimeProgressRef.current[threadId] = false;
    startRuntimeActivity(threadId);
    setRuntimeProgress({ threadId, phase: "preparing", runtimeObserved: false });
    try {
      await window.codexh.replaceMessage({ threadId, messageId, content });
      clearAutoScrollReleaseTimer();
      shouldAutoScrollRef.current = true;
      window.setTimeout(() => {
        void refreshSnapshot(threadId);
      }, 120);
    } catch (error) {
      removeOptimisticUserMessage(threadId, optimisticMessage.id);
      if (previousPendingMessages?.length) {
        pendingUserMessagesRef.current[threadId] = previousPendingMessages;
      } else {
        delete pendingUserMessagesRef.current[threadId];
      }
      if (previousRuntimeMessages) {
        persistedRuntimeMessagesRef.current[threadId] = previousRuntimeMessages;
      }
      if (previousRuntimeThread) {
        latestRuntimeThreadsRef.current[threadId] = previousRuntimeThread;
      }
      setSnapshot((current) => current?.thread.id === threadId && previousSnapshot ? previousSnapshot : current);
      setRuntimeProgress((current) => current?.threadId === threadId ? null : current);
      clearRuntimeActivity(threadId);
      setEditingUserMessage((current) => current ?? editingMessage);
      void refreshSnapshot(threadId);
      showNotice("更新消息失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    }
  }

  async function handleGpaStageSelect(stage: GpaStage) {
    if (stage !== "off" && selectedThread?.mode !== "project") {
      showNotice("GPA 仅支持项目模式", {
        message: "请先新建或打开一个项目对话，再开启 Goal-Plan-Act 工作流。"
      });
      return;
    }
    setGpaState((prev) => ({ ...prev, stage, awaitingConfirmation: null }));
    setGpaComposerSelected(stage !== "off");
    setGpaMenuOpen(false);
    setGpaMenuPos(null);
    const threadId = selectedThreadId;
    if (stage !== "off" && multiAgentMode !== "proactive") {
      await updateMultiAgentMode("proactive");
    }
    if (threadId) {
      await window.codexh.setGpaStage({ threadId, stage });
    }
  }

  async function confirmGpaStage() {
    const stage = gpaState.awaitingConfirmation;
    if ((stage !== "goal" && stage !== "plan") || gpaConfirmationPendingStageRef.current) return;

    // The message is queued asynchronously; hide the card before another click can enqueue a duplicate confirmation.
    gpaConfirmationPendingStageRef.current = stage;
    setGpaConfirmationSubmitting(true);
    setGpaState((current) => current.awaitingConfirmation === stage
      ? { ...current, awaitingConfirmation: null }
      : current
    );

    await sendMessage(
      stage === "goal"
        ? "[internal:gpa-confirm] Continue with the confirmed goal. Produce the PLAN task list and acceptance criteria."
        : "[internal:gpa-confirm] The plan is confirmed. Enter ACT and implement the planned tasks.",
      undefined,
      {
        internal: true,
        displayContent: stage === "goal" ? "已确认目标，开始制定计划" : "已确认计划，开始执行"
      }
    );
  }

  function openGpaRevision() {
    setGpaRevisionOpen(true);
    window.requestAnimationFrame(() => gpaRevisionRef.current?.focus());
  }

  async function cancelGpaRevision() {
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

    interruptingThreadIdsRef.current.add(threadId);
    // Block late tool/retry/delta events from flipping the UI back to "执行中".
    suppressRuntimeProgressRef.current[threadId] = true;
    discardQueuedAssistantDraftsForThread(threadId);

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
        ? {
            ...current,
            thread: { ...current.thread, status: "idle", updatedAt },
            toolCalls: current.toolCalls.map((toolCall) =>
              toolCall.status === "pending" || toolCall.status === "running"
                ? { ...toolCall, status: "failed", completedAt: updatedAt }
                : toolCall
            )
          }
        : current
    );
    setRuntimeProgress((current) => current?.threadId === threadId ? null : current);
    setActiveToolCall((current) => current?.threadId === threadId ? null : current);
    setAssistantDrafts((current) => {
      const next = { ...current };
      for (const [draftId, draft] of Object.entries(next)) {
        if (draft.threadId === threadId) {
          delete next[draftId];
        }
      }
      return next;
    });
    clearRuntimeActivity(threadId);

    try {
      await window.codexh.interruptThread(threadId);
    } catch (error) {
      showNotice("停止任务失败。", {
        message: error instanceof Error ? error.message : "请稍后重试。"
      });
    } finally {
      // Interrupt completion can race an in-flight delta snapshot. Reset every
      // incremental source so persisted messages are restored authoritatively.
      invalidateThreadSnapshotForFullRefresh(threadId, {
        cursorByThread: snapshotCursorByThreadRef.current,
        requestIdsByThread: snapshotRequestIdsRef.current,
        cacheByThread: snapshotCacheByThreadRef.current,
        runtimeMessagesByThread: persistedRuntimeMessagesRef.current
      }, { preserveRuntimeMessages: true });
      try {
        await refreshThreads({ refreshSelectedSnapshot: false });
        await refreshSnapshot(threadId);
      } finally {
        interruptingThreadIdsRef.current.delete(threadId);
      }
    }
  }

  async function enableGpaMode() {
    if (selectedThread?.mode !== "project") {
      showNotice("GPA 仅支持项目模式", {
        message: "请先新建或打开一个项目对话，再开启 Goal-Plan-Act 工作流。"
      });
      setGpaMenuOpen(false);
      setGpaMenuPos(null);
      return;
    }
    setGpaMenuOpen(false);
    setGpaMenuPos(null);
    if (multiAgentMode !== "proactive") {
      await updateMultiAgentMode("proactive");
    }
    if (selectedThreadId) {
      try {
          const handled = await maybeHandleIncompleteGpaPlan(selectedThreadId, {
            // Enabling GPA is an explicit decision point. Even plans from this
            // session require confirmation before execution resumes.
            preferAutoSameSession: false,
            forcePrompt: true
          });
        if (handled) {
          return;
        }
      } catch (error) {
        showNotice("检查 GPA 计划失败", {
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }
    }
    if (gpaState.stage !== "off") {
      setGpaComposerSelected(true);
      showNotice("GPA 已开启", {
        message: `当前处于${gpaModeLabel(gpaState.stage)}阶段。`,
        tone: "success"
      });
      return;
    }
    await handleGpaStageSelect("goal");
  }

  async function dismissGpaPlanResumeDialog(options?: { abandon?: boolean }) {
    const dialog = gpaPlanResumeDialog;
    if (!dialog) {
      setGpaPlanResumeDialog(null);
      return;
    }
    const shouldAbandon = options?.abandon ?? dialog.step === "ask";
    if (shouldAbandon) {
      try {
        await window.codexh.abandonProjectGpaPlan(dialog.threadId);
        showNotice("已废弃未完成的 GPA 计划", {
          message: "下次打开此项目时不会再询问。需要时可重新开启 GPA 生成新计划。",
          tone: "success"
        });
      } catch (error) {
        showNotice("废弃计划失败", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    setGpaPlanResumeDialog(null);
  }

  async function acceptGpaPlanResumeAsk() {
    setGpaPlanResumeDialog((current) => current ? { ...current, step: "review" } : null);
  }

  async function confirmGpaPlanResumeExecution() {
    if (!gpaPlanResumeDialog) {
      return;
    }
    const { threadId, plan } = gpaPlanResumeDialog;
    setGpaPlanResumeBusy(true);
    try {
      gpaSameSessionAutoResumeRef.current.add(threadId);
      setGpaPlanResumeDialog(null);
      await resumeGpaPlanExecution(threadId, plan);
      showNotice("已继续未完成的 GPA 计划", {
        message: `剩余 ${plan.pendingCount} 项，开始执行。`,
        tone: "success"
      });
    } catch (error) {
      showNotice("继续 GPA 计划失败", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setGpaPlanResumeBusy(false);
    }
  }

  async function confirmGpaPlanResumeRetry() {
    const prompt = gpaPlanResumeRetryPrompt;
    if (!prompt) {
      return;
    }
    setGpaPlanResumeBusy(true);
    try {
      gpaPlanResumeRetryRequiredRef.current.delete(prompt.threadId);
      setGpaPlanResumeRetryPrompt(null);
      await resumeGpaPlanExecution(prompt.threadId, prompt.plan);
      showNotice("已继续未完成的 GPA 计划", {
        message: `剩余 ${prompt.plan.pendingCount} 项，开始执行。`,
        tone: "success"
      });
    } catch (error) {
      gpaPlanResumeRetryRequiredRef.current.add(prompt.threadId);
      setGpaPlanResumeRetryPrompt(prompt);
      showNotice("继续 GPA 计划失败", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setGpaPlanResumeBusy(false);
    }
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

  async function guideActiveTask(content: string) {
    const threadId = selectedThreadId;
    if (!threadId) return;
    try {
      const result = await window.codexh.guideActiveThread({ threadId, content });
      if (result.accepted) {
        showNotice("已引导当前任务", {
          tone: "success",
          message: "引导指令会在下一次模型决策前生效。"
        });
      } else {
        showNotice("当前任务已结束", {
          message: "该消息已按普通消息加入队列。"
        });
        await refreshSnapshot(threadId);
      }
    } catch (error) {
      showNotice("发送引导失败", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function guideQueuedMessage(message: QueuedMessageRecord) {
    const threadId = selectedThreadId;
    if (!threadId) return;
    setDeletingQueuedMessageId(message.id);
    let removedFromQueue = false;
    try {
      // Remove the queued copy first so the instruction cannot run twice.
      await window.codexh.deleteQueuedMessage({ threadId, id: message.id });
      removedFromQueue = true;
      const result = await window.codexh.guideActiveThread({ threadId, content: message.content });
      if (result.accepted) {
        showNotice("已引导当前任务", {
          tone: "success",
          message: "该排队消息已作为引导指令生效。"
        });
      } else {
        showNotice("当前任务已结束", {
          message: "该消息已按普通消息加入队列。"
        });
      }
      await refreshSnapshot(threadId);
    } catch (error) {
      if (removedFromQueue) {
        try {
          await window.codexh.sendMessage({
            threadId,
            content: message.content,
            displayContent: message.displayContent,
            attachments: message.attachments
          });
          await refreshSnapshot(threadId);
        } catch {
          // Keep the original error: the primary action is what the user needs to retry.
        }
      }
      showNotice("引导排队消息失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeletingQueuedMessageId((current) => current === message.id ? null : current);
    }
  }

  async function answerPendingPrompt(prompt: UserInputPrompt, answers: Record<string, string>) {
    setResolvingPromptId(prompt.id);
    setSnapshot((current) => {
      if (!current || !current.prompts.some((item) => item.id === prompt.id)) {
        return current;
      }
      return {
        ...current,
        thread: current.thread.id === prompt.threadId
          ? { ...current.thread, status: "running" }
          : current.thread,
        prompts: current.prompts.map((item) =>
          item.id === prompt.id
            ? {
                ...item,
                status: "answered" as const,
                answers,
                answeredAt: new Date().toISOString()
              }
            : item
        )
      };
    });
    try {
      await window.codexh.answerPrompt(prompt.id, answers);
      await refreshSnapshot(activeSnapshotThreadId ?? selectedThreadId);
    } catch (error) {
      await refreshSnapshot(activeSnapshotThreadId ?? selectedThreadId);
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

  function beginRenameHistoryThread(thread: ThreadRecord) {
    skipHistoryRenameCommitRef.current = false;
    setRenamingHistoryThread({ id: thread.id, title: thread.title });
  }

  function cancelRenameHistoryThread() {
    skipHistoryRenameCommitRef.current = true;
    setRenamingHistoryThread(null);
  }

  async function commitRenameHistoryThread(nextTitleInput?: string) {
    if (skipHistoryRenameCommitRef.current) {
      skipHistoryRenameCommitRef.current = false;
      return;
    }
    if (!renamingHistoryThread) return;
    const threadId = renamingHistoryThread.id;
    const nextTitle = (nextTitleInput ?? renamingHistoryThread.title).trim();
    const current = threads.find((thread) => thread.id === threadId);
    setRenamingHistoryThread(null);
    if (!current || !nextTitle || nextTitle === current.title) {
      return;
    }
    try {
      await window.codexh.renameThread({ threadId, title: nextTitle });
      await refreshThreads();
      showNotice("任务已重命名。", { tone: "success" });
    } catch (error) {
      showNotice("重命名失败。", {
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

  async function confirmManagedRemoval() {
    const target = managedRemoval;
    if (!target || removingManagedItem) return;
    setRemovingManagedItem(true);
    try {
      if (target.kind === "plugin") {
        await window.codexh.removePlugin(target.plugin.id);
        await Promise.all([refreshPlugins(), refreshSkills(), refreshThreads()]);
      } else {
        await window.codexh.removeSkill(target.skill.id);
        await Promise.all([refreshSkills(), refreshUserSkills()]);
      }
      setManagedRemoval(null);
      showNotice(target.kind === "plugin" ? "插件已移除" : "Skill 已移除", { tone: "success" });
    } catch (error) {
      showNotice("移除失败", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRemovingManagedItem(false);
    }
  }

  async function setLlmLogViewerEnabled(enabled: boolean) {
    if (!config) return;
    const previousConfig = config;
    const previousDraft = configDraft;
    const nextConfig = {
      ...config,
      desktop: {
        ...config.desktop,
        llmLogViewer: enabled,
        ...(enabled ? { liveEditPreview: false } : {})
      }
    };
    setConfig(nextConfig);
    setConfigDraft((current) => current ? {
      ...current,
      desktop: {
        ...current.desktop,
        llmLogViewer: enabled,
        ...(enabled ? { liveEditPreview: false } : {})
      }
    } : current);
    try {
      await window.codexh.setLlmLogViewerEnabled(enabled);
      if (enabled && selectedThreadId) {
        await window.codexh.openConversationLogWindow(selectedThreadId);
      }
    } catch (error) {
      setConfig(previousConfig);
      setConfigDraft(previousDraft);
      showNotice("对话日志设置失败。", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function saveConfigDraft(options?: { showSuccessNotice?: boolean }) {
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
    if (options?.showSuccessNotice !== false) {
      showNotice("配置已保存。", {
        message: "聊天区已同步最新的供应商和模型列表。",
        tone: "success"
      });
    }
    // Refresh in parallel, and skip the full conversation snapshot reload —
    // saving settings never changes message contents, and the snapshot reload
    // is the most expensive step for long conversations.
    await Promise.all([
      refreshConfig(preferredProviderId),
      refreshThreads({ refreshSelectedSnapshot: false }),
      refreshMcpServers()
    ]);
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

  function openComposerAddSubmenu(view: "skills" | "mcp" | "database" | "apiCards", target: HTMLElement) {
    clearComposerAddMenuCloseTimer();
    setComposerAddSubmenuAnchor(target);
    setComposerAddMenuView(view);
  }

  function removeComposerAttachment(id: string) {
    if (removingComposerAttachmentId) return;
    setRemovingComposerAttachmentId(id);
    window.setTimeout(() => {
      setComposerAttachments((current) => current.filter((attachment) => attachment.id !== id));
      setRemovingComposerAttachmentId((current) => current === id ? null : current);
    }, 140);
  }

  function applyPluginEnabledLocally(threadId: string, pluginId: string, enabled: boolean) {
    const updateIds = (ids: string[]) => enabled
      ? [...new Set([...ids, pluginId])]
      : ids.filter((id) => id !== pluginId);

    setThreads((current) => current.map((thread) =>
      thread.id === threadId && thread.mode !== "project"
        ? { ...thread, selectedPluginIds: updateIds(thread.selectedPluginIds) }
        : thread
    ));
    setSnapshot((current) => {
      if (!current || current.thread.id !== threadId) return current;
      if (current.thread.mode !== "project") {
        return { ...current, thread: { ...current.thread, selectedPluginIds: updateIds(current.thread.selectedPluginIds) } };
      }
      return {
        ...current,
        projectPlugins: current.projectPlugins.map((item) =>
          item.plugin.id === pluginId
            ? {
                ...item,
                binding: {
                  ...(item.binding ?? { projectId: current.thread.projectId ?? "", pluginId }),
                  enabled
                }
              }
            : item
        )
      };
    });
  }

  function setThreadPluginEnabled(pluginId: string, enabled: boolean) {
    const threadId = selectedThreadId;
    if (!threadId) return;
    const stateKey = `${threadId}:${pluginId}`;
    const previous = pluginEnabledStateRef.current.get(stateKey) ?? enabledPluginIds.has(pluginId);
    if (previous === enabled) return;

    pluginEnabledStateRef.current.set(stateKey, enabled);
    applyPluginEnabledLocally(threadId, pluginId, enabled);
    pluginToggleQueueRef.current = pluginToggleQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await window.codexh.setThreadPluginEnabled({ threadId, pluginId, enabled });
        } catch (error) {
          if (pluginEnabledStateRef.current.get(stateKey) !== enabled) return;
          pluginEnabledStateRef.current.set(stateKey, previous);
          applyPluginEnabledLocally(threadId, pluginId, previous);
          showNotice("更新插件状态失败", { message: error instanceof Error ? error.message : String(error) });
        }
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
    resetProviderDraft(nextConfig, preferredProviderId);
    resetMultimodalPicker();
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

  async function updateGlobalReasoningEffort(reasoningEffort: GptReasoningEffort) {
    if (!config || isUpdatingReasoningEffort) return;
    const previous = config.reasoningEffort;
    setIsUpdatingReasoningEffort(true);
    setConfig((current) => current ? { ...current, reasoningEffort } : current);
    setConfigDraft((current) => current ? { ...current, reasoningEffort } : current);
    try {
      await window.codexh.setGlobalReasoningEffort(reasoningEffort);
    } catch (error) {
      setConfig((current) => current ? { ...current, reasoningEffort: previous } : current);
      setConfigDraft((current) => current ? { ...current, reasoningEffort: previous } : current);
      showNotice("推理强度保存失败。", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setIsUpdatingReasoningEffort(false);
    }
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
      // Enter always submits the composer. While a task is running this
      // becomes a queued message; stopping work remains an explicit click.
      void sendMessage();
    }
  }

  /** 选中的收藏卡片作为真实用户消息发给模型,由模型回复中的 api-card 块渲染卡片,保留完整对话上下文 */
  async function sendApiCardFavoriteToChat(favorite: ApiCardFavorite) {
    const content = [
      `我要调用接口卡片「${favorite.name}」。请严格按照下面的配置,在回复中原样输出一个完整的 \`\`\`api-card 代码块(不要增删或修改任何字段),让我可以直接填写参数并调用:`,
      "",
      "```api-card",
      JSON.stringify(favorite.config, null, 2),
      "```"
    ].join("\n");
    await sendMessage(content, undefined, { displayContent: `调用接口卡片「${favorite.name}」` });
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

  async function runGitAction(action: () => Promise<GitActionResult>) {
    if (gitActionBusy) return;
    setGitActionBusy(true);
    setGitActionMessage(null);
    try {
      const result = await action();
      setGitSnapshot(result.snapshot);
      setGitActionMessage(result.message);
    } catch (error) {
      setGitActionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setGitActionBusy(false);
    }
  }

  useEffect(() => {
    if (isSettingsOpen && settingsTab === "usage") void refreshUsageStatistics();
  }, [isSettingsOpen, settingsTab, usageStatisticsRangeDays, usageStatisticsGranularity]);

  useEffect(() => {
    if (isSettingsOpen && settingsTab === "general") void refreshRuntimeLogStats();
  }, [isSettingsOpen, settingsTab]);

  useEffect(() => {
    if (!isSettingsOpen) {
      setSettingsContentReady(false);
      return;
    }
    let disposed = false;
    let secondFrame = 0;
    const showContent = () => {
      if (disposed) return;
      setSettingsContentReady(true);
    };
    // requestAnimationFrame is suspended for hidden or occluded Electron
    // windows. Keep a timer fallback so the settings body cannot remain a
    // permanent placeholder when the window is restored.
    const fallback = window.setTimeout(showContent, 150);
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        showContent();
      });
    });
    return () => {
      disposed = true;
      window.clearTimeout(fallback);
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [isSettingsOpen]);

  const historySearchPresence = useMotionPresence(isHistorySearchOpen ? true : null);
  const settingsPresence = useMotionPresence(isSettingsOpen ? true : null, 220);
  const projectCreatePresence = useMotionPresence(isProjectCreateOpen ? true : null);
  const mcpCreatePresence = useMotionPresence(isMcpCreateOpen && mcpCreateDraft ? mcpCreateDraft : null);
  const visibleMcpCreateDraft = mcpCreateDraft ?? mcpCreatePresence.value;
  const gpaPlanResumePresence = useMotionPresence(gpaPlanResumeDialog);
  const visibleGpaPlanResumeDialog = gpaPlanResumeDialog ?? gpaPlanResumePresence.value;
  const updateConfirmPresence = useMotionPresence(updateConfirmDialog);
  const visibleUpdateConfirmDialog = updateConfirmDialog ?? updateConfirmPresence.value;
  const historyThreadDeleteConfirmPresence = useMotionPresence(historyThreadDeleteConfirmation);
  const visibleHistoryThreadDeleteConfirmation = historyThreadDeleteConfirmation ?? historyThreadDeleteConfirmPresence.value;
  const userSkillGenerationDialogPresence = useMotionPresence(userSkillGenerationDialog);
  const visibleUserSkillGenerationDialog = userSkillGenerationDialog ?? userSkillGenerationDialogPresence.value;
  const managedRemovalPresence = useMotionPresence(managedRemoval);
  const visibleManagedRemoval = managedRemoval ?? managedRemovalPresence.value;
  const clearChatConfirmPresence = useMotionPresence(isClearChatConfirmOpen ? true : null);
  const clearErrorSolutionsConfirmPresence = useMotionPresence(isClearErrorSolutionsConfirmOpen ? true : null);
  const clearSelfImprovementConfirmPresence = useMotionPresence(isClearSelfImprovementConfirmOpen ? true : null);
  const clearLogsConfirmPresence = useMotionPresence(isClearLogsConfirmOpen ? true : null);
  const fetchedModelsPresence = useMotionPresence(showFetchedModels ? true : null);
  const multimodalPickerPresence = useMotionPresence(multimodalPickerRole);
  const visibleMultimodalPickerRole = multimodalPickerRole ?? multimodalPickerPresence.value;
  const gpaMenuPresence = useMotionPresence(gpaMenuOpen && gpaMenuPos ? gpaMenuPos : null, 140);
  const visibleGpaMenuPos = gpaMenuPos ?? gpaMenuPresence.value;
  const skillsSortPresence = useMotionPresence(skillsSortOpen ? true : null, 140);
  const notificationCenterPresence = useMotionPresence(isNotificationCenterOpen ? true : null, 160);
  const tokenUsagePanelPresence = useMotionPresence(isTokenUsagePanelOpen ? true : null, 160);
  const terminalDrawerPresence = useMotionPresence(isTerminalOpen ? true : null, 220);
  const helpPresence = useMotionPresence(isHelpOpen ? true : null, 220);
  const quickNotesPresence = useMotionPresence(isQuickNotesOpen ? true : null, 220);
  const quickNoteListMenuPresence = useMotionPresence(quickNoteListMenu, 140);
  const visibleQuickNoteListMenu = quickNoteListMenu ?? quickNoteListMenuPresence.value;
  const quickNoteDeleteConfirmPresence = useMotionPresence(quickNoteDeleteConfirm, 180);
  const visibleQuickNoteDeleteConfirm = quickNoteDeleteConfirm ?? quickNoteDeleteConfirmPresence.value;
  const pendingInteractionsKey = pendingApprovals.length || pendingPrompts.length
    ? `${pendingApprovals.length}:${pendingPrompts.length}`
    : null;
  const pendingInteractionsPresence = useMotionPresence(pendingInteractionsKey, 180);
  const visiblePendingInteractionCounts = (pendingInteractionsKey ?? pendingInteractionsPresence.value)
    ?.split(":")
    .map(Number) ?? [0, 0];
  const visiblePendingApprovalCount = visiblePendingInteractionCounts[0] ?? 0;
  const visiblePendingPromptCount = visiblePendingInteractionCounts[1] ?? 0;
  const projectHistoryGroups = useMemo(() => {
    const groups = new Map<string, { cwd: string; threads: ThreadRecord[]; updatedAt: number }>();

    for (const thread of threads) {
      if (thread.mode !== "project" || !thread.cwd) continue;

      const key = normalizeHistoryGroupKey(thread.cwd);
      const updatedAt = Date.parse(thread.updatedAt);
      const existing = groups.get(key);
      if (existing) {
        existing.threads.push(thread);
        existing.updatedAt = Math.max(existing.updatedAt, Number.isFinite(updatedAt) ? updatedAt : 0);
      } else {
        groups.set(key, {
          cwd: thread.cwd,
          threads: [thread],
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
        });
      }
    }

    return [...groups.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }, [threads]);
  const standaloneHistoryThreads = useMemo(
    () => threads.filter((thread) => thread.mode !== "project" || !thread.cwd),
    [threads]
  );
  const recentProjectPaths = useMemo(
    () => projectHistoryGroups.slice(0, 6).map((group) => group.cwd),
    [projectHistoryGroups]
  );

  useEffect(() => {
    if (!selectedThreadId) return;
    const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
    if (!selectedThread || selectedThread.mode !== "project" || !selectedThread.cwd) return;

    const groupKey = normalizeHistoryGroupKey(selectedThread.cwd);
    setCollapsedHistoryGroups((current) => {
      if (!current.has(groupKey)) return current;
      const next = new Set(current);
      next.delete(groupKey);
      return next;
    });
  }, [selectedThreadId, threads]);

  function toggleNotificationCenter() {
    if (isNotificationCenterOpen) {
      setIsNotificationCenterOpen(false);
      setHighlightedNotificationTarget(null);
      return;
    }
    syncThreadNotificationsFromThreads(threadsRef.current);
    dispatchNotificationCenter({ type: "mark-all-read" });
    setNotificationNow(Date.now());
    setIsNotificationCenterOpen(true);
  }

  async function openNotificationItem(item: NotificationCenterItem) {
    setIsNotificationCenterOpen(false);
    setHighlightedNotificationTarget(null);
    if (item.source === "skill-lab") {
      if (config) resetConfigDraft(config);
      setSettingsTab("capabilities");
      setCapabilityTab("lab");
      setIsSettingsOpen(true);
      return;
    }

    setIsSettingsOpen(false);
    await openThread(item.targetId, { scrollToLatest: true });
    if (!item.anchorId) return;
    window.setTimeout(() => {
      const prefix = item.attentionKind === "approval" ? "approval-card" : "user-input-prompt";
      document.getElementById(`${prefix}-${item.anchorId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 180);
  }

  const openGeneratedFileLocationEvent = useStableEvent((filePath: string) => {
    void openGeneratedFileLocation(filePath);
  });
  const toggleConversationTurnCollapsedEvent = useStableEvent(toggleConversationTurnCollapsed);
  const createThreadEvent = useStableEvent(createThread);
  const openThreadEvent = useStableEvent(openThread);
  const openQuickNotesEvent = useStableEvent(openQuickNotes);
  const openHistorySearchEvent = useStableEvent(openHistorySearch);
  const openSettingsEvent = useStableEvent((tab: SettingsTab) => {
    if (config) resetConfigDraft(config);
    setSettingsTab(tab);
    setCapabilityTab("skills");
    setIsSettingsOpen(true);
  });
  const openHelpEvent = useStableEvent(() => setIsHelpOpen(true));
  const generateUserSkillEvent = useStableEvent(openUserSkillGenerationDialog);
  const toggleThreadPinnedEvent = useStableEvent(toggleThreadPinned);
  const requestDeleteHistoryThreadEvent = useStableEvent(requestDeleteHistoryThread);
  const beginRenameHistoryThreadEvent = useStableEvent(beginRenameHistoryThread);
  const commitRenameHistoryThreadEvent = useStableEvent(commitRenameHistoryThread);
  const cancelRenameHistoryThreadEvent = useStableEvent(cancelRenameHistoryThread);
  const hideRightWorkspaceEvent = useStableEvent(() => setIsRightWorkspaceOpen(false));
  const addComposerAttachmentEvent = useStableEvent(addComposerAttachment);
  const refreshGitEvent = useStableEvent(() => {
    if (!selectedThreadId || gitLoading) return;
    setGitRefreshRevision((current) => current + 1);
  });
  const runGitActionEvent = useStableEvent(runGitAction);
  const sendGitCommentEvent = useStableEvent((content: string) => { void sendMessage(content); });
  const selectProjectFileEvent = useStableEvent(selectProjectFile);
  const openProjectPreviewEvent = useStableEvent(openProjectPreview);
  const closeBrowserTabEvent = useStableEvent((threadId: string, tabId: string) => {
    void window.codexh.closeBrowserTab({ threadId, tabId });
  });

  const skillLabCurrentProgress = skillLabProgress[skillLabProgress.length - 1] ?? null;
  const skillLabCurrentIteration = skillLabCurrentProgress?.iteration ?? 0;
  const skillLabCompletedIterations = skillLabStatus === "completed"
    ? skillLabTotalIterations
    : skillLabProgress.filter((item) => item.iteration > 0 && item.state === "tested").length;
  const skillLabProgressPercent = skillLabTotalIterations > 0
    ? Math.round((skillLabCompletedIterations / skillLabTotalIterations) * 100)
    : 0;
  const skillLabElapsedLabel = `${String(Math.floor(skillLabElapsedSeconds / 60)).padStart(2, "0")}:${String(skillLabElapsedSeconds % 60).padStart(2, "0")}`;
  const skillLabLastCompletedActivity = [...skillLabActivityLog].reverse().find((activity) => activity.state === "tested") ?? null;
  const skillLabHeartbeatText = skillLabApproval
    ? "等待工具调用确认"
    : skillLabStatus === "clarifying"
      ? "等待你补充关键信息"
      : skillLabStatus === "running"
        ? skillLabElapsedSeconds >= 90
          ? "模型响应较慢，任务仍在运行"
          : skillLabElapsedSeconds >= 30
            ? "模型正在处理，任务未中断"
            : "模型正在工作"
        : skillLabStatus === "completed"
          ? "全部测试已完成"
          : skillLabStatus === "failed"
            ? "任务执行失败"
            : skillLabStatus === "cancelled"
              ? "任务已取消"
              : "等待开始";
  const skillLabCurrentPhase = skillLabStatus === "clarifying"
    ? "需要用户澄清"
    : skillLabCurrentProgress?.phase ?? (skillLabMode === "optimize" ? "准备优化 Skill" : "准备生成 Skill");
  const skillLabCurrentSummary = skillLabStatus === "clarifying"
    ? skillLabClarification?.summary ?? "正在整理需要确认的信息"
    : skillLabCurrentProgress?.summary ?? (skillLabMode === "optimize" ? "选择用户技能和迭代次数后开始" : "填写需求和迭代次数后开始");

  return (
    <div
      ref={appShellRef}
      className={`app-shell ${backgroundMode === "image" ? "has-app-background" : ""} ${backgroundMode === "dynamic" ? "has-realtime-character" : ""} ${isSidebarCollapsed ? "sidebar-collapsed" : ""} ${
        isRightWorkspaceOpen ? "right-workspace-open" : ""
      } ${isTerminalOpen ? "terminal-open" : ""}`}
      style={{
        "--sidebar-pane-width": `${sidebarWidth}px`,
        "--right-workspace-pane-width": `${rightWorkspaceWidth}px`,
        ...(backgroundMode === "image"
          ? getChatBackgroundSurfaceStyleVars(chatBackgroundSettings.surfaces)
          : {})
      } as React.CSSProperties}
    >
      {backgroundMode === "image" ? <AppBackgroundLayer images={chatBackgroundImages} activeIndex={activeChatBackgroundIndex} settings={chatBackgroundSettings} /> : null}
      {backgroundMode === "dynamic" ? <RealtimeBackgroundLayer scene={realtimeEnhancement.scene} /> : null}
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

      <HistorySidebar
        threads={threads}
        projectGroups={projectHistoryGroups}
        standaloneThreads={standaloneHistoryThreads}
        selectedThreadId={selectedThreadId}
        deletingThreadId={deletingThreadId}
        collapsedGroups={collapsedHistoryGroups}
        setCollapsedGroups={setCollapsedHistoryGroups}
        expandedGroups={expandedHistoryThreadGroups}
        setExpandedGroups={setExpandedHistoryThreadGroups}
        renamingThread={renamingHistoryThread}
        setRenamingThread={setRenamingHistoryThread}
        onCommitRename={commitRenameHistoryThreadEvent}
        onCancelRename={cancelRenameHistoryThreadEvent}
        onCreateThread={createThreadEvent}
        onOpenThread={openThreadEvent}
        onOpenQuickNotes={openQuickNotesEvent}
        onOpenSearch={openHistorySearchEvent}
        onOpenSettings={openSettingsEvent}
        updatePhase={updateState?.phase}
        updateReminder={getSidebarUpdateReminder(updateState?.phase)}
        onOpenHelp={openHelpEvent}
        isGeneratingUserSkill={isGeneratingUserSkill}
        onGenerateUserSkill={generateUserSkillEvent}
        onTogglePinned={toggleThreadPinnedEvent}
        onRequestDelete={requestDeleteHistoryThreadEvent}
        onBeginRename={beginRenameHistoryThreadEvent}
      />

      {historySearchPresence.value ? (
        <HistorySearchDialog
          motionPhase={historySearchPresence.phase}
          selectedThreadId={selectedThreadId}
          query={historySearchQuery}
          setQuery={setHistorySearchQuery}
          results={historySearchResults}
          loading={isHistorySearchLoading}
          onClose={() => setIsHistorySearchOpen(false)}
          onOpenThread={(threadId) => openThread(threadId, { scrollToLatest: true })}
          formatRelativeTime={formatRelativeTime}
        />
      ) : null}

      {!isSidebarCollapsed ? (
        <PanelResizeHandle
          pane="sidebar"
          active={resizingPane === "sidebar"}
          onPointerDown={() => setResizingPane("sidebar")}
        />
      ) : null}

      <main className="workspace">
        {backgroundMode === "dynamic" ? (
          <RealtimeCharacterLayer
            scene={realtimeEnhancement.scene}
            onTerminalVideoEnd={() => realtimeEnhancement.returnToIdle(realtimeEnhancement.scene.turnRunId)}
          />
        ) : null}
        <WorkspaceControls
          tokenUsage={threadTokenUsage.thread}
          tokenUsageOpen={isTokenUsagePanelOpen}
          tokenUsageMotionPhase={tokenUsagePanelPresence.value ? tokenUsagePanelPresence.phase : undefined}
          selectedThreadId={selectedThreadId}
          tokenUsageButtonRef={tokenUsageButtonRef}
          tokenUsagePanelRef={tokenUsagePanelRef}
          onToggleTokenUsage={() => setIsTokenUsagePanelOpen((current) => !current)}
          notifications={notificationCenterState.items}
          notificationNow={notificationNow}
          notificationOpen={isNotificationCenterOpen}
          notificationVisible={Boolean(notificationCenterPresence.value)}
          notificationMotionPhase={notificationCenterPresence.phase}
          highlightedNotificationTarget={highlightedNotificationTarget}
          notificationButtonRef={notificationButtonRef}
          notificationPanelRef={notificationCenterRef}
          onToggleNotifications={toggleNotificationCenter}
          onOpenNotification={openNotificationItem}
          onClearFinishedNotifications={() => dispatchNotificationCenter({ type: "clear-finished" })}
          onMarkNotificationsRead={() => dispatchNotificationCenter({ type: "mark-all-read" })}
          terminalOpen={isTerminalOpen}
          onToggleTerminal={() => setIsTerminalOpen((current) => !current)}
          rightWorkspaceOpen={isRightWorkspaceOpen}
          onOpenRightWorkspace={() => { setRightWorkspaceTab("files"); setRightWorkspaceExpandedTab("files"); setIsRightWorkspaceOpen(true); }}
        />
        {pendingInteractionsPresence.value ? (
          <div className="pending-strip" data-motion={pendingInteractionsPresence.phase}>
            {visiblePendingApprovalCount > 0 ? (
              <div className="pending-pill">
                <span className="pending-count">{visiblePendingApprovalCount}</span>
                <span>待审批</span>
              </div>
            ) : null}
            {visiblePendingPromptCount > 0 ? (
              <button
                type="button"
                className="pending-pill"
                onClick={() => document.getElementById(`user-input-prompt-${pendingPrompts[0]?.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              >
                <span className="pending-count">{visiblePendingPromptCount}</span>
                <span>需要选择</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <section className="chat-canvas">
          <div
            ref={chatScrollRef}
            className={`chat-scroll ${showWelcome ? "welcome-mode" : ""} ${isThreadSwitching ? "is-thread-switching" : ""}`}
            onScroll={handleTranscriptScroll}
          >
            {!showWelcome && !isThreadSwitchPlaceholderVisible ? (
              <div className="conversation-turn-rail-shell">
                <ConversationTurnRail turns={conversationTurns} />
              </div>
            ) : null}
            {isThreadSwitchPlaceholderVisible ? (
              <div className="thread-switch-placeholder" aria-busy="true" aria-label="加载聊天记录">
                <span className="thread-switch-placeholder-line short" />
                <span className="thread-switch-placeholder-line" />
                <span className="thread-switch-placeholder-line medium" />
              </div>
            ) : showWelcome ? (
              <ChatWelcome
                submission={composerSubmission}
                showDefaultHome={showDefaultHome}
                isProject={isProjectWelcome}
                defaultModelLabel={defaultHomeModelLabel}
                cards={welcomeCards}
                onCreateThread={createThread}
                onSelectPrompt={(prompt) => { setInput(prompt); window.setTimeout(() => composerRef.current?.focus(), 0); }}
              />
            ) : (
              <div key={activeSnapshotThreadId ?? selectedThreadId ?? "empty-thread"} ref={chatTranscriptRef} className="chat-transcript task-timeline motion-thread-content">
                <TimelineEntries
                  entries={timelineEntries}
                  turnByEntryId={timelineTurnByEntryId}
                  latestTurnId={latestConversationTurn?.id ?? null}
                  taskProcessing={isTaskProcessing}
                  collapsedTurnIds={collapsedTurnIds}
                  deferredRuntimeToolGroup={deferredRuntimeToolGroup}
                  skillNames={skillNames}
                  assistantLabel={activeAssistantLabel}
                  userMessageActions={transcriptUserMessageActions}
                  gpaPlanMessageId={gpaPlanMessageId}
                  finalizingAssistantMessageIds={finalizingAssistantMessageIds}
                  completedLatestTurnAt={completedTurnTimer?.completedAt ?? null}
                  scrollElementRef={chatScrollRef}
                  onOpenFolder={openGeneratedFileLocationEvent}
                  onToggleTurn={toggleConversationTurnCollapsedEvent}
                />
                {pendingApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    resolving={resolvingApprovalId === approval.id}
                    onResolve={(decision, mode) => void resolvePendingApproval(approval.id, decision, mode)}
                  />
                ))}
                {pendingPrompts.map((prompt) => (
                  <UserInputPromptCard
                    key={prompt.id}
                    prompt={prompt}
                    resolving={resolvingPromptId === prompt.id}
                    canAnswer={prompt.threadId === activeSnapshotThreadId
                      ? selectedThreadStatus === "waiting"
                      : prompt.status === "pending"}
                    onAnswer={(answers) => void answerPendingPrompt(prompt, answers)}
                  />
                ))}
                {(gpaState.awaitingConfirmation === "goal" || gpaState.awaitingConfirmation === "plan") && !gpaConfirmationSubmitting ? (
                  <GpaConfirmationCard
                    stage={gpaState.awaitingConfirmation}
                    disabled={gpaRevisionSubmitting || gpaConfirmationSubmitting}
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
                {gpaPlanResumeRetryPrompt?.threadId === selectedThreadId ? (
                  <GpaPlanResumeRetryConfirmationCard
                    pendingCount={gpaPlanResumeRetryPrompt.plan.pendingCount}
                    disabled={gpaPlanResumeBusy}
                    onDismiss={() => setGpaPlanResumeRetryPrompt(null)}
                    onConfirm={() => void confirmGpaPlanResumeRetry()}
                  />
                ) : null}
                {(completedDeferredRuntimeToolGroup || activeAssistantDraft || shouldRenderRuntimeTailPanel) ? (
                  <div className="runtime-tail">
                    {completedDeferredRuntimeToolGroup ? (
                      <ToolActivityGroup toolCalls={completedDeferredRuntimeToolGroup} skillNames={skillNames} />
                    ) : null}
                    {activeAssistantDraft ? (
                      <AssistantDraftMessage
                        key={`draft-${activeAssistantDraft.draftId}`}
                        assistantLabel={activeAssistantLabel}
                        content={activeDraftContent}
                        draftId={activeAssistantDraft.draftId}
                        phase={activeAssistantDraft.phase}
                        startedAt={activeAssistantDraft.startedAt}
                        completed={activeAssistantDraft.completed}
                      />
                    ) : null}
                    {shouldRenderRuntimeTailPanel ? (
                      <RuntimeActivityPanel
                        key={activeSnapshotThreadId ?? "runtime-activity"}
                        label={taskProcessingLabel}
                        entries={activeRuntimeActivity?.entries ?? []}
                        startedAt={activeRuntimeActivity?.startedAt ?? null}
                        phase={localRuntimeProgress?.phase ?? null}
                        skillNames={skillNames}
                        preferLabel={isWaitingForSubagents}
                        hideCurrentStatus={false}
                        activeSubagents={activeSubagents}
                        queuedSubagentIds={queuedSubagentIds}
                        runtimeActivities={runtimeActivities}
                        onInterruptSubagent={(agent) => {
                          if (!selectedThreadId) return;
                          void window.codexh.interruptAgent({ threadId: selectedThreadId, agent: agent.agentPath })
                            .then(() => refreshSnapshot(selectedThreadId));
                        }}
                      />
                    ) : null}
                  </div>
                ) : null}
                {showPendingResumeCard && pendingResumeThread ? (
                  <PendingResumeCard
                    pending={pendingResumeThread}
                    onResume={() => void handleResumePendingThread(pendingResumeThread.threadId)}
                    onDismiss={() => void handleDismissPendingThread(pendingResumeThread.threadId)}
                  />
                ) : null}
              </div>
            )}
            {!showWelcome && composerSubmission ? (
              <ComposerSubmissionStatus submission={composerSubmission} />
            ) : null}
          </div>

          <footer
            className={[
              "composer-shell",
              displayedQueuedMessages.length > 0 ? "has-queue" : ""
            ].filter(Boolean).join(" ")}
            style={(() => {
              const queueCount = displayedQueuedMessages.length;
              if (queueCount === 0) return undefined;
              const queueSpace = queueCount * 40;
              const floatSpace = 8 + queueSpace;
              return {
                "--queued-message-space": `${Math.max(48, floatSpace)}px`,
                "--queued-message-scroll-offset": `${Math.max(3, floatSpace - 5)}px`
              } as CSSProperties;
            })()}
          >
            {displayedQueuedMessages.length > 0 ? (
              <div
                className={`composer-float-stack ${selectedProjectCwd ? "has-project" : ""}`}
                aria-label="输入框上方浮层"
              >
                <QueuedMessageList
                  messages={displayedQueuedMessages}
                  hasProject={!!selectedProjectCwd}
                  deletingId={deletingQueuedMessageId}
                  onDelete={(id) => void deleteQueuedMessage(id)}
                  onSteer={(message) => void guideQueuedMessage(message)}
                />
              </div>
            ) : null}
            {!showWelcome && !isTranscriptAtLatest ? (
              <button
                type="button"
                className={`scroll-to-latest-button ${displayedQueuedMessages.length > 0 ? "with-queue" : ""}`}
                title="定位到最新消息"
                aria-label="定位到最新消息"
                onClick={() => scrollTranscriptToLatest("smooth")}
              >
                <IconChevronDown />
              </button>
            ) : null}
            {selectedProjectCwd || gpaState.stage !== "off" ? (
              <div className="composer-meta-row">
                {gpaState.stage !== "off" ? <PlanTimeline state={gpaState} isRunning={isThreadExecutionInProgress(selectedThreadStatus)} /> : null}
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
              </div>
            ) : null}
            <div className="chat-composer">
              {composerMediaIntent ? (
                <div className="composer-attachments" aria-label="当前生成模式">
                  <div
                    className={`composer-attachment-chip media-intent is-${composerMediaIntent}`}
                    title={composerMediaIntent === "image" ? "本次发送将使用默认图片模型生成图片" : "本次发送将使用默认视频模型生成视频"}
                  >
                    <span className="composer-attachment-icon" aria-hidden>{composerMediaIntent === "image" ? <IconImage /> : <IconVideo />}</span>
                    <span className="composer-attachment-copy"><strong><span>{composerMediaIntent === "image" ? "生成图片" : "生成视频"}</span></strong></span>
                    <button type="button" className="composer-attachment-remove" aria-label="取消生成模式" onClick={() => setComposerMediaIntent(null)}><IconClose /></button>
                  </div>
                </div>
              ) : null}
              <ComposerAttachments
                attachments={composerAttachments}
                removingAttachmentId={removingComposerAttachmentId}
                plugins={plugins}
                enabledPluginIds={enabledPluginIds}
                isProjectThread={selectedThread?.mode === "project"}
                onRemoveAttachment={removeComposerAttachment}
                onDisablePlugin={setThreadPluginEnabled}
              />
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
                placeholder={composerMediaIntent === "image" ? "描述要生成的图片…" : composerMediaIntent === "video" ? "描述要生成的视频…" : "随心输入"}
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
                  {multiAgentMode === "proactive" ? (
                    <span className={`composer-mode-chip composer-mode-chip-agent composer-mode-chip-agent-${multiAgentMode}`} title="子智能体">
                      <IconSkills />
                      <span>子智能体</span>
                      <button
                        className="composer-mode-chip-remove"
                        type="button"
                        title="移除子智能体委派"
                        aria-label="移除子智能体委派"
                        onClick={() => void updateMultiAgentMode("disabled")}
                      >
                        <IconClose />
                      </button>
                    </span>
                  ) : null}
                  {gpaComposerSelected && gpaState.stage !== "off" ? (
                    <span className={`composer-mode-chip composer-mode-chip-gpa composer-mode-chip-gpa-${gpaState.stage}`} title={`GPA 当前阶段：${gpaModeLabel(gpaState.stage)}`}>
                      <IconGpa />
                      <span>{gpaModeLabel(gpaState.stage)}</span>
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
                  <button
                    className="composer-icon-button composer-clear-chat-button"
                    type="button"
                    title={isThreadExecutionInProgress(selectedThreadStatus) ? "请先停止任务" : "清空本次聊天"}
                    aria-label="清空本次聊天"
                    disabled={!selectedThreadId || showWelcome || isClearingChat || isThreadExecutionInProgress(selectedThreadStatus)}
                    onClick={requestClearCurrentChat}
                  >
                    <IconEraser />
                  </button>
                  <ComposerModelPicker
                    triggerLabel={currentModelTriggerLabel}
                    providers={composerProviderOptions}
                    modelGroups={composerModelGroups}
                    selectedProviderId={composerProviderId}
                    selectedModelId={composerModelId}
                    onSelectModel={handleComposerModelChange}
                    disabled={composerProviders.length === 0}
                  />
                  {showReasoningEffortPicker ? (
                    <ReasoningEffortPicker
                      value={config?.reasoningEffort ?? "medium"}
                      onChange={(value) => void updateGlobalReasoningEffort(value)}
                      disabled={isUpdatingReasoningEffort || isActiveThreadExecuting || isPreparingRuntime}
                    />
                  ) : null}
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
        {terminalDrawerPresence.value ? (
          <section className="workspace-terminal-drawer" data-motion={terminalDrawerPresence.phase} aria-label="终端">
            <TerminalWorkspace
              tabs={currentTerminalTabs}
              activeSessionId={activeTerminalSessionId}
              shell={activeTerminalSession?.shell ?? "PowerShell"}
              cwd={activeTerminalSession?.cwd ?? ""}
              output={activeTerminalSession?.output ?? ""}
              input={activeTerminalInput}
              scrollRef={terminalScrollRef}
              onInputChange={setActiveTerminalInput}
              onSubmit={submitTerminalInput}
              onSelectTab={selectTerminalTab}
              onAddTab={addTerminalTab}
              onCloseTab={closeTerminalTab}
              hasThread={Boolean(selectedThreadId)}
            />
          </section>
        ) : null}
      </main>

      {isRightWorkspaceOpen ? (
        <PanelResizeHandle
          pane="right-workspace"
          active={resizingPane === "right-workspace"}
          onPointerDown={() => setResizingPane("right-workspace")}
        />
      ) : null}

      <RightWorkspacePanel
          hidden={!isRightWorkspaceOpen}
          activeTab={rightWorkspaceTab}
          onTabChange={setRightWorkspaceTab}
          expandedTab={rightWorkspaceExpandedTab}
          onExpandedTabChange={setRightWorkspaceExpandedTab}
          onHide={hideRightWorkspaceEvent}
          projectRoot={selectedThread?.cwd ?? ""}
          onAddAttachment={addComposerAttachmentEvent}
          projectFiles={projectFiles}
          projectFilesLoading={isProjectFilesLoading}
          gitSnapshot={gitSnapshot}
          gitLoading={gitLoading}
          gitActionBusy={gitActionBusy}
          gitActionMessage={gitActionMessage}
          onGitRefresh={refreshGitEvent}
          onGitAction={runGitActionEvent}
          onGitComment={sendGitCommentEvent}
          selectedProjectFile={selectedProjectFile}
          projectToolCalls={projectToolCalls}
          onSelectProjectFile={selectProjectFileEvent}
          onOpenProjectFile={openProjectPreviewEvent}
          browserTabsByThread={browserTabsByThread}
          onCloseBrowserTab={closeBrowserTabEvent}
          threadId={selectedThreadId}
        />

      {visibleFilePreviewPath ? (
        <FilePreviewDialog
          path={visibleFilePreviewPath}
          preview={projectFilePreview}
          motionPhase={filePreviewPresence.phase}
          onClose={closeProjectPreview}
          onAddAttachment={addComposerAttachment}
          onSave={saveProjectPreview}
        />
      ) : null}

      {settingsPresence.value ? (
        <SettingsDialog
          motionPhase={settingsPresence.phase}
          activeTab={settingsTab}
          closeIcon={<IconClose />}
          onClose={() => setIsSettingsOpen(false)}
          onTabChange={setSettingsTab}
        >
          {settingsContentReady ? <>
              {settingsTab === "usage" ? (
                <SettingsUsagePage summary={usageStatistics} providers={config?.providers ?? []} loading={isUsageStatisticsLoading} rangeDays={usageStatisticsRangeDays} granularity={usageStatisticsGranularity} onRangeChange={setUsageStatisticsRangeDays} onGranularityChange={setUsageStatisticsGranularity} onRefresh={() => void refreshUsageStatistics()} />
              ) : null}
              {settingsTab === "appearance" ? (
                <AppearanceSettingsPage
                  inputRef={chatBackgroundInputRef}
                  images={chatBackgroundImages}
                  activeImageIndex={activeChatBackgroundIndex}
                  imageUrl={chatBackgroundUrl}
                  settings={chatBackgroundSettings}
                  backgroundMode={backgroundMode}
                  isDragging={isChatBackgroundDragging}
                  onImportFiles={importChatBackgroundFiles}
                  onSelectImage={setActiveChatBackgroundIndex}
                  onMoveImage={moveChatBackgroundImage}
                  onRemoveImage={removeChatBackgroundImage}
                  onUpdateSettings={updateChatBackgroundSettings}
                  onBackgroundModeChange={setBackgroundMode}
                  onUpdateSurface={updateChatBackgroundSurface}
                  onBeginDrag={beginChatBackgroundDrag}
                  onMoveDrag={moveChatBackground}
                  onEndDrag={endChatBackgroundDrag}
                  onResetSurfaces={resetChatBackgroundSurfaces}
                  onClear={clearChatBackground}
                />
              ) : null}

              {settingsTab === "general" ? (
                <RuntimeOverviewPage
                  config={config}
                  configDraft={configDraft}
                  threadCount={threads.length}
                  skillCount={skills.length}
                  subagentDefaultModelValue={subagentDefaultModelValue}
                  subagentDefaultModelOptions={subagentDefaultModelOptions}
                  setConfigDraft={setConfigDraft}
                  onSave={saveConfigDraft}
                  onSetLlmLogViewerEnabled={(enabled) => void setLlmLogViewerEnabled(enabled)}
                />
              ) : null}

    {settingsTab === "provider" ? (
      <ProviderSettingsPage
        configDraft={configDraft} config={config} settingsProvider={settingsProvider} settingsProviderModels={settingsProviderModels}
        providerSecretDrafts={providerSecretDrafts} setProviderSecretDrafts={setProviderSecretDrafts} isFetchingModels={isFetchingModels}
        newModelId={newModelId} newModelDisplayName={newModelDisplayName} modelTestResults={modelTestResults} testingModelKey={testingModelKey}
        onSetProviderId={setSettingsProviderId} onSetNewModelId={setNewModelId} onSetNewModelDisplayName={setNewModelDisplayName}
        onAddCustomProvider={addCustomProvider} onRemoveProvider={removeProvider} onUpdateProvider={updateProviderDraft} onFetchModels={fetchAndShowProviderModels}
        onUpdateModel={updateModelDraft} onCheckModel={checkProviderModel} onRemoveModel={removeModel} onAddModel={addModelToProvider} onSave={saveConfigDraft}
        onRefresh={refreshConfig} onShowNotice={showNotice} formatLatency={formatLatency} formatTokensPerSecond={formatTokensPerSecond}
      />
    ) : null}

    {settingsTab === "multimodal" ? (
      <MultimodalSettingsPage
        configDraft={configDraft}
        setPickerRole={setMultimodalPickerRole}
        setPickerSelected={setMultimodalPickerSelected}
        setMultimodalEnabled={setMultimodalEnabled}
        setMultimodalDefault={setMultimodalDefault}
        setReasoningDefault={setReasoningDefault}
        removeFromMultimodalRole={removeFromMultimodalRole}
        clearMultimodalInputDefault={clearMultimodalInputDefault}
      />
    ) : null}

              {settingsTab === "general" && configDraft ? (
                <ResponseTonePage configDraft={configDraft} options={RESPONSE_TONE_OPTIONS} defaultTone={DEFAULT_RESPONSE_TONE} setConfigDraft={setConfigDraft} onSave={saveConfigDraft} />
              ) : null}

              {settingsTab === "update" ? (
                <SettingsUpdatePage updateState={updateState} onCheck={() => void checkForUpdates()} onDownload={() => void downloadAvailableUpdate()} onInstall={() => void installDownloadedUpdate()} formatPhase={formatUpdatePhase} formatDownloadSize={formatUpdateDownloadSize} />
              ) : null}

              {settingsTab === "knowledge" ? (
                <KnowledgePage
                  knowledgeSources={knowledgeSources}
                  knowledgeName={knowledgeName}
                  setKnowledgeName={setKnowledgeName}
                  knowledgeScope={knowledgeScope}
                  setKnowledgeScope={setKnowledgeScope}
                  canImportProjectKnowledge={canImportProjectKnowledge}
                  isKnowledgeUrlEditorOpen={isKnowledgeUrlEditorOpen}
                  setIsKnowledgeUrlEditorOpen={setIsKnowledgeUrlEditorOpen}
                  knowledgeUrlInput={knowledgeUrlInput}
                  setKnowledgeUrlInput={setKnowledgeUrlInput}
                  onAddUrls={addKnowledgeUrls}
                  onChooseSources={chooseKnowledgeSources}
                  onRemoveSource={removeKnowledgeSource}
                  getSourceKey={knowledgeSourceKey}
                  isKnowledgeImporting={isKnowledgeImporting}
                  onImport={importKnowledge}
                  snapshot={snapshot}
                  knowledgeBases={knowledgeBases}
                  knowledgeDocuments={knowledgeDocuments}
                  knowledgeBusyId={knowledgeBusyId}
                  onRefreshBases={refreshKnowledgeBases}
                  onToggleDocuments={toggleKnowledgeDocuments}
                  onRefreshBase={refreshKnowledgeBase}
                  onDeleteBase={deleteKnowledgeBase}
                  formatScope={formatKnowledgeScope}
                  formatStatus={formatKnowledgeStatus}
                  formatBytes={formatKnowledgeBytes}
                  formatRelativeTime={formatRelativeTime}
                />
              ) : null}

              {settingsTab === "apiFavorites" ? (
                <ApiFavoritesPage onInsert={(favorite) => {
                  setIsSettingsOpen(false);
                  void sendApiCardFavoriteToChat(favorite);
                }} />
              ) : null}
              {settingsTab === "memory" ? (
                <MemoryPage configDraft={configDraft} setConfigDraft={setConfigDraft} selfImprovementMemories={selfImprovementMemories} visibleSelfImprovementMemories={visibleSelfImprovementMemories} selfImprovementMemoryListRef={selfImprovementMemoryListRef} safeSelfImprovementMemoryPage={safeSelfImprovementMemoryPage} selfImprovementMemoryPageCount={selfImprovementMemoryPageCount} setSelfImprovementMemoryPage={setSelfImprovementMemoryPage} isRefreshingSelfImprovementMemories={isRefreshingSelfImprovementMemories} isClearingSelfImprovement={isClearingSelfImprovement} onRefreshMemories={refreshSelfImprovementNow} onOpenClearMemories={() => setIsClearSelfImprovementConfirmOpen(true)} onSaveConfig={saveConfigDraft} onDeleteMemory={deleteSelfImprovementMemory} errorSolutionModelFilter={errorSolutionModelFilter} setErrorSolutionModelFilter={setErrorSolutionModelFilter} setErrorSolutionPage={setErrorSolutionPage} onRefreshErrorSolutions={refreshErrorSolutions} errorSolutionModelOptions={errorSolutionModelOptions} errorSolutions={errorSolutions} visibleErrorSolutions={visibleErrorSolutions} errorSolutionListRef={errorSolutionListRef} safeErrorSolutionPage={safeErrorSolutionPage} errorSolutionPageCount={errorSolutionPageCount} isClearingErrorSolutions={isClearingErrorSolutions} errorSolutionBusyId={errorSolutionBusyId} expandedErrorSolutionIds={expandedErrorSolutionIds} resolveModelLabel={resolveErrorSolutionModelLabel} getRecallStatus={getErrorSolutionRecallStatus} formatRelativeTime={formatRelativeTime} onToggleExpanded={toggleErrorSolutionExpanded} onDeleteErrorSolution={deleteErrorSolution} onOpenClearErrorSolutions={() => setIsClearErrorSolutionsConfirmOpen(true)} />
              ) : null}
              {settingsTab === "capabilities" ? (
                <CapabilitiesPage activeTab={capabilityTab} skillsCount={skills.length} userSkillsCount={userSkills.length} pluginsCount={plugins.length} onTabChange={setCapabilityTab} />
              ) : null}
              {settingsTab === "capabilities" && capabilityTab === "skills" ? (
                <SkillsPage skillsSearchQuery={skillsSearchQuery} setSkillsSearchQuery={setSkillsSearchQuery} skillsSortMenuRef={skillsSortMenuRef} skillsSortOpen={skillsSortOpen} setSkillsSortOpen={setSkillsSortOpen} skillsSortMode={skillsSortMode} setSkillsSortMode={setSkillsSortMode} skillsSortPresence={skillsSortPresence} visibleSkills={visibleSkills} formatRelativeTime={formatRelativeTime} onRemove={(skill) => setManagedRemoval({ kind: "skill", skill })} />
              ) : null}

              {settingsTab === "database" ? (
                <DatabasePage configDraft={configDraft} savedCredentialIds={savedDatabaseCredentialIds} testingId={testingDatabaseConnectionId} savingCredentialId={savingDatabaseCredentialId} changingEnabledId={changingDatabaseEnabledId} editingId={editingDatabaseConnectionId} databaseCatalogs={databaseCatalogs} passwordDrafts={databasePasswordDrafts} permissions={DATABASE_PERMISSION_OPTIONS} setPasswordDrafts={setDatabasePasswordDrafts} setEditingId={setEditingDatabaseConnectionId} onAdd={addDatabaseConnection} onSetEnabled={setDatabaseConnectionEnabled} onUpdate={updateDatabaseDraft} onTest={testDatabaseConnection} onSave={saveDatabaseConnection} onRemove={removeDatabaseConnection} />
              ) : null}

              {settingsTab === "mcp" ? (
                <McpPage configDraft={configDraft} mcpRuntimeServers={mcpRuntimeServers} editingMcpServerId={editingMcpServerId} setEditingMcpServerId={setEditingMcpServerId} mcpTestResults={mcpTestResults} testingMcpServerId={testingMcpServerId} mcpAuthBusyId={mcpAuthBusyId} onAdd={addMcpServer} onUpdate={updateMcpServerDraft} onTest={testMcpServer} onRefreshTools={refreshMcpToolDirectory} onLogin={loginMcpServer} onLogout={logoutMcpServer} onRemove={removeMcpServer} onSave={saveConfigDraft} parseEnvironment={parseMcpEnvironment} />
              ) : null}
              {settingsTab === "capabilities" && capabilityTab === "plugins" ? (
                <PluginsPage {...{ plugins, pluginCallCounts, setManagedRemoval }} />
              ) : null}
              {settingsTab === "capabilities" && capabilityTab === "userSkills" ? (
                <UserSkillsPage {...{ userSkills, resolveSkillUsageStats, setManagedRemoval }} />
              ) : null}

              {settingsTab === "capabilities" && capabilityTab === "lab" ? (
                <SkillLabPage {...{ skillLabMode, setSkillLabMode, isSkillLabBusy, skillLabPrompt, setSkillLabPrompt, skillLabTargetSkillId, setSkillLabTargetSkillId, userSkills, skillLabName, setSkillLabName, skillLabModelSelection, setSkillLabModelSelection, skillLabModelOptions, skillLabIterations, setSkillLabIterations, cancelSkillLab, skillLabStatus, startSkillLab, skillLabError, skillLabClarification, setSkillLabClarification, submitSkillLabClarification, skillLabProgress, skillLabCurrentPhase, skillLabCurrentSummary, skillLabHeartbeatText, skillLabCompletedIterations, skillLabTotalIterations, skillLabElapsedLabel, skillLabCurrentIteration, skillLabLastCompletedActivity, skillLabResult, skillLabLastRunMode, skillLabApproval, resolveSkillLabApproval, skillLabProgressPercent }} />
              ) : null}
          </> : <div className="settings-content-placeholder" aria-hidden="true"><span /><span /><span /></div>}
                      </SettingsDialog>
      ) : null}

      {helpPresence.value ? <HelpSheet motionPhase={helpPresence.phase} onClose={() => setIsHelpOpen(false)} /> : null}

      {quickNotesPresence.value ? (
        <QuickNotesSheet
          motionPhase={quickNotesPresence.phase}
          notes={quickNotes}
          selectedId={selectedQuickNoteId}
          title={quickNoteTitle}
          content={quickNoteContent}
          saving={quickNoteSaving}
          status={quickNoteStatus}
          renamingId={renamingQuickNoteId}
          setRenamingId={setRenamingQuickNoteId}
          renameDraft={quickNoteRenameDraft}
          setRenameDraft={setQuickNoteRenameDraft}
          visibleMenu={visibleQuickNoteListMenu}
          menuMotionPhase={quickNoteListMenuPresence.phase}
          visibleDeleteConfirm={visibleQuickNoteDeleteConfirm}
          deleteMotionPhase={quickNoteDeleteConfirmPresence.phase}
          onClose={() => setIsQuickNotesOpen(false)}
          onCreate={createQuickNote}
          onSelect={selectQuickNote}
          onOpenMenu={setQuickNoteListMenu}
          onCloseMenu={() => setQuickNoteListMenu(null)}
          onRequestDelete={setQuickNoteDeleteConfirm}
          onCloseDeleteConfirm={() => setQuickNoteDeleteConfirm(null)}
          onRename={renameQuickNote}
          onContentChange={changeQuickNoteContent}
          onSave={saveQuickNote}
          onDelete={deleteQuickNote}
        />
      ) : null}

      {mcpCreatePresence.value && visibleMcpCreateDraft ? (
        <McpCreateSheet
          motionPhase={mcpCreatePresence.phase}
          draft={visibleMcpCreateDraft}
          mode={mcpCreateMode}
          jsonDraft={mcpJsonDraft}
          error={mcpCreateError ?? mcpJsonError}
          onClose={closeMcpCreateSheet}
          onConfirm={confirmMcpCreate}
          onModeChange={(mode) => {
            setMcpCreateMode(mode);
            setMcpCreateError(null);
            setMcpJsonError(null);
            if (mode === "json" && !mcpJsonDraft) {
              setMcpJsonDraft(JSON.stringify(serializeMcpJsonConfig([visibleMcpCreateDraft]), null, 2));
            }
          }}
          onDraftChange={setMcpCreateDraft}
          onJsonDraftChange={setMcpJsonDraft}
          onClearError={() => {
            setMcpCreateError(null);
            setMcpJsonError(null);
          }}
        />
      ) : null}

      {projectCreatePresence.value ? (
        <ProjectCreateSheet
          motionPhase={projectCreatePresence.phase}
          pathDraft={projectPathDraft}
          recentPaths={recentProjectPaths}
          isPickingFolder={isPickingProjectFolder}
          onClose={() => setIsProjectCreateOpen(false)}
          onChooseFolder={() => void chooseProjectFolder()}
          onPathChange={setProjectPathDraft}
          onConfirm={() => void confirmProjectCreate()}
        />
      ) : null}

      {visibleGpaPlanResumeDialog && gpaPlanResumeRetryPrompt?.threadId !== visibleGpaPlanResumeDialog.threadId ? (
        <GpaPlanResumeSheet
          motionPhase={gpaPlanResumePresence.phase}
          dialog={visibleGpaPlanResumeDialog}
          busy={gpaPlanResumeBusy}
          onDismiss={(options) => void dismissGpaPlanResumeDialog(options)}
          onReview={() => void acceptGpaPlanResumeAsk()}
          onConfirm={() => void confirmGpaPlanResumeExecution()}
        />
      ) : null}

      {clearLogsConfirmPresence.value ? (
        <ConfirmationSheet
          motionPhase={clearLogsConfirmPresence.phase}
          titleId="clear-logs-confirm-title"
          title="清理日志？"
          description={<>将删除约 {formatStorageBytes(runtimeLogStats?.bytes ?? 0)} 的应用运行日志并回收 SQLite WAL。此操作不会删除聊天、项目文件或知识库数据。</>}
          confirmLabel={isClearingLogs ? "正在清理..." : "确认清理"}
          busy={isClearingLogs}
          role="alertdialog"
          onClose={() => setIsClearLogsConfirmOpen(false)}
          onConfirm={() => void confirmClearRuntimeLogs()}
        />
      ) : null}

      {clearChatConfirmPresence.value ? (
        <ConfirmationSheet
          motionPhase={clearChatConfirmPresence.phase}
          titleId="clear-chat-confirm-title"
          title="清空本次聊天？"
          description="消息、执行记录和本次打开的网页都会被永久删除，且无法恢复。项目文件不会被删除。"
          confirmLabel={isClearingChat ? "正在清空..." : "确认清空"}
          busy={isClearingChat}
          onClose={() => setIsClearChatConfirmOpen(false)}
          onConfirm={() => void confirmClearCurrentChat()}
        />
      ) : null}

      {clearSelfImprovementConfirmPresence.value ? (
        <ConfirmationSheet
          motionPhase={clearSelfImprovementConfirmPresence.phase}
          titleId="clear-self-improvement-confirm-title"
          title="清空全部记忆？"
          description={`将删除全部 ${selfImprovementMemories.length} 条任务经验，且无法恢复。错误记忆、聊天、项目和知识库不会受到影响。`}
          confirmLabel={isClearingSelfImprovement ? "正在清空..." : "确认清空"}
          busy={isClearingSelfImprovement}
          role="alertdialog"
          onClose={() => setIsClearSelfImprovementConfirmOpen(false)}
          onConfirm={() => void confirmClearSelfImprovementMemories()}
        />
      ) : null}

      {clearErrorSolutionsConfirmPresence.value ? (
        <ConfirmationSheet
          motionPhase={clearErrorSolutionsConfirmPresence.phase}
          titleId="clear-error-solutions-confirm-title"
          title={errorSolutionModelFilter === "all" ? "清空全部错误记忆？" : "清空当前模型错误记忆？"}
          description={errorSolutionModelFilter === "all"
            ? `将删除全部 ${errorSolutions.length} 条错误记忆，且无法恢复。任务经验和其他数据不会受到影响。`
            : `将删除模型“${resolveErrorSolutionModelLabel(errorSolutionModelFilter)}”的 ${errorSolutions.length} 条记忆，其他模型的记忆会保留。`}
          confirmLabel={isClearingErrorSolutions ? "正在清空..." : "确认清空"}
          busy={isClearingErrorSolutions}
          onClose={() => setIsClearErrorSolutionsConfirmOpen(false)}
          onConfirm={() => void confirmClearErrorSolutions()}
        />
      ) : null}
      {visibleUserSkillGenerationDialog ? (
        <UserSkillGenerationDialogView dialog={visibleUserSkillGenerationDialog} motionPhase={userSkillGenerationDialogPresence.phase} generating={isGeneratingUserSkill} onClose={() => setUserSkillGenerationDialog(null)} onNameChange={(name) => setUserSkillGenerationDialog((current) => current ? { ...current, name } : current)} onGenerate={() => void generateUserSkill(visibleUserSkillGenerationDialog)} />
      ) : null}
      {visibleManagedRemoval ? (
        <ConfirmationSheet
          motionPhase={managedRemovalPresence.phase}
          titleId="managed-removal-title"
          title={visibleManagedRemoval.kind === "plugin" ? "移除插件？" : "移除 Skill？"}
          description={visibleManagedRemoval.kind === "plugin"
            ? `“${visibleManagedRemoval.plugin.name}”及其所有 Skill、项目绑定和聊天选择都会被移除。`
            : `“${visibleManagedRemoval.skill.displayName ?? visibleManagedRemoval.skill.qualifiedName}”及其关联文件会被移除。`}
          confirmLabel={removingManagedItem ? "正在移除..." : "确认移除"}
          busy={removingManagedItem}
          onClose={() => setManagedRemoval(null)}
          onConfirm={() => void confirmManagedRemoval()}
        />
      ) : null}

      {visibleHistoryThreadDeleteConfirmation ? (
        <ConfirmationSheet
          motionPhase={historyThreadDeleteConfirmPresence.phase}
          titleId="history-thread-delete-confirm-title"
          title="删除历史任务？"
          description={`“${visibleHistoryThreadDeleteConfirmation.title}”的消息、执行记录、附件和子任务都会被永久删除，且无法恢复。`}
          confirmLabel={deletingThreadId ? "正在删除..." : "确认删除"}
          busy={Boolean(deletingThreadId)}
          onClose={() => setHistoryThreadDeleteConfirmation(null)}
          onConfirm={() => void confirmDeleteHistoryThread()}
        />
      ) : null}

      {visibleUpdateConfirmDialog ? (
        <ConfirmationSheet
          motionPhase={updateConfirmPresence.phase}
          titleId="update-confirm-title"
          title={visibleUpdateConfirmDialog.title}
          description={visibleUpdateConfirmDialog.message}
          confirmLabel={visibleUpdateConfirmDialog.kind === "download" ? "继续下载" : "立即安装并重启"}
          confirmVariant="warm"
          sheetClassName="delete-confirm-sheet update-confirm-sheet"
          bodyClassName="delete-confirm-body update-confirm-body"
          onClose={() => setUpdateConfirmDialog(null)}
          onConfirm={() => void confirmUpdateDialog()}
        >
          {visibleUpdateConfirmDialog.details.length > 0 ? <ul className="update-confirm-details">{visibleUpdateConfirmDialog.details.map((detail) => <li key={detail}>{detail}</li>)}</ul> : null}
        </ConfirmationSheet>
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

      {fetchedModelsPresence.value ? <FetchedModelsDialog {...{ motionPhase: fetchedModelsPresence.phase, fetchedModels, selectedFetchedModelIds, configDraft, settingsProvider, setSelectedFetchedModelIds, setShowFetchedModels, toggleFetchedModelSelection, applyFetchedModels }} /> : null}
      {visibleMultimodalPickerRole && configDraft ? <MultimodalPickerDialog {...{ motionPhase: multimodalPickerPresence.phase, role: visibleMultimodalPickerRole, configDraft, selected: multimodalPickerSelected, setSelected: setMultimodalPickerSelected, onClose: resetMultimodalPicker, onApply: applyMultimodalPicker, onSetDefault: setMultimodalDefault }} /> : null}
      {visibleGpaMenuPos ? (
        <ComposerAddMenu
          position={visibleGpaMenuPos}
          motionPhase={gpaMenuPresence.phase}
          open={gpaMenuOpen}
          view={composerAddMenuView}
          submenuAnchor={composerAddSubmenuAnchor}
          config={config}
          gpaState={gpaState}
          multiAgentMode={multiAgentMode}
          isProjectThread={selectedThread?.mode === "project"}
          canAttachMultimodal={composerCanAttachMultimodal}
          canGenerateImage={composerMediaGenerationReady.image}
          canGenerateVideo={composerMediaGenerationReady.video}
          mediaIntent={composerMediaIntent}
          onSelectMediaIntent={(intent) => setComposerMediaIntent((current) => (current === intent ? null : intent))}
          skills={visibleComposerSkills}
          filteredSkills={filteredComposerSkills}
          apiCardFavorites={apiCardFavorites}
          apiCardMatches={apiCardMenuMatches}
          skillsQuery={skillsMenuQuery}
          apiCardQuery={apiCardMenuQuery}
          onClose={() => { setGpaMenuOpen(false); setGpaMenuPos(null); }}
          onChooseFiles={chooseComposerFiles}
          onOpenSubmenu={openComposerAddSubmenu}
          onSetView={setComposerAddMenuView}
          onSetSkillsQuery={setSkillsMenuQuery}
          onSetApiCardQuery={setApiCardMenuQuery}
          onAddAttachment={addComposerAttachment}
          onSendApiCard={sendApiCardFavoriteToChat}
          onSetFullAccess={setFullAccess}
          onSetKnowledgeEnabled={setKnowledgeEnabled}
          onSetMultiAgentMode={updateMultiAgentMode}
          onEnableGpa={enableGpaMode}
          onClearCloseTimer={clearComposerAddMenuCloseTimer}
          onScheduleCloseTimer={scheduleComposerAddMenuClose}
          isGeneratedUserSkill={isGeneratedUserSkill}
          formatGpaStage={gpaModeLabel}
        />
      ) : null}    </div>
  );
}
