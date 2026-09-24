import { describe, expect, it } from "vitest";
import {
  hashCachePrefixText,
  measureCachePrefix,
  summarizeCachePrefixChange,
  type CachePrefixLayerInput
} from "@agent-runtime";

function buildLayers(dynamicText: string): CachePrefixLayerInput[] {
  return [
    {
      id: "base_instructions",
      fragments: [{ id: "decision_system_prompt", text: "stable base instructions" }]
    },
    {
      id: "tool_schemas",
      fragments: [{ id: "request_tools", text: '[{"name":"fs.read_file"}]' }]
    },
    {
      id: "dynamic_context",
      fragments: [{ id: "stored_turn_context", text: dynamicText }]
    }
  ];
}

describe("cache prefix measurement", () => {
  it("hashes identical text to the same value", () => {
    expect(hashCachePrefixText("same prefix")).toBe(hashCachePrefixText("same prefix"));
    expect(hashCachePrefixText("same prefix")).not.toBe(hashCachePrefixText("same prefiX"));
  });

  it("reports byte counts without exposing prompt text", () => {
    const measurement = measureCachePrefix(buildLayers("上下文"));
    const layer = measurement.layers[2];
    expect(layer.bytes).toBe(Buffer.byteLength("上下文", "utf8"));
    expect(layer.fragments[0]).toEqual({
      id: "stored_turn_context",
      hash: hashCachePrefixText("上下文"),
      bytes: Buffer.byteLength("上下文", "utf8")
    });
  });

  it("keeps stable layer hashes when only dynamic content changes", () => {
    const first = measureCachePrefix(buildLayers("turn 1"));
    const second = measureCachePrefix(buildLayers("turn 2"));
    const summary = summarizeCachePrefixChange(first, second);

    expect(summary.baseline).toBe(false);
    expect(summary.stable).toBe(false);
    expect(summary.changedLayers).toEqual(["dynamic_context"]);
    expect(summary.changedFragments).toEqual(["dynamic_context.stored_turn_context"]);
    expect(second.layers[0].hash).toBe(first.layers[0].hash);
    expect(second.layers[1].hash).toBe(first.layers[1].hash);
  });

  it("marks the first request as a baseline and repeated prefixes as stable", () => {
    const measurement = measureCachePrefix(buildLayers("turn 1"));
    const baseline = summarizeCachePrefixChange(null, measurement);
    expect(baseline.baseline).toBe(true);
    expect(baseline.stable).toBe(false);

    const repeated = summarizeCachePrefixChange(measurement, measureCachePrefix(buildLayers("turn 1")));
    expect(repeated.baseline).toBe(false);
    expect(repeated.stable).toBe(true);
    expect(repeated.changedFragments).toEqual([]);
  });

  it("attributes a changed tool schema to the tool layer", () => {
    const first = measureCachePrefix(buildLayers("turn 1"));
    const layers = buildLayers("turn 1");
    layers[1] = { id: "tool_schemas", fragments: [{ id: "request_tools", text: '[{"name":"fs.write_file"}]' }] };
    const summary = summarizeCachePrefixChange(first, measureCachePrefix(layers));

    expect(summary.changedLayers).toEqual(["tool_schemas"]);
    expect(summary.changedFragments).toEqual(["tool_schemas.request_tools"]);
  });
});
