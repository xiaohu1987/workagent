import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectMissingSnapshotMessages,
  expectedVisibleMessageIds,
  filterTranscriptMessages,
  mergeServerMessagesWithNewerLocal,
  mergeSnapshotRecords,
  resolveSnapshotRecoveryMessages
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import type { MessageRecord } from "@shared-types";

// A snapshot read is authoritative, but the commit that carries it can be
// dropped (it is an interruptible transition whenever the read looks like it
// brings nothing new) or followed by an update that loses rows it returned. The
// transcript then stays short with no read scheduled to fix it, which is what
// "the conclusion is gone until I reload" looks like from the outside. These
// tests pin the convergence check that repairs it from data already in hand.
describe("a transcript commit must converge on the snapshot it read", () => {
  const row = (id: string, createdAt: string) => ({ id, createdAt });

  it("reports the rows the live transcript is missing", () => {
    const live = [row("a", "2026-09-18T09:00:00.000Z")];
    const expected = [row("a", "2026-09-18T09:00:00.000Z"), row("final", "2026-09-18T09:21:39.813Z")];
    expect(collectMissingSnapshotMessages(live, expected).map((message) => message.id)).toEqual(["final"]);
  });

  it("is empty when the transcript already holds every row", () => {
    const rows = [row("a", "2026-09-18T09:00:00.000Z"), row("b", "2026-09-18T09:01:00.000Z")];
    expect(collectMissingSnapshotMessages(rows, rows)).toEqual([]);
  });

  it("is empty when there is nothing to expect", () => {
    expect(collectMissingSnapshotMessages([row("a", "2026-09-18T09:00:00.000Z")], [])).toEqual([]);
  });

  it("never resurrects a row the server deleted", () => {
    // The read that dropped `a` is authoritative and both copies agree on it,
    // so there is nothing to merge back.
    const live = [row("b", "2026-09-18T09:01:00.000Z")];
    const cached = [row("b", "2026-09-18T09:01:00.000Z")];
    const expected = mergeServerMessagesWithNewerLocal(cached, live);
    expect(collectMissingSnapshotMessages(live, expected)).toEqual([]);
  });
});

// The repair path may only schedule a commit for rows it can actually keep. A row
// the merge drops again has to leave the gate shut, otherwise the layout effect that
// schedules the repair re-enters itself and React aborts with #185.
describe("a recovery commit never re-schedules a repair it cannot keep", () => {
  const userRow = (id: string, createdAt: string, content = "调用接口卡片「当前审批人」") =>
    ({ id, role: "user", content, createdAt }) as unknown as MessageRecord;

  it("stays shut when every row the cache adds back is dropped again", () => {
    // The cached list holds the in-flight send placeholder beside the row the runtime
    // persisted for the same text, and the placeholder carries the newer timestamp, so
    // the cache wins the "which side is fresher" comparison. The live list has already
    // dropped the placeholder, so a raw diff reports it missing on every commit while
    // the merge removes it again immediately - the state that looped.
    const persisted = userRow("persisted-u", "2026-09-22T02:44:00.000Z");
    const placeholder = userRow("optimistic-abc", "2026-09-22T02:44:05.000Z");
    const live = [persisted];
    const expected = mergeServerMessagesWithNewerLocal([persisted, placeholder], live);

    // The gate the effect used before: non-empty, so the commit was scheduled again.
    expect(collectMissingSnapshotMessages(live, expected).map((message) => message.id))
      .toEqual(["optimistic-abc"]);
    // The gate it uses now: nothing this commit does can change the list.
    expect(resolveSnapshotRecoveryMessages(live, expected)).toBeNull();
  });

  it("stays open for a row that genuinely survives the merge", () => {
    const live = [userRow("a", "2026-09-18T09:00:00.000Z")];
    const expected = [live[0], userRow("final", "2026-09-18T09:21:39.813Z", "结论在这里")];

    expect(resolveSnapshotRecoveryMessages(live, expected)?.map((message) => message.id))
      .toEqual(["a", "final"]);
  });
});

const FIXTURE_PATH = path.resolve(process.cwd(), "tmp/repro-4e4847c1.json");
const hasFixture = fs.existsSync(FIXTURE_PATH);

const fixture = (hasFixture
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))
  : { messages: [] }) as { messages: MessageRecord[] };

// Thread 4e4847c1 at 2026-09-18 09:21:39Z: the server reported 62 rows and the
// runtime broadcast the final answer (38fc0890), but the transcript settled on
// 61 rows one second later.
const snapshotMessages = fixture.messages.slice(0, 62);
const TARGET = "38fc0890-a9f5-4446-9324-0baf50b45adf";

const describeWithFixture = hasFixture ? describe : describe.skip;

describeWithFixture("4e4847c1: a short live transcript converges on the read", () => {
  it("merges the dropped final answer back into the live transcript", () => {
    const live = snapshotMessages.filter((message) => message.id !== TARGET);
    expect(live.length).toBe(61);

    const expected = mergeServerMessagesWithNewerLocal(snapshotMessages, live);
    const missing = collectMissingSnapshotMessages(live, expected);
    expect(missing.map((message) => message.id)).toEqual([TARGET]);

    const repaired = mergeSnapshotRecords(live, missing, (message) => message.createdAt);
    const visible = filterTranscriptMessages(repaired, "completed");
    // eslint-disable-next-line no-console
    console.log(
      "[converge] repaired",
      JSON.stringify({
        repairedCount: repaired.length,
        visibleCount: visible.length,
        answerOnScreen: visible.at(-1)?.id === TARGET
      })
    );
    expect(visible.length).toBe(62);
    expect(visible.at(-1)!.id).toBe(TARGET);
  });

  it("reports nothing to repair once the transcript is whole", () => {
    const expected = mergeServerMessagesWithNewerLocal(snapshotMessages, snapshotMessages);
    expect(collectMissingSnapshotMessages(snapshotMessages, expected)).toEqual([]);
  });

  it("compares against the painted set, not the raw snapshot rows", () => {
    // Rows the transcript hides on purpose must not read as "new" forever, or
    // every single refresh would be forced into a synchronous commit.
    const internal: MessageRecord = {
      ...snapshotMessages[0],
      id: "internal-row",
      role: "assistant",
      content: "[internal: hidden]"
    } as MessageRecord;
    const ids = expectedVisibleMessageIds([...snapshotMessages, internal], "completed");
    expect(ids.has("internal-row")).toBe(false);
    expect(ids.has(TARGET)).toBe(true);
  });
});
