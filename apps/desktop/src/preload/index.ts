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
  deleteThread: (threadId: string) => ipcRenderer.invoke("threads:delete", threadId),
  getThreadSnapshot: (threadId: string) => ipcRenderer.invoke("threads:snapshot", threadId),
  sendMessage: (payload: { threadId: string; content: string }) =>
    ipcRenderer.invoke("threads:send", payload),
  interruptThread: (threadId: string) => ipcRenderer.invoke("threads:interrupt", threadId),
  updateThreadModelSelection: (payload: { threadId: string; providerId: string; modelId: string }) =>
    ipcRenderer.invoke("threads:update-model", payload),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  installPlugin: (source: string) => ipcRenderer.invoke("plugins:install", source),
  setProjectPluginEnabled: (payload: { threadId: string; pluginId: string; enabled: boolean }) =>
    ipcRenderer.invoke("plugins:set-enabled", payload),
  getConfig: () => ipcRenderer.invoke("config:get"),
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
  resolveApproval: (
    id: string,
    resolution: { decision: "approved" | "denied"; mode?: "once" | "session" | "remember" }
  ) => ipcRenderer.invoke("approval:resolve", { id, resolution }),
  answerPrompt: (id: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("prompt:answer", { id, answers }),
  onRuntimeEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on("runtime:event", wrapped);
    return () => ipcRenderer.off("runtime:event", wrapped);
  }
};

contextBridge.exposeInMainWorld("codexh", api);
