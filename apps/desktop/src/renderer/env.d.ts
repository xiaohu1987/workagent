declare global {
  interface Window {
    codexh: {
      listThreads: () => Promise<any[]>;
      createThread: (payload: {
        title: string;
        mode: "project" | "chat";
        cwd?: string | null;
        providerId?: string | null;
        modelId?: string | null;
      }) => Promise<any>;
      deleteThread: (threadId: string) => Promise<void>;
      getThreadSnapshot: (threadId: string) => Promise<any>;
      sendMessage: (payload: { threadId: string; content: string }) => Promise<void>;
      interruptThread: (threadId: string) => Promise<void>;
      updateThreadModelSelection: (payload: {
        threadId: string;
        providerId: string;
        modelId: string;
      }) => Promise<any>;
      listSkills: () => Promise<any[]>;
      listPlugins: () => Promise<any[]>;
      installPlugin: (source: string) => Promise<any>;
      setProjectPluginEnabled: (payload: {
        threadId: string;
        pluginId: string;
        enabled: boolean;
      }) => Promise<any>;
      getConfig: () => Promise<any>;
      saveConfig: (config: unknown) => Promise<void>;
      importKnowledge: (payload: {
        displayName: string;
        scope: "global" | "project" | "imported";
        sourcePaths: string[];
        threadId?: string;
      }) => Promise<any>;
      openBrowserTab: (payload: { threadId: string; url: string }) => Promise<any>;
      navigateBrowserTab: (payload: { threadId: string; tabId: string; url: string }) => Promise<any>;
      focusBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      reloadBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      goBackBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
      goForwardBrowserTab: (payload: { threadId: string; tabId: string }) => Promise<any>;
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
      onRuntimeEvent: (listener: (event: unknown) => void) => () => void;
    };
  }
}

export {};
