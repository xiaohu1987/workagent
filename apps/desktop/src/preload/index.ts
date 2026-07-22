import { contextBridge, ipcRenderer } from "electron";
import type { NotificationNavigationTarget } from "@shared-types";

const api = {
  getApplicationBackground: () => ipcRenderer.invoke("appearance:background:get"),
  saveApplicationBackground: (payload: {
    bytes: ArrayBuffer;
    mimeType: string;
    fileName: string;
    settings: unknown;
  }) => ipcRenderer.invoke("appearance:background:save", payload),
  saveApplicationBackgroundSettings: (settings: unknown) =>
    ipcRenderer.invoke("appearance:background:save-settings", settings),
  clearApplicationBackground: () => ipcRenderer.invoke("appearance:background:clear"),
  listThreads: () => ipcRenderer.invoke("threads:list"),
  searchThreads: (query: string) => ipcRenderer.invoke("threads:search", query),
  setThreadPinned: (payload: { threadId: string; isPinned: boolean }) =>
    ipcRenderer.invoke("threads:set-pinned", payload),
  renameThread: (payload: { threadId: string; title: string }) =>
    ipcRenderer.invoke("threads:rename", payload),
  setThreadMultiAgentMode: (payload: { threadId: string; mode: "disabled" | "proactive" }) =>
    ipcRenderer.invoke("threads:set-multi-agent-mode", payload),
  createThread: (payload: {
    title: string;
    mode: "project" | "chat";
    cwd?: string | null;
    providerId?: string | null;
    modelId?: string | null;
  }) =>
    ipcRenderer.invoke("threads:create", payload),
  chooseProjectDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke("projects:choose-directory", defaultPath),
  chooseAttachmentFiles: (payload?: { imagesOnly?: boolean }) =>
    ipcRenderer.invoke("attachments:choose-files", payload),
  chooseKnowledgeFiles: () => ipcRenderer.invoke("knowledge:choose-files"),
  chooseKnowledgeFolders: () => ipcRenderer.invoke("knowledge:choose-folders"),
  listProjectFiles: (threadId: string) => ipcRenderer.invoke("projects:list-files", threadId),
  readProjectFile: (payload: { threadId: string; path: string }) =>
    ipcRenderer.invoke("projects:read-file", payload),
  writeProjectFile: (payload: { threadId: string; path: string; content: string }) =>
    ipcRenderer.invoke("projects:write-file", payload),
  getGitSnapshot: (threadId: string) => ipcRenderer.invoke("git:snapshot", threadId),
  stageGitFile: (payload: { threadId: string; path: string }) => ipcRenderer.invoke("git:stage-file", payload),
  stageAllGitChanges: (threadId: string) => ipcRenderer.invoke("git:stage-all", threadId),
  unstageGitFile: (payload: { threadId: string; path: string }) => ipcRenderer.invoke("git:unstage-file", payload),
  revertGitFile: (payload: { threadId: string; path: string; untracked?: boolean }) =>
    ipcRenderer.invoke("git:revert-file", payload),
  applyGitHunk: (payload: {
    threadId: string;
    path: string;
    hunkId: string;
    source: "staged" | "unstaged";
    action: "stage" | "unstage" | "revert";
  }) => ipcRenderer.invoke("git:apply-hunk", payload),
  commitGitChanges: (payload: { threadId: string; message: string }) => ipcRenderer.invoke("git:commit", payload),
  pushGitChanges: (threadId: string) => ipcRenderer.invoke("git:push", threadId),
  pullGitChanges: (threadId: string) => ipcRenderer.invoke("git:pull", threadId),
  createGitPullRequest: (threadId: string) => ipcRenderer.invoke("git:create-pr", threadId),
  deleteThread: (threadId: string) => ipcRenderer.invoke("threads:delete", threadId),
  clearThreadConversation: (threadId: string) => ipcRenderer.invoke("threads:clear-conversation", threadId),
  getThreadSnapshot: (threadId: string, messageLimit?: number) =>
    ipcRenderer.invoke("threads:snapshot", threadId, messageLimit),
  sendMessage: (payload: { threadId: string; content: string; displayContent?: string; attachments?: unknown[] }) =>
    ipcRenderer.invoke("threads:send", payload),
  replaceMessage: (payload: { threadId: string; messageId: string; content: string }) =>
    ipcRenderer.invoke("threads:replace-message", payload),
  deleteQueuedMessage: (payload: { threadId: string; id: string }) =>
    ipcRenderer.invoke("threads:queue:delete", payload),
  importAttachments: (payload: { threadId: string; attachments: unknown[] }) =>
    ipcRenderer.invoke("attachments:import", payload),
  previewAttachment: (payload: { threadId: string; absolutePath: string }) =>
    ipcRenderer.invoke("attachments:preview", payload),
  getAttachmentMediaUrl: (payload: { threadId: string; absolutePath: string }) =>
    ipcRenderer.invoke("attachments:media-url", payload),
  previewLocalImage: (payload: { absolutePath: string }) =>
    ipcRenderer.invoke("attachments:preview-local", payload),
  rejectUnsupportedMultimodal: (payload: { threadId: string; content: string }) =>
    ipcRenderer.invoke("threads:reject-multimodal", payload),
  interruptThread: (threadId: string) => ipcRenderer.invoke("threads:interrupt", threadId),
  listSubagents: (threadId: string) => ipcRenderer.invoke("multi-agents:list", threadId),
  interruptAgent: (payload: { threadId: string; agent: string }) =>
    ipcRenderer.invoke("multi-agents:interrupt", payload),
  updateThreadModelSelection: (payload: { threadId: string; providerId: string; modelId: string }) =>
    ipcRenderer.invoke("threads:update-model", payload),
  addThreadSkill: (payload: { threadId: string; skillId: string }) =>
    ipcRenderer.invoke("threads:add-skill", payload),
  openTerminal: (payload: { threadId: string; sessionId?: string }) => ipcRenderer.invoke("terminal:open", payload),
  writeTerminal: (payload: { threadId: string; input: string; sessionId?: string }) =>
    ipcRenderer.invoke("terminal:write", payload),
  closeTerminal: (payload: { threadId: string; sessionId?: string }) => ipcRenderer.invoke("terminal:close", payload),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:open-path", targetPath),
  openFolder: (targetPath: string) => ipcRenderer.invoke("shell:open-folder", targetPath),
  openFileLocation: (payload: { threadId: string; path: string }) =>
    ipcRenderer.invoke("threads:open-file-location", payload),
  listSkills: (cwd?: string | null) => ipcRenderer.invoke("skills:list", cwd),
  getSkillUsageStats: () => ipcRenderer.invoke("skills:usage-stats"),
  removeSkill: (skillId: string) => ipcRenderer.invoke("skills:remove", skillId),
  listUserSkills: () => ipcRenderer.invoke("user-skills:list"),
  generateUserSkill: (threadId: string, skillName?: string) => ipcRenderer.invoke("user-skills:generate", threadId, skillName),
  startSkillLab: (payload: { prompt: string; requestedName?: string; iterations?: number; targetSkillId?: string }) => ipcRenderer.invoke("skill-lab:start", payload),
  cancelSkillLab: (jobId: string) => ipcRenderer.invoke("skill-lab:cancel", jobId),
  resolveSkillLabApproval: (payload: { jobId: string; approvalId: string; approved: boolean }) =>
    ipcRenderer.invoke("skill-lab:approval", payload),
  resolveSkillLabClarification: (payload: { jobId: string; clarificationId: string; answers: Record<string, string> }) =>
    ipcRenderer.invoke("skill-lab:clarification", payload),
  onSkillLabEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("skill-lab:event", wrapped);
    return () => ipcRenderer.removeListener("skill-lab:event", wrapped);
  },
  onOpenNotificationCenter: (listener: (target: NotificationNavigationTarget) => void) => {
    const wrapped = (_event: unknown, target: NotificationNavigationTarget) => listener(target);
    ipcRenderer.on("notifications:open", wrapped);
    return () => ipcRenderer.removeListener("notifications:open", wrapped);
  },
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  installPlugin: (source: string) => ipcRenderer.invoke("plugins:install", source),
  onPluginInstallProgress: (listener: (progress: unknown) => void) => {
    const wrapped = (_event: unknown, progress: unknown) => listener(progress);
    ipcRenderer.on("plugins:install-progress", wrapped);
    return () => ipcRenderer.removeListener("plugins:install-progress", wrapped);
  },
  removePlugin: (pluginId: string) => ipcRenderer.invoke("plugins:remove", pluginId),
  setThreadPluginEnabled: (payload: { threadId: string; pluginId: string; enabled: boolean }) =>
    ipcRenderer.invoke("plugins:set-enabled", payload),
  getConfig: async () => {
    console.log("[preload] config:get invoke");
    const result = await ipcRenderer.invoke("config:get");
    console.log("[preload] config:get success", {
      providers: Array.isArray(result?.providers) ? result.providers.length : null,
      models: Array.isArray(result?.models) ? result.models.length : null,
      defaultProvider: result?.defaultProvider,
      defaultModel: result?.defaultModel
    });
    return result;
  },
  saveConfig: (config: unknown) => ipcRenderer.invoke("config:save", config),
  listDatabases: () => ipcRenderer.invoke("databases:list"),
  listDatabaseCredentialConnectionIds: () => ipcRenderer.invoke("databases:credential-connection-ids"),
  testDatabase: (payload: { connection: unknown; password?: string }) => ipcRenderer.invoke("databases:test", payload),
  saveDatabaseCredential: (payload: { connectionId: string; password: string }) => ipcRenderer.invoke("databases:save-credential", payload),
  deleteDatabaseCredential: (connectionId: string) => ipcRenderer.invoke("databases:delete-credential", connectionId),
  listMcpServers: () => ipcRenderer.invoke("mcp:list"),
  testMcpServer: (config: unknown) => ipcRenderer.invoke("mcp:test", config),
  refreshMcpTools: (serverId?: string) => ipcRenderer.invoke("mcp:refresh-tools", serverId),
  loginMcpServer: (serverId: string) => ipcRenderer.invoke("mcp:login", serverId),
  logoutMcpServer: (serverId: string) => ipcRenderer.invoke("mcp:logout", serverId),
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
  }) => ipcRenderer.invoke("knowledge:import", payload),
  listKnowledgeBases: () => ipcRenderer.invoke("knowledge:list"),
  listQuickNotes: () => ipcRenderer.invoke("quick-notes:list"),
  saveQuickNote: (payload: { id?: string; title?: string; content: string }) => ipcRenderer.invoke("quick-notes:save", payload),
  deleteQuickNote: (id: string) => ipcRenderer.invoke("quick-notes:delete", id),
  createQuickNoteWithAi: (payload: { prompt: string; context: string }) => ipcRenderer.invoke("quick-notes:ai-create", payload),
  listKnowledgeDocuments: (knowledgeBaseId: string) => ipcRenderer.invoke("knowledge:documents", knowledgeBaseId),
  refreshKnowledgeBase: (knowledgeBaseId: string) => ipcRenderer.invoke("knowledge:refresh", knowledgeBaseId),
  deleteKnowledgeBase: (knowledgeBaseId: string) => ipcRenderer.invoke("knowledge:delete", knowledgeBaseId),
  openBrowserTab: (payload: { threadId: string; url: string }) =>
    ipcRenderer.invoke("browser:open", payload),
  navigateBrowserTab: (payload: { threadId: string; tabId: string; url: string }) =>
    ipcRenderer.invoke("browser:navigate", payload),
  focusBrowserTab: (payload: { threadId: string; tabId: string }) =>
    ipcRenderer.invoke("browser:focus", payload),
  reloadBrowserTab: (payload: { threadId: string; tabId: string }) =>
    ipcRenderer.invoke("browser:reload", payload),
  goBackBrowserTab: (payload: { threadId: string; tabId: string }) =>
    ipcRenderer.invoke("browser:back", payload),
  goForwardBrowserTab: (payload: { threadId: string; tabId: string }) =>
    ipcRenderer.invoke("browser:forward", payload),
  closeBrowserTab: (payload: { threadId: string; tabId: string }) =>
    ipcRenderer.invoke("browser:close", payload),
  registerBrowserWebContents: (payload: { threadId: string; tabId: string; webContentsId: number }) =>
    ipcRenderer.invoke("browser:register-webcontents", payload),
  syncBrowserWebContents: (payload: { threadId: string; tabId: string }) =>
    ipcRenderer.invoke("browser:sync-webcontents", payload),
  resolveApproval: (
    id: string,
    resolution: { decision: "approved" | "denied"; mode?: "once" | "session" | "remember" }
  ) => ipcRenderer.invoke("approval:resolve", { id, resolution }),
  answerPrompt: (id: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("prompt:answer", { id, answers }),
  getGpaState: (threadId: string) => ipcRenderer.invoke("gpa:state", threadId),
  getProjectGpaPlan: (threadId: string) => ipcRenderer.invoke("gpa:project-plan", threadId),
  restoreProjectGpaPlan: (threadId: string) => ipcRenderer.invoke("gpa:restore-plan", threadId),
  abandonProjectGpaPlan: (threadId: string) => ipcRenderer.invoke("gpa:abandon-plan", threadId),
  setGpaStage: (payload: { threadId: string; stage: "off" | "goal" | "plan" | "act" }) =>
    ipcRenderer.invoke("gpa:set-stage", payload),
  resetGpaConfirmationTimeout: (threadId: string) => ipcRenderer.invoke("gpa:reset-confirmation-timeout", threadId),
  setGpaFullAccess: (payload: { threadId: string; fullAccess: boolean }) =>
    ipcRenderer.invoke("gpa:set-full-access", payload),
  setKnowledgeEnabled: (payload: { threadId: string; knowledgeEnabled: boolean }) =>
    ipcRenderer.invoke("knowledge:set-enabled", payload),
  fetchProviderModels: (payload: {
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    type?: "mock" | "openai-compatible" | "anthropic" | "gemini" | "openrouter" | "ollama" | "vllm" | "gateway";
    id?: string;
  }) => ipcRenderer.invoke("models:fetch", payload) as Promise<Array<{ id: string; displayName?: string; contextWindow?: number }>>,
  testProviderModel: (payload: {
    provider: unknown;
    model: unknown;
  }) => ipcRenderer.invoke("models:test", payload),
  saveModelAgentCapability: (payload: {
    providerId: string;
    modelId: string;
    agentCapability: "verified" | "unsupported";
    agentCapabilityReason?: string;
  }) => ipcRenderer.invoke("models:save-capability", payload),
  getUpdateState: () => ipcRenderer.invoke("updates:state"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: (payload: { confirmInsecureHttp?: boolean }) => ipcRenderer.invoke("updates:download", payload),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("update:state", wrapped);
    return () => ipcRenderer.off("update:state", wrapped);
  },
  onRuntimeEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("runtime:event", wrapped);
    return () => ipcRenderer.off("runtime:event", wrapped);
  }
};

contextBridge.exposeInMainWorld("codexh", api);
