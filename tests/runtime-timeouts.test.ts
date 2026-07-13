import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_TIMEOUTS, normalizeRuntimeTimeouts } from "@shared-types";

describe("runtime timeout settings", () => {
  it("uses the current runtime defaults when older configuration has no timeout section", () => {
    expect(normalizeRuntimeTimeouts()).toEqual(DEFAULT_RUNTIME_TIMEOUTS);
  });

  it("preserves unrestricted timeout values and treats zero as disabled", () => {
    expect(normalizeRuntimeTimeouts({
      modelDecisionMs: 1_000_000,
      recoveryModelDecisionMs: 0,
      modelTimeoutRetries: 99,
      videoPollIntervalMs: 0
    })).toMatchObject({
      modelDecisionMs: 1_000_000,
      recoveryModelDecisionMs: 0,
      modelTimeoutRetries: 99,
      videoPollIntervalMs: 0
    });
  });
});
