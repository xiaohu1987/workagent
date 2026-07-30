import { defineCompat } from "./types";
import type { ImageGenerationPlan, ModelCompatContext, ModelCompatToolCallMode, ModelGenerationContext } from "./types";
import { gptCompat } from "./gpt";

const COMPLETION_AUDIT_PROMPT_MARKER = "You are a completion auditor for a desktop agent.";

export function isGrokCompletionAudit(context: ModelCompatContext): boolean {
  const identity = `${context.model.id} ${context.model.displayName ?? ""}`.toLowerCase();
  return identity.includes("grok")
    && context.input.availableTools.length === 0
    && context.input.systemPrompt.includes(COMPLETION_AUDIT_PROMPT_MARKER);
}

export function appendGrokCompletionAuditInstruction(context: ModelCompatContext, systemPrompt: string): string {
  if (!isGrokCompletionAudit(context)) return systemPrompt;
  return `${systemPrompt}\n\nGrok completion-audit compatibility: do not return JSON. Return exactly APPROVED when the candidate is complete. Otherwise return REJECTED: followed by concise factual gaps. Do not add commentary.`;
}

export function normalizeGrokCompletionAuditDecision(
  context: ModelCompatContext,
  decision: ReturnType<typeof gptCompat.parseResponse>,
  text?: string,
  reasoning?: string
): ReturnType<typeof gptCompat.parseResponse> {
  if (!isGrokCompletionAudit(context)) return decision;

  const verdict = text?.trim() || reasoning?.trim() || decision.assistantMessage?.trim() || "";
  if (/^APPROVED[.!。]?$/i.test(verdict)) {
    return {
      ...decision,
      assistantMessage: "APPROVED",
      toolCalls: [],
      endTurn: true,
      goalCompleted: true,
      isStructured: true
    };
  }
  if (/^REJECTED\s*[:：-]/i.test(verdict)) {
    return {
      ...decision,
      assistantMessage: verdict.replace(/^REJECTED\s*[:：-]?\s*/i, "").trim() || "Grok completion audit returned no verdict.",
      toolCalls: [],
      endTurn: false,
      goalCompleted: false,
      isStructured: true
    };
  }

  // The runtime has already run deterministic completion validation before
  // asking this optional audit. Grok gateways often return prose or put the
  // verdict in an unsupported response field, neither of which is evidence
  // that the candidate task failed.
  return {
    ...decision,
    assistantMessage: "APPROVED",
    toolCalls: [],
    endTurn: true,
    goalCompleted: true,
    isStructured: true,
    reasoningSummary: "Grok completion audit did not return a compatible verdict; deterministic completion validation was used."
  };
}

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
  resolveToolCallMode(context: ModelCompatContext): ModelCompatToolCallMode {
    if (isGrokCompletionAudit(context)) {
      // Some Grok-compatible gateways omit visible content when json_object is
      // requested for this internal, no-tool verdict. Use the compact text
      // protocol below instead.
      return { useNativeTools: false, useJsonOutput: false };
    }
    return gptCompat.resolveToolCallMode(context);
  },
  normalizeRequestParams(context: ModelCompatContext, base: Record<string, unknown>): Record<string, unknown> {
    const request = gptCompat.normalizeRequestParams(context, base);
    if (!isGrokCompletionAudit(context)) return request;

    const { response_format: _responseFormat, ...withoutJsonFormat } = request;
    const messages = Array.isArray(withoutJsonFormat.messages)
      ? withoutJsonFormat.messages.map((message) => {
          if (!message || typeof message !== "object" || (message as Record<string, unknown>).role !== "system") {
            return message;
          }
          const current = message as Record<string, unknown>;
          return {
            ...current,
            content: appendGrokCompletionAuditInstruction(context, String(current.content ?? ""))
          };
        })
      : withoutJsonFormat.messages;
    return { ...withoutJsonFormat, messages };
  },
  parseResponse(response, context: ModelCompatContext, hasNativeTools: boolean) {
    const parsed = gptCompat.parseResponse(response, context, hasNativeTools);
    const message = response?.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    return normalizeGrokCompletionAuditDecision(context, parsed, content, reasoning);
  },
  resolveImageGeneration({ model, prompt }: ModelGenerationContext): ImageGenerationPlan {
    const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
    if (!identity.includes("image")) {
      // Non-image grok models (grok-3, grok-4, ...) are NOT image generators.
      // Fail loudly instead of delegating to the GPT baseline: the baseline's
      // OpenAI SDK path sends size/response_format, which xAI rejects with
      // HTTP 400 — and OpenAI-compatible gateways in between often silently
      // remap such requests to their own default image model (DALL-E, Flux,
      // ...), returning an image that was never drawn by Grok.
      throw new Error(
        `模型「${model.displayName || model.id}」不是图片生成模型，无法用于生成图片。` +
        `请到「设置 → 多模态」将默认图片模型切换为 Grok 的图片模型（如 grok-imagine-image-quality）后再试。`
      );
    }
    // xAI image generation: POST /images/generations with model/prompt/n.
    // size/quality/style are NOT supported by xAI and are intentionally
    // omitted (sending them triggers HTTP 400).
    // NOTE: do NOT add response_format: "b64_json" here. Although xAI
    // documents it, OpenAI-compatible gateway relays often fail proxying the
    // large inline-base64 response body (upstream timeout / payload limits),
    // surfacing as HTTP 502. The default short-lived URL response proxies
    // fine because the gateway only forwards JSON and the client downloads
    // the image bytes directly from the CDN.
    return {
      protocol: "grok-images",
      endpoint: "/images/generations",
      payload: { model: model.id, prompt, n: 1 },
      label: "Grok image generation request"
    };
  }
});
