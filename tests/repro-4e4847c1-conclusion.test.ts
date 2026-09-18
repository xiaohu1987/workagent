import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversationTurnSections,
  buildTimelineEntries,
  filterTranscriptMessages,
  getDisplayMessageContent,
  getMessageDisplayKind,
  isCommentaryOnlyTranscriptMessage
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import type { MessageRecord } from "@shared-types";

// Offline replay for thread 4e4847c1, turn 7c205ffe, final answer 38fc0890.
// Captured 2026-09-18 09:21:39Z: the server reported 62 rows and the runtime
// broadcast the answer, yet at 09:21:41 the renderer measured 61 visible
// messages, summaryEntryId was null and the collapsed turn was empty.
const FIXTURE_PATH = path.resolve(process.cwd(), "tmp/repro-4e4847c1.json");
const hasFixture = fs.existsSync(FIXTURE_PATH);

const fixture = (hasFixture
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))
  : { messages: [], toolCalls: [] }) as {
  messages: MessageRecord[];
  toolCalls: Array<Record<string, unknown>>;
};

// The dump kept growing after the incident; 62 rows is exactly what the server
// reported in the failing snapshot read.
const messages = fixture.messages.slice(0, 62);
const toolCalls = fixture.toolCalls as never[];
const WORKSPACE_ROOT = "D:\\workagent";
const TARGET = "38fc0890-a9f5-4446-9324-0baf50b45adf";
const TARGET_ENTRY = `message-${TARGET}`;

const describeWithFixture = hasFixture ? describe : describe.skip;

describeWithFixture("4e4847c1: the final answer must reach the visible transcript", () => {
  it("has the exact 62-row transcript the server reported", () => {
    expect(messages.length).toBe(62);
    expect(messages.at(-1)!.id).toBe(TARGET);
    expect(messages.at(-1)!.content.length).toBe(2128);
  });

  it("describes the answer as a formal (non-commentary) message", () => {
    const target = messages.find((message) => message.id === TARGET)!;
    // eslint-disable-next-line no-console
    console.log(
      "[4e4847c1] target",
      JSON.stringify({
        role: target.role,
        displayKind: getMessageDisplayKind(target),
        commentaryOnly: isCommentaryOnlyTranscriptMessage(target),
        metadataJson: target.metadataJson,
        displayLength: getDisplayMessageContent(target).length
      })
    );
    expect(getMessageDisplayKind(target)).toBeNull();
    expect(isCommentaryOnlyTranscriptMessage(target)).toBe(false);
    expect(getDisplayMessageContent(target).length).toBeGreaterThan(1500);
  });

  it("keeps the answer in the visible message list", () => {
    const visible = filterTranscriptMessages(messages, "completed");
    const ids = visible.map((message) => message.id);
    const targetIndex = ids.indexOf(TARGET);
    // eslint-disable-next-line no-console
    console.log(
      "[4e4847c1] visible",
      JSON.stringify({
        kept: visible.length,
        of: messages.length,
        targetKept: targetIndex >= 0,
        targetIndex,
        lastThree: visible.slice(-3).map((message) => `${message.id.slice(0, 8)}:${message.role}`)
      })
    );
    expect(ids).toContain(TARGET);
  });

  it("also keeps it while the thread still reads as running", () => {
    const visible = filterTranscriptMessages(messages, "running");
    expect(visible.map((message) => message.id)).toContain(TARGET);
  });

  it("turns the answer into the collapsed turn's summary entry", () => {
    const visible = filterTranscriptMessages(messages, "completed");
    const entries = buildTimelineEntries(visible, toolCalls, [], WORKSPACE_ROOT, "completed", [], null);
    const targetEntry = entries.find((entry) => entry.id === TARGET_ENTRY);
    const sections = buildConversationTurnSections(entries);
    const section = sections.find((candidate) => candidate.entryIds.includes(TARGET_ENTRY));
    // eslint-disable-next-line no-console
    console.log(
      "[4e4847c1] entries",
      JSON.stringify({
        entryCount: entries.length,
        hasTargetEntry: Boolean(targetEntry),
        sectionId: section?.id.slice(0, 20) ?? null,
        summaryId: section?.summaryEntryId?.slice(0, 28) ?? null,
        sectionEntries: section?.entryIds.length ?? null
      })
    );
    expect(targetEntry).toBeDefined();
    expect(section?.summaryEntryId).toBe(TARGET_ENTRY);
  });
});
