import { defineCompat } from "./types";
import type { ImageGenerationPlan, ModelGenerationContext } from "./types";
import { gptCompat } from "./gpt";

/**
 * Grok (xAI) openai-compatible shell.
 *
 * Reference: xAI official API docs
 * (https://docs.xai.ac.cn/docs/guides/image-generations,
 *  https://www.atlascloud.ai/zh/blog/guides/grok-imagine-video-generation,
 *  https://docs.xai.ac.cn/docs/guides/deferred-chat-completions).
 *
 * Tuned:
 *  - `resolveImageGeneration`: only image models (id/displayName contains
 *    "image") route to the grok-images protocol. xAI image generation uses
 *    `/images/generations` and does NOT accept OpenAI's `size`/`quality`/
 *    `style` params; output is JPG (provider infers mime from the response
 *    content-type, so no mime override is needed here). Non-image grok
 *    models (grok-3, grok-4, ...) delegate to the GPT baseline's
 *    openai-compatible SDK path instead of forcing grok-images.
 *
 * Inherited from GPT baseline (verified matching xAI docs):
 *  - `resolveVideoGeneration`: xAI video uses `/videos/generations` create +
 *    `/videos/{request_id}` poll, status values pending/done/expired/failed,
 *    payload fields model/prompt/duration/aspect_ratio/resolution — identical
 *    to the GPT baseline plan, so no override. (xAI also supports an `image`
 *    field for image-to-video, but generateVideo's signature has no image
 *    input, so that path is out of scope here.)
 *  - `extractReasoningFromDelta`/`extractReasoningFromMessage`: xAI surfaces
 *    chain-of-thought via `reasoning_content` (grok-4 does not return it).
 *    The GPT baseline already reads that field, so grok inherits; when
 *    reasoning_content is absent (grok-4), the hooks return "" and
 *    reasoningSummary stays undefined.
 *  - chat tool call / streaming: xAI is OpenAI-compatible (tool_calls shape,
 *    usage on the final chunk via stream_options.include_usage).
 *
 * Changes in this file never affect deepseek/glm/qwen/sensenova/gpt.
 */
export const grokCompat = defineCompat(gptCompat, {
  id: "grok",
  keywords: ["grok"],
  resolveImageGeneration({ model, prompt }: ModelGenerationContext): ImageGenerationPlan {
    const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
    if (!identity.includes("image")) {
      // Non-image grok models (grok-3, grok-4, ...) are not image generators.
      // Delegate to the GPT baseline rather than forcing the grok-images
      // protocol onto a chat model.
      return gptCompat.resolveImageGeneration({ model, prompt });
    }
    // xAI image generation: POST /images/generations with model/prompt/n.
    // size/quality/style are NOT supported by xAI and are intentionally
    // omitted (sending them triggers HTTP 400). Output is JPG.
    return {
      protocol: "grok-images",
      endpoint: "/images/generations",
      payload: { model: model.id, prompt, n: 1 },
      label: "Grok image generation request"
    };
  }
});
