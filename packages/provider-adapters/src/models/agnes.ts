import { isGptReasoningEffort } from "@shared-types";
import { stripThinkBlocksFromStream } from "../index";
import { defineCompat } from "./types";
import type {
  ImageGenerationPlan,
  ModelCompatContext,
  ModelGenerationContext,
  VideoGenerationPlan
} from "./types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

/**
 * Agnes AI openai-compatible shell.
 *
 * Reference: Agnes AI official docs
 * (https://agnes-ai.com/doc/agnes-20-flash, https://agnes-ai.com/doc/agnes-image-21-flash,
 *  https://agnes-ai.com/doc/agnes-video-v20; gateway https://apihub.agnes-ai.com/v1).
 *
 * Tuned:
 *  - `normalizeRequestParams`:
 *    * Thinking mode (agnes-2.0-flash) is enabled via the OpenAI-compatible
 *      extension field `chat_template_kwargs: { enable_thinking: true }`. It is
 *      injected only when the turn carries an explicit reasoning effort
 *      (low/medium/high/xhigh); none/minimal/undefined leaves the model in its
 *      default non-thinking mode.
 *    * Raises `max_tokens` to at least 8192 when the profile default is
 *      smaller (agnes-2.0-flash allows ~64K output). Same incident class as
 *      deepseek: a small cap truncates long replies and apply_patch payloads
 *      mid-stream (finish_reason: length). Larger configured values are kept.
 *    * Appends the shared Chinese-output reminder when the conversation is
 *      Chinese, so English system prompts and tool output do not pull Agnes
 *      into replying in English.
 *  - `extractVisibleStreamText`: agnes-2.0-flash runs in native-tool-call
 *    mode, so `content` is a natural-language reply, NOT a JSON decision
 *    envelope. Only route to the GPT envelope extractor when the buffer
 *    actually looks like an envelope (`"assistant_message"` substring);
 *    otherwise return the accumulated text verbatim so code/JSON blocks
 *    starting with `{` are not swallowed.
 *  - `resolveImageGeneration` (agnes-image-2.0/2.1-flash): the gateway
 *    REJECTS a top-level `response_format` field (documented HTTP 400), which
 *    is exactly what the GPT baseline's OpenAI SDK images.generate path sends.
 *    The plan therefore dispatches through the shared requestImage helper
 *    with a custom payload: `size` is required (tier value "1K"; legacy exact
 *    sizes are normalized server-side), and base64 output is requested via
 *    the top-level `return_base64: true` switch. The standard
 *    `data[0].b64_json` response shape is already handled by the baseline
 *    extractor.
 *  - `resolveVideoGeneration` (agnes-video-v2.0): POSTs to `/videos` with the
 *    documented standard parameter set (width/height/num_frames/frame_rate;
 *    num_frames follows the 8n+1 rule, 121 frames @ 24fps ≈ 5s). The create
 *    response carries `id`/`task_id` (captured by the baseline request-id
 *    extractor) and the legacy poll endpoint `GET /v1/videos/{task_id}` —
 *    still officially supported — matches the baseline poll URL shape, while
 *    `status: "completed"` / `"failed"` match the baseline status sets. The
 *    final MP4 URL lives in `metadata.url`, which the baseline video payload
 *    extractor reads via its metadata branch.
 *
 * Inherited from GPT baseline:
 *  - `extractReasoningFromDelta`/`extractReasoningFromMessage`: Agnes'
 *    `chat_template_kwargs.enable_thinking` convention follows the Qwen-style
 *    thinking mode, whose chain-of-thought surfaces via reasoning_content
 *    (stream delta.reasoning_content / non-stream message.reasoning_content) —
 *    the exact field path the baseline already reads.
 *  - tool_calls / JSON output: agnes-2.0-flash follows the OpenAI native
 *    function-calling shape (tools array + tool_call_id round trips).
 *
 * Changes in this file never affect deepseek/grok/glm/qwen/sensenova/kimi/gpt.
 */
export const agnesCompat = defineCompat(gptCompat, {
  id: "agnes",
  keywords: ["agnes"],
  normalizeRequestParams(
    ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    let next: Record<string, unknown> = base;

    // 1. Enable thinking mode only when an explicit reasoning effort is set.
    if (isGptReasoningEffort(ctx.input.reasoningEffort)) {
      const existingKwargs =
        next.chat_template_kwargs && typeof next.chat_template_kwargs === "object" && !Array.isArray(next.chat_template_kwargs)
          ? next.chat_template_kwargs as Record<string, unknown>
          : {};
      next = {
        ...next,
        chat_template_kwargs: { ...existingKwargs, enable_thinking: true }
      };
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
    // decision envelope; otherwise pass content through verbatim so Agnes'
    // native-tool-call replies (including code/JSON blocks starting with `{`)
    // are not swallowed.
    if (accumulated.includes('"assistant_message"')) {
      return gptCompat.extractVisibleStreamText(accumulated);
    }
    return stripThinkBlocksFromStream(accumulated);
  },
  resolveImageGeneration({ model, prompt }: ModelGenerationContext): ImageGenerationPlan {
    return {
      protocol: "agnes-images",
      endpoint: "/images/generations",
      payload: {
        model: model.id,
        prompt,
        // `size` is required by the gateway. Tier values (1K/2K/3K/4K) are
        // recommended; "1K" with the default 1:1 ratio matches the baseline
        // 1024x1024 default.
        size: "1K",
        // Top-level response_format is rejected by the gateway (HTTP 400);
        // base64 output for text-to-image is requested via return_base64.
        return_base64: true
      },
      label: "Agnes image generation request"
    };
  },
  resolveVideoGeneration({ model, prompt }: ModelGenerationContext): VideoGenerationPlan {
    return {
      protocol: "agnes-videos",
      endpoint: "/videos",
      payload: {
        model: model.id,
        prompt,
        // Documented standard settings: 121 frames @ 24fps ≈ 5s. num_frames
        // must follow the 8n+1 rule and stay <= 441.
        width: 1152,
        height: 768,
        num_frames: 121,
        frame_rate: 24
      }
    };
  }
});
