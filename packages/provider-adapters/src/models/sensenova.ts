import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import { gptCompat } from "./gpt";

/**
 * SenseNova (SenseTime) openai-compatible shell.
 *
 * Reference: SenseNova OpenAI compatible-mode docs
 * (https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode).
 *
 * Tuned:
 *  - `normalizeRequestParams`: SenseNova's compatible mode uses
 *    `max_completion_tokens` (OpenAI new-style) instead of `max_tokens`.
 *    Sending `max_tokens` is silently ignored, so without this rename the
 *    model would run without an output cap. The field is renamed when
 *    present.
 *
 * Inherited from GPT baseline (verified against SenseNova docs):
 *  - chat completions: SenseNova accepts the OpenAI messages structure, SSE
 *    stream format (`data: {json}` + `[DONE]`), and Bearer auth.
 *  - reasoning: SenseNova accepts `reasoning_effort` (medium/low) on the
 *    request side, but the response-side reasoning_content field is not
 *    documented. The GPT baseline's extractReasoningFrom* hooks return ""
 *    safely when the field is absent.
 *  - tool_calls: SenseNova docs do not document the tools/tool_choice shape
 *    (a private `plugins` param exists). The GPT baseline tool-call path is
 *    left in place; tune here once a real SenseNova tool envelope is
 *    observed.
 *
 * SenseNova-specific params not surfaced here (repetition_penalty, plugins,
 * reasoning_effort) are intentionally omitted because the provider does not
 * build them; add them in normalizeRequestParams when needed.
 *
 * Changes in this file never affect deepseek/grok/glm/qwen/gpt.
 */
export const senseNovaCompat = defineCompat(gptCompat, {
  id: "sensenova",
  keywords: ["sensenova", "sense-nova", "sense_nova", "sensechat"],
  normalizeRequestParams(
    _ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    // SenseNova's compatible mode uses max_completion_tokens, not max_tokens.
    const {
      max_tokens,
      ...rest
    } = base as { max_tokens?: unknown } & Record<string, unknown>;
    if (max_tokens === undefined || max_tokens === null) return rest;
    return { ...rest, max_completion_tokens: max_tokens };
  }
});
