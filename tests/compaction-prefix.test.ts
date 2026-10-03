import { describe, expect, it } from "vitest";

import { summarizeCompactionPrefixOutcome } from "../packages/agent-runtime/src/compaction-prefix";

describe("summarizeCompactionPrefixOutcome", () => {
  it("charges no miss when compaction leaves the reusable prefix intact", () => {
    const outcome = summarizeCompactionPrefixOutcome({ changedLayers: [] }, "pre_model_request");

    expect(outcome).toEqual({
      trigger: "pre_model_request",
      stableLayersPreserved: true,
      changedLayers: [],
      explainableMisses: 0
    });
  });

  it("charges exactly one attributable miss when a stable layer moves", () => {
    const outcome = summarizeCompactionPrefixOutcome(
      { changedLayers: ["tool_schemas"] },
      "task_completed"
    );

    expect(outcome).toEqual({
      trigger: "task_completed",
      stableLayersPreserved: false,
      changedLayers: ["tool_schemas"],
      explainableMisses: 1
    });
  });

  it("treats a missing changed-layer collection as an intact prefix", () => {
    const outcome = summarizeCompactionPrefixOutcome({}, "upstream_context_overflow");

    expect(outcome.stableLayersPreserved).toBe(true);
    expect(outcome.explainableMisses).toBe(0);
  });
});
