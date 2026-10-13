import type { RuntimeActivity, RuntimeActivityEntry } from "./app-types";

export type RuntimeActivityOutput = Extract<RuntimeActivityEntry, { kind: "output" }>;

export const RUNTIME_ACTIVITY_OUTPUT_BATCH_INTERVAL_MS = 100;
export const MAX_RUNTIME_ACTIVITY_OUTPUT_CHARS = 20_000;

/**
 * Appends a group of terminal output events while coalescing adjacent chunks
 * from the same command. Keeping this pure makes the event reduction easy to
 * verify without rendering the whole application.
 */
export function appendRuntimeOutputBatch(
  activity: RuntimeActivity | undefined,
  threadId: string,
  outputs: RuntimeActivityOutput[]
): RuntimeActivity {
  const entries = activity?.entries.slice() ?? [];

  for (const output of outputs) {
    const boundedContent = output.content.slice(-MAX_RUNTIME_ACTIVITY_OUTPUT_CHARS);
    const last = entries.at(-1);
    if (last?.kind === "output" && last.label === output.label) {
      entries[entries.length - 1] = {
        ...last,
        content: `${last.content}${output.content}`.slice(-MAX_RUNTIME_ACTIVITY_OUTPUT_CHARS)
      };
    } else {
      entries.push({ ...output, content: boundedContent });
    }
  }

  const firstOutput = outputs[0];
  return {
    threadId,
    startedAt: activity?.startedAt ?? firstOutput?.createdAt ?? new Date().toISOString(),
    entries
  };
}
