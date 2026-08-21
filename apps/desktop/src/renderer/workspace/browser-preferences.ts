export type BrowserOpenRuntimeEvent = {
  type: string;
  threadId?: string;
  payload?: { action?: string; silentBrowserOpen?: boolean };
};

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
