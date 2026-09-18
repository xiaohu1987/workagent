import { describe, expect, it } from "vitest";
import {
  isSnapshotReadShort,
  mergeMessagesAfterOptimisticUserEdit,
  reconcilePendingUserMessagesDetailed,
  shouldKeepOptimisticBaselineMessage
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import type { MessageRecord } from "@shared-types";

// Regression cover for "the message I just sent / the answer that just finished is
// missing until I reload the thread".
//
// Live diagnostics from thread e63786f0 caught the failure twice, right after a
// submission:
//
//   06:50:38  message.created  role=user id=ee372b5b len=12
//   06:50:38  snapshot.applied mode=delta serverCount=38 localCount=38 finalCount=38
//   06:50:38  snapshot.applied mode=delta serverCount=38 localCount=37 finalCount=37 got=0
//
// The database confirms row 38 of that thread is exactly ee372b5b: the renderer held
// every row except the one the user had just sent, and the delta read returned
// nothing new, so no later delta could ever deliver it - only a full read, i.e. a
// thread reload, did.

const THREAD = "e63786f0-26e2-432b-b064-d648d403463f";

function message(overrides: Partial<MessageRecord> & Pick<MessageRecord, "id" | "role">): MessageRecord {
  return {
    threadId: THREAD,
    turnRunId: null,
    content: "",
    metadataJson: null,
    createdAt: "2026-09-18T06:50:38.000Z",
    ...overrides
  } as MessageRecord;
}

describe("isSnapshotReadShort", () => {
  it("flags the observed failure: a delta that cannot account for the server count", () => {
    // local 37 held + 0 returned, server reports 38 -> one row is unreachable.
    expect(isSnapshotReadShort("delta", 38, 37, 0)).toBe(true);
  });

  it("accepts a delta that caught up", () => {
    expect(isSnapshotReadShort("delta", 38, 37, 1)).toBe(false);
    expect(isSnapshotReadShort("delta", 38, 38, 0)).toBe(false);
  });

  it("accepts a delta that is ahead of the reported count (deletions)", () => {
    expect(isSnapshotReadShort("delta", 36, 38, 0)).toBe(false);
  });

  it("never treats a full read as short: a full list is authoritative", () => {
    // A full read replaces the list outright, so a count mismatch there is not the
    // delta-cursor problem and must not trigger another read.
    expect(isSnapshotReadShort("full", 38, 35, 35)).toBe(false);
  });
});

describe("shouldKeepOptimisticBaselineMessage", () => {
  const optimistic = message({
    id: "optimistic-11111111-1111-4111-8111-111111111111",
    role: "user",
    content: "小说最后大结局是什么样的",
    createdAt: "2026-09-18T06:50:38.200Z"
  });

  it("keeps the row while it is still pending", () => {
    expect(shouldKeepOptimisticBaselineMessage(optimistic, [optimistic], [])).toBe(true);
  });

  it("keeps the row after it leaves pending if the server list has no twin yet", () => {
    // This is the regression. The optimistic row leaves `pending` the instant its
    // persisted twin is broadcast; if the following read does not carry that twin,
    // dropping the optimistic copy here leaves the transcript with no copy of the
    // user's message at all - the bubble disappears until a reload.
    expect(shouldKeepOptimisticBaselineMessage(optimistic, [], [])).toBe(true);
    const otherRows = [
      message({ id: "5412382f-0000-4000-8000-000000000000", role: "assistant", content: "结论文本" })
    ];
    expect(shouldKeepOptimisticBaselineMessage(optimistic, [], otherRows)).toBe(true);
  });

  it("drops the row once the server list carries the persisted twin", () => {
    const twin = message({
      id: "ee372b5b-0000-4000-8000-000000000000",
      role: "user",
      content: "小说最后大结局是什么样的",
      createdAt: "2026-09-18T06:50:38.362Z"
    });
    expect(shouldKeepOptimisticBaselineMessage(optimistic, [], [twin])).toBe(false);
  });

  it("matches the twin across line-ending and surrounding-whitespace differences", () => {
    const twin = message({
      id: "ee372b5b-0000-4000-8000-000000000000",
      role: "user",
      content: "  程序\r\n结束  ",
      createdAt: "2026-09-18T06:50:38.362Z"
    });
    const multiline = message({
      id: "optimistic-11111111-1111-4111-8111-111111111111",
      role: "user",
      content: "  程序\n结束  ",
      createdAt: "2026-09-18T06:50:38.200Z"
    });
    expect(shouldKeepOptimisticBaselineMessage(multiline, [], [twin])).toBe(false);
  });

  it("keeps the optimistic row when the twin's text differs, because losing the message beats a duplicate", () => {
    // `normalizeUserMessageForReconciliation` only normalizes line endings and trims,
    // so an inner-whitespace difference is not treated as the same message. Keeping the
    // optimistic copy is the deliberate side of that trade-off: a duplicate is visible
    // and self-corrects on the next read, a dropped message is not.
    const twin = message({
      id: "ee372b5b-0000-4000-8000-000000000000",
      role: "user",
      content: "小说最后大结局是什么样 的",
      createdAt: "2026-09-18T06:50:38.362Z"
    });
    expect(shouldKeepOptimisticBaselineMessage(optimistic, [], [twin])).toBe(true);
  });
});

describe("the send -> delta -> reload sequence", () => {
  it("keeps exactly one copy of the user message across the whole handover", () => {
    const optimistic = message({
      id: "optimistic-22222222-2222-4222-8222-222222222222",
      role: "user",
      content: "介绍一下这部剧的内容",
      createdAt: "2026-09-18T06:41:49.700Z"
    });
    const twin = message({
      id: "148069a3-0000-4000-8000-000000000000",
      role: "user",
      content: "介绍一下这部剧的内容",
      createdAt: "2026-09-18T06:41:49.854Z"
    });
    const earlier = message({
      id: "5412382f-0000-4000-8000-000000000000",
      role: "assistant",
      content: "所有检索都完成了。",
      createdAt: "2026-09-18T06:38:06.679Z"
    });

    // 1. Just sent: the optimistic row is pending and shown.
    const pendingOnSend = [optimistic];
    expect(mergeMessagesAfterOptimisticUserEdit([earlier, optimistic], [earlier], pendingOnSend))
      .toEqual([earlier, optimistic]);

    // 2. The twin is broadcast, which consumes the optimistic id, but the read that
    //    follows is a delta that does not carry the twin. The baseline must still
    //    carry a copy, otherwise the bubble vanishes.
    const reconciliation = reconcilePendingUserMessagesDetailed(pendingOnSend, [twin]);
    expect(reconciliation.consumedIds.has(optimistic.id)).toBe(true);
    expect(shouldKeepOptimisticBaselineMessage(optimistic, reconciliation.remaining, [earlier])).toBe(true);

    // 3. A later read finally carries the twin: the optimistic copy is dropped and
    //    exactly one copy of the user's message remains.
    const settled = mergeMessagesAfterOptimisticUserEdit(
      [earlier, optimistic],
      [earlier, twin],
      reconciliation.remaining
    );
    expect(settled.filter((item) => item.content === twin.content)).toHaveLength(1);
    expect(settled.map((item) => item.id)).toEqual([earlier.id, twin.id]);
  });
});
