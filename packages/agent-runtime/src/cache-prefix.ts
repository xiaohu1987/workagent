import { createHash } from "node:crypto";

/**
 * Stable prefix accounting for provider requests.
 *
 * Prompt caches only help when the beginning of a request stays byte-identical
 * between calls, so the runtime measures the reusable layers (base
 * instructions, tool schemas) and the dynamic layers separately. Only hashes
 * and byte counts leave this module: no prompt text and no user content.
 */
export type CachePrefixLayerId = "base_instructions" | "tool_schemas" | "dynamic_context";

export interface CachePrefixFragmentInput {
  id: string;
  text: string;
}

export interface CachePrefixLayerInput {
  id: CachePrefixLayerId;
  fragments: CachePrefixFragmentInput[];
}

export interface CachePrefixFragmentMeasurement {
  id: string;
  hash: string;
  bytes: number;
}

export interface CachePrefixLayerMeasurement {
  id: CachePrefixLayerId;
  hash: string;
  bytes: number;
  fragments: CachePrefixFragmentMeasurement[];
}

export interface CachePrefixMeasurement {
  /** Hash over every measured layer, used as the request-prefix fingerprint. */
  hash: string;
  layers: CachePrefixLayerMeasurement[];
}

export interface CachePrefixChangeSummary {
  /** True for the first measured request of a thread, when there is nothing to compare. */
  baseline: boolean;
  /** True when every measured layer matched the previous request byte for byte. */
  stable: boolean;
  changedLayers: CachePrefixLayerId[];
  changedFragments: string[];
}

export function hashCachePrefixText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function measureCachePrefix(layers: CachePrefixLayerInput[]): CachePrefixMeasurement {
  const measuredLayers = layers.map((layer) => {
    const fragments = layer.fragments.map((fragment) => ({
      id: fragment.id,
      hash: hashCachePrefixText(fragment.text),
      bytes: Buffer.byteLength(fragment.text, "utf8")
    }));
    // The layer hash covers the concatenated fragments, so it stays meaningful
    // even if a later refactor moves text between fragments.
    const combinedText = layer.fragments.map((fragment) => fragment.text).join("");
    return {
      id: layer.id,
      hash: hashCachePrefixText(combinedText),
      bytes: Buffer.byteLength(combinedText, "utf8"),
      fragments
    };
  });
  return {
    hash: hashCachePrefixText(measuredLayers.map((layer) => `${layer.id}:${layer.hash}`).join("|")),
    layers: measuredLayers
  };
}

export function summarizeCachePrefixChange(
  previous: CachePrefixMeasurement | null,
  next: CachePrefixMeasurement
): CachePrefixChangeSummary {
  if (!previous) {
    return {
      baseline: true,
      stable: false,
      changedLayers: next.layers.map((layer) => layer.id),
      changedFragments: next.layers.flatMap((layer) =>
        layer.fragments.map((fragment) => `${layer.id}.${fragment.id}`)
      )
    };
  }
  const changedLayers: CachePrefixLayerId[] = [];
  const changedFragments: string[] = [];
  for (const layer of next.layers) {
    const previousLayer = previous.layers.find((candidate) => candidate.id === layer.id);
    if (!previousLayer) {
      changedLayers.push(layer.id);
      changedFragments.push(...layer.fragments.map((fragment) => `${layer.id}.${fragment.id}`));
      continue;
    }
    if (previousLayer.hash !== layer.hash) {
      changedLayers.push(layer.id);
    }
    for (const fragment of layer.fragments) {
      const previousFragment = previousLayer.fragments.find((candidate) => candidate.id === fragment.id);
      if (!previousFragment || previousFragment.hash !== fragment.hash) {
        changedFragments.push(`${layer.id}.${fragment.id}`);
      }
    }
  }
  return {
    baseline: false,
    stable: changedLayers.length === 0,
    changedLayers,
    changedFragments
  };
}
