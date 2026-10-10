import type { ThreadRecord } from "@shared-types";
import type { DatabaseService } from "./storage";

export type ThreadModelSelection = Pick<ThreadRecord, "providerId" | "modelId">;

/**
 * Rewrites the stored provider/model pair of threads whose configured model no
 * longer resolves (renamed or removed models in settings).
 *
 * This is pure configuration maintenance, not user activity: the previous
 * `updatedAt` is carried over, otherwise the history sidebar suddenly shows
 * months-old threads as "yesterday" and reorders the whole task list.
 */
export async function remapThreadModelSelections(options: {
  database: DatabaseService;
  resolveSelection: (thread: ThreadRecord) => ThreadModelSelection;
  onThreadUpdated: (thread: ThreadRecord) => Promise<void>;
}): Promise<void> {
  const selectionCache = new Map<string, ThreadModelSelection>();
  for (const thread of options.database.listThreads()) {
    const cacheKey = `${thread.providerId ?? ""}::${thread.modelId ?? ""}`;
    let selection = selectionCache.get(cacheKey);
    if (!selection) {
      selection = options.resolveSelection(thread);
      selectionCache.set(cacheKey, selection);
    }
    if (selection.providerId === thread.providerId && selection.modelId === thread.modelId) {
      continue;
    }

    const updated = options.database.updateThread(thread.id, {
      ...selection,
      updatedAt: thread.updatedAt
    });
    await options.onThreadUpdated(updated);
  }
}
