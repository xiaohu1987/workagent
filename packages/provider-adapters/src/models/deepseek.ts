import {
  normalizeToolCallsForAvailableTools,
  parseDecisionFromText,
  stripTaggedToolCalls,
  stripThinkBlocks,
  surfaceThinkBlocksInStream
} from "../index";
import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

const DEEPSEEK_V4_PATTERN = /\bv4-(?:flash|pro)\b/;
const DEEPSEEK_REASONER_PATTERN = /reasoner|\br1\b|thinking/;

function isDeepSeekV4Model(identity: string): boolean {
  return DEEPSEEK_V4_PATTERN.test(identity);
}

function mapDeepSeekReasoningEffort(value: unknown, isPro: boolean): "low" | "high" | "max" | undefined {
  if (value === "none") return undefined;
  if (value === "minimal" || value === "low") return isPro ? "high" : "low";
  if (value === "medium" || value === "high") return "high";
  if (value === "xhigh" || value === "max") return "max";
  return undefined;
}

function looksLikeDecisionEnvelope(accumulated: string): boolean {
  const trimmed = stripThinkBlocks(accumulated).trimStart();
  return /^(?:```(?:json)?\s*)?\{\s*"assistant_message"\s*:/i.test(trimmed) ||
    (
      /^(?:```(?:json)?\s*)?\{/i.test(trimmed) &&
      /"tool_calls"\s*:/i.test(trimmed) &&
      /"end_turn"\s*:/i.test(trimmed) &&
      /"goal_completed"\s*:/i.test(trimmed)
    );
}

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
 *  - `normalizeDecision`: deepseek-v4-flash / reasoner variants were
 *    observed finishing a turn in ~3s with an empty assistant_message and
 *    no tool calls. The runtime then has nothing visible to validate, which
 *    surfaced as GPA PLAN silently falling back to a synthetic single-task
 *    plan. Recovery here: when the whole reply landed in reasoning_content,
 *    promote it to the visible message; when the response is truly empty,
 *    convert the decision to a retryable unstructured one so the runtime
 *    re-samples with an explicit correction instead of accepting a blank
 *    end-of-turn.
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
  shouldBypassStandardCompletionAudit(model): boolean {
    const identity = `${model.id} ${model.displayName ?? ""}`.toLowerCase();
    // DeepSeek reasoning calls can spend another minute on the optional,
    // tool-free audit even after the runtime's deterministic evidence check
    // has already accepted the candidate. Limit this optimization to the
    // affected reasoning families; ordinary deepseek-chat keeps the audit.
    return /reasoner|\br1\b|thinking|v4-(?:flash|pro)/.test(identity);
  },
  normalizeRequestParams(
    ctx: ModelCompatContext,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    const identity = [
      ctx.model.id,
      ctx.model.displayName ?? "",
      ctx.input.provider.id,
      ctx.input.provider.name ?? "",
      ctx.input.provider.baseUrl ?? ""
    ].join(" ").toLowerCase();
    const isV4 = isDeepSeekV4Model(identity);
    const isReasoner = DEEPSEEK_REASONER_PATTERN.test(identity);

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

    // DeepSeek V4 defaults to thinking mode, but compatible gateways do not
    // always apply that default consistently. Make the mode explicit and map
    // the app's reasoning levels to the V4 API's low/high/max values.
    if (isV4) {
      const isPro = /\bv4-pro\b/.test(identity);
      const reasoningEffort = ctx.input.reasoningEffort;
      next = {
        ...next,
        thinking: { type: reasoningEffort === "none" ? "disabled" : "enabled" }
      };
      const mappedEffort = reasoningEffort === "none"
        ? undefined
        : mapDeepSeekReasoningEffort(reasoningEffort, isPro);
      if (mappedEffort) {
        next = { ...next, reasoning_effort: mappedEffort };
      } else {
        const { reasoning_effort, ...withoutReasoningEffort } = next;
        next = withoutReasoningEffort;
      }
    }

    // 2. Raise small output caps to prevent mid-stream truncation, but keep
    //    the floor within a quarter of unusually small model context windows.
    //    Larger configured values are preserved.
    const currentMax = next.max_tokens;
    const maxTokensFloor = Math.min(
      8_192,
      Math.max(1_024, Math.floor(ctx.model.contextWindow / 4))
    );
    if (typeof currentMax !== "number" || currentMax < maxTokensFloor) {
      next = { ...next, max_tokens: maxTokensFloor };
    }

    return preserveChineseOutputLanguage(ctx, next);
  },
  extractVisibleStreamText(accumulated: string): string {
    // Only apply the GPT envelope extractor when the buffer really is a
    // decision envelope; otherwise pass content through verbatim so deepseek's
    // native-tool-call replies (including code/JSON blocks starting with `{`)
    // are not swallowed.
    if (looksLikeDecisionEnvelope(accumulated)) {
      return gptCompat.extractVisibleStreamText(accumulated);
    }
    // Surface inline <think> reasoning in the streaming draft so users can
    // watch the think process; final parsing still strips it.
    return stripTaggedToolCalls(surfaceThinkBlocksInStream(accumulated));
  },
  normalizeDecision(decision, ctx) {
    let next = decision;
    const reasoning = stripThinkBlocks(decision.reasoningSummary ?? "").trim();
    if (next.toolCalls.length === 0 && reasoning) {
      // Some DeepSeek relays put the DSML/tool payload in reasoning_content,
      // sometimes after a visible preamble. Re-run the parser over that field
      // before treating it as ordinary private reasoning.
      const recovered = parseDecisionFromText(reasoning);
      if (
        recovered.isStructured &&
        (recovered.toolCalls.length > 0 || recovered.assistantMessage?.trim())
      ) {
        const toolCalls = normalizeToolCallsForAvailableTools(
          recovered.toolCalls,
          ctx.input.availableTools
        );
        next = {
          ...next,
          ...recovered,
          assistantMessage: next.assistantMessage?.trim() || recovered.assistantMessage,
          toolCalls,
          reasoningSummary: decision.reasoningSummary
        };
      }
    }

    const hasMessage = Boolean(next.assistantMessage?.trim());
    if (
      hasMessage &&
      next.toolCalls.length === 0 &&
      next.endTurn &&
      !next.goalCompleted
    ) {
      // DeepSeek sometimes returns a complete terminal answer while leaving
      // goal_completed false. The runtime still validates the answer content,
      // pending tools, delivery, and verification after this normalization.
      return { ...next, goalCompleted: true };
    }
    if (hasMessage || next.toolCalls.length > 0) {
      return next;
    }
    // The turn produced no visible final text and no tool calls. Keep raw
    // reasoning private and let the runtime perform bounded recovery.
    return {
      ...next,
      assistantMessage: undefined,
      endTurn: false,
      goalCompleted: false,
      isStructured: false
    };
  }
});
