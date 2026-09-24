import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversationTurnSections,
  buildTimelineEntries,
  filterTranscriptMessages,
  getDisplayMessageContent,
  getMessageDisplayKind,
  isCommentaryOnlyTranscriptMessage,
  isOutcomeTranscriptMessage,
  shouldKeepTimelineEntryWhenTurnCollapsed
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import type { MessageRecord } from "@shared-types";

// Offline replay for the thread where the final answer stayed invisible until the
// thread was reloaded (thread 4a91894d, answer 82c87184, 5551 chars).
//
// The live diagnostics recorded: at 06:14:06 the renderer's own render inputs had
// entryCount 66 with the target entry absent, while the database already had the
// answer as row 101. This fixture is the dump of that thread so the pipeline can be
// replayed offline. Skipped when the dump is absent (it lives under tmp/).
const FIXTURE_PATH = path.resolve(process.cwd(), "tmp/repro-4a91894d.json");
const hasFixture = fs.existsSync(FIXTURE_PATH);

const fixture = (hasFixture
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))
  : { messages: [], toolCalls: [] }) as {
  messages: MessageRecord[];
  toolCalls: Array<Record<string, unknown>>;
};

const messages = fixture.messages;
const toolCalls = fixture.toolCalls as never[];
const WORKSPACE_ROOT = "C:\\Users\\xhwange\\Desktop\\06-项目文件夹\\Node项目\\运维\\help3";
const TARGET = "82c87184-6d3d-43bc-96fe-1b50a722aa76";
const TARGET_ENTRY = `message-${TARGET}`;

const describeWithFixture = hasFixture ? describe : describe.skip;

describeWithFixture("4a91894d final answer survives the pipeline", () => {
  it("stays visible under every thread status", () => {
    const statuses = ["completed", "running", "waiting", "idle", null] as const;
    const results = statuses.map((status) => {
      const visible = filterTranscriptMessages(messages, status as never);
      return {
        status: String(status),
        visible: visible.length,
        total: messages.length,
        kept: visible.some((message) => message.id === TARGET)
      };
    });
    // eslint-disable-next-line no-console
    console.log("[4a91894d] filter", JSON.stringify(results));
    for (const result of results) {
      expect(result.kept).toBe(true);
    }
  });

  it("is classified as a formal answer, not commentary", () => {
    const target = messages.find((message) => message.id === TARGET)!;
    const details = {
      displayKind: getMessageDisplayKind(target),
      commentaryOnly: isCommentaryOnlyTranscriptMessage(target),
      outcome: isOutcomeTranscriptMessage(target),
      displayLength: getDisplayMessageContent(target).length
    };
    // eslint-disable-next-line no-console
    console.log("[4a91894d] classify", JSON.stringify(details));
    expect(details.commentaryOnly).toBe(false);
    expect(details.outcome).toBe(true);
    expect(details.displayLength).toBeGreaterThan(4000);
  });

  it("builds an entry and becomes the turn summary", () => {
    const visible = filterTranscriptMessages(messages, "completed");
    const entries = buildTimelineEntries(
      visible,
      toolCalls,
      [],
      WORKSPACE_ROOT,
      "completed",
      [],
      null
    );
    const hasTargetEntry = entries.some((entry) => entry.id === TARGET_ENTRY);
    const sections = buildConversationTurnSections(entries);
    const last = sections.at(-1)!;
    // eslint-disable-next-line no-console
    console.log(
      "[4a91894d] timeline",
      JSON.stringify({
        entries: entries.length,
        hasTargetEntry,
        sections: sections.length,
        lastSection: last.id.slice(0, 24),
        lastSummary: last.summaryEntryId ? last.summaryEntryId.slice(0, 24) : null,
        lastEntryCount: last.entryIds.length,
        tailEntries: entries.slice(-3).map((entry) => ({
          k: entry.kind,
          i: entry.id.slice(0, 20),
          c: entry.createdAt
        }))
      })
    );
    expect(hasTargetEntry).toBe(true);
    expect(last.summaryEntryId).toBe(TARGET_ENTRY);
  });

  it("folds commentary away when the answer has not landed yet", () => {
    // Regression for the other half of the symptom. With the answer absent the
    // turn has no summary entry, and the previous rule kept *every* assistant
    // message visible - commentary included - so finished turns rendered fully
    // expanded while the conclusion was still missing.
    const withoutAnswer = filterTranscriptMessages(
      messages.filter((message) => message.id !== TARGET),
      "completed"
    );
    const entries = buildTimelineEntries(
      withoutAnswer,
      toolCalls,
      [],
      WORKSPACE_ROOT,
      "completed",
      [],
      null
    );
    const sections = buildConversationTurnSections(entries);
    const last = sections.at(-1)!;
    const collapsed = new Set([last.id]);
    const kept = last.entryIds
      .map((entryId) => entries.find((entry) => entry.id === entryId))
      .filter((entry): entry is (typeof entries)[number] => Boolean(entry))
      .filter((entry) => shouldKeepTimelineEntryWhenTurnCollapsed(entry, last, collapsed));
    const keptCommentary = kept.filter(
      (entry) =>
        entry.kind === "message" &&
        entry.message.role === "assistant" &&
        getMessageDisplayKind(entry.message) === "commentary"
    );
    // eslint-disable-next-line no-console
    console.log(
      "[4a91894d] noSummaryFold",
      JSON.stringify({
        summaryEntryId: last.summaryEntryId ?? null,
        entries: last.entryIds.length,
        kept: kept.length,
        keptCommentary: keptCommentary.length
      })
    );
    // The collapsed turn always renders an assistant entry now: the summary falls back to
    // the last assistant text when no formal answer has landed yet, so a finished turn can
    // no longer fold away to an empty body while the user waits for the conclusion.
    const summaryEntry = entries.find((entry) => entry.id === last.summaryEntryId);
    expect(summaryEntry?.kind).toBe("message");
    expect(last.entryIds.length).toBeGreaterThan(1);
    // Only the summary line survives from the commentary; the remaining progress notes and
    // the tool activity stay folded away.
    expect(keptCommentary.length).toBeLessThanOrEqual(1);
    expect(keptCommentary.every((entry) => entry.id === last.summaryEntryId)).toBe(true);
  });
});
