import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SubagentResultEnvelope, ThreadRecord, ToolCallRecord } from "@shared-types";
import type { RuntimeActivity } from "../apps/desktop/src/renderer/core/app-types";
import {
  SubagentDetailWorkspace,
  SubagentSwitchRow,
  SUBAGENT_COURTESY_NAMES,
  assignSubagentCourtesyNames,
  buildSubagentPresentations,
  getSubagentGroupSummary,
  getSubagentPhases,
  getSubagentTaskName,
  resolveSubagentDisplayState,
  resolveSelectedSubagentId
} from "../apps/desktop/src/renderer/cards/runtime-cards";

const rendererStylesCss = readFileSync(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");
const backendSource = readFileSync(new URL("../apps/desktop/src/main/app.ts", import.meta.url), "utf8");
const rendererAppSource = readFileSync(new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url), "utf8");
const workspaceControlsSource = readFileSync(new URL("../apps/desktop/src/renderer/workspace/workspace-controls.tsx", import.meta.url), "utf8");
const rightWorkspaceSource = readFileSync(new URL("../apps/desktop/src/renderer/workspace/right-workspace.tsx", import.meta.url), "utf8");

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
  it("keeps task names for details while chat uses short courtesy names", () => {
    expect(getSubagentTaskName({ agentRole: "api_docs_analysis", lastTaskMessage: null })).toBe("API 文档分析");
    expect(getSubagentTaskName({ agentRole: "test_coverage_check", lastTaskMessage: null })).toBe("测试覆盖检查");
    expect(getSubagentTaskName({ agentRole: "api_layer_analysis", lastTaskMessage: null })).toBe("API 层分析");
    expect(getSubagentTaskName({ agentRole: "APIlayer分析", lastTaskMessage: null })).toBe("API 层分析");
    expect(getSubagentTaskName({ agentRole: "测试andquality分析", lastTaskMessage: null })).toBe("测试与质量分析");
    expect(getSubagentTaskName({ agentRole: "spawn_agent", lastTaskMessage: "检查登录接口的鉴权边界。" })).toBe("检查登录接口的鉴权边界");
    expect(getSubagentTaskName({ agentRole: "api_layer_analysis", lastTaskMessage: "你在分析位于 D:\\Code\\PmpfinOps 的项目" })).toBe("API 层分析");
    expect(getSubagentTaskName({
      agentRole: "你是一个只读代码分析子智能体",
      lastTaskMessage: "你是一个只读代码分析子智能体"
    })).toBe("代码分析");
  });

  it("assigns unique anime-character names in spawn order", () => {
    expect(SUBAGENT_COURTESY_NAMES.every((name) => name.trim().length >= 2)).toBe(true);
    expect(new Set(SUBAGENT_COURTESY_NAMES).size).toBe(SUBAGENT_COURTESY_NAMES.length);
    const names = assignSubagentCourtesyNames([
      { id: "later", createdAt: "2026-09-01T00:00:02.000Z" },
      { id: "first", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "middle", createdAt: "2026-09-01T00:00:01.000Z" }
    ]);
    expect([...names.values()]).toEqual(SUBAGENT_COURTESY_NAMES.slice(0, 3));
    expect(names.get("first")).toBe(SUBAGENT_COURTESY_NAMES[0]);
    expect(names.get("middle")).toBe(SUBAGENT_COURTESY_NAMES[1]);
    expect(names.get("later")).toBe(SUBAGENT_COURTESY_NAMES[2]);
  });

  it("invents distinct names when child agents reuse the same persona", () => {
    const persona = "你是一个只读代码分析子智能体";
    const layered = buildSubagentPresentations({
      agents: [
        { ...createAgent("api", "running", persona), lastTaskMessage: "请分析 API 层的控制器与路由。" },
        { ...createAgent("domain", "running", persona), lastTaskMessage: "请分析 Domain 层的实体与业务规则。" },
        { ...createAgent("quality", "running", persona), lastTaskMessage: "请分析测试项目与工程质量。" }
      ],
      queuedAgentIds: new Set<string>(),
      resultsById: new Map(),
      waitingInputAgentIds: new Set<string>(),
      runtimeActivities: {}
    });
    expect(layered.map((item) => item.title)).toEqual(SUBAGENT_COURTESY_NAMES.slice(0, 3));
    expect(layered.map((item) => item.taskName)).toEqual(["API 层分析", "领域层分析", "测试质量分析"]);

    const numbered = buildSubagentPresentations({
      agents: [
        { ...createAgent("one", "running", persona), lastTaskMessage: persona },
        { ...createAgent("two", "running", persona), lastTaskMessage: persona },
        { ...createAgent("three", "running", persona), lastTaskMessage: persona }
      ],
      queuedAgentIds: new Set<string>(),
      resultsById: new Map(),
      waitingInputAgentIds: new Set<string>(),
      runtimeActivities: {}
    });
    expect(numbered.map((item) => item.title)).toEqual([SUBAGENT_COURTESY_NAMES[0], SUBAGENT_COURTESY_NAMES[2], SUBAGENT_COURTESY_NAMES[1]]);
    expect(new Set(numbered.map((item) => item.title)).size).toBe(3);
    expect(numbered.every((item) => item.taskName === "代码分析")).toBe(true);
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

  it("builds one shared presentation for workspace details", () => {
    const completed = createAgent("done", "completed", "api_docs_analysis");
    const failed = createAgent("failed", "failed", "test_coverage_check");
    const running = createAgent("running", "running", "security_review");
    const items = buildSubagentPresentations({
      agents: [completed, failed, running],
      queuedAgentIds: new Set<string>(),
      resultsById: new Map([
        [completed.id, createResult(completed, "completed", "发现 2 个阻塞问题")],
        [failed.id, createResult(failed, "failed", "测试没有完成", ["测试进程退出码为 1"])]
      ]),
      waitingInputAgentIds: new Set<string>(),
      runtimeActivities: {}
    });
    const detailHtml = renderToStaticMarkup(createElement(SubagentDetailWorkspace, { item: items[1] }));

    expect(items.map((item) => item.title)).toEqual(SUBAGENT_COURTESY_NAMES.slice(0, 3));
    expect(items.map((item) => item.taskName)).toEqual(["API 文档分析", "测试覆盖检查", "安全审查"]);
    expect(items[0].summary).toBe("发现 2 个阻塞问题");
    expect(items[1].detailOutput).toContain("测试进程退出码为 1");
    expect(detailHtml).toContain("测试进程退出码为 1");
    expect(detailHtml).toContain("任务结果");
    expect(detailHtml).toContain("subagent-workspace-phases");
    expect(detailHtml).toContain("测试覆盖检查");
    expect(detailHtml.indexOf("阶段进度")).toBeLessThan(detailHtml.indexOf("任务目标"));
    expect(detailHtml).not.toContain("<button");

    const switchHtml = renderToStaticMarkup(createElement(SubagentSwitchRow, {
      items,
      selectedId: items[1].agent.id,
      onSelect: () => undefined
    }));
    expect(switchHtml).toContain("aria-label=\"切换子智能体\"");
    for (const name of SUBAGENT_COURTESY_NAMES.slice(0, 3)) {
      expect(switchHtml).toContain(`subagent-switch-name">${name}</`);
    }
    expect(switchHtml).toContain("运行中");
    expect(switchHtml).toContain("已完成");
    expect(switchHtml).not.toMatch(/subagent-switch-name">[^<]*(?:API|测试覆盖|安全审查)/);
    expect(switchHtml).toContain("tone-0");
    expect(switchHtml).toContain("tone-1");
    expect(switchHtml).toContain("tone-2");
    expect(switchHtml).toContain("is-selected");
    expect(switchHtml).toContain("aria-current=\"true\"");
  });

  it("keeps the selected child and otherwise prioritizes active work", () => {
    const completed = createAgent("done", "completed", "review");
    const queued = createAgent("queued", "idle", "docs");
    const waiting = createAgent("waiting", "waiting", "security");
    const running = createAgent("running", "running", "analysis");
    const items = buildSubagentPresentations({
      agents: [completed, queued, waiting, running],
      queuedAgentIds: new Set([queued.id]),
      resultsById: new Map([[completed.id, createResult(completed, "completed", "done")]]),
      waitingInputAgentIds: new Set([waiting.id]),
      runtimeActivities: {}
    });

    expect(resolveSelectedSubagentId(items, waiting.id)).toBe(waiting.id);
    expect(resolveSelectedSubagentId(items, "missing")).toBe(running.id);
    expect(resolveSelectedSubagentId([], running.id)).toBeNull();
  });

  it("updates transcript and detail output from the same changed state", () => {
    const agent = createAgent("worker", "running", "analysis");
    const initial = buildSubagentPresentations({
      agents: [agent],
      queuedAgentIds: new Set(),
      resultsById: new Map(),
      waitingInputAgentIds: new Set(),
      runtimeActivities: {}
    })[0];
    const completedAgent = { ...agent, status: "completed" as const };
    const completed = buildSubagentPresentations({
      agents: [completedAgent],
      queuedAgentIds: new Set(),
      resultsById: new Map([[agent.id, createResult(completedAgent, "completed", "分析已经完成")]]),
      waitingInputAgentIds: new Set(),
      runtimeActivities: {}
    })[0];

    expect(initial.state).toBe("running");
    expect(completed.state).toBe("completed");
    expect(completed.summary).toBe("分析已经完成");
    expect(completed.detailOutput).toBe("分析已经完成");
  });

  it("moves the child-agent entry out of the top-right controls and into the workspace", () => {
    expect(workspaceControlsSource).not.toContain("subagentControl");
    expect(rendererAppSource).not.toContain("SubagentStatusDock");
    expect(rendererAppSource).not.toContain("SubagentNarrativeUpdates");
    expect(rightWorkspaceSource).toContain('id="subagents"');
    expect(rightWorkspaceSource).toContain("showSubagentTab ?");
    expect(rightWorkspaceSource).toContain("SubagentSwitchRow");
    expect(rightWorkspaceSource).toContain("onSelectSubagent");
    expect(rendererAppSource).toContain("SubagentSwitchRow");
    expect(rendererAppSource).toContain("onSelect={selectSubagentEvent}");
    expect(workspaceControlsSource).toContain("onOpenRightWorkspace");
    expect(workspaceControlsSource).toContain("显示右侧工作区（浏览器 / 子智能体）");
    expect(workspaceControlsSource).not.toContain("!rightWorkspaceOpen && projectWorkspace");
    expect(rendererAppSource).not.toContain("&& (rightWorkspaceTab === \"files\" || rightWorkspaceTab === \"changes\")");
    expect(renderToStaticMarkup(createElement(SubagentDetailWorkspace, { item: null }))).toContain("无正在执行的子智能体");
  });

  it("publishes child-agent results into the parent process conversation", () => {
    expect(backendSource).toContain("publishSubagentCompletionSummary");
    expect(backendSource).toContain('displayKind: "subagent-summary"');
    expect(backendSource).toContain("subagent.completion_summary_published");
    expect(readFileSync(new URL("../apps/desktop/src/renderer/lib/conversation-utils.ts", import.meta.url), "utf8"))
      .not.toContain('getMessageDisplayKind(message) === "subagent-summary"');
  });

  it("styles workspace states, reduced motion, and transparent background modes", () => {
    expect(rendererStylesCss).toContain(".subagent-workspace-status.completed");
    expect(rendererStylesCss).toContain(".subagent-workspace-status.failed");
    expect(rendererStylesCss).toContain(".subagent-workspace-status.waiting_input");
    expect(rendererStylesCss).toContain(".subagent-switch-row");
    expect(rendererStylesCss).toContain("flex-wrap: nowrap");
    expect(rendererStylesCss).toContain("flex: 0 0 auto");
    expect(rendererStylesCss).toContain("width: max-content");
    expect(rendererStylesCss).toContain(".subagent-switch-chip.tone-0");
    expect(rendererStylesCss).toContain(".subagent-switch-chip.is-selected");
    expect(rendererAppSource).toContain("subagentItems={workspaceSubagentPresentations}");
    expect(rendererStylesCss).toContain(".app-shell:is(.has-app-background, .has-realtime-character) :is(");
    expect(rendererStylesCss).toContain(".subagent-workspace-phases");
    expect(rendererStylesCss).toContain(".subagent-workspace-scroll");
    expect(rendererStylesCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps completed child tasks in the current-request snapshot while the parent is still running", () => {
    const snapshotImplementation = backendSource.slice(
      backendSource.indexOf("public getThreadSnapshot"),
      backendSource.indexOf("public getGpaState")
    );

    expect(snapshotImplementation).toContain("const subagents = this.getVisibleSubagents(thread);");
    expect(snapshotImplementation).not.toContain("getVisibleSubagents(thread).filter((child) => this.isSubagentActive(child))");
    expect(backendSource).toContain("this.isSubagentActive(item) && isOverlappingSubagentAssignment");
    expect(backendSource).toContain("schedulePendingSubagentDispatch(parent.rootThreadId)");
    expect(backendSource).toContain("await this.emitAgentTreeUpdated(parent.rootThreadId, thread)");
    expect(backendSource).toContain("payload: childThread ? { thread: root, childThread } : { thread: root }");
    expect(backendSource).toContain("thread.status === \"waiting\"");
    expect(backendSource).toContain("this.#db.isSubagentPendingDispatch(thread.id)");
    expect(rendererAppSource).toContain("upsertSubagentIntoSnapshot");
    expect(rendererAppSource).toContain("shouldInvalidateSnapshotForThreadUpdate");
    expect(rendererAppSource).toContain("mergeSnapshotSubagents");
  });

  it("loads the complete conversation snapshot instead of a truncated message window", () => {
    const snapshotImplementation = backendSource.slice(
      backendSource.indexOf("public getThreadSnapshot"),
      backendSource.indexOf("public getGpaState")
    );

    expect(snapshotImplementation).toContain("this.#db.listRecentMessages(threadId, Math.max(1, messageCount))");
    expect(snapshotImplementation).toContain("this.#db.listToolCallSummaries(threadId)");
    expect(snapshotImplementation).not.toContain("THREAD_SNAPSHOT_MESSAGE_LIMIT");
    expect(snapshotImplementation).not.toContain("capSnapshotRecordCount");
    expect(rendererAppSource).not.toContain("THREAD_SNAPSHOT_MESSAGE_LIMIT");
    expect(rendererAppSource).not.toContain("capRecentRecords");
  });
});
