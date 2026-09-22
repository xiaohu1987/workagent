/**
 * Reasoning streams into the renderer frame by frame and then disappears the
 * moment the assistant draft is committed. The 深度思考 workspace tab keeps the
 * latest non-empty text per thread so it still shows what the model was thinking
 * about after the reply landed, instead of blanking out mid-read.
 */
export type ThinkingMemory = {
  threadId: string;
  text: string;
};

export function rememberThinkingText(
  previous: ThinkingMemory | null,
  threadId: string | null | undefined,
  reasoning: string | null | undefined
): ThinkingMemory | null {
  if (!threadId) return previous;
  const text = typeof reasoning === "string" ? reasoning : "";
  // Most frames are empty for a thread that is not thinking; never let those
  // clear what the tab is already displaying.
  if (!text.trim()) return previous;
  if (previous && previous.threadId === threadId && previous.text === text) return previous;
  return { threadId, text };
}

export function selectThinkingText(
  memory: ThinkingMemory | null,
  threadId: string | null | undefined
): string {
  if (!threadId || !memory || memory.threadId !== threadId) return "";
  return memory.text;
}
