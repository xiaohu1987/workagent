import { describe, expect, it } from "vitest";
import type { MessageRecord } from "@shared-types";
import {
  LEADING_SHARE_TURN_ID,
  allShareMessageIds,
  buildShareFileName,
  buildShareTurns,
  composeShareMessageMarkdown,
  computeShareStats,
  defaultShareMessageIds,
  formatShareStats,
  isShareableMessage,
  shareMessageText,
  shareMessagesById,
  shareTurnIdsForMessages
} from "../apps/desktop/src/renderer/lib/share-turns";
import { stripMarkdown } from "../apps/desktop/src/renderer/lib/share-text";

function message(
  role: MessageRecord["role"],
  content: string,
  id: string,
  turnRunId: string | null = null
): MessageRecord {
  return {
    id,
    threadId: "thread-1",
    turnRunId,
    role,
    content,
    metadataJson: null,
    createdAt: "2026-09-17T00:00:00.000Z"
  };
}

const conversation = [
  message("user", "帮我看看这个 bug", "u1", "turn-1"),
  message("assistant", "第一轮分析：问题出在状态机。", "a1", "turn-1"),
  message("user", "继续", "u2", "turn-2"),
  message("assistant", "最终结论：把阈值改成 0.6 即可。", "a2", "turn-2")
];

describe("share turn grouping", () => {
  it("starts a turn at every user prompt and keeps it in transcript order", () => {
    const turns = buildShareTurns(conversation);
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe("帮我看看这个 bug");
    expect(turns[1].prompt).toBe("继续");
    expect(turns[0].turnRunIds).toEqual(["turn-1"]);
    expect(turns[1].turnRunIds).toEqual(["turn-2"]);
    expect(turns[1].answers[0].content).toContain("最终结论");
  });

  it("drops tool event blocks and turns without an answer", () => {
    const turns = buildShareTurns([
      message("user", "跑一下", "u1"),
      message("assistant", '<event type="tool_call" name="shell.exec">ls</event>', "a1"),
      message("user", "还是没有回答", "u2"),
      message("assistant", "有答案了。", "a2")
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].answers).toHaveLength(1);
    expect(turns[0].answers[0].content).not.toContain("<event");
  });

  it("keeps assistant prose that precedes the first prompt", () => {
    const turns = buildShareTurns([message("assistant", "开场总结。", "a0")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe(LEADING_SHARE_TURN_ID);
    expect(turns[0].question).toBeNull();
  });

  it("includes a leading prompt line without markdown syntax in the label", () => {
    const turns = buildShareTurns([
      message("user", "## 部署流程\n\n细说", "u1"),
      message("assistant", "好的。", "a1")
    ]);
    expect(turns[0].prompt).toBe("部署流程");
  });
});

describe("share statistics", () => {
  const turns = buildShareTurns(conversation);
  const toolCalls = [
    { turnRunId: "turn-1" },
    { turnRunId: "turn-2" },
    { turnRunId: "turn-2" },
    { turnRunId: "turn-3" }
  ];
  const filesByTurn = new Map([
    ["turn-1", [{ path: "a.ts" }]],
    ["turn-2", [{ path: "b.ts" }, { path: "c.ts" }]],
    ["turn-3", [{ path: "d.ts" }]]
  ]);

  it("attributes tool calls and files to the selected turns only", () => {
    const latest = computeShareStats(turns, [turns[1].id], toolCalls, filesByTurn as never);
    expect(latest).toEqual({ conversations: 1, toolCalls: 2, files: 2 });

    const all = computeShareStats(turns, turns.map((turn) => turn.id), toolCalls, filesByTurn as never);
    expect(all).toEqual({ conversations: 2, toolCalls: 3, files: 3 });

    const none = computeShareStats(turns, [], toolCalls, filesByTurn as never);
    expect(none).toEqual({ conversations: 0, toolCalls: 0, files: 0 });
  });

  it("formats the header line", () => {
    expect(formatShareStats({ conversations: 2, toolCalls: 3, files: 1 })).toBe("2 轮对话 · 3 次工具调用 · 1 个文件");
  });
});

describe("share message selection", () => {
  const turns = buildShareTurns(conversation);

  it("reads the shareable text of each role", () => {
    expect(shareMessageText(conversation[0])).toBe("帮我看看这个 bug");
    expect(shareMessageText(conversation[1])).toContain("第一轮分析");
    expect(
      shareMessageText(message("assistant", '<event type="tool_call" name="shell.exec">ls</event>', "t1"))
    ).toBe("");
    expect(shareMessageText(message("tool", "输出", "t2"))).toBe("");
  });

  it("offers only messages that carry prose", () => {
    const messages = [
      message("user", "跑一下", "u1"),
      message("assistant", '<event type="tool_call" name="shell.exec">ls</event>', "a1"),
      message("assistant", "有答案了。", "a2"),
      message("system", "系统提示", "s1")
    ];
    expect(allShareMessageIds(messages)).toEqual(["u1", "a2"]);
    expect(isShareableMessage(messages[1])).toBe(false);
  });

  it("pre-ticks every shareable message of the latest answered turn", () => {
    expect(defaultShareMessageIds(conversation)).toEqual(["u2", "a2"]);
    expect(defaultShareMessageIds([message("user", "还没回答", "u1")])).toEqual([]);
  });

  it("keeps transcript order and drops unknown ids", () => {
    expect(shareMessagesById(conversation, ["a2", "u1", "missing"]).map((item) => item.id)).toEqual(["u1", "a2"]);
  });

  it("groups an answer under its prompt and rules off separate turns", () => {
    const all = composeShareMessageMarkdown(conversation, ["u1", "a1", "u2", "a2"]);
    expect(all.indexOf("帮我看看这个 bug")).toBeLessThan(all.indexOf("第一轮分析"));
    expect(all.indexOf("第一轮分析")).toBeLessThan(all.indexOf("继续"));
    expect(all).toContain("\n\n---\n\n");

    // Dropping the second prompt leaves a single block, so no stray rule.
    const answerOnly = composeShareMessageMarkdown(conversation, ["a2"]);
    expect(answerOnly).toBe("最终结论：把阈值改成 0.6 即可。");
    expect(answerOnly).not.toContain("---");
  });

  it("strips the block rule when the body is flattened to plain text", () => {
    const plain = stripMarkdown(composeShareMessageMarkdown(conversation, ["u1", "a1", "u2", "a2"]));
    expect(plain).not.toContain("---");
    expect(plain).toContain("帮我看看这个 bug");
    expect(plain).toContain("最终结论");
  });

  it("attributes tools and files through the turns the ticks touch", () => {
    const toolCalls = [
      { turnRunId: "turn-1" },
      { turnRunId: "turn-2" },
      { turnRunId: "turn-2" }
    ];
    const filesByTurn = new Map([
      ["turn-1", [{ path: "a.ts" }]],
      ["turn-2", [{ path: "b.ts" }]]
    ]);

    // Ticking only the answer still counts its whole turn's activity.
    expect(shareTurnIdsForMessages(turns, ["a2"])).toEqual([turns[1].id]);
    expect(computeShareStats(turns, shareTurnIdsForMessages(turns, ["a2"]), toolCalls, filesByTurn as never))
      .toEqual({ conversations: 1, toolCalls: 2, files: 1 });
    expect(computeShareStats(turns, shareTurnIdsForMessages(turns, []), toolCalls, filesByTurn as never))
      .toEqual({ conversations: 0, toolCalls: 0, files: 0 });
  });
});

describe("share file name", () => {
  it("sanitizes path separators and reserved characters", () => {
    expect(buildShareFileName("修复/登录:bug?")).toBe("修复 登录 bug.png");
    expect(buildShareFileName("")).toBe("codexh-对话.png");
    expect(buildShareFileName("a".repeat(80)).length).toBeLessThanOrEqual(64);
  });
});
