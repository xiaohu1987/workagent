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

type TimelineToolGroupEntry = {
  kind: string;
  toolCalls?: readonly { id: string }[] | null;
};

/**
 * Whether the group that owns `toolCallIds` is the newest tool group in the timeline.
 *
 * Only the tail batch may be handed over to the live runtime panel. That panel is fed by the
 * runtime activity stream, and the stream can lag the transcript, so the "latest root tool" may
 * still point at an earlier batch after a newer one has already rendered. Handing over the
 * earlier batch in that window dropped its records out of the middle of the chat while their
 * successors stayed on screen, and only reopening the thread brought them back.
 */
export function isLastToolGroupInTimeline(
  entries: readonly TimelineToolGroupEntry[],
  toolCallIds: readonly string[]
): boolean {
  const wanted = new Set(toolCallIds);
  let targetIndex = -1;
  let lastGroupIndex = -1;
  entries.forEach((entry, index) => {
    const toolCalls = entry.kind === "tool-group" ? entry.toolCalls : null;
    if (!toolCalls || toolCalls.length === 0) return;
    lastGroupIndex = index;
    if (targetIndex === -1 && toolCalls.some((toolCall) => wanted.has(toolCall.id))) {
      targetIndex = index;
    }
  });
  return targetIndex !== -1 && targetIndex === lastGroupIndex;
}
