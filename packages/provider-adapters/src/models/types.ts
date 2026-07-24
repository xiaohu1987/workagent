import type { ModelProfile, ProviderTurnDecision, ProviderTurnInput } from "@shared-types";

/**
 * Context handed to every {@link ModelCompat} hook. It bundles the model
 * profile with the full turn input so per-model overrides can read flags
 * (supportsToolCalling, supportsJsonOutput, ...) and the transcript without
 * having to thread additional parameters.
 */
export interface ModelCompatContext {
  model: ModelProfile;
  input: ProviderTurnInput;
}

/**
 * Lightweight context for image/video generation hooks. Only the model and
 * prompt are needed because generation does not flow through the chat
 * transcript.
 */
export interface ModelGenerationContext {
  model: ModelProfile;
  prompt: string;
}

/**
 * Result of {@link ModelCompat.resolveToolCallMode}. Decides whether the
 * provider sends native function tools and whether it falls back to the
 * `json_object` response format when native tools are disabled.
 */
export interface ModelCompatToolCallMode {
  useNativeTools: boolean;
  useJsonOutput: boolean;
}

/**
 * Image generation protocol family. Mirrors the historical
 * `imageGenerationProtocolForModel` values so existing behaviour is
 * preserved when a model shell delegates to the GPT baseline.
 */
export type ImageGenerationProtocol =
  | "gpt-image-api"
  | "gpt-responses"
  | "grok-images"
  | "openai-compatible";

/**
 * Plan returned by {@link ModelCompat.resolveImageGeneration}. The provider
 * either:
 *  - dispatches through the OpenAI SDK `images.generate` when `protocol` is
 *    `"openai-compatible"` (endpoint/payload are ignored), or
 *  - calls the shared `requestImage(endpoint, payload)` helper for the
 *    other protocols, using `label` for error messages.
 */
export interface ImageGenerationPlan {
  protocol: ImageGenerationProtocol;
  /** Required when `protocol !== "openai-compatible"`. */
  endpoint?: string;
  payload: Record<string, unknown>;
  /** Error label passed to `requestImage`; defaults to "Image generation request". */
  label?: string;
}

/**
 * Plan returned by {@link ModelCompat.resolveVideoGeneration}. The provider
 * POSTs `payload` to `endpoint`, then runs the unified poll/extract loop.
 */
export interface VideoGenerationPlan {
  /** Free-form protocol tag for logs/diagnostics (e.g. "openai-compatible"). */
  protocol: string;
  endpoint: string;
  payload: Record<string, unknown>;
}

/**
 * Per-model compatibility strategy for the openai-compatible provider path.
 *
 * Each model (gpt, deepseek, grok, glm, qwen, sensenova, ...) ships its own
 * file under `packages/provider-adapters/src/models/`. The default behaviour
 * lives in `gpt.ts`; other models start as thin shells via
 * {@link defineCompat} and override only the hooks they need to tune.
 *
 * Hooks cover the dimensions agreed with the user:
 *  - chat request params  -> {@link normalizeRequestParams}
 *  - chat tool call mode  -> {@link resolveToolCallMode}
 *  - chat response/stream -> {@link extractVisibleStreamText} + {@link parseResponse}
 *  - image generation     -> {@link resolveImageGeneration}
 *  - video generation     -> {@link resolveVideoGeneration}
 *
 * Hooks are required (not optional) so the type system forces every shell to
 * either implement or inherit them. Shells inherit by spreading the GPT base
 * through {@link defineCompat}, which keeps "薄壳互不干扰" true: tuning one
 * model never touches another's file.
 */
export interface ModelCompat {
  /** Stable identifier for logs/diagnostics, e.g. "deepseek". */
  readonly id: string;
  /** Lower-case keywords matched against `model.id` + `model.displayName`. */
  readonly keywords: readonly string[];

  /** Decide native tool calling and JSON output fallback for this turn. */
  resolveToolCallMode(ctx: ModelCompatContext): ModelCompatToolCallMode;

  /**
   * Adjust the chat request payload built by the provider (model, messages,
   * temperature, max_tokens, tools, response_format, ...). Return the
   * patched object. The base already reflects the tool-call decision, so
   * overrides typically add model-specific fields (e.g. reasoning flags).
   */
  normalizeRequestParams(
    ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown>;

  /**
   * Extract the user-visible text from an accumulated stream buffer. Used
   * both to feed `onTextDelta` and to suppress control JSON / thinking tags
   * (e.g. deepseek reasoning_content) until they can be decoded.
   */
  extractVisibleStreamText(accumulated: string): string;

  /**
   * Parse a non-streaming chat completion response into a decision. Also
   * used when a streaming request falls back to a single response object.
   */
  parseResponse(
    response: any,
    ctx: ModelCompatContext,
    hasNativeTools: boolean
  ): ProviderTurnDecision;

  /**
   * Extract a reasoning fragment from a streaming chunk delta. Models that
   * surface chain-of-thought (deepseek-reasoner, qwen-qwq, glm-thinking)
   * return it in `delta.reasoning_content`; the GPT baseline reads that field
   * and returns "" when absent. The provider accumulates fragments and fills
   * `ProviderTurnDecision.reasoningSummary`.
   */
  extractReasoningFromDelta(delta: any): string;

  /**
   * Extract the full reasoning text from a non-streaming message. Same
   * field convention as {@link extractReasoningFromDelta}.
   */
  extractReasoningFromMessage(message: any): string;

  /**
   * Resolve the image generation plan for this model. GPT baseline mirrors
   * `imageGenerationProtocolForModel` (gpt-image-api / gpt-responses /
   * openai-compatible SDK). grok overrides this to emit the grok-images
   * protocol. Tune here when a model needs a different endpoint or payload.
   */
  resolveImageGeneration(ctx: ModelGenerationContext): ImageGenerationPlan;

  /**
   * Resolve the video generation plan for this model. GPT baseline posts to
   * `/videos/generations` with the default duration/aspect/resolution. Tune
   * here when a model needs a different create endpoint or payload.
   */
  resolveVideoGeneration(ctx: ModelGenerationContext): VideoGenerationPlan;
}

/**
 * Build a per-model compat by inheriting every hook from a base (normally
 * {@link gptCompat}) and overriding only the fields that need tuning. This
 * is the only sanctioned way to create shells, so a shell can never
 * accidentally drop a hook and silently fall back to undefined behaviour.
 */
export function defineCompat(
  base: ModelCompat,
  override: Partial<Omit<ModelCompat, "keywords">> & { keywords: readonly string[] }
): ModelCompat {
  return { ...base, ...override, keywords: override.keywords };
}
