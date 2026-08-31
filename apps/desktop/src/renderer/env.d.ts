type UpdateState = {
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";
  currentVersion: string;
  remoteVersion?: string;
  changelog?: string;
  downloadUrl?: string;
  insecureTransport?: boolean;
  missingSha256?: boolean;
  progress?: number;
  receivedBytes?: number;
  totalBytes?: number;
  downloadedInstaller?: string;
  error?: string;
  isPackaged: boolean;
};

type RendererSkillLabEvent = import("@shared-types").SkillLabEvent;
type RendererNotificationNavigationTarget = import("@shared-types").NotificationNavigationTarget;
type RendererPendingResumeThread = import("@shared-types").PendingResumeThread;
type RendererRuntimeLogPage = import("@shared-types").RuntimeLogPage;

declare global {
  interface Window {
    codexh: {
      reportRendererError: (payload: { message: string; stack?: string; componentStack?: string; unhandledRejection?: boolean }) => void;
      getApplicationBackgrounds: () => Promise<{
        items: Array<{
          id: string;
          bytes: ArrayBuffer;
          mimeType: string;
          fileName: string;
        }>;
        settings: unknown;
      } | null>;
      saveApplicationBackgrounds: (payload: {
        items: Array<{
          id: string;
          bytes: ArrayBuffer;
          mimeType: string;
          fileName: string;
        }>;
        settings: unknown;
      }) => Promise<void>;
      saveApplicationBackgroundSettings: (settings: unknown) => Promise<void>;
      clearApplicationBackground: () => Promise<void>;
      getRuntimeLogStats: () => Promise<{ bytes: number; fileCount: number }>;
      clearRuntimeLogs: () => Promise<{ bytes: number; fileCount: number }>;
      getThreadRuntimeLogs: (threadId: string, limit?: number) => Promise<RendererRuntimeLogPage>;
      openConversationLogWindow: (threadId: string) => Promise<void>;
      setConversationLogWindowThread: (threadId: string | null) => Promise<void>;
      markConversationLogWindowReady: () => void;
      closeConversationLogWindow: () => Promise<void>;
      listThreads: () => Promise<any[]>;
      getThreadTokenUsage: (threadId: string) => Promise<{
        turn: import("@shared-types").TokenUsage;
        thread: import("@shared-types").TokenUsage;
        turnRunId: string | null;
      }>;
      getUsageAnalytics: (input?: { rangeDays?: number | null; granularity?: "day" | "week" | "month" }) =>
        Promise<import("@shared-types").UsageAnalyticsSummary>;
      setGlobalReasoningEffort: (reasoningEffort: import("@shared-types").GptReasoningEffort) =>
        Promise<import("@shared-types").GptReasoningEffort>;
      searchThreads: (query: string) => Promise<Array<{ thread: ThreadRecord; snippet: string | null; score: number }>>;
      setThreadPinned: (payload: { threadId: string; isPinned: boolean }) => Promise<ThreadRecord>;
      renameThread: (payload: { threadId: string; title: string }) => Promise<ThreadRecord>;
      setThreadMultiAgentMode: (payload: { threadId: string; mode: "disabled" | "proactive" }) => Promise<ThreadRecord>;
      createThread: (payload: {
        title: string;
        mode: "project" | "chat";
        cwd?: string | null;
        workspaceRoots?: string[];
        providerId?: string | null;
        modelId?: string | null;
      }) => Promise<any>;
      addThreadWorkspaceRoot: (payload: { threadId: string; rootPath: string }) => Promise<ThreadRecord>;
      removeThreadWorkspaceRoot: (payload: { threadId: string; rootPath: string }) => Promise<ThreadRecord>;
      chooseProjectDirectory: (defaultPath?: string) => Promise<string | null>;
      chooseAttachmentFiles: (payload?: { imagesOnly?: boolean }) => Promise<string[]>;
      chooseKnowledgeFiles: () => Promise<string[]>;
      chooseKnowledgeFolders: () => Promise<string[]>;
      listQuickNotes: () => Promise<Array<{ id: string; title: string; content: string; knowledgeBaseId: string; knowledgeSourcePath: string; createdAt: string; updatedAt: string }>>;
      saveQuickNote: (payload: { id?: string; title?: string; content: string }) => Promise<{ id: string; title: string; content: string; knowledgeBaseId: string; knowledgeSourcePath: string; createdAt: string; updatedAt: string }>;
      deleteQuickNote: (id: string) => Promise<void>;
      createQuickNoteWithAi: (payload: { prompt: string; context: string }) => Promise<string>;
      listProjectFiles: (payload: { threadId: string; rootPath?: string; relativeDirectory?: string }) => Promise<Array<{ path: string; kind: "file" | "directory"; size?: number }>>;
      readProjectFile: (payload: { threadId: string; rootPath?: string; path: string }) => Promise<{ path: string; content: string; truncated: boolean; binary: boolean }>;
      writeProjectFile: (payload: { threadId: string; rootPath?: string; path: string; content: string }) => Promise<{ path: string }>;
      setLiveEditPreviewEnabled: (enabled: boolean) => Promise<boolean>;
      setLlmLogViewerEnabled: (enabled: boolean) => Promise<boolean>;
      setLiveEditPreviewActiveThread: (threadId: string | null) => Promise<void>;
      acknowledgeLiveEditPreviewPath: (payload: { toolCallId: string; path: string }) => Promise<void>;
      markLiveEditPreviewReady: () => Promise<void>;
      getGitSnapshot: (payload: { threadId: string; rootPath?: string }) => Promise<any>;
      stageGitFile: (payload: { threadId: string; rootPath?: string; path: string }) => Promise<any>;
      stageAllGitChanges: (payload: { threadId: string; rootPath?: string }) => Promise<any>;
      unstageGitFile: (payload: { threadId: string; rootPath?: string; path: string }) => Promise<any>;
      revertGitFile: (payload: { threadId: string; rootPath?: string; path: string; untracked?: boolean }) => Promise<any>;
      applyGitHunk: (payload: {
        threadId: string;
        rootPath?: string;
        path: string;
        hunkId: string;
        source: "staged" | "unstaged";
        action: "stage" | "unstage" | "revert";
      }) => Promise<any>;
      commitGitChanges: (payload: { threadId: string; rootPath?: string; message: string }) => Promise<any>;
      pushGitChanges: (payload: { threadId: string; rootPath?: string }) => Promise<any>;
      pullGitChanges: (payload: { threadId: string; rootPath?: string }) => Promise<any>;
      switchGitBranch: (payload: { threadId: string; rootPath?: string; branch: string }) => Promise<any>;
      createGitPullRequest: (payload: { threadId: string; rootPath?: string }) => Promise<any>;
      deleteThread: (threadId: string) => Promise<void>;
      clearThreadConversation: (threadId: string) => Promise<ThreadRecord>;
      getThreadSnapshot: (threadId: string, cursor?: import("@shared-types").RuntimeThreadSnapshotCursor) => Promise<any>;
      getToolCallDetails: (payload: { threadId: string; toolCallIds: string[] }) =>
        Promise<import("@shared-types").ToolCallDetail[]>;
      sendMessage: (payload: { threadId: string; content: string; displayContent?: string; attachments?: any[]; mediaIntent?: "image" | "video" | null }) => Promise<{
        queued: QueuedMessageRecord;
        queuedBehindActiveTask: boolean;
      }>;
      requestHttp: (payload: {
        threadId: string;
        method: string;
        url: string;
        headers?: Record<string, string>;
        body?: string;
        downloadFileName?: string;
      }) => Promise<
        | {
            ok: true;
            status: number;
            statusText: string;
            headers: Record<string, string>;
            bodyText: string;
            bodyKind: "text" | "file";
            download?: {
              fileName: string;
              filePath: string;
              mimeType: string;
              sizeBytes: number;
            };
            truncated: boolean;
            durationMs: number;
          }
        | { ok: false; error: string }
      >;
      guideActiveThread: (payload: { threadId: string; content: string }) => Promise<{ accepted: boolean }>;
      replaceMessage: (payload: { threadId: string; messageId: string; content: string }) => Promise<void>;
      deleteQueuedMessage: (payload: { threadId: string; id: string }) => Promise<void>;
      importAttachments: (payload: { threadId: string; attachments: any[] }) => Promise<any[]>;
      previewAttachment: (payload: { threadId: string; absolutePath: string }) => Promise<string>;
      getAttachmentMediaUrl: (payload: { threadId: string; absolutePath: string }) => Promise<{
        url: string;
        mimeType: string;
        kind: "image" | "video" | "file";
      }>;
      previewLocalImage: (payload: { absolutePath: string }) => Promise<string>;
      rejectUnsupportedMultimodal: (payload: { threadId: string; content: string }) => Promise<void>;
      loadApiCardFavorites: () => Promise<unknown[]>;
      saveApiCardFavorites: (favorites: unknown[]) => Promise<void>;
      interruptThread: (threadId: string) => Promise<void>;
      listPendingResume: () => Promise<RendererPendingResumeThread[]>;
      dismissPendingResume: (threadId: string) => Promise<void>;
      resumePendingResume: (threadId: string) => Promise<void>;
      listSubagents: (threadId: string) => Promise<ThreadRecord[]>;
      interruptAgent: (payload: { threadId: string; agent: string }) => Promise<any>;
      updateThreadModelSelection: (payload: {
        threadId: string;
        providerId: string;
        modelId: string;
      }) => Promise<any>;
      addThreadSkill: (payload: { threadId: string; skillId: string }) => Promise<any>;
      removeThreadSkill: (payload: { threadId: string; skillId: string }) => Promise<any>;
      openTerminal: (payload: { threadId: string; sessionId?: string; rootPath?: string }) => Promise<{ cwd: string; shell: string; output: string }>;
      writeTerminal: (payload: { threadId: string; input: string; sessionId?: string; rootPath?: string }) => Promise<void>;
      closeTerminal: (payload: { threadId: string; sessionId?: string }) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      openPath: (targetPath: string) => Promise<string>;
      openFolder: (targetPath: string) => Promise<string>;
      openFileLocation: (payload: { threadId: string; path: string }) => Promise<string>;
      listSkills: (cwd?: string | null) => Promise<any[]>;
      getSkillUsageStats: () => Promise<Array<{
        skillId: string;
        callCount: number;
        successCount: number;
        successRate: number;
        lastUsedAt: string | null;
      }>>;
      removeSkill: (skillId: string) => Promise<void>;
      listUserSkills: () => Promise<SkillMetadata[]>;
      generateUserSkill: (threadId: string, skillName?: string) => Promise<SkillMetadata>;
      startSkillLab: (payload: {
        prompt: string;
        requestedName?: string;
        iterations?: number;
        targetSkillId?: string;
        providerId?: string;
        modelId?: string;
      }) => Promise<string>;
      cancelSkillLab: (jobId: string) => Promise<void>;
      resolveSkillLabApproval: (payload: { jobId: string; approvalId: string; approved: boolean }) => Promise<void>;
      resolveSkillLabClarification: (payload: { jobId: string; clarificationId: string; answers: Record<string, string> }) => Promise<void>;
      onSkillLabEvent: (listener: (event: RendererSkillLabEvent) => void) => () => void;
      onOpenNotificationCenter: (listener: (target: RendererNotificationNavigationTarget) => void) => () => void;
      listPlugins: () => Promise<any[]>;
      installPlugin: (source: string) => Promise<any>;
      onPluginInstallProgress: (listener: (progress: { percent: number; stage: string }) => void) => () => void;
      removePlugin: (pluginId: string) => Promise<void>;
      setThreadPluginEnabled: (payload: {
        threadId: string;
        pluginId: string;
        enabled: boolean;
      }) => Promise<any>;
      getConfig: () => Promise<any>;
      saveConfig: (config: unknown) => Promise<void>;
      listDatabases: () => Promise<any[]>;
      listDatabaseCredentialConnectionIds: () => Promise<string[]>;
      testDatabase: (payload: { connection: unknown; password?: string }) => Promise<
        | { ok: true; result: { version: string; schemas: string[]; databases: string[] } }
        | { ok: false; error: string }
      >;
      saveDatabaseCredential: (payload: { connectionId: string; password: string }) => Promise<void>;
      deleteDatabaseCredential: (connectionId: string) => Promise<void>;
      listMcpServers: () => Promise<any[]>;
      testMcpServer: (config: unknown) => Promise<{ tools: any[]; resources: any[]; resourceTemplates: any[]; prompts: any[] }>;
      refreshMcpTools: (serverId?: string) => Promise<any[]>;
      loginMcpServer: (serverId: string) => Promise<void>;
      logoutMcpServer: (serverId: string) => Promise<void>;
      fetchProviderModels: (payload: {
        baseUrl?: string;
        apiKey?: string;
        apiKeyEnv?: string;
        type?: string;
        id?: string;
      }) => Promise<Array<{ id: string; displayName?: string; contextWindow?: number }>>;
      testProviderModel: (payload: {
        provider: ProviderDefinition;
        model: ModelProfile;
      }) => Promise<{
        latencyMs: number;
        outputTokens: number;
        tokensPerSecond: number;
        agentCapability: "verified" | "unsupported";
        agentCapabilityReason?: string;
        verifiedApiFormats?: import("@shared-types").OpenAiApiFormat[];
        preferredApiFormat?: import("@shared-types").OpenAiApiFormat;
        apiFormatCheckedAt?: string;
      }>;
      saveModelAgentCapability: (payload: {
        providerId: string;
        modelId: string;
        agentCapability: "verified" | "unsupported";
        agentCapabilityReason?: string;
        contextWindow?: number;
        verifiedApiFormats?: import("@shared-types").OpenAiApiFormat[];
        preferredApiFormat?: import("@shared-types").OpenAiApiFormat;
        apiFormatCheckedAt?: string;
      }) => Promise<ModelProfile>;
      getUpdateState: () => Promise<UpdateState | null>;
      checkForUpdates: () => Promise<UpdateState>;
      downloadUpdate: (payload: { confirmInsecureHttp?: boolean }) => Promise<UpdateState>;
      installUpdate: () => Promise<void>;
      onUpdateState: (listener: (state: UpdateState) => void) => () => void;
      importKnowledge: (payload: {
        displayName: string;
        scope: "global" | "project" | "imported";
        sourcePaths?: string[];
        sources?: Array<
          | { kind: "file" | "folder"; path: string }
          | { kind: "url"; url: string }
          | { kind: "browser"; url: string; threadId: string; tabId: string }
        >;
        threadId?: string;
      }) => Promise<any>;
      listKnowledgeBases: () => Promise<any[]>;
      listKnowledgeDocuments: (knowledgeBaseId: string) => Promise<any[]>;
      refreshKnowledgeBase: (knowledgeBaseId: string) => Promise<any>;
      deleteKnowledgeBase: (knowledgeBaseId: string) => Promise<void>;
      listErrorSolutions: (input?: { limit?: number; modelId?: string | null }) => Promise<any[]>;
      deleteErrorSolution: (id: string) => Promise<void>;
      clearErrorSolutions: (modelId?: string | null) => Promise<number>;
      clearSelfImprovementMemories: () => Promise<number>;
      listSelfImprovementMemories: (input?: { projectId?: string | null; limit?: number; all?: boolean }) => Promise<any[]>;
      deleteSelfImprovementMemory: (id: string) => Promise<void>;
      refreshSelfImprovementMemories: () => Promise<{ processed: number; pruned: number }>;
      openBrowserTab: (payload: { threadId: string; url: string; openMode?: "in_app" | "external_default" }) => Promise<any>;
      navigateBrowserTab: (payload: { threadId: string; tabId: string; url: string }) => Promise<any>;
      focusBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      reloadBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      goBackBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      goForwardBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      closeBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      registerBrowserWebContents: (payload: { threadId: string; tabId: string; webContentsId: number }) => Promise<void>;
      syncBrowserWebContents: (payload: { threadId: string; tabId: string }) => Promise<any>;
      onBrowserReregisterRequest: (handler: (payload: { threadId: string; tabId: string }) => void) => () => void;
      detectRecordingBrowsers: () => Promise<import("@shared-types").DetectedBrowser[]>;
      chooseChromeExecutablePath: () => Promise<string | null>;
      listBrowserRecordings: () => Promise<import("@shared-types").BrowserRecording[]>;
      getBrowserRecordingState: () => Promise<import("@shared-types").BrowserRecordingSession>;
      startBrowserRecording: (payload: { threadId: string; browser: import("@shared-types").BrowserRecordingFamily; name?: string; startUrl?: string; startUrls?: string[] }) => Promise<import("@shared-types").BrowserRecordingSession>;
      stopBrowserRecording: () => Promise<import("@shared-types").BrowserRecordingSession>;
      cancelBrowserRecording: () => Promise<import("@shared-types").BrowserRecordingSession>;
      playBrowserRecording: (payload: { recordingId: string; threadId: string }) => Promise<import("@shared-types").BrowserRecordingSession>;
      retryBrowserRecordingPlayback: () => Promise<import("@shared-types").BrowserRecordingSession>;
      stopBrowserRecordingPlayback: () => Promise<import("@shared-types").BrowserRecordingSession>;
      applyBrowserRecordingLlmCandidate: (recordingId: string) => Promise<import("@shared-types").BrowserRecordingSession>;
      discardBrowserRecordingLlmCandidate: (recordingId: string) => Promise<import("@shared-types").BrowserRecordingSession>;
      enhanceBrowserRecording: (payload: { recordingId: string; threadId: string }) => Promise<import("@shared-types").BrowserRecordingSession>;
      renameBrowserRecording: (payload: { recordingId: string; name: string }) => Promise<import("@shared-types").BrowserRecording>;
      deleteBrowserRecording: (recordingId: string) => Promise<void>;
      readBrowserRecordingScript: (recordingId: string) => Promise<string>;
      readBrowserRecordingDocument: (recordingId: string) => Promise<string>;
      openBrowserRecordingDirectory: (recordingId: string) => Promise<void>;
      onBrowserRecordingState: (handler: (state: import("@shared-types").BrowserRecordingSession) => void) => () => void;
      onOpenBrowserRecordingSettings: (handler: (payload: { recordingId: string | null }) => void) => () => void;
      resolveApproval: (
        id: string,
        resolution: { decision: "approved" | "denied"; mode?: "once" | "session" | "remember" }
      ) => Promise<void>;
      answerPrompt: (id: string, answers: Record<string, string>) => Promise<void>;
      getGpaState: (threadId: string) => Promise<any>;
      getProjectGpaPlan: (threadId: string) => Promise<{
        status: "awaiting_confirmation" | "in_progress" | "completed" | "abandoned";
        sourceThreadId: string;
        currentThreadId: string;
        sameSession: boolean;
        updatedAt: string;
        tasks: Array<{ id: string; title: string; done: boolean }>;
        body: string;
        doneCount: number;
        pendingCount: number;
        pendingTasks: Array<{ id: string; title: string; done: boolean }>;
      } | null>;
      restoreProjectGpaPlan: (threadId: string) => Promise<any>;
      abandonProjectGpaPlan: (threadId: string) => Promise<boolean>;
      setGpaStage: (payload: {
        threadId: string;
        stage: "off" | "goal" | "plan" | "act";
      }) => Promise<void>;
      resetGpaConfirmationTimeout: (threadId: string) => Promise<void>;
      setGpaFullAccess: (payload: { threadId: string; fullAccess: boolean }) => Promise<void>;
      setKnowledgeEnabled: (payload: { threadId: string; knowledgeEnabled: boolean }) => Promise<void>;
      onRuntimeEvent: (listener: (event: unknown) => void) => () => void;
      onConversationLogWindowEvent: (listener: (event: unknown) => void) => () => void;
      onLiveEditPreviewEvent: (listener: (event: { kind: "show"; toolCallId: string; threadId: string; path: string; completed: boolean } | { kind: "complete"; toolCallId: string }) => void) => () => void;
    };
  }
}

export {};
