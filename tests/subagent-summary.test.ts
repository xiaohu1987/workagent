import { describe, expect, it } from "vitest";
import { buildSubagentCompletionSummary } from "../apps/desktop/src/main/subagent-summary";

describe("subagent completion summaries", () => {
  it("publishes a compact, labeled result for the parent task", () => {
    const summary = buildSubagentCompletionSummary({
      agentRole: "api_layer_review",
      agentPath: "/root/api_layer_review"
    }, {
      summary: `发现接口鉴权缺少租户校验。${"细节 ".repeat(200)}`
    });

    expect(summary.startsWith("子智能体 api layer review 已完成")).toBe(true);
    expect(summary).toContain("发现接口鉴权缺少租户校验。");
    expect(summary.endsWith("...")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(530);
  });

  it("falls back to the agent path and a useful empty-result message", () => {
    expect(buildSubagentCompletionSummary({ agentRole: null, agentPath: "/root/security-check" }, { summary: "  " }))
      .toBe("子智能体 security check 已完成\n\n已完成，未返回额外说明。");
  });
});
