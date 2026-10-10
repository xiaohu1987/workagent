export function mergeToolCallResults<T extends {
  toolCallId: string;
  available: boolean;
  resultJson: string | null;
}>(
  loadedResults: Map<string, string | null>,
  details: readonly T[],
  runningToolCallIds: ReadonlySet<string>
): Map<string, string | null> {
  const resolvedDetails = details.filter((detail) =>
    detail.available && (detail.resultJson !== null || !runningToolCallIds.has(detail.toolCallId))
  );
  if (resolvedDetails.length === 0) return loadedResults;

  const next = new Map(loadedResults);
  for (const detail of resolvedDetails) {
    next.set(detail.toolCallId, detail.resultJson);
  }
  return next;
}
