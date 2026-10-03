/**
 * Verbatim media prompt policy.
 *
 * The image and video models must receive the user's own words. This module is
 * the only place that decides which text is handed to those models, so no
 * caller can silently translate, expand, shorten, restyle, or decorate the
 * user's request before it leaves the app.
 */

/** Internal turns (GPA confirmations, observer prompts, ...) are not user speech. */
export const INTERNAL_TURN_INPUT_PREFIX = "[internal:";

export type VerbatimMediaPromptInput = {
  /** Raw text of the current user turn, exactly as the user submitted it. */
  userInput: string;
  /**
   * Text the chat model proposed for the media tool call. It is only used when
   * the turn did not originate from the user (internal turns, blank input).
   */
  requestedPrompt?: string | null;
};

export type VerbatimMediaPromptResolution = {
  /** Text handed to the image/video model. */
  prompt: string;
  /** `user` means the prompt is the user's message, byte for byte. */
  source: "user" | "model";
};

/**
 * True when the turn text is user speech rather than an internal instruction.
 */
export function isUserOriginatedMediaPrompt(userInput: string): boolean {
  const text = String(userInput ?? "");
  if (!text.trim()) return false;
  return !text.trim().startsWith(INTERNAL_TURN_INPUT_PREFIX);
}

/**
 * Resolve the prompt sent to the image/video model.
 *
 * User-originated turns return the user's message unchanged: no trim, no
 * translation, no added style, composition, or lighting hints. Model-authored
 * text is only a fallback for turns that carry no user speech at all.
 */
export function resolveVerbatimMediaPrompt(
  input: VerbatimMediaPromptInput
): VerbatimMediaPromptResolution {
  if (isUserOriginatedMediaPrompt(input.userInput)) {
    return { prompt: input.userInput, source: "user" };
  }
  return { prompt: String(input.requestedPrompt ?? "").trim(), source: "model" };
}
