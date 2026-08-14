import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@shared-types";
import { ApprovalCard } from "../apps/desktop/src/renderer/timeline/transcript";

function createApproval(kind: ApprovalRequest["kind"]): ApprovalRequest {
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
    payloadJson: "{}",
    status: "pending",
    resolutionMode: null,
    expiresAt: null,
    resolutionSource: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    resolvedAt: null
  };
}

describe("approval card", () => {
  it("limits explicit authorization to a one-time decision", () => {
    const html = renderToStaticMarkup(createElement(ApprovalCard, {
      approval: createApproval("explicit_authorization"),
      resolving: false,
      onResolve: () => undefined
    }));

    expect(html).toContain("需要明确授权");
    expect(html).toContain("授权并继续");
    expect(html).toContain("拒绝");
    expect(html).not.toContain("本会话允许");
    expect(html).not.toContain("允许且不再询问");
  });
});
