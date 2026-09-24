/**
 * Attribution for prompt-cache misses caused by context compaction.
 *
 * Compaction rewrites the transcript. It must never rewrite the reusable
 * prefix layers (base instructions, tool schemas); if it does, the next
 * request pays for a fresh prefix. This module turns the prefix-change
 * summary into an explicit statement so a miss that follows a compaction is
 * reported as a named, bounded cost instead of an anonymous regression.
 */

export interface CompactionPrefixOutcome {
  trigger: string;
  stableLayersPreserved: boolean;
  changedLayers: readonly string[];
  explainableMisses: number;
}

/**
 * Structural input: accepts any prefix-change summary that reports the
 * layers whose bytes moved, so callers do not have to re-declare the
 * measurement types.
 */
export interface CompactionPrefixChangeInput {
  changedLayers?: readonly string[] | undefined;
}

/**
 * Classifies the cache cost of one compaction.
 *
 * A compaction is allowed to cost at most one miss: the request carrying the
 * rewritten transcript. When a reusable layer moved, that still counts as a
 * single attributable miss, and `stableLayersPreserved: false` marks it as a
 * defect to chase rather than an accepted cost.
 */
export function summarizeCompactionPrefixOutcome(
  change: CompactionPrefixChangeInput,
  compactionTrigger: string
): CompactionPrefixOutcome {
  const changedLayers = [...(change.changedLayers ?? [])];
  const stableLayersPreserved = changedLayers.length === 0;
  return {
    trigger: compactionTrigger,
    stableLayersPreserved,
    changedLayers,
    explainableMisses: stableLayersPreserved ? 0 : 1
  };
}
