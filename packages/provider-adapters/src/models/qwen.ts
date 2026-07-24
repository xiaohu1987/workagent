import { defineCompat } from "./types";
import { gptCompat } from "./gpt";

/**
 * Qwen (Alibaba) openai-compatible shell.
 *
 * Reference: Qwen thinking-mode docs
 * (https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking).
 *
 * Verified against official docs (no override needed for default behaviour):
 *  - reasoning_content field path matches the GPT baseline exactly:
 *    stream delta.reasoning_content / non-stream message.reasoning_content.
 *  - tool_calls follow the OpenAI shape (tools array + tool_call_id round
 *    trips), including in thinking mode where reasoning_content must be
 *    echoed back on subsequent turns (handled by the transcript builder).
 *  - Pure-reasoning models (qwq-plus, qwen3-*-thinking) always emit
 *    reasoning_content; mixed-mode models (qwen3-max/plus/flash/turbo)
 *    default to thinking OFF on commercial tiers and ON on open-source tiers.
 *
 * Not surfaced here (intentional):
 *  - `enable_thinking` / `thinking_budget` / `preserve_thinking` are
 *    non-standard params that the OpenAI SDK expects via extra_body. They are
 *    omitted by default to respect each model's native default. Add them in
 *    normalizeRequestParams when you want to force thinking on/off for a
 *    specific deployment.
 *  - DashScope native mode uses a different base URL (/compatible-mode/v1 vs
 *    /api/v1) and list-shaped content; that is a baseUrl/config concern, not
 *    a compat-layer concern.
 *
 * Tune here when you need to force enable_thinking, set thinking_budget, or
 * adjust tool-call behaviour.
 */
export const qwenCompat = defineCompat(gptCompat, {
  id: "qwen",
  keywords: ["qwen", "tongyi"]
});
