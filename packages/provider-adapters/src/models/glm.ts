import { defineCompat } from "./types";
import { gptCompat } from "./gpt";

/**
 * GLM (Zhipu) openai-compatible shell.
 *
 * Reference: Zhipu AI thinking docs
 * (https://docs.bigmodel.cn/cn/guide/capabilities/thinking).
 *
 * Verified against official docs (no override needed):
 *  - GLM-4.5+ models default to thinking.type="enabled" (auto-decide whether
 *    to reason), so reasoning_content is returned without an explicit param.
 *  - reasoning_content field path matches the GPT baseline exactly:
 *    stream delta.reasoning_content / non-stream message.reasoning_content.
 *  - tool_calls follow the OpenAI shape. GLM additionally offers a
 *    tool_stream flag for streaming tool args, but it defaults to off and the
 *    OpenAI shape is used as-is.
 *  - parallel_tool_calls support is model-dependent; configure it via
 *    ModelProfile.supportsParallelToolCalls rather than here.
 *
 * Tune here when you need to set reasoning_effort, force thinking on/off via
 * thinking.type, enable tool_stream, or adjust tool-call behaviour.
 */
export const glmCompat = defineCompat(gptCompat, {
  id: "glm",
  keywords: ["glm", "chatglm"]
});
