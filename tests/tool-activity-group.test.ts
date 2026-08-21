import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolCallSummary } from "@shared-types";
import { DatabaseExecutionDetails, getDatabaseExecutionDetails, getToolActivityMetric, ToolActivityGroup, ToolActivityMetricLabel } from "../apps/desktop/src/renderer/timeline/transcript";

const timelineCss = readFileSync(new URL("../apps/desktop/src/renderer/timeline.css", import.meta.url), "utf8");

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
    expect(html).not.toContain("tool-activity-summary-status");
    expect(html).not.toContain("tool-activity-summary-count");
    expect(html).not.toContain(">已完成<");
    expect(html).not.toContain("tool-activity-details-shell");
    expect(html).not.toContain("tool-activity-row compact");
  });

  it("keeps long expanded tool histories inside a bounded scroll area", () => {
    const detailsRule = timelineCss.match(/\.tool-activity-details\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(detailsRule).toContain("max-height: min(360px, 46vh)");
    expect(detailsRule).toContain("overflow-y: auto");
    expect(detailsRule).toContain("overscroll-behavior: contain");
  });

  it("extracts the submitted SQL and parameters from database operations", () => {
    expect(getDatabaseExecutionDetails("database.query", {
      sourceId: "orders-db",
      sql: "SELECT * FROM orders WHERE id = ?",
      parameters: [42]
    })).toEqual([{
      label: "orders-db",
      sql: "SELECT * FROM orders WHERE id = ?",
      parameters: [42]
    }]);
  });

  it("extracts each source SQL from a federated query", () => {
    expect(getDatabaseExecutionDetails("database.federated_query", {
      sources: [
        { alias: "orders", sourceId: "sales-db", sql: "SELECT id FROM orders" },
        { alias: "users", sourceId: "crm-db", sql: "SELECT id FROM users", parameters: ["active"] }
      ]
    })).toEqual([
      { label: "orders · sales-db", sql: "SELECT id FROM orders" },
      { label: "users · crm-db", sql: "SELECT id FROM users", parameters: ["active"] }
    ]);
  });

  it("renders SQL and bound parameters in database execution details", () => {
    const html = renderToStaticMarkup(createElement(DatabaseExecutionDetails, {
      details: [{
        label: "orders-db",
        sql: "SELECT * FROM orders WHERE id = ?",
        parameters: [42]
      }]
    }));

    expect(html).toContain("database-execution-details");
    expect(html).toContain("SELECT * FROM orders WHERE id = ?");
    expect(html).toContain("orders-db");
    expect(html).toContain("参数");
    expect(html).toContain("42");
  });

  it("reports the actual line range returned by a file read", () => {
    expect(getToolActivityMetric("fs.read_file", {
      ok: true,
      json: { totalLines: 300, startLine: 120, endLine: 180 }
    })).toEqual({ kind: "read", startLine: 120, endLine: 180 });

    expect(getToolActivityMetric("fs.read_file", {
      ok: true,
      json: { totalLines: 86 }
    })).toEqual({ kind: "read", startLine: 1, endLine: 86 });
  });

  it("sums additions and deletions reported by an applied patch", () => {
    expect(getToolActivityMetric("apply_patch", {
      ok: true,
      json: {
        changes: [
          { path: "one.ts", additions: 8, deletions: 3 },
          { path: "two.ts", additions: 5, deletions: 1 }
        ]
      }
    })).toEqual({ kind: "edit", additions: 13, deletions: 4 });
  });

  it("calculates write counts from complete before and after snapshots", () => {
    expect(getToolActivityMetric("search_replace", {
      ok: true,
      json: {
        snapshots: [{
          before: "first\nsecond",
          after: "first\nchanged\nthird",
          beforeTruncated: false,
          afterTruncated: false
        }]
      }
    })).toEqual({ kind: "edit", additions: 2, deletions: 1 });
  });

  it("renders read ranges and edit counts in compact activity labels", () => {
    const readHtml = renderToStaticMarkup(createElement(ToolActivityMetricLabel, {
      metric: { kind: "read", startLine: 120, endLine: 180 }
    }));
    const editHtml = renderToStaticMarkup(createElement(ToolActivityMetricLabel, {
      metric: { kind: "edit", additions: 13, deletions: 4 }
    }));

    expect(readHtml).toContain("第 120-180 行");
    expect(editHtml).toContain("<b>+13</b>");
    expect(editHtml).toContain("<i>-4</i>");
  });
});
