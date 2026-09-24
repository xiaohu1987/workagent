import { createHash } from "node:crypto";
import type {
  ResponsesContinuationPlan,
  ResponsesContinuationReason,
  ResponsesContinuationState
} from "@shared-types";

/** Result of planning one Responses request for incremental continuation. */
export interface ResponsesIncrementalRequestPlan {
  /** The request that must be sent upstream. */
  request: Record<string, unknown>;
  plan: ResponsesContinuationPlan;
  /**
   * Fingerprints to keep for the next turn, or null when the input is not an
   * item list and therefore cannot be extended by a delta.
   */
  state: {
    propertiesFingerprint: string;
    itemFingerprints: string[];
  } | null;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

/** Order-independent fingerprint of one JSON-ish value. */
export function fingerprintResponsesContinuationValue(value: unknown): string {
  return createHash("sha1").update(stableSerialize(value)).digest("hex");
}

/**
 * Fingerprints every non-input request field. `previous_response_id` is
 * excluded because this planner adds it itself.
 */
export function fingerprintResponsesRequestProperties(request: Record<string, unknown>): string {
  const { input: _input, previous_response_id: _previousResponseId, ...properties } = request;
  return fingerprintResponsesContinuationValue(properties);
}

/** One fingerprint per input item, in order. */
export function fingerprintResponsesInputItems(items: readonly unknown[]): string[] {
  return items.map((item) => fingerprintResponsesContinuationValue(item));
}

/**
 * Decides between reusing `previous_response_id` with a delta input and
 * resending the full input. Every fallback path reports a reason so the caller
 * can log why prompt reuse did not happen.
 */
export function planResponsesIncrementalRequest(params: {
  enabled: boolean;
  previous: ResponsesContinuationState | null;
  request: Record<string, unknown>;
}): ResponsesIncrementalRequestPlan {
  const propertiesFingerprint = fingerprintResponsesRequestProperties(params.request);
  const items = Array.isArray(params.request.input) ? (params.request.input as unknown[]) : null;
  const itemFingerprints = items ? fingerprintResponsesInputItems(items) : [];
  const requestItemCount = items?.length ?? 0;
  const planState = items ? { propertiesFingerprint, itemFingerprints } : null;
  const full = (reason: ResponsesContinuationReason): ResponsesIncrementalRequestPlan => ({
    request: params.request,
    plan: { mode: "full", reason, requestItemCount },
    state: planState
  });

  if (!params.enabled) return full("disabled");
  const previous = params.previous;
  if (!previous) return full("no_previous_request");
  // A restored conversation cannot guarantee the gateway still holds the
  // response object, so it always starts from a full input again.
  if (previous.restoredHistory) return full("restored_history");
  if (previous.propertiesFingerprint !== propertiesFingerprint) return full("properties_mismatch");
  if (!items) return full("items_mismatch");

  const previousCount = previous.itemFingerprints.length;
  const shared = Math.min(previousCount, itemFingerprints.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous.itemFingerprints[index] !== itemFingerprints[index]) return full("items_mismatch");
  }
  // Same length (no new items) or a shorter transcript than last time.
  if (itemFingerprints.length <= previousCount) return full("incompatible_length");

  const deltaItems = items.slice(previousCount);
  return {
    request: { ...params.request, input: deltaItems, previous_response_id: previous.responseId },
    plan: {
      mode: "incremental",
      reason: "prefix_extension",
      previousResponseId: previous.responseId,
      deltaItemCount: deltaItems.length,
      requestItemCount
    },
    state: planState
  };
}
