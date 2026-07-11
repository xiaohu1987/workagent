import { contextBridge, ipcRenderer } from "electron";

const api = {
  listThreads: () => ipcRenderer.invoke("threads:list"),
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
  listProjectFiles: (threadId: string) => ipcRenderer.invoke("projects:list-files", threadId),
  readProjectFile: (payload: { threadId: string; path: string }) =>
    ipcRenderer.invoke("projects:read-file", payload),
  deleteThread: (threadId: string) => ipcRenderer.invoke("threads:delete", threadId),
  getThreadSnapshot: (threadId: string) => ipcRenderer.invoke("threads:snapshot", threadId),
  sendMessage: (payload: { threadId: string; content: string }) =>
    ipcRenderer.invoke("threads:send", payload),
  interruptThread: (threadId: string) => ipcRenderer.invoke("threads:interrupt", threadId),
  updateThreadModelSelection: (payload: { threadId: string; providerId: string; modelId: string }) =>
    ipcRenderer.invoke("threads:update-model", payload),
  addThreadSkill: (payload: { threadId: string; skillId: string }) =>
    ipcRenderer.invoke("threads:add-skill", payload),
  openTerminal: (payload: { threadId: string; sessionId?: string }) => ipcRenderer.invoke("terminal:open", payload),
  writeTerminal: (payload: { threadId: string; input: string; sessionId?: string }) =>
    ipcRenderer.invoke("terminal:write", payload),
  closeTerminal: (payload: { threadId: string; sessionId?: string }) => ipcRenderer.invoke("terminal:close", payload),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  installPlugin: (source: string) => ipcRenderer.invoke("plugins:install", source),
  setProjectPluginEnabled: (payload: { threadId: string; pluginId: string; enabled: boolean }) =>
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
  importKnowledge: (payload: {
    displayName: string;
    scope: "global" | "project" | "imported";
    sourcePaths: string[];
    threadId?: string;
  }) => ipcRenderer.invoke("knowledge:import", payload),
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
  resolveApproval: (
    id: string,
    resolution: { decision: "approved" | "denied"; mode?: "once" | "session" | "remember" }
  ) => ipcRenderer.invoke("approval:resolve", { id, resolution }),
  answerPrompt: (id: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("prompt:answer", { id, answers }),
  getGpaState: (threadId: string) => ipcRenderer.invoke("gpa:state", threadId),
  setGpaStage: (payload: { threadId: string; stage: "off" | "goal" | "plan" | "act" }) =>
    ipcRenderer.invoke("gpa:set-stage", payload),
  setGpaFullAccess: (payload: { threadId: string; fullAccess: boolean }) =>
    ipcRenderer.invoke("gpa:set-full-access", payload),
  fetchProviderModels: (payload: {
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    type?: "mock" | "openai-compatible" | "anthropic" | "gemini" | "openrouter" | "ollama" | "vllm" | "gateway";
    id?: string;
  }) => ipcRenderer.invoke("models:fetch", payload),
  onRuntimeEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("runtime:event", wrapped);
    return () => ipcRenderer.off("runtime:event", wrapped);
  }
};

contextBridge.exposeInMainWorld("codexh", api);
