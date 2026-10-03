import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversationTurnSections,
  buildTimelineEntries,
  buildTimelineEntriesIncremental,
  filterTranscriptMessages,
  getDisplayMessageContent,
  getMessageDisplayKind,
  mergeServerMessagesWithNewerLocal,
  shouldKeepTimelineEntryWhenTurnCollapsed
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import type { MessageRecord } from "@shared-types";

// Offline replay of the real transcript pipeline for the turn that reproduced
// "the final answer only shows up after the thread is reloaded"
// (thread 59b6aa59, turn 7138b4c7, final answer e1271f46).
//
// The fixture is a dump of that thread taken from the local codexh database. It
// lives under tmp/ because it is captured data, not source, so the suite skips
// itself when the dump is absent instead of failing on a clean checkout.
const FIXTURE_PATH = path.resolve(process.cwd(), "tmp/repro-59b6aa59.json");
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
const TARGET = "e1271f46-65a6-4eee-a5ce-71f3d175dc3d";
const TARGET_ENTRY = `message-${TARGET}`;

const describeWithFixture = hasFixture ? describe : describe.skip;

describeWithFixture("final answer survives the transcript pipeline", () => {
  it("is not filtered out of the visible messages", () => {
    const visible = filterTranscriptMessages(messages, "completed");
    const ids = visible.map((message) => message.id);
    // eslint-disable-next-line no-console
    console.log("[repro] visible", visible.length, "of", messages.length, "targetKept", ids.includes(TARGET));
    expect(ids).toContain(TARGET);
  });

  it("renders non-empty display content", () => {
    const target = messages.find((message) => message.id === TARGET)!;
    const display = getDisplayMessageContent(target);
    // eslint-disable-next-line no-console
    console.log("[repro] displayContentLength", display.length);
    expect(display.length).toBeGreaterThan(1500);
  });

  it("produces a timeline entry and becomes the collapsed turn summary", () => {
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
    const targetEntry = entries.find((entry) => entry.id === TARGET_ENTRY);
    // eslint-disable-next-line no-console
    console.log("[repro] entryCount", entries.length, "targetEntry", Boolean(targetEntry));
    expect(targetEntry).toBeDefined();

    const sections = buildConversationTurnSections(entries);
    const section = sections.find((candidate) => candidate.entryIds.includes(TARGET_ENTRY));
    // eslint-disable-next-line no-console
    console.log(
      "[repro] lastSections",
      JSON.stringify(
        sections.slice(-2).map((item) => ({
          id: item.id.slice(0, 20),
          summary: item.summaryEntryId?.slice(0, 20) ?? null,
          entries: item.entryIds.length
        })),
        null,
        0
      )
    );
    expect(section?.summaryEntryId).toBe(TARGET_ENTRY);

    const collapsed = new Set([section!.id]);
    expect(shouldKeepTimelineEntryWhenTurnCollapsed(targetEntry!, section, collapsed)).toBe(true);
  });

  it("keeps the entry through the incremental append path", () => {
    const beforeTarget = filterTranscriptMessages(
      messages.filter((message) => message.id !== TARGET),
      "running"
    );
    const first = buildTimelineEntriesIncremental(
      {
        messages: beforeTarget,
        toolCalls,
        artifacts: [],
        workspaceRoot: WORKSPACE_ROOT,
        threadStatus: "running",
        prompts: [],
        contextCompaction: null
      },
      null
    );
    const second = buildTimelineEntriesIncremental(
      {
        messages: filterTranscriptMessages(messages, "completed"),
        toolCalls,
        artifacts: [],
        workspaceRoot: WORKSPACE_ROOT,
        threadStatus: "completed",
        prompts: [],
        contextCompaction: null
      },
      first.cache
    );
    const ids = second.entries.map((entry) => entry.id);
    // eslint-disable-next-line no-console
    console.log(
      "[repro] incremental",
      JSON.stringify({
        usedIncremental: second.usedIncremental,
        entryCount: second.entries.length,
        hasTarget: ids.includes(TARGET_ENTRY)
      })
    );
    expect(ids).toContain(TARGET_ENTRY);
  });

  it("hides the final answer while the turn's section is still stale", () => {
    // What the renderer sees if the collapse is applied with entries that do not
    // yet contain the final answer: summaryEntryId points at an earlier short
    // reply, so the conclusion is not among the kept entries.
    const staleMessages = filterTranscriptMessages(
      messages.filter((message) => message.id !== TARGET),
      "running"
    );
    const staleEntries = buildTimelineEntries(
      staleMessages,
      toolCalls,
      [],
      WORKSPACE_ROOT,
      "running",
      [],
      null
    );
    const staleSections = buildConversationTurnSections(staleEntries);
    const staleSection = staleSections.at(-1)!;
    const targetEntry = staleEntries.find((entry) => entry.id === TARGET_ENTRY);
    // eslint-disable-next-line no-console
    console.log(
      "[repro] staleSummary",
      JSON.stringify({
        sectionId: staleSection.id.slice(0, 20),
        summary: staleSection.summaryEntryId?.slice(0, 20) ?? null,
        targetEntryPresent: Boolean(targetEntry)
      })
    );
    expect(staleSection.summaryEntryId).not.toBe(TARGET_ENTRY);
    expect(targetEntry).toBeUndefined();
  });

  it("never hides a collapsed turn's prose when it has no summary entry yet", () => {
    // Regression for the reload-only symptom. A turn that finishes before its
    // final answer reaches the transcript used to collapse down to a summary that
    // did not exist, dropping every assistant entry in it and leaving exactly the
    // screenshot shape: file summary + duration footer, no conclusion.
    const staleMessages = filterTranscriptMessages(
      messages.filter((message) => message.id !== TARGET),
      "running"
    );
    const staleEntries = buildTimelineEntries(
      staleMessages,
      toolCalls,
      [],
      WORKSPACE_ROOT,
      "running",
      [],
      null
    );
    const staleSections = buildConversationTurnSections(staleEntries);
    const staleSection = staleSections.at(-1)!;
    // A summary may resolve before the formal answer lands, so what matters is that it
    // resolves to real assistant prose: the collapsed turn must always have something
    // readable to render, and the assertions below still forbid hiding formal text.
    expect(staleEntries.find((entry) => entry.id === staleSection.summaryEntryId)?.kind)
      .toBe("message");
    // The turn must actually have assistant entries, otherwise hiding none of
    // them would be trivially true and this test would prove nothing.
    expect(staleSection.entryIds.length).toBeGreaterThan(1);

    const collapsed = new Set([staleSection.id]);
    const hiddenEntries = staleSection.entryIds
      .map((entryId) => staleEntries.find((candidate) => candidate.id === entryId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .filter((entry) => !shouldKeepTimelineEntryWhenTurnCollapsed(entry, staleSection, collapsed));
    // Counterfactual: the rule before this fix kept only the user message, the
    // file summary and the (here absent) summary entry, so the whole turn body
    // disappeared while "主要改动文件" and the duration footer stayed. That is the
    // exact screenshot that prompted this work.
    const legacyHidden = staleSection.entryIds.filter((entryId) => {
      const entry = staleEntries.find((candidate) => candidate.id === entryId);
      if (!entry) return false;
      return entryId !== staleSection.userEntryId
        && entryId !== staleSection.summaryEntryId
        && entry.kind !== "file-summary";
    });
    // eslint-disable-next-line no-console
    console.log(
      "[repro] collapsedWithoutSummary",
      JSON.stringify({
        entries: staleSection.entryIds.length,
        hidden: hiddenEntries.map((entry) => entry.kind),
        legacyHidden: legacyHidden.length
      })
    );
    expect(legacyHidden.length).toBeGreaterThan(0);
    // Nothing the user is waiting to read may vanish: every formal assistant entry
    // survives the collapse. Interim commentary may fold away - keeping *all*
    // assistant text visible here is what left finished turns fully expanded
    // (the "过程不收起了" half of the symptom reported against this fix).
    expect(
      hiddenEntries.filter((entry) =>
        entry.kind === "message"
        && entry.message.role === "assistant"
        && getMessageDisplayKind(entry.message) !== "commentary")
    ).toEqual([]);
    // The noisy tool activity is still folded away - that is the whole point of
    // collapsing a finished turn.
    expect(hiddenEntries.some((entry) => entry.kind === "tool-group")).toBe(true);
  });
});

describe("a snapshot read must not erase a message the ui already painted", () => {
  const message = (id: string, createdAt: string) => ({ id, createdAt });

  it("re-attaches the final answer when the server list is behind", () => {
    // `message.created` is broadcast before the row is visible to a snapshot
    // read, so the read returns a list without it. Replacing the painted list
    // with that read is what left the conclusion missing until a reload.
    const server = [message("a", "2026-09-18T05:55:00.000Z"), message("b", "2026-09-18T05:55:12.000Z")];
    const local = [...server, message("final", "2026-09-18T05:55:28.052Z")];
    expect(mergeServerMessagesWithNewerLocal(server, local).map((item) => item.id))
      .toEqual(["a", "b", "final"]);
  });

  it("lets a current server list win", () => {
    const local = [message("a", "2026-09-18T05:55:00.000Z")];
    const server = [...local, message("b", "2026-09-18T05:55:12.000Z")];
    expect(mergeServerMessagesWithNewerLocal(server, local).map((item) => item.id))
      .toEqual(["a", "b"]);
  });

  it("still honours server-side deletion when the server is not behind", () => {
    // `a` was removed server-side; the newest row matches what we hold, so the
    // server list is authoritative and `a` must not be resurrected.
    const server = [message("b", "2026-09-18T05:55:12.000Z")];
    const local = [message("a", "2026-09-18T05:55:00.000Z"), message("b", "2026-09-18T05:55:12.000Z")];
    expect(mergeServerMessagesWithNewerLocal(server, local).map((item) => item.id))
      .toEqual(["b"]);
  });

  it("does nothing when there is no local state", () => {
    const server = [message("a", "2026-09-18T05:55:00.000Z")];
    expect(mergeServerMessagesWithNewerLocal(server, [])).toBe(server);
  });
});
