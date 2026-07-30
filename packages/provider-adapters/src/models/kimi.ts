import { stripThinkBlocksFromStream } from "../index";
import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

/**
 * Kimi (Moonshot AI) openai-compatible shell.
 *
 * Reference: Moonshot AI platform docs
 * (https://platform.moonshot.ai/docs/api/chat, https://platform.moonshot.cn/docs/api/chat).
 *
 * Tuned:
 *  - `normalizeRequestParams`:
 *    * Thinking models (kimi-thinking-preview, k2-thinking, any display name
 *      with "thinking") reject sampling fields — temperature, top_p,
 *      frequency_penalty, presence_penalty, logprobs, top_logprobs — and
 *      response_format. They are stripped to avoid HTTP 400, mirroring the
 *      deepseek-reasoner treatment.
 *    * Raises `max_tokens` to at least 8192 when the profile default is
 *      smaller. Same incident class as deepseek: a small cap truncates long
 *      replies and apply_patch payloads mid-stream (finish_reason: length),
 *      which surfaces as unparseable tool arguments. Larger configured
 *      values are preserved.
 *    * Appends the shared Chinese-output reminder when the conversation is
 *      Chinese, so English system prompts and tool output do not pull Kimi
 *      into replying in English.
 *  - `extractVisibleStreamText`: kimi-k2 runs in native-tool-call mode
 *    (supportsToolCalling=true), so `content` is a natural-language reply,
 *    NOT a JSON decision envelope. The GPT baseline suppresses buffers that
 *    start with `{` or `<`, which would swallow Kimi's code blocks / JSON
 *    outputs. Only route to the GPT envelope extractor when the buffer
 *    actually looks like an envelope (`"assistant_message"` substring);
 *    otherwise return the accumulated text verbatim.
 *
 * Inherited from GPT baseline (verified matching Moonshot docs):
 *  - `extractReasoningFromDelta`/`extractReasoningFromMessage`: Kimi thinking
 *    models surface chain-of-thought via reasoning_content (stream
 *    delta.reasoning_content / non-stream message.reasoning_content), the
 *    exact field path the baseline already reads.
 *  - tool_calls / JSON output: kimi-k2 follows the OpenAI native
 *    function-calling shape (tools array + tool_call_id round trips), and
 *    response_format json_object is supported on non-thinking models.
 *  - parallel_tool_calls is model-dependent; configure it via
 *    ModelProfile.supportsParallelToolCalls rather than here.
 *
 * Changes in this file never affect deepseek/grok/glm/qwen/sensenova/gpt.
 */
export const kimiCompat = defineCompat(gptCompat, {
  id: "kimi",
  keywords: ["kimi", "moonshot"],
  normalizeRequestParams(
    ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    const identity = `${ctx.model.id} ${ctx.model.displayName ?? ""}`.toLowerCase();
    const isThinking = /thinking/.test(identity);

    // 1. Thinking models: strip fields the thinking API rejects (HTTP 400).
    let next: Record<string, unknown> = base;
    if (isThinking) {
      const {
        temperature,
        top_p,
        frequency_penalty,
        presence_penalty,
        logprobs,
        top_logprobs,
        response_format,
        ...rest
      } = base as Record<string, unknown> & {
        temperature?: unknown;
        top_p?: unknown;
        frequency_penalty?: unknown;
        presence_penalty?: unknown;
        logprobs?: unknown;
        top_logprobs?: unknown;
        response_format?: unknown;
      };
      next = rest;
    }

    // 2. Raise max_tokens floor to 8192 to prevent mid-stream truncation
    //    (finish_reason: length) that breaks apply_patch arguments and
    //    truncates long replies. Larger configured values are preserved.
    const currentMax = next.max_tokens;
    if (typeof currentMax !== "number" || currentMax < 8192) {
      next = { ...next, max_tokens: 8192 };
    }
    return preserveChineseOutputLanguage(ctx, next);
  },
  extractVisibleStreamText(accumulated: string): string {
    // Only apply the GPT envelope extractor when the buffer really is a
    // decision envelope; otherwise pass content through verbatim so Kimi's
    // native-tool-call replies (including code/JSON blocks starting with `{`)
    // are not swallowed.
    if (accumulated.includes('"assistant_message"')) {
      return gptCompat.extractVisibleStreamText(accumulated);
    }
    return stripThinkBlocksFromStream(accumulated);
  }
});
