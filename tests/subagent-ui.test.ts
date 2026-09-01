import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SubagentResultEnvelope, ThreadRecord, ToolCallRecord } from "@shared-types";
import type { RuntimeActivity } from "../apps/desktop/src/renderer/core/app-types";
import {
  SubagentStatusDock,
  SubagentTaskGroup,
  getSubagentGroupSummary,
  getSubagentPhases,
  getSubagentTaskName,
  resolveSubagentDisplayState,
  shouldShowSubagentStatusDock
} from "../apps/desktop/src/renderer/cards/runtime-cards";

const rendererStylesCss = readFileSync(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");

function createAgent(id: string, status: ThreadRecord["status"], role: string): ThreadRecord {
  return {
    id,
    title: role,
    mode: "project",
    workspaceKind: "project",
    cwd: "D:\\repo",
    workspaceRoots: ["D:\\repo"],
    projectId: "project-1",
    workspaceId: null,
    modelId: "model-1",
    providerId: "provider-1",
    status,
    selectedSkillIds: [],
    selectedPluginIds: [],
    knowledgeBaseIds: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    isPinned: false,
    pinnedAt: null,
    gpaStateJson: null,
    parentThreadId: "root",
    rootThreadId: "root",
    agentPath: `/root/${id}`,
    agentRole: role,
    lastTaskMessage: `完成 ${role} 并返回结论。`,
    multiAgentMode: "proactive"
  };
}

function createResult(agent: ThreadRecord, status: SubagentResultEnvelope["status"], summary: string, errors: string[] = []): SubagentResultEnvelope {
  return {
    status,
    summary,
    evidence: [],
    errors,
    agentPath: agent.agentPath,
    threadId: agent.id
  };
}

function createToolCall(id: string, toolName: string, argumentsJson: string, status: ToolCallRecord["status"]): ToolCallRecord {
  return {
    id,
    threadId: "running",
    turnRunId: "turn-1",
    toolName,
    argumentsJson,
    resultJson: status === "completed" ? "{}" : null,
    status,
    riskLevel: "low",
    approvalMode: "auto",
    startedAt: "2026-09-01T00:00:01.000Z",
    completedAt: status === "completed" ? "2026-09-01T00:00:02.000Z" : null
  };
}

describe("subagent task UI", () => {
  it("turns internal task keys into user-facing task names", () => {
    expect(getSubagentTaskName({ agentRole: "api_docs_analysis", lastTaskMessage: null })).toBe("API 文档分析");
    expect(getSubagentTaskName({ agentRole: "test_coverage_check", lastTaskMessage: null })).toBe("测试覆盖检查");
    expect(getSubagentTaskName({ agentRole: "spawn_agent", lastTaskMessage: "检查登录接口的鉴权边界。" })).toBe("检查登录接口的鉴权边界");
  });

  it("distinguishes all six user-visible lifecycle states", () => {
    const agent = createAgent("agent", "running", "review");
    expect(resolveSubagentDisplayState(agent, true, undefined, false)).toBe("queued");
    expect(resolveSubagentDisplayState(agent, false, undefined, false)).toBe("running");
    expect(resolveSubagentDisplayState(agent, false, undefined, true)).toBe("waiting_input");
    expect(resolveSubagentDisplayState({ status: "completed" }, false, createResult(agent, "completed", "done"), false)).toBe("completed");
    expect(resolveSubagentDisplayState({ status: "failed" }, false, createResult(agent, "failed", "failed"), false)).toBe("failed");
    expect(resolveSubagentDisplayState(agent, false, createResult(agent, "interrupted", "stopped"), false)).toBe("cancelled");
  });

  it("reports exact state counts without percentage progress", () => {
    const agents = [
      createAgent("done", "completed", "review"),
      createAgent("running", "running", "analysis"),
      createAgent("input", "waiting", "security"),
      createAgent("queued", "idle", "docs"),
      createAgent("failed", "failed", "tests"),
      createAgent("cancelled", "completed", "research")
    ];
    const results = new Map([
      ["done", createResult(agents[0], "completed", "done")],
      ["failed", createResult(agents[4], "failed", "failed")],
      ["cancelled", createResult(agents[5], "interrupted", "stopped")]
    ]);

    const summary = getSubagentGroupSummary(agents, new Set(["queued"]), results, new Set(["input"]));

    expect(summary).toBe("子任务 1 已完成 · 1 运行中 · 1 等待输入 · 1 排队中 · 1 失败 · 1 已取消");
    expect(summary).not.toContain("%");
  });

  it("builds phase progress only from observed activity", () => {
    const activity: RuntimeActivity = {
      threadId: "running",
      startedAt: "2026-09-01T00:00:00.000Z",
      entries: [
        { id: "status-1", kind: "status", label: "正在分析任务", createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "tool-read", kind: "tool", toolCall: createToolCall("tool-read", "fs.read_file", JSON.stringify({ path: "auth.ts" }), "completed") },
        { id: "tool-test", kind: "tool", toolCall: createToolCall("tool-test", "shell.exec", JSON.stringify({ command: "pnpm test" }), "running") }
      ]
    };

    expect(getSubagentPhases("running", activity).map((phase) => [phase.label, phase.state])).toEqual([
      ["分析任务", "completed"],
      ["读取代码", "completed"],
      ["执行测试", "current"]
    ]);
  });

  it("does not present model or subtask waits as user input", () => {
    const modelWait: RuntimeActivity = {
      threadId: "model-wait",
      startedAt: "2026-09-01T00:00:00.000Z",
      entries: [
        { id: "tool-read", kind: "tool", toolCall: createToolCall("tool-read", "fs.read_file", JSON.stringify({ path: "auth.ts" }), "completed") },
        { id: "status-model", kind: "status", label: "等待模型响应", createdAt: "2026-09-01T00:00:03.000Z" }
      ]
    };
    const subtaskWait: RuntimeActivity = {
      threadId: "subtask-wait",
      startedAt: "2026-09-01T00:00:00.000Z",
      entries: [
        { id: "status-subtask", kind: "status", label: "正在等待子智能体", createdAt: "2026-09-01T00:00:03.000Z" }
      ]
    };

    expect(getSubagentPhases("running", modelWait).map((phase) => phase.label)).toEqual([
      "读取代码",
      "等待模型响应"
    ]);
    expect(getSubagentPhases("running", subtaskWait).map((phase) => phase.label)).toEqual(["等待子任务"]);
    expect(getSubagentPhases("waiting_input", modelWait).map((phase) => phase.label)).toEqual([
      "读取代码",
      "等待模型响应",
      "等待输入"
    ]);
  });

  it("renders scan-friendly results, failure recovery, and takeover controls", () => {
    const completed = createAgent("done", "completed", "api_docs_analysis");
    const failed = createAgent("failed", "failed", "test_coverage_check");
    const running = createAgent("running", "running", "security_review");
    const html = renderToStaticMarkup(createElement(SubagentTaskGroup, {
      agents: [completed, failed, running],
      queuedAgentIds: new Set<string>(),
      resultsById: new Map([
        [completed.id, createResult(completed, "completed", "发现 2 个阻塞问题")],
        [failed.id, createResult(failed, "failed", "测试没有完成", ["测试进程退出码为 1"])]
      ]),
      waitingInputAgentIds: new Set<string>(),
      runtimeActivities: {},
      onInterrupt: vi.fn(),
      onSendInstruction: vi.fn(async () => undefined),
      onRetry: vi.fn(async () => undefined),
      onTakeOver: vi.fn()
    }));

    expect(html).toContain("API 文档分析");
    expect(html).toContain("测试覆盖检查");
    expect(html).toContain("发现 2 个阻塞问题");
    expect(html).toContain("测试进程退出码为 1");
    expect(html).toContain("查看结果");
    expect(html).toContain("subagent-task-quick-retry");
    expect(html).toContain("追加指令");
    expect(html).toContain("重试");
    expect(html).toContain("停止");
    expect(html).toContain("接管");
    expect(html).toContain("代理详情");
  });

  it("shows only a small collapsible icon while the enabled task is running", () => {
    const collapsedHtml = renderToStaticMarkup(createElement(SubagentStatusDock, {
      summary: "子任务 1 已完成 · 2 运行中",
      count: 3,
      expanded: false,
      onToggle: vi.fn()
    }, createElement("div", null, "任务详情")));
    const expandedHtml = renderToStaticMarkup(createElement(SubagentStatusDock, {
      summary: "子任务 1 已完成 · 2 运行中",
      count: 3,
      expanded: true,
      onToggle: vi.fn()
    }, createElement("div", null, "任务详情")));
    const dockRule = rendererStylesCss.match(/\.subagent-status-dock\s*\{([^}]*)\}/)?.[1] ?? "";
    const toggleRule = rendererStylesCss.match(/\.subagent-status-dock-toggle\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).toContain("展开子智能体详情");
    expect(collapsedHtml).toContain("subagent-status-dock-count");
    expect(collapsedHtml).not.toContain("任务详情</div>");
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain("收起子智能体详情");
    expect(expandedHtml).toContain("subagent-status-panel");
    expect(expandedHtml).toContain("任务详情</div>");
    expect(dockRule).toContain("position: relative");
    expect(dockRule).not.toContain("position: sticky");
    expect(collapsedHtml).toContain("workspace-control-button subagent-status-dock-toggle");
    expect(toggleRule).not.toContain("width: 34px");
    expect(toggleRule).not.toContain("height: 34px");
  });

  it("hides the subagent control when execution finishes or the feature is disabled", () => {
    expect(shouldShowSubagentStatusDock(true, "proactive")).toBe(true);
    expect(shouldShowSubagentStatusDock(false, "proactive")).toBe(false);
    expect(shouldShowSubagentStatusDock(true, "disabled")).toBe(false);
    expect(getSubagentGroupSummary([], new Set(), new Map(), new Set())).toBe("子任务 尚未启动");
  });
});
