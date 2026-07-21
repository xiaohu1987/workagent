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

declare global {
  interface Window {
    codexh: {
      listThreads: () => Promise<any[]>;
      searchThreads: (query: string) => Promise<Array<{ thread: ThreadRecord; snippet: string | null; score: number }>>;
      setThreadPinned: (payload: { threadId: string; isPinned: boolean }) => Promise<ThreadRecord>;
      renameThread: (payload: { threadId: string; title: string }) => Promise<ThreadRecord>;
      setThreadMultiAgentMode: (payload: { threadId: string; mode: "disabled" | "proactive" }) => Promise<ThreadRecord>;
      createThread: (payload: {
        title: string;
        mode: "project" | "chat";
        cwd?: string | null;
        providerId?: string | null;
        modelId?: string | null;
      }) => Promise<any>;
      chooseProjectDirectory: (defaultPath?: string) => Promise<string | null>;
      chooseAttachmentFiles: (payload?: { imagesOnly?: boolean }) => Promise<string[]>;
      chooseKnowledgeFiles: () => Promise<string[]>;
      chooseKnowledgeFolders: () => Promise<string[]>;
      listQuickNotes: () => Promise<Array<{ id: string; title: string; content: string; knowledgeBaseId: string; knowledgeSourcePath: string; createdAt: string; updatedAt: string }>>;
      saveQuickNote: (payload: { id?: string; title?: string; content: string }) => Promise<{ id: string; title: string; content: string; knowledgeBaseId: string; knowledgeSourcePath: string; createdAt: string; updatedAt: string }>;
      deleteQuickNote: (id: string) => Promise<void>;
      createQuickNoteWithAi: (payload: { prompt: string; context: string }) => Promise<string>;
      listProjectFiles: (threadId: string) => Promise<Array<{ path: string; kind: "file" | "directory"; size?: number }>>;
      readProjectFile: (payload: { threadId: string; path: string }) => Promise<{ path: string; content: string; truncated: boolean; binary: boolean }>;
      writeProjectFile: (payload: { threadId: string; path: string; content: string }) => Promise<{ path: string }>;
      getGitSnapshot: (threadId: string) => Promise<any>;
      stageGitFile: (payload: { threadId: string; path: string }) => Promise<any>;
      stageAllGitChanges: (threadId: string) => Promise<any>;
      unstageGitFile: (payload: { threadId: string; path: string }) => Promise<any>;
      revertGitFile: (payload: { threadId: string; path: string; untracked?: boolean }) => Promise<any>;
      applyGitHunk: (payload: {
        threadId: string;
        path: string;
        hunkId: string;
        source: "staged" | "unstaged";
        action: "stage" | "unstage" | "revert";
      }) => Promise<any>;
      commitGitChanges: (payload: { threadId: string; message: string }) => Promise<any>;
      pushGitChanges: (threadId: string) => Promise<any>;
      pullGitChanges: (threadId: string) => Promise<any>;
      createGitPullRequest: (threadId: string) => Promise<any>;
      deleteThread: (threadId: string) => Promise<void>;
      clearThreadConversation: (threadId: string) => Promise<ThreadRecord>;
      getThreadSnapshot: (threadId: string) => Promise<any>;
      sendMessage: (payload: { threadId: string; content: string; displayContent?: string; attachments?: any[] }) => Promise<void>;
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
      interruptThread: (threadId: string) => Promise<void>;
      listSubagents: (threadId: string) => Promise<ThreadRecord[]>;
      interruptAgent: (payload: { threadId: string; agent: string }) => Promise<any>;
      updateThreadModelSelection: (payload: {
        threadId: string;
        providerId: string;
        modelId: string;
      }) => Promise<any>;
      addThreadSkill: (payload: { threadId: string; skillId: string }) => Promise<any>;
      openTerminal: (payload: { threadId: string; sessionId?: string }) => Promise<{ cwd: string; shell: string; output: string }>;
      writeTerminal: (payload: { threadId: string; input: string; sessionId?: string }) => Promise<void>;
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
        contextWindow?: number;
        agentCapability: "verified" | "unsupported";
        agentCapabilityReason?: string;
      }>;
      saveModelAgentCapability: (payload: {
        providerId: string;
        modelId: string;
        agentCapability: "verified" | "unsupported";
        agentCapabilityReason?: string;
        contextWindow?: number;
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
      openBrowserTab: (payload: { threadId: string; url: string }) => Promise<any>;
      navigateBrowserTab: (payload: { threadId: string; tabId: string; url: string }) => Promise<any>;
      focusBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      reloadBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      goBackBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      goForwardBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      closeBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      registerBrowserWebContents: (payload: { threadId: string; tabId: string; webContentsId: number }) => Promise<void>;
      syncBrowserWebContents: (payload: { threadId: string; tabId: string }) => Promise<any>;
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
    };
  }
}

export {};
