import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectMissingSnapshotMessages,
  expectedVisibleMessageIds,
  filterTranscriptMessages,
  mergeServerMessagesWithNewerLocal,
  mergeSnapshotRecords
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
