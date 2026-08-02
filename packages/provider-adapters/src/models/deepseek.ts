import { stripThinkBlocks, surfaceThinkBlocksInStream } from "../index";
import { Buffer } from "node:buffer";
import { defineCompat } from "./types";
import type { ModelCompatContext } from "./types";
import { gptCompat } from "./gpt";
import { preserveChineseOutputLanguage } from "./output-language";

const MAX_DEEPSEEK_REQUEST_BYTES = 120 * 1024;
const COMPACTED_ASSISTANT_HISTORY = "[Earlier assistant progress omitted to fit the gateway request limit.]";

type DeepseekWireMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
};

function mergeDeepseekMessageContent(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  if (Array.isArray(left) && typeof right === "string") return [...left, { type: "text", text: right }];
  if (typeof left === "string" && Array.isArray(right)) return [{ type: "text", text: left }, ...right];
  if (typeof left === "string" && typeof right === "string") return left && right ? `${left}\n\n${right}` : left || right;
  return right !== undefined && right !== null ? right : left;
}

/**
 * DeepSeek-compatible relays often validate OpenAI messages more strictly
 * than the OpenAI API itself. Runtime progress updates can otherwise produce
 * runs of assistant messages that the relay rejects.
 */
function coalesceDeepseekMessages(messages: unknown[]): DeepseekWireMessage[] {
  const out: DeepseekWireMessage[] = [];
  for (const raw of messages as DeepseekWireMessage[]) {
    const message = raw?.role === "assistant" && (raw.content === null || raw.content === undefined)
      ? { ...raw, content: "" }
      : raw;
    const previous = out[out.length - 1];
    const sameTextRole =
      (message?.role === "assistant" || message?.role === "user") &&
      previous?.role === message.role &&
      !Array.isArray(previous.tool_calls) &&
      !Array.isArray(message.tool_calls);
    const textBeforeToolCall =
      message?.role === "assistant" &&
      previous?.role === "assistant" &&
      !Array.isArray(previous.tool_calls) &&
      Array.isArray(message.tool_calls);
    if (sameTextRole || textBeforeToolCall) {
      message.content = mergeDeepseekMessageContent(previous.content, message.content);
      out[out.length - 1] = message;
    } else {
      out.push(message);
    }
  }
  return out;
}

function requestBytes(request: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8");
}

/**
 * Some relays cap the entire JSON body at 128 KiB even for models advertised
 * with a much larger token context. Reduce only historical assistant status
 * messages when needed; user prompts and tool results remain intact.
 */
function fitDeepseekRequestBudget(request: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(request.messages)) return request;
  // Preserve the regular OpenAI-compatible transcript shape unless this
  // particular gateway limit is actually in play.
  if (requestBytes(request) <= MAX_DEEPSEEK_REQUEST_BYTES) return request;
  const messages = coalesceDeepseekMessages(request.messages);
  const next: Record<string, unknown> = { ...request, messages };
  if (requestBytes(next) <= MAX_DEEPSEEK_REQUEST_BYTES) return next;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message.role !== "assistant" ||
      Array.isArray(message.tool_calls) ||
      typeof message.content !== "string" ||
      message.content.length < 1_024
    ) {
      continue;
    }
    messages[index] = { ...message, content: COMPACTED_ASSISTANT_HISTORY };
    if (requestBytes(next) <= MAX_DEEPSEEK_REQUEST_BYTES) return next;
  }
  return next;
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

    // Some DeepSeek-compatible gateways reject long function catalogs with
    // an empty HTTP 400 response. Keep the core tools, which the runtime puts
    // first, and omit only the tail of optional/MCP tools.
    if (Array.isArray(next.tools) && next.tools.length > 50) {
      next = { ...next, tools: next.tools.slice(0, 50) };
    }
    return preserveChineseOutputLanguage(ctx, fitDeepseekRequestBudget(next));
  },
  extractVisibleStreamText(accumulated: string): string {
    // Only apply the GPT envelope extractor when the buffer really is a
    // decision envelope; otherwise pass content through verbatim so deepseek's
    // native-tool-call replies (including code/JSON blocks starting with `{`)
    // are not swallowed.
    if (accumulated.includes('"assistant_message"')) {
      return gptCompat.extractVisibleStreamText(accumulated);
    }
    // Surface inline <think> reasoning in the streaming draft so users can
    // watch the think process; final parsing still strips it.
    return surfaceThinkBlocksInStream(accumulated);
  },
  normalizeDecision(decision) {
    const hasMessage = Boolean(decision.assistantMessage?.trim());
    if (hasMessage || decision.toolCalls.length > 0) {
      return decision;
    }
    // The turn produced no visible text and no tool calls.
    const reasoning = stripThinkBlocks(decision.reasoningSummary ?? "").trim();
    if (reasoning) {
      // The reply landed entirely in reasoning_content: promote it so
      // GOAL/PLAN can parse the analysis and chat threads show the answer
      // instead of a blank end-of-turn.
      return { ...decision, assistantMessage: reasoning };
    }
    // Truly empty response: mark the decision unstructured and keep the turn
    // open so the runtime re-samples with an explicit correction instead of
    // accepting a blank end-of-turn.
    return {
      ...decision,
      assistantMessage: undefined,
      endTurn: false,
      goalCompleted: false,
      isStructured: false
    };
  }
});
