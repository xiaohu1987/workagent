import type { ProviderUsageReport } from "@shared-types";

/**
 * Describes which usage fields a provider actually reported on the wire.
 *
 * The branch order mirrors `parseProviderTokenUsage` so the presence flags and
 * the parsed numbers always come from the same protocol decision. Presence is
 * about reported fields only: a reported `0` stays a real zero, while a missing
 * field means "unknown cache state" instead of an implicit miss.
 */
export function describeProviderUsageReport(rawUsage: unknown): ProviderUsageReport {
  const unknownReport: ProviderUsageReport = {
    protocol: "unknown",
    inputTokensReported: false,
    cacheHitReported: false,
    cacheWriteReported: false,
    reasoningReported: false
  };
  if (!rawUsage || typeof rawUsage !== "object") return unknownReport;
  const usage = rawUsage as Record<string, unknown>;
  const isNumber = (value: unknown): value is number => typeof value === "number";

  // OpenAI-compatible chat completions.
  if (isNumber(usage.prompt_tokens) || isNumber(usage.completion_tokens)) {
    const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
    return {
      protocol: "openai_chat",
      inputTokensReported: isNumber(usage.prompt_tokens),
      cacheHitReported: isNumber(promptDetails?.cached_tokens) || isNumber(usage.cached_tokens),
      cacheWriteReported: isNumber(promptDetails?.cache_write_tokens) || isNumber(usage.cache_write_tokens),
      reasoningReported: isNumber(completionDetails?.reasoning_tokens) || isNumber(usage.reasoning_tokens)
    };
  }

  // OpenAI Responses shares `input_tokens`/`output_tokens` with Anthropic, so
  // the nested detail object and the Anthropic-only cache fields decide which
  // protocol this payload belongs to.
  if (
    (isNumber(usage.input_tokens) || isNumber(usage.output_tokens)) &&
    !!usage.input_tokens_details &&
    typeof usage.input_tokens_details === "object" &&
    !("cache_read_input_tokens" in usage) &&
    !("cache_creation_input_tokens" in usage)
  ) {
    const inputDetails = usage.input_tokens_details as Record<string, unknown>;
    const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
    return {
      protocol: "openai_responses",
      inputTokensReported: isNumber(usage.input_tokens),
      cacheHitReported: isNumber(inputDetails.cached_tokens),
      // The Responses API only reports cache reads for automatic caching.
      cacheWriteReported: false,
      reasoningReported: isNumber(outputDetails?.reasoning_tokens)
    };
  }

  // Anthropic Messages.
  if (isNumber(usage.input_tokens) || isNumber(usage.output_tokens)) {
    const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
    return {
      protocol: "anthropic",
      inputTokensReported: isNumber(usage.input_tokens),
      cacheHitReported: isNumber(usage.cache_read_input_tokens),
      cacheWriteReported: isNumber(usage.cache_creation_input_tokens),
      reasoningReported: isNumber(outputDetails?.thinking_tokens) || isNumber(usage.thinking_tokens)
    };
  }

  // Gemini usage metadata.
  if (
    isNumber(usage.promptTokenCount) ||
    isNumber(usage.candidatesTokenCount) ||
    isNumber(usage.totalTokenCount)
  ) {
    return {
      protocol: "gemini",
      inputTokensReported: isNumber(usage.promptTokenCount),
      cacheHitReported: isNumber(usage.cachedContentTokenCount),
      cacheWriteReported: false,
      reasoningReported: isNumber(usage.thoughtsTokenCount)
    };
  }

  return unknownReport;
}
