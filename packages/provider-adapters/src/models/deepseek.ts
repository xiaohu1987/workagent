import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import { gptCompat } from "./gpt";

/**
 * DeepSeek openai-compatible shell.
 *
 * Reference: DeepSeek API docs
 * (https://api-docs.deepseek.com/, https://www.deepseek4.net/zh-cn/docs/api-workflows).
 *
 * Tuned:
 *  - `normalizeRequestParams`:
 *    * Reasoning models (deepseek-reasoner, deepseek-r1, v4-flash/pro with
 *      thinking in the display name) reject temperature, top_p,
 *      frequency_penalty, presence_penalty, logprobs, top_logprobs,
 *      prompt_cache_id, and response_format. They are stripped to avoid
 *      HTTP 400.
 *    * Raises `max_tokens` to at least 8192 when the profile default is
 *      smaller. Observed incident: the default 4096 truncates long replies
 *      and apply_patch payloads mid-stream (`finish_reason: length`),
 *      which surfaces as "写入失败" (truncated tool arguments cannot be
 *      parsed) and "长文本丢失偏离" (truncated assistant message). 8192 is
 *      the documented deepseek-chat output ceiling; larger configured values
 *      are preserved.
 *  - `extractVisibleStreamText`: deepseek runs in native-tool-call mode
 *    (supportsToolCalling=true, no forceTextToolProtocol), so `content` is a
 *    natural-language reply, NOT a JSON decision envelope. The GPT baseline
 *    suppresses buffers that start with `{` or `<` to hide envelope text
 *    until it can be decoded — but that wrongly swallows deepseek's code
 *    blocks / JSON outputs, which is the "长文本丢失" symptom. This override
 *    only routes to the GPT envelope extractor when the buffer actually
 *    looks like an envelope (`"assistant_message"` substring); otherwise it
 *    returns the accumulated text verbatim so code/JSON content streams
 *    through.
 *
 * Inherited from GPT baseline (verified matching DeepSeek docs):
 *  - `extractReasoningFromDelta`/`extractReasoningFromMessage`: DeepSeek
 *    surfaces chain-of-thought via reasoning_content (stream
 *    delta.reasoning_content / non-stream message.reasoning_content).
 *  - tool_calls / JSON output: deepseek-chat / v4-flash follow the OpenAI
 *    native function-calling shape (verified agentCapability).
 *
 * Changes in this file never affect grok/glm/qwen/sensenova.
 */
export const deepseekCompat = defineCompat(gptCompat, {
  id: "deepseek",
  keywords: ["deepseek"],
  normalizeRequestParams(
    ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    const identity = `${ctx.model.id} ${ctx.model.displayName ?? ""}`.toLowerCase();
    const isReasoner = /reasoner|\br1\b|thinking/.test(identity);

    // 1. Reasoning models: strip fields the thinking API rejects (HTTP 400).
    let next: Record<string, unknown> = base;
    if (isReasoner) {
      const {
        temperature,
        top_p,
        frequency_penalty,
        presence_penalty,
        logprobs,
        top_logprobs,
        prompt_cache_id,
        response_format,
        ...rest
      } = base as Record<string, unknown> & {
        temperature?: unknown;
        top_p?: unknown;
        frequency_penalty?: unknown;
        presence_penalty?: unknown;
        logprobs?: unknown;
        top_logprobs?: unknown;
        prompt_cache_id?: unknown;
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
    return next;
  },
  extractVisibleStreamText(accumulated: string): string {
    // Only apply the GPT envelope extractor when the buffer really is a
    // decision envelope; otherwise pass content through verbatim so deepseek's
    // native-tool-call replies (including code/JSON blocks starting with `{`)
    // are not swallowed.
    if (accumulated.includes('"assistant_message"')) {
      return gptCompat.extractVisibleStreamText(accumulated);
    }
    return accumulated;
  }
});
