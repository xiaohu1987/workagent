import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "@shared-types";
import { TimelineEntries } from "../apps/desktop/src/renderer/timeline/timeline-entries";

describe("TimelineEntries tool history", () => {
  it("keeps a running tool group in the chronological transcript", () => {
    const toolCall = {
      id: "call-running",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "shell.exec",
      argumentsJson: JSON.stringify({ command: "git status --short" }),
      resultJson: null,
      status: "running",
      riskLevel: "low",
      approvalMode: "auto",
      startedAt: "2026-10-03T08:00:00.000Z",
      completedAt: null
    } as ToolCallRecord;
    const entry = {
      kind: "tool-group" as const,
      id: "tool-group-message-1",
      createdAt: "2026-10-03T08:00:00.000Z",
      toolCalls: [toolCall]
    };
    const html = renderToStaticMarkup(createElement(TimelineEntries, {
      threadId: "thread-1",
      entries: [entry],
      turnByEntryId: new Map(),
      latestTurnId: null,
      taskProcessing: true,
      collapsedTurnIds: new Set<string>(),
      assistantLabel: "助手",
      userMessageActions: {
        editingMessage: null,
        onEditDraftChange: () => undefined,
        onCopy: () => undefined,
        onEdit: () => undefined,
        onEditCancel: () => undefined,
        onEditSubmit: () => undefined
      },
      gpaPlanMessageId: null,
      finalizingAssistantMessageIds: new Set<string>(),
      completedLatestTurnAt: null,
      scrollElementRef: { current: null },
      scrollInteractionActive: false,
      followLatest: true,
      onOpenFolder: () => undefined,
      onRequestFollowLatest: () => undefined,
      onToggleTurn: () => undefined,
      shareMode: false,
      shareableMessageIds: new Set<string>(),
      selectedShareMessageIds: new Set<string>(),
      onToggleShareMessage: () => undefined
    }));

    expect(html).toContain("tool-activity-group");
    expect(html).toContain("正在执行命令");
  });
});
