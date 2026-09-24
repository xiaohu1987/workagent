type DeferredToolGroupCall = {
  completedAt?: string | null;
  status?: "pending" | "running" | "completed" | "failed" | "denied" | "blocked";
};

/**
 * The tool calls of a group that may be hidden from the transcript because the live runtime
 * panel already shows them.
 *
 * Only a batch in which every call is still running counts as live status. A group that already
 * holds a finished call is history: hiding it until the next assistant message landed dropped
 * whole batches out of the middle of the chat and put them back a moment later, which is the
 * "tool records keep blinking in and out" report. The rule lives in its own module instead of
 * inline in the memo so the invariant stays covered by tests.
 */
export function resolveDeferredToolGroup<T extends DeferredToolGroupCall>(
  toolCalls: readonly T[],
  hasReplacementReply: boolean
): T[] | null {
  if (toolCalls.length === 0) return null;
  const everyCallIsActive = toolCalls.every((toolCall) => toolCall.status
    ? toolCall.status === "pending" || toolCall.status === "running"
    : !toolCall.completedAt);
  if (!everyCallIsActive) return null;
  return hasReplacementReply ? null : [...toolCalls];
}
