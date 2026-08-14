import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCallSummary } from "@shared-types";
import { ToolActivityGroup } from "../apps/desktop/src/renderer/timeline/transcript";

describe("ToolActivityGroup", () => {
  it("does not render collapsed historical tool details", () => {
    const toolCall: ToolCallSummary = {
      id: "tool-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "shell.exec",
      argumentsJson: JSON.stringify({ command: "build" }),
      resultJson: null,
      resultSize: 12_000,
      hasFullResult: false,
      status: "completed",
      riskLevel: "low",
      approvalMode: "auto",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z"
    };

    const html = renderToStaticMarkup(createElement(ToolActivityGroup, { toolCalls: [toolCall] }));

    expect(html).toContain("tool-activity-summary");
    expect(html).not.toContain("tool-activity-details-shell");
    expect(html).not.toContain("tool-activity-row compact");
  });
});
