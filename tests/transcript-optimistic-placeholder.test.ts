import { describe, expect, it } from "vitest";
import {
  buildTimelineEntries,
  dropSupersededOptimisticMessages,
  isOptimisticUserMessage,
  mergeMessagesAfterOptimisticUserEdit
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import type { MessageRecord } from "@shared-types";

// Regression cover for "the message I just sent is painted twice, with a 0s turn footer
// between the two copies, until the thread is reloaded".
//
// The bubble the renderer paints on send (`optimistic-<uuid>`) and the row the runtime
// persists are two different ids carrying the same text. The only thing that ever
// removed the placeholder was the event path's consumed-id set, which is empty whenever
// the placeholder had already left `pending` (an earlier snapshot commit removes it
// there), and nothing else compared the two rows. Both therefore stayed in the message
// list, and since the timeline entry id is `message-<id>` there was no cross-id dedupe
// either: the text rendered twice and opened a second turn whose only content was that
// message, which is the footer that reported "已处理 0s". A reload rebuilt every
// in-memory structure from the server list, which is why the duplicate disappeared
// afterwards.

const THREAD = "thread-duplicate-user-bubble";

function message(overrides: Partial<MessageRecord> & Pick<MessageRecord, "id" | "role">): MessageRecord {
  return {
    threadId: THREAD,
    turnRunId: null,
    content: "",
    metadataJson: null,
    createdAt: "2026-09-21T07:20:00.000Z",
    ...overrides
  } as MessageRecord;
}

const SENT_TEXT = "我怎么没看到 云匣子 地址";

const placeholder = message({
  id: "optimistic-2f1c0e52-0000-4000-8000-000000000001",
  role: "user",
  content: SENT_TEXT,
  createdAt: "2026-09-21T07:20:00.400Z"
});
const persistedTwin = message({
  id: "b7c1f0aa-1111-4111-8111-111111111111",
  role: "user",
  content: SENT_TEXT,
  createdAt: "2026-09-21T07:20:00.100Z"
});
const earlierAssistant = message({
  id: "assistant-earlier",
  role: "assistant",
  content: "一声我就改。",
  createdAt: "2026-09-21T07:19:00.000Z"
});

describe("isOptimisticUserMessage", () => {
  it("recognises the client-side placeholder row", () => {
    expect(isOptimisticUserMessage(placeholder)).toBe(true);
    expect(isOptimisticUserMessage(persistedTwin)).toBe(false);
    expect(isOptimisticUserMessage(message({ id: "optimistic-not-user", role: "assistant" }))).toBe(false);
  });
});

describe("dropSupersededOptimisticMessages", () => {
  it("drops the placeholder once its persisted twin is in the same list", () => {
    expect(dropSupersededOptimisticMessages([earlierAssistant, placeholder, persistedTwin]))
      .toEqual([earlierAssistant, persistedTwin]);
  });

  it("matches symmetrically, so a twin that sorts before the placeholder still counts", () => {
    // The twin lands lower than the placeholder whenever the runtime stamps the row with
    // a time earlier than the click. The old comparison only accepted persisted rows
    // newer than the placeholder, so this ordering was never reconciled.
    const earlyTwin = message({
      id: "twin-early",
      role: "user",
      content: SENT_TEXT,
      createdAt: "2026-09-21T07:19:59.500Z"
    });
    expect(dropSupersededOptimisticMessages([earlyTwin, placeholder]).map((item) => item.id))
      .toEqual(["twin-early"]);
  });

  it("keeps the placeholder while the server list does not carry it yet", () => {
    expect(dropSupersededOptimisticMessages([earlierAssistant, placeholder]))
      .toEqual([earlierAssistant, placeholder]);
  });

  it("never drops a persisted row and leaves other messages alone", () => {
    const other = message({
      id: "other-persisted",
      role: "user",
      content: "另一条消息",
      createdAt: "2026-09-21T07:20:00.300Z"
    });
    expect(dropSupersededOptimisticMessages([persistedTwin, other, placeholder]).map((item) => item.id))
      .toEqual([persistedTwin.id, other.id]);
  });

  it("returns the input array untouched when there is no placeholder", () => {
    const input = [earlierAssistant];
    expect(dropSupersededOptimisticMessages(input)).toBe(input);
  });
});

describe("mergeMessagesAfterOptimisticUserEdit", () => {
  it("stops re-painting a placeholder whose twin is already in the merged list", () => {
    // The shape the merge produced: the persisted row sorts before the placeholder, so
    // the placeholder was never re-matched against it and came back as a second copy of
    // the same message.
    const merged = mergeMessagesAfterOptimisticUserEdit(
      [earlierAssistant, persistedTwin, placeholder],
      [earlierAssistant, persistedTwin],
      []
    );
    expect(merged.map((item) => item.id)).toEqual([earlierAssistant.id, persistedTwin.id]);
  });

  it("still keeps a placeholder the server list has not delivered", () => {
    const merged = mergeMessagesAfterOptimisticUserEdit(
      [earlierAssistant, placeholder],
      [earlierAssistant],
      [placeholder]
    );
    expect(merged.map((item) => item.id)).toEqual([earlierAssistant.id, placeholder.id]);
  });
});

describe("buildTimelineEntries", () => {
  it("keeps distinct rows that happen to carry the same text", () => {
    const entries = buildTimelineEntries(
      [earlierAssistant, placeholder, persistedTwin],
      [], [], undefined, "completed", [], null
    );
    // The timeline sorts by timestamp, so the dedupe must not collapse rows that merely
    // share their text: only a repeated entry id is a duplicate.
    expect(entries.filter((entry) => entry.kind === "message").map((entry) => entry.message.id))
      .toEqual([earlierAssistant.id, persistedTwin.id, placeholder.id]);
  });

  it("paints a row the message list handed over twice only once", () => {
    const entries = buildTimelineEntries(
      [earlierAssistant, earlierAssistant],
      [], [], undefined, "completed", [], null
    );
    expect(entries.filter((entry) => entry.kind === "message")).toHaveLength(1);
  });
});
