import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@shared-types";
import { ApprovalCard } from "../apps/desktop/src/renderer/timeline/transcript";

function createApproval(kind: ApprovalRequest["kind"], payloadJson?: string): ApprovalRequest {
  return {
    id: "approval-1",
    threadId: "thread-1",
    turnRunId: "turn-1",
    toolCallId: null,
    projectId: null,
    kind,
    title: "Git 操作需要明确授权",
    description: "git pull origin test",
    scope: "prompt",
    riskLevel: "high",
    approvalKey: "approval-key",
    payloadJson: payloadJson ?? (kind === "explicit_authorization" ? "{\"authorizationKind\":\"git_mutation\"}" : "{}"),
    status: "pending",
    resolutionMode: null,
    expiresAt: null,
    resolutionSource: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    resolvedAt: null
  };
}

describe("approval card", () => {
  it("offers remembered approval for explicit authorization", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, {
      approval: createApproval("explicit_authorization"),
      resolving: false,
      onResolve: () => undefined
    }));

    expect(html).toContain("需要明确授权");
    expect(html).toContain("授权并继续");
    expect(html).toContain("同意且下次不再询问");
    expect(html).toContain("拒绝");
    expect(html).not.toContain("本会话允许");
  });

  it("keeps non-Git explicit authorization one-time only", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, {
      approval: createApproval("explicit_authorization", "{\"authorizationKind\":\"filesystem_delete\"}"),
      resolving: false,
      onResolve: () => undefined
    }));

    expect(html).toContain("授权并继续");
    expect(html).not.toContain("同意且下次不再询问");
  });
});
