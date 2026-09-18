import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversationTurnSections,
  buildTimelineEntries,
  buildTimelineEntriesIncremental,
  filterTranscriptMessages,
  getDisplayMessageContent,
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

  it("never hides a collapsed turn that has no summary entry yet", () => {
    // Regression for the reload-only symptom. A turn that finishes before its
    // final answer reaches the transcript has summaryEntryId === null. Collapsing
    // such a turn used to drop every assistant entry in it, leaving exactly the
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
    expect(staleSection.summaryEntryId ?? null).toBeNull();
    // The turn must actually have assistant entries, otherwise hiding none of
    // them would be trivially true and this test would prove nothing.
    expect(staleSection.entryIds.length).toBeGreaterThan(1);

    const collapsed = new Set([staleSection.id]);
    const hidden = staleSection.entryIds.filter((entryId) => {
      const entry = staleEntries.find((candidate) => candidate.id === entryId);
      return entry ? !shouldKeepTimelineEntryWhenTurnCollapsed(entry, staleSection, collapsed) : false;
    });
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
        hidden,
        legacyHidden: legacyHidden.length
      })
    );
    expect(legacyHidden.length).toBeGreaterThan(0);
    expect(hidden).toEqual([]);
  });
});
