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

declare global {
  interface Window {
    codexh: {
      listThreads: () => Promise<any[]>;
      searchThreads: (query: string) => Promise<Array<{ thread: ThreadRecord; snippet: string | null; score: number }>>;
      setThreadPinned: (payload: { threadId: string; isPinned: boolean }) => Promise<ThreadRecord>;
      renameThread: (payload: { threadId: string; title: string }) => Promise<ThreadRecord>;
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
      listProjectFiles: (threadId: string) => Promise<Array<{ path: string; kind: "file" | "directory"; size?: number }>>;
      readProjectFile: (payload: { threadId: string; path: string }) => Promise<{ path: string; content: string; truncated: boolean }>;
      deleteThread: (threadId: string) => Promise<void>;
      getThreadSnapshot: (threadId: string) => Promise<any>;
      sendMessage: (payload: { threadId: string; content: string; displayContent?: string; attachments?: any[] }) => Promise<void>;
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
      listPlugins: () => Promise<any[]>;
      installPlugin: (source: string) => Promise<any>;
      setProjectPluginEnabled: (payload: {
        threadId: string;
        pluginId: string;
        enabled: boolean;
      }) => Promise<any>;
      getConfig: () => Promise<any>;
      saveConfig: (config: unknown) => Promise<void>;
      listMcpServers: () => Promise<any[]>;
      testMcpServer: (config: unknown) => Promise<{ tools: any[]; resources: any[]; resourceTemplates: any[] }>;
      fetchProviderModels: (payload: {
        baseUrl?: string;
        apiKey?: string;
        apiKeyEnv?: string;
        type?: string;
        id?: string;
      }) => Promise<Array<{ id: string; displayName?: string }>>;
      testProviderModel: (payload: {
        provider: ProviderDefinition;
        model: ModelProfile;
      }) => Promise<{
        latencyMs: number;
        outputTokens: number;
        tokensPerSecond: number;
        agentCapability: "verified" | "unsupported";
        agentCapabilityReason?: string;
      }>;
      saveModelAgentCapability: (payload: {
        providerId: string;
        modelId: string;
        agentCapability: "verified" | "unsupported";
        agentCapabilityReason?: string;
      }) => Promise<ModelProfile>;
      getUpdateState: () => Promise<UpdateState | null>;
      checkForUpdates: () => Promise<UpdateState>;
      downloadUpdate: (payload: { confirmInsecureHttp?: boolean }) => Promise<UpdateState>;
      installUpdate: () => Promise<void>;
      onUpdateState: (listener: (state: UpdateState) => void) => () => void;
      importKnowledge: (payload: {
        displayName: string;
        scope: "global" | "project" | "imported";
        sourcePaths: string[];
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
      setGpaStage: (payload: {
        threadId: string;
        stage: "off" | "goal" | "plan" | "act";
      }) => Promise<void>;
      setGpaFullAccess: (payload: { threadId: string; fullAccess: boolean }) => Promise<void>;
      setKnowledgeEnabled: (payload: { threadId: string; knowledgeEnabled: boolean }) => Promise<void>;
      onRuntimeEvent: (listener: (event: unknown) => void) => () => void;
    };
  }
}

export {};
