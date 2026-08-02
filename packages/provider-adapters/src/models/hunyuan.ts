import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

/**
 * Tencent Hunyuan (混元) openai-compatible shell.
 *
 * Reference: Tencent Cloud Hunyuan OpenAI-compatible chat completions
 * (https://cloud.tencent.com/document/product/1729/111007). The endpoint
 * follows the OpenAI request/response shape, so the GPT baseline covers
 * tool_calls round trips, streaming deltas, and usage accounting.
 *
 * Tuned:
 *  - `normalizeRequestParams`: appends the shared Chinese-output reminder
 *    when the recent user conversation is Chinese. Hunyuan models drift
 *    into English whenever the system prompt and tool output are English
 *    (the agent harness prompt is English), even while the user writes in
 *    Chinese — reported as "总是出现英文". Same treatment as
 *    qwen/deepseek/kimi; the helper keeps an escape hatch for explicit
 *    user requests to answer in another language.
 *
 * Inherited from GPT baseline (no override needed):
 *  - tool_calls follow the OpenAI native function-calling shape (tools
 *    array + tool_call_id round trips).
 *  - streaming delta parsing and usage accounting.
 */
export const hunyuanCompat = defineCompat(gptCompat, {
  id: "hunyuan",
  keywords: ["hunyuan", "hy3", "混元"],
  normalizeRequestParams(ctx: ModelCompatContext, base: Record<string, unknown>): Record<string, unknown> {
    return preserveChineseOutputLanguage(ctx, gptCompat.normalizeRequestParams(ctx, base));
  }
});
