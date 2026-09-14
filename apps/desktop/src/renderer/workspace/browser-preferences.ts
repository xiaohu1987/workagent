export const MAX_MOUNTED_BROWSER_THREADS = 2;

export type BrowserOpenRuntimeEvent = {
  type: string;
  threadId?: string;
  payload?: { action?: string; silentBrowserOpen?: boolean };
};

export function selectMountedBrowserThreadIds(input: {
  selectedThreadId: string | null;
  browserPanelVisible: boolean;
  threads: Array<{ id: string; status?: string }>;
  tabsByThread: Record<string, unknown[] | undefined>;
  limit?: number;
}): string[] {
  const limit = Math.max(1, input.limit ?? MAX_MOUNTED_BROWSER_THREADS);
  const hasTabs = (threadId: string) => (input.tabsByThread[threadId]?.length ?? 0) > 0;
  const mounted: string[] = [];
  const add = (threadId: string | null | undefined) => {
    if (!threadId || mounted.includes(threadId) || !hasTabs(threadId) || mounted.length >= limit) return;
    mounted.push(threadId);
  };
  const hasActiveTask = input.threads.some((thread) => thread.status === "running" || thread.status === "waiting");

  if (input.browserPanelVisible) add(input.selectedThreadId);
  for (const thread of input.threads) {
    if (thread.status === "running" || thread.status === "waiting") add(thread.id);
  }
  if (hasActiveTask) {
    for (const threadId of Object.keys(input.tabsByThread).reverse()) {
      if (threadId === input.selectedThreadId) continue;
      add(threadId);
    }
  }
  return mounted;
}

export function shouldRevealBrowserWorkspace(
  event: BrowserOpenRuntimeEvent,
  selectedThreadId: string | null
): boolean {
  return (
    event.type === "browser.updated" &&
    event.threadId === selectedThreadId &&
    event.payload?.action === "open" &&
    event.payload.silentBrowserOpen === false
  );
}
