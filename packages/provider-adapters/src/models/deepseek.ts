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

const INTERNAL_EXECUTED_TOOLS_MARKER = /\s*\[Executed tools:\s*[^\]\r\n]*(?:\]|$)|\s*\[E(?:x(?:e(?:c(?:u(?:t(?:e(?:d(?:\s*)?)?)?)?)?)?)?)?$/gi;

function stripInternalExecutedToolsMarker(text: string): string {
  return text.replace(INTERNAL_EXECUTED_TOOLS_MARKER, "");
}

/**
 * DeepSeek openai-compatible shell.
 *
 * Reference: DeepSeek API docs
 * (https://api-docs.deepseek.com/, https://www.deepseek4.net/zh-cn/docs/api-workflows).
 *
 * Tuned:
 *  - `normalizeRequestParams`:
 *    * Thinking requests (deepseek-reasoner, deepseek-r1, and v4-flash/pro
 *      variants while thinking is enabled) reject temperature, top_p,
 *      frequency_penalty, presence_penalty, logprobs, top_logprobs,
 *      prompt_cache_id, and response_format. They are stripped to avoid
 *      HTTP 400.
 *    * Preserves the model profile's `max_tokens` value. Output limits are
 *      model/provider configuration, not a compatibility-layer default.
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
    const usesNativeProtocol = ctx.input.provider.deepseekProtocol !== "openai-compatible";
    const reasoningEffort = ctx.input.reasoningEffort;
    // V4 is a thinking model even when the catalog display name does not
    // include the word "thinking" (for example, deepseek-v4-flash-0731).
    // Keep enabled V4 requests in the same sanitization branch as
    // deepseek-reasoner; otherwise the generated request still carries
    // temperature and can be rejected with an opaque HTTP 400 by compatible
    // gateways. A deliberate `none` effort disables thinking, so normal
    // sampling parameters remain meaningful in that mode.
    // The text-tool fallback needs the provider to enforce its JSON envelope.
    // DeepSeek V4 rejects response_format while thinking is enabled, which
    // previously left this recovery path relying only on prompt compliance
    // and led to repeated unparseable decisions. The fallback is entered only
    // after native tool calling has already failed, so a one-request switch to
    // non-thinking JSON mode is the reliable recovery transport.
    const useStrictJsonRecovery = usesNativeProtocol && Boolean(
      ctx.input.forceTextToolProtocol && ctx.model.supportsJsonOutput && isV4
    );
    const isThinkingRequest = usesNativeProtocol && !useStrictJsonRecovery && (isV4
      ? reasoningEffort !== "none"
      : DEEPSEEK_REASONER_PATTERN.test(identity));

    // 1. Reasoning models: strip fields the thinking API rejects (HTTP 400).
    let next: Record<string, unknown> = base;
    if (isThinkingRequest) {
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
    if (usesNativeProtocol && isV4) {
      const isPro = /\bv4-pro\b/.test(identity);
      next = {
        ...next,
        thinking: { type: reasoningEffort === "none" || useStrictJsonRecovery ? "disabled" : "enabled" }
      };
      const mappedEffort = reasoningEffort === "none" || useStrictJsonRecovery
        ? undefined
        : mapDeepSeekReasoningEffort(reasoningEffort, isPro);
      if (mappedEffort) {
        next = { ...next, reasoning_effort: mappedEffort };
      } else {
        const { reasoning_effort, ...withoutReasoningEffort } = next;
        next = withoutReasoningEffort;
      }
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
    return stripInternalExecutedToolsMarker(
      stripTaggedToolCalls(surfaceThinkBlocksInStream(accumulated))
    );
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
