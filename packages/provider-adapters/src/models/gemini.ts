import { isGptReasoningEffort } from "@shared-types";
import { surfaceThinkBlocksInStream } from "../index";
import { defineCompat } from "./types";
import type {
  ImageGenerationPlan,
  ModelCompatContext,
  ModelGenerationContext
} from "./types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

/**
 * Google Gemini openai-compatible shell.
 *
 * Reference: Gemini API OpenAI compatibility docs
 * (https://ai.google.dev/gemini-api/docs/openai; compatible base URL
 *  https://generativelanguage.googleapis.com/v1beta/openai/).
 *
 * Tuned:
 *  - `normalizeRequestParams`:
 *    * Passes the turn's reasoning effort through as `reasoning_effort`.
 *      Gemini 2.5/3 models accept minimal/low/medium/high (and "none" to
 *      disable thinking on 2.5 Flash-class models; 2.5 Pro / 3 series cannot
 *      disable it and will surface Google's own error, which is the intended
 *      user feedback for an impossible configuration). The GPT baseline only
 *      injects reasoning_effort for GPT reasoning models, so Gemini would
 *      silently drop the user's configured effort without this. "xhigh" maps
 *      to "high" (the highest Gemini level).
 *    * Raises `max_tokens` to at least 8192 when the profile default is
 *      smaller (Gemini 2.5 allows up to 64K output). Same incident class as
 *      deepseek: a small cap truncates long replies and apply_patch payloads
 *      mid-stream (finish_reason: length). Larger configured values are kept.
 *    * Appends the shared Chinese-output reminder when the conversation is
 *      Chinese, so English system prompts and tool output do not pull Gemini
 *      into replying in English.
 *  - `extractVisibleStreamText`: Gemini runs in native-tool-call mode, so
 *    `content` is a natural-language reply, NOT a JSON decision envelope.
 *    Only route to the GPT envelope extractor when the buffer actually looks
 *    like an envelope (`"assistant_message"` substring); otherwise pass the
 *    accumulated text through the shared think-block stripper so code/JSON
 *    blocks starting with `{` are not swallowed and reasoning-style models
 *    behind relays never leak <think> markup.
 *  - `resolveImageGeneration` (gemini-2.5-flash-image, gemini-3-pro-image-preview,
 *    imagen-*): the OpenAI-compatible endpoint officially supports
 *    POST /images/generations with prompt/model/n/response_format — the
 *    documented example uses b64_json. The plan pins exactly that supported
 *    parameter set (no `size`: aspect control on Gemini image models lives in
 *    extra_body.aspect_ratio, and unknown params are silently ignored, so
 *    sending a hardcoded size would only risk surprises). Non-image Gemini
 *    models (gemini-2.5-flash/pro chat models) fail loudly instead of
 *    delegating to the baseline SDK path, which gateway relays may silently
 *    remap to another vendor's image model.
 *
 * Inherited from GPT baseline (verified matching Google docs):
 *  - `extractReasoningFromDelta`/`extractReasoningFromMessage`: the OpenAI
 *    compatibility layer surfaces Gemini thinking summaries via
 *    reasoning_content (stream delta.reasoning_content / non-stream
 *    message.reasoning_content), the exact field path the baseline reads.
 *  - tool_calls / JSON output: function calling follows the OpenAI shape
 *    (tools array + tool_call_id round trips); structured output via
 *    response_format is supported.
 *  - stream_options.include_usage: the baseline always requests it, which is
 *    exactly what Gemini requires to emit chunk.usage.
 *
 * Changes in this file never affect deepseek/grok/glm/qwen/sensenova/kimi/agnes/gpt.
 */
export const geminiCompat = defineCompat(gptCompat, {
  id: "gemini",
  keywords: ["gemini", "imagen"],
  normalizeRequestParams(
    ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    let next: Record<string, unknown> = base;

    // 1. Pass through the configured reasoning effort (the GPT baseline only
    //    injects reasoning_effort for GPT reasoning models). "xhigh" maps to
    //    "high", Gemini's highest documented level.
    const effort = ctx.input.reasoningEffort;
    if (isGptReasoningEffort(effort)) {
      next = { ...next, reasoning_effort: effort === "xhigh" ? "high" : effort };
    } else if (effort === "none") {
      // Disables thinking on 2.5 Flash-class models. On models that cannot
      // disable thinking (2.5 Pro / 3 series) Google returns its own error,
      // which is the intended feedback for an impossible configuration.
      next = { ...next, reasoning_effort: "none" };
    } else if (effort === "minimal") {
      next = { ...next, reasoning_effort: "minimal" };
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
    // decision envelope; otherwise pass content through the shared think-block
    // surfacer so Gemini's native-tool-call replies (including code/JSON
    // blocks starting with `{`) are not swallowed, and relay-mapped reasoning
    // shows in the draft without leaking <think> markup.
    if (accumulated.includes('"assistant_message"')) {
      return gptCompat.extractVisibleStreamText(accumulated);
    }
    return surfaceThinkBlocksInStream(accumulated);
  },
  resolveImageGeneration({ model, prompt }: ModelGenerationContext): ImageGenerationPlan {
    const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
    const isImageModel = identity.includes("image") || identity.includes("imagen");
    if (!isImageModel) {
      // Chat-only Gemini models (gemini-2.5-flash, gemini-2.5-pro, ...) are NOT
      // image generators. Fail loudly instead of delegating to the baseline
      // SDK path, which gateway relays may silently remap to another vendor's
      // image model (the "wrong image" incident class).
      throw new Error(
        `模型「${model.displayName || model.id}」不是图片生成模型，无法用于生成图片。` +
        `请到「设置 → 多模态」将默认图片模型切换为 Gemini 的图片模型（如 gemini-2.5-flash-image）后再试。`
      );
    }
    // The OpenAI-compatible endpoint documents images/generations with
    // prompt/model/n/size/response_format and silently ignores anything else.
    // Pin the documented set: b64_json (the documented example) and no size —
    // aspect control lives in extra_body.aspect_ratio, which the runtime does
    // not currently expose.
    return {
      protocol: "gemini-images",
      endpoint: "/images/generations",
      payload: { model: model.id, prompt, n: 1, response_format: "b64_json" },
      label: "Gemini image generation request"
    };
  }
});
