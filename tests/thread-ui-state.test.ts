import { describe, expect, it } from "vitest";
import {
  canDeleteThread,
  getComposerPrimaryActionState,
  getDeleteThreadBlockedMessage,
  getHistoryItemAffordance,
  getThreadContentView,
  invalidateThreadSnapshotForFullRefresh,
  isThreadExecutionInProgress,
  normalizeGpaStateForThread,
  replaceThreadSnapshotGpa,
  shouldCommitThreadSnapshotImmediately,
  shouldIncludeRuntimeThreadInHistory,
  shouldPreservePreparingRuntime,
  shouldRefreshSelectedSnapshotForRuntimeEvent,
  shouldShowTaskProcessing
} from "../apps/desktop/src/renderer/core/thread-ui-state";
import {
  buildTimelineEntries,
  buildTimelineEntriesIncremental,
  buildConversationTurnSections,
  completeRuntimeToolCallSummary,
  getConversationTurnIdToCollapseAfterExecution,
  getConversationTurnIdsToCollapseForNewSubmission,
  getDefaultCollapsedConversationTurnIds,
  createOptimisticThreadSnapshot,
  getThreadDeleteFailureMessage,
  getPostToolDecisionLabel,
  getToolProcessingLabel,
  getActiveSubagents,
  getSubagentWaitLabel,
  isSubagentWaitTool,
  getToolActivityPresentation,
  getToolActivitySummary,
  getToolActivityTarget,
  shouldShowRuntimeActivityPanel,
  filterTranscriptMessages,
  isFileWriteTool,
  isInternalAgentProtocolMessage,
  isPatchAssistantMessage,
  getAssistantDraftDisplayContent,
  mergeSnapshotRecords,
  reconcilePendingUserMessages,
  reconcilePendingUserMessagesDetailed,
  reconcileAssistantDraftCompletion,
  reconcileAssistantDraftReasoningUpdate,
  reconcileAssistantDraftStreamUpdate,
  reconcileAssistantDraftUpdate,
  resolveLatestThreadRecord,
  replaceConversationMessagesFromEdit,
  rewindThreadSnapshotForMessageEdit,
  selectActiveAssistantDraft,
  shouldKeepAssistantDraft,
  shouldKeepTimelineEntryWhenTurnCollapsed,
  upsertRuntimeUserInputPrompt,
  upsertRuntimeToolCallSummary
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import { getConciseToolActivityLabel } from "../apps/desktop/src/renderer/timeline/transcript";
import { didTranscriptScrollUpWithoutContentShrink, getSidebarUpdateReminder, isPointerInTranscriptScrollbar, removeQueuedMessageById, shouldFollowLatestAfterTranscriptScroll } from "../apps/desktop/src/renderer/App";
import { hasRecognizedGitRepository, selectWorkspaceTab } from "../apps/desktop/src/renderer/workspace/right-workspace";
import type { MessageRecord, RuntimeThreadSnapshot, ThreadRecord, ToolCallRecord, ToolCallSummary, UserInputPrompt } from "../packages/shared-types/src";

it("removes a guided queue item without disturbing the remaining queue", () => {
  const messages = [
    { id: "queue-1", displayContent: "first" },
    { id: "queue-2", displayContent: "guided" },
    { id: "queue-3", displayContent: "last" }
  ] as RuntimeThreadSnapshot["queuedMessages"];

  expect(removeQueuedMessageById(messages, "queue-2").map((message) => message.id))
    .toEqual(["queue-1", "queue-3"]);
  expect(removeQueuedMessageById(messages, "missing")).toBe(messages);
});

it("does not re-enable transcript auto-scroll during a manual drag near the bottom", () => {
  expect(shouldFollowLatestAfterTranscriptScroll(24, false)).toBe(true);
  expect(shouldFollowLatestAfterTranscriptScroll(24, true)).toBe(false);
  expect(shouldFollowLatestAfterTranscriptScroll(0, true)).toBe(true);
  expect(didTranscriptScrollUpWithoutContentShrink(
    { scrollTop: 800, scrollHeight: 1_400 },
    { scrollTop: 760, scrollHeight: 1_400 }
  )).toBe(true);
  expect(didTranscriptScrollUpWithoutContentShrink(
    { scrollTop: 800, scrollHeight: 1_400 },
    { scrollTop: 760, scrollHeight: 1_300 }
  )).toBe(false);
  expect(isPointerInTranscriptScrollbar(995, 1_000, 1_000, 988)).toBe(true);
  expect(isPointerInTranscriptScrollbar(970, 1_000, 1_000, 988)).toBe(false);
});

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "tool-1",
    threadId: "thread-1",
    turnRunId: "turn-1",
    toolName: "fs.read_file",
    argumentsJson: JSON.stringify({ path: "src/App.tsx" }),
    resultJson: "{}",
    status: "completed",
    riskLevel: "low",
    approvalMode: "auto",
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:01.000Z",
    ...overrides
  };
}

function makeThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-1",
    title: "Task",
    mode: "chat",
    workspaceKind: "projectless",
    cwd: null,
    projectId: null,
    workspaceId: null,
    modelId: "model-1",
    providerId: "provider-1",
    status: "idle",
    selectedSkillIds: [],
    selectedPluginIds: [],
    knowledgeBaseIds: [],
    createdAt: "2026-08-03T07:58:00.000Z",
    updatedAt: "2026-08-03T07:58:00.000Z",
    isPinned: false,
    pinnedAt: null,
    gpaStateJson: null,
    parentThreadId: null,
    rootThreadId: "thread-1",
    agentPath: "/root",
    agentRole: null,
    lastTaskMessage: null,
    multiAgentMode: "disabled",
    ...overrides
  };
}

function makeUserInputPrompt(overrides: Partial<UserInputPrompt> = {}): UserInputPrompt {
  return {
    id: "prompt-1",
    threadId: "thread-1",
    turnRunId: "turn-1",
    title: "Need more information",
    kind: "generic",
    allowSkip: false,
    expiresAt: null,
    defaultAnswers: null,
    resolutionSource: null,
    questions: [],
    status: "pending",
    answers: null,
    createdAt: "2026-07-15T01:00:00.000Z",
    answeredAt: null,
    ...overrides
  };
}

describe("thread UI state helpers", () => {
  it("keeps the loading view visible until the selected thread snapshot is ready", () => {
    expect(getThreadContentView("thread-2", null, 0)).toBe("switching");
    expect(getThreadContentView("thread-2", "thread-1", 3)).toBe("switching");
  });

  it("shows welcome only for home or a genuinely empty selected thread", () => {
    expect(getThreadContentView(null, null, 0)).toBe("welcome");
    expect(getThreadContentView("thread-2", "thread-2", 0)).toBe("welcome");
    expect(getThreadContentView("thread-2", "thread-2", 3)).toBe("transcript");
  });

  it("commits the first selected snapshot without a transition", () => {
    expect(shouldCommitThreadSnapshotImmediately("thread-2", null, "thread-2")).toBe(true);
    expect(shouldCommitThreadSnapshotImmediately("thread-2", "thread-1", "thread-2")).toBe(true);
    expect(shouldCommitThreadSnapshotImmediately("thread-2", "thread-2", "thread-2")).toBe(false);
    expect(shouldCommitThreadSnapshotImmediately("thread-3", "thread-1", "thread-2")).toBe(false);
  });

  it("refreshes a parent task snapshot for runtime events from its subagents", () => {
    expect(shouldRefreshSelectedSnapshotForRuntimeEvent(
      "parent-thread",
      "child-thread",
      "parent-thread"
    )).toBe(true);
    expect(shouldRefreshSelectedSnapshotForRuntimeEvent(
      "parent-thread",
      "unrelated-thread",
      "other-parent"
    )).toBe(false);
    expect(shouldRefreshSelectedSnapshotForRuntimeEvent(
      "parent-thread",
      "parent-thread"
    )).toBe(true);
    expect(shouldRefreshSelectedSnapshotForRuntimeEvent("parent-thread")).toBe(true);
  });

  it("keeps child-agent runtime updates out of the history list", () => {
    expect(shouldIncludeRuntimeThreadInHistory(makeThread({ parentThreadId: null }))).toBe(true);
    expect(shouldIncludeRuntimeThreadInHistory(makeThread({ parentThreadId: "parent-thread" }))).toBe(false);
  });

  it("shows the Git workspace only after the current project is identified as a Git repository", () => {
    expect(hasRecognizedGitRepository(null, "E:\\project")).toBe(false);
    expect(hasRecognizedGitRepository({ available: false, ahead: 0, behind: 0, branches: [], canCreatePullRequest: false, files: [] }, "E:\\project")).toBe(false);
    expect(hasRecognizedGitRepository({ available: true, ahead: 0, behind: 0, branches: [], canCreatePullRequest: false, files: [] }, "E:\\project")).toBe(false);
    expect(hasRecognizedGitRepository({ available: true, root: "E:\\project", ahead: 0, behind: 0, branches: [], canCreatePullRequest: false, files: [] }, "E:\\project")).toBe(true);
    expect(hasRecognizedGitRepository({ available: true, root: "E:\\project", ahead: 0, behind: 0, branches: [], canCreatePullRequest: false, files: [] }, "E:\\project\\src")).toBe(false);
  });

  it("selects a horizontal workspace tab without toggling it closed", () => {
    const selected: string[] = [];
    const expanded: Array<string | null> = [];
    selectWorkspaceTab("browser", (tab) => selected.push(tab), (tab) => expanded.push(tab));
    selectWorkspaceTab("browser", (tab) => selected.push(tab), (tab) => expanded.push(tab));
    expect(selected).toEqual(["browser", "browser"]);
    expect(expanded).toEqual(["browser", "browser"]);
  });

  it("isolates GPA stages from non-project chats", () => {
    const state = normalizeGpaStateForThread("chat", {
      stage: "plan",
      fullAccess: true,
      knowledgeEnabled: true,
      awaitingConfirmation: "plan",
      planTasks: [{ id: "task-1", title: "Task", done: false }],
      updatedAt: "2026-08-06T00:00:00.000Z"
    });

    expect(state).toMatchObject({
      stage: "off",
      fullAccess: true,
      knowledgeEnabled: true,
      awaitingConfirmation: null,
      planTasks: []
    });
  });

  it("provides a clean thread-scoped GPA state when no snapshot exists", () => {
    expect(normalizeGpaStateForThread("project", null)).toMatchObject({
      stage: "off",
      fullAccess: false,
      knowledgeEnabled: false,
      awaitingConfirmation: null,
      planTasks: []
    });
  });

  it("keeps a completed task's full-access preference in the matching snapshot", () => {
    const snapshot = {
      ...createOptimisticThreadSnapshot(makeThread({ mode: "project" })),
      gpa: {
        stage: "act",
        fullAccess: false,
        knowledgeEnabled: false,
        awaitingConfirmation: null,
        planTasks: [],
        updatedAt: "2026-08-06T00:00:00.000Z"
      }
    };
    const completedGpa = {
      ...snapshot.gpa!,
      stage: "off" as const,
      fullAccess: true,
      updatedAt: "2026-08-06T00:01:00.000Z"
    };

    expect(replaceThreadSnapshotGpa(snapshot, snapshot.thread.id, completedGpa)?.gpa)
      .toEqual(completedGpa);
    expect(replaceThreadSnapshotGpa(snapshot, "another-thread", completedGpa)).toBe(snapshot);
  });

  it("forces an authoritative snapshot after interrupt without clearing other threads", () => {
    const cursorByThread = { "thread-1": "cursor-1", "thread-2": "cursor-2" };
    const requestIdsByThread = { "thread-1": 4, "thread-2": 2 };
    const cacheByThread = new Map([
      ["thread-1", "snapshot-1"],
      ["thread-2", "snapshot-2"]
    ]);
    const runtimeMessagesByThread = {
      "thread-1": ["persisted-summary"],
      "thread-2": ["other-message"]
    };

    invalidateThreadSnapshotForFullRefresh("thread-1", {
      cursorByThread,
      requestIdsByThread,
      cacheByThread,
      runtimeMessagesByThread
    });

    expect(requestIdsByThread).toEqual({ "thread-1": 5, "thread-2": 2 });
    expect(cursorByThread).toEqual({ "thread-2": "cursor-2" });
    expect([...cacheByThread.entries()]).toEqual([["thread-2", "snapshot-2"]]);
    expect(runtimeMessagesByThread).toEqual({ "thread-2": ["other-message"] });
  });

  it("can preserve runtime messages while an interrupt refresh catches up", () => {
    const runtimeMessagesByThread = { "thread-1": ["new-message"] };

    invalidateThreadSnapshotForFullRefresh("thread-1", {
      cursorByThread: { "thread-1": "cursor-1" },
      requestIdsByThread: { "thread-1": 1 },
      cacheByThread: new Map([["thread-1", "snapshot-1"]]),
      runtimeMessagesByThread
    }, { preserveRuntimeMessages: true });

    expect(runtimeMessagesByThread).toEqual({ "thread-1": ["new-message"] });
  });

  it("replaces the edited message and removes its stale conversation tail locally", () => {
    const messages: MessageRecord[] = [
      { id: "user-1", threadId: "thread-1", turnRunId: "turn-1", role: "user", content: "old", metadataJson: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "assistant-1", threadId: "thread-1", turnRunId: "turn-1", role: "assistant", content: "old answer", metadataJson: null, createdAt: "2026-07-28T00:00:01.000Z" }
    ];
    const replacement: MessageRecord = {
      id: "optimistic-replacement",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: "edited",
      metadataJson: null,
      createdAt: "2026-07-28T00:00:02.000Z"
    };

    expect(replaceConversationMessagesFromEdit(messages, "user-1", replacement)).toEqual([replacement]);
  });

  it("rewinds timeline-dependent snapshot records with an edited message", () => {
    const thread = makeThread({ id: "thread-1" });
    const messages: MessageRecord[] = [
      { id: "user-keep", threadId: thread.id, turnRunId: "turn-keep", role: "user", content: "keep", metadataJson: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "user-edit", threadId: thread.id, turnRunId: "turn-edit", role: "user", content: "old", metadataJson: null, createdAt: "2026-07-28T00:00:01.000Z" },
      { id: "assistant-old", threadId: thread.id, turnRunId: "turn-edit", role: "assistant", content: "old answer", metadataJson: null, createdAt: "2026-07-28T00:00:02.000Z" }
    ];
    const replacement: MessageRecord = {
      id: "optimistic-replacement",
      threadId: thread.id,
      turnRunId: null,
      role: "user",
      content: "edited",
      metadataJson: null,
      createdAt: "2026-07-28T00:00:03.000Z"
    };
    const snapshot = {
      ...createOptimisticThreadSnapshot(thread),
      messages,
      messageCount: messages.length,
      toolCalls: [
        { id: "tool-keep", threadId: thread.id, turnRunId: "turn-keep" },
        { id: "tool-old", threadId: thread.id, turnRunId: "turn-edit" }
      ],
      artifacts: [
        { id: "artifact-keep", threadId: thread.id, turnRunId: "turn-keep", messageId: null },
        { id: "artifact-old", threadId: thread.id, turnRunId: null, messageId: "assistant-old" }
      ],
      approvals: [
        { id: "approval-keep", turnRunId: "turn-keep" },
        { id: "approval-old", turnRunId: "turn-edit" }
      ],
      prompts: [
        { id: "prompt-keep", turnRunId: "turn-keep" },
        { id: "prompt-old", turnRunId: "turn-edit" }
      ],
      contextCompaction: { turnRunId: "turn-edit" },
      contextMeasurement: { turnRunId: "turn-edit" },
      queuedMessages: [{ id: "queued-old" }]
    } as unknown as RuntimeThreadSnapshot;

    const rewound = rewindThreadSnapshotForMessageEdit(snapshot, "user-edit", replacement);

    expect(rewound.messages).toEqual([messages[0], replacement]);
    expect(rewound.messageCount).toBe(2);
    expect(rewound.toolCalls.map((toolCall) => toolCall.id)).toEqual(["tool-keep"]);
    expect(rewound.artifacts.map((artifact) => artifact.id)).toEqual(["artifact-keep"]);
    expect(rewound.approvals.map((approval) => approval.id)).toEqual(["approval-keep"]);
    expect(rewound.prompts.map((prompt) => prompt.id)).toEqual(["prompt-keep"]);
    expect(rewound.queuedMessages).toEqual([]);
    expect(rewound.contextCompaction).toBeNull();
    expect(rewound.contextMeasurement).toBeNull();
  });

  it("hides incomplete agent decision JSON from the chat transcript", () => {
    expect(isInternalAgentProtocolMessage('{"assistant_message": "正在检查服务')).toBe(true);
    expect(isInternalAgentProtocolMessage("普通的助手回复")).toBe(false);
  });

  it("treats running and waiting threads as executing", () => {
    expect(isThreadExecutionInProgress("running")).toBe(true);
    expect(isThreadExecutionInProgress("waiting")).toBe(true);
    expect(isThreadExecutionInProgress("completed")).toBe(false);
    expect(isThreadExecutionInProgress(null)).toBe(false);
  });

  it("does not keep processing UI from stale progress after stop", () => {
    expect(shouldShowTaskProcessing("running", false)).toBe(true);
    expect(shouldShowTaskProcessing("waiting", false)).toBe(true);
    expect(shouldShowTaskProcessing("idle", true)).toBe(true);
    expect(shouldShowTaskProcessing("idle", false)).toBe(false);
    expect(shouldShowTaskProcessing("completed", true)).toBe(false);
    expect(shouldShowTaskProcessing("completed", false)).toBe(false);
    expect(shouldShowTaskProcessing("failed", true)).toBe(false);
    expect(shouldShowTaskProcessing("failed", false)).toBe(false);
  });

  it("keeps a just-submitted message out of the queue during the runtime handoff", () => {
    expect(shouldPreservePreparingRuntime("idle", 1, false)).toBe(true);
    expect(shouldPreservePreparingRuntime("running", 1, false)).toBe(false);
    expect(shouldPreservePreparingRuntime("idle", 0, false)).toBe(false);
    expect(shouldPreservePreparingRuntime("completed", 0, false)).toBe(false);
    expect(shouldPreservePreparingRuntime("idle", 1, true)).toBe(false);
  });

  it("shows a spinner affordance for executing history items", () => {
    expect(getHistoryItemAffordance("running")).toEqual({
      kind: "running-indicator",
      title: "任务执行中"
    });
    expect(getHistoryItemAffordance("waiting")).toEqual({
      kind: "running-indicator",
      title: "任务等待中"
    });
    expect(getHistoryItemAffordance("completed")).toEqual({
      kind: "delete",
      title: "删除任务"
    });
  });

  it("only shows interrupt for an empty composer while a thread is executing", () => {
    expect(getComposerPrimaryActionState("running", "")).toEqual({
      kind: "interrupt",
      title: "停止执行",
      ariaLabel: "停止执行",
      disabled: false
    });

    expect(getComposerPrimaryActionState("waiting", "继续")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: false
    });
  });

  it("keeps the send action disabled until trimmed input is present", () => {
    expect(getComposerPrimaryActionState("completed", "")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: true
    });

    expect(getComposerPrimaryActionState("completed", "   ")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: true
    });

    expect(getComposerPrimaryActionState("completed", "你好")).toEqual({
      kind: "send",
      title: "发送",
      ariaLabel: "发送",
      disabled: false
    });
  });

  it("blocks delete while the thread is executing or another delete is already pending", () => {
    expect(canDeleteThread("running", null)).toBe(false);
    expect(getDeleteThreadBlockedMessage("running", null)).toBe("任务正在执行，暂时不能删除。");

    expect(canDeleteThread("completed", "thread-1")).toBe(false);
    expect(getDeleteThreadBlockedMessage("completed", "thread-1")).toBeNull();

    expect(canDeleteThread("completed", null)).toBe(true);
    expect(getDeleteThreadBlockedMessage("completed", null)).toBeNull();
  });
});

describe("tool processing labels", () => {
  it("uses specific status text for common tool operations", () => {
    expect(getToolProcessingLabel("fs.read_file")).toBe("正在读取文件");
    expect(getToolProcessingLabel("fs.read_directory")).toBe("正在读取目录");
    expect(getToolProcessingLabel("apply_patch")).toBe("正在写入文件");
    expect(getToolProcessingLabel("search_replace")).toBe("正在写入文件");
    expect(getToolProcessingLabel("shell.exec")).toBe("正在执行命令");
    expect(getToolProcessingLabel("browser.open_tab")).toBe("正在操作浏览器");
    expect(getToolProcessingLabel("code.search")).toBe("正在代码搜索");
    expect(getToolProcessingLabel("knowledge.search")).toBe("正在知识库搜索");
    expect(getToolProcessingLabel("knowledge.read")).toBe("正在读取知识库");
    expect(getToolProcessingLabel("web_search.search_query")).toBe("正在浏览器搜索");
    expect(getToolProcessingLabel("web_search.open_page")).toBe("正在打开网页");
    expect(getToolProcessingLabel("web_search.find_in_page")).toBe("正在页内查找");
    expect(getToolProcessingLabel("image.generate")).toBe("正在生成图片");
    expect(getToolProcessingLabel("video.generate")).toBe("正在生成视频");
    expect(getToolProcessingLabel("database.query")).toBe("正在查询数据库");
    expect(getToolProcessingLabel("memories.search")).toBe("正在搜索记忆");
    expect(getToolProcessingLabel("skills.load")).toBe("正在加载技能");
    expect(getToolProcessingLabel("mcp.call")).toBe("正在调用 MCP");
    expect(getToolProcessingLabel("wait_agent")).toBe("正在等待子智能体");
    expect(getToolProcessingLabel("fs.mkdir")).toBe("正在创建目录");
    expect(getToolProcessingLabel("fs.rename")).toBe("正在重命名文件");
    expect(getToolProcessingLabel("fs.delete")).toBe("正在删除文件");
    expect(getToolProcessingLabel("fs.copy")).toBe("正在复制文件");
    expect(getToolProcessingLabel("code.diagnostics")).toBe("正在读取诊断");
    expect(getToolProcessingLabel("knowledge.add")).toBe("正在写入知识库");
    expect(getToolProcessingLabel("todo.read")).toBe("正在查看任务清单");
    expect(getToolProcessingLabel("todo.write")).toBe("正在更新任务清单");
    expect(getToolProcessingLabel("git.stage_file")).toBe("正在暂存变更");
    expect(getToolProcessingLabel("git.unstage_file")).toBe("正在取消暂存");
    expect(getToolProcessingLabel("git.revert_file")).toBe("正在撤销文件修改");
    expect(getToolProcessingLabel("git.apply_hunk")).toBe("正在应用修改块");
    expect(getToolProcessingLabel("git.push")).toBe("正在推送分支");
    expect(getToolProcessingLabel("git.pull")).toBe("正在拉取远端");
    expect(getToolProcessingLabel("git.create_pr")).toBe("正在创建 Pull Request");
  });

  it("includes the current command or target in the running status", () => {
    expect(getToolProcessingLabel("shell.exec", JSON.stringify({ command: "pnpm build" }))).toBe("正在运行 pnpm build");
    expect(getToolProcessingLabel("fs.read_file", JSON.stringify({ path: "src/App.tsx" }))).toBe("正在读取 src/App.tsx");
    expect(getToolProcessingLabel("search_replace", JSON.stringify({ file_path: "src/App.tsx" }))).toBe("正在写入 src/App.tsx");
    expect(getToolProcessingLabel("fs.mkdir", JSON.stringify({ path: "docs/api" }))).toBe("正在创建目录 docs/api");
    expect(
      getToolProcessingLabel("apply_patch", JSON.stringify({
        patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch"
      }))
    ).toBe("正在修改 src/App.tsx");
  });

  it("describes processing after a tool result with grammatical status text", () => {
    expect(getPostToolDecisionLabel([])).toBe("正在处理工具结果");
    expect(getPostToolDecisionLabel([
      { toolName: "fs.read_file", argumentsJson: JSON.stringify({ path: "src/App.tsx" }) }
    ])).toBe("正在读取 src/App.tsx");
    expect(getPostToolDecisionLabel([
      { toolName: "fs.read_file", argumentsJson: JSON.stringify({ path: "src/App.tsx" }) },
      { toolName: "shell.exec", argumentsJson: JSON.stringify({ command: "pnpm test" }) }
    ])).toBe("已完成 2 项操作，正在运行 pnpm test");
    expect(getPostToolDecisionLabel([
      { toolName: "wait_agent", argumentsJson: "{}" }
    ], undefined, false)).toBe("正在汇总子任务结果");
    expect(getPostToolDecisionLabel([
      { toolName: "wait_agent", argumentsJson: "{}" }
    ], undefined, true)).toBe("正在等待子智能体");
  });
});

describe("tool activity targets", () => {
  it("hides a fallback tool name that would duplicate the activity label", () => {
    expect(getToolActivityTarget("skills.load", {}, "skills.load")).toBe("");
    expect(getToolActivityTarget("shell.exec", { command: "pnpm test" }, "pnpm test")).toBe("pnpm test");
    expect(getToolActivityTarget("fs.write_file", { path: "src/App.tsx" }, "src/App.tsx")).toBe("src/App.tsx");
  });

  it("shows the loaded skill id as the target for skill tools", () => {
    expect(getToolActivityTarget("skills.load", { skill_id: "pdf" }, "pdf")).toBe("pdf");
    expect(getToolActivityTarget("skills.install", { source: "https://example.com/skill" }, "skills.install")).toBe("https://example.com/skill");
  });

  it("uses the skill name when a skill catalog is available", () => {
    const skillNames = new Map([["skill-id", "PDF 文档"]]);
    const toolCall = makeToolCall({
      id: "named-skill",
      toolName: "skills.load",
      argumentsJson: JSON.stringify({ skill_id: "skill-id" })
    });

    expect(getToolActivityTarget("skills.load", { skill_id: "skill-id" }, "skill-id", skillNames)).toBe("PDF 文档");
    expect(getConciseToolActivityLabel([toolCall], undefined, skillNames)).toBe("加载技能 PDF 文档");
    expect(getToolProcessingLabel("skills.load", toolCall.argumentsJson, skillNames)).toBe("正在加载技能 PDF 文档");
  });

  it("includes loaded skill ids in the concise activity label", () => {
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "s1", toolName: "skills.load", argumentsJson: JSON.stringify({ skill_id: "pdf" }) }),
      makeToolCall({ id: "s2", toolName: "skills.load", argumentsJson: JSON.stringify({ skill_id: "pdf" }) }),
      makeToolCall({ id: "s3", toolName: "skills.load", argumentsJson: JSON.stringify({ skill_id: "docx" }) })
    ])).toBe("加载技能 pdf、docx");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "s4", toolName: "skills.load", argumentsJson: "{}" })
    ])).toBe("加载技能");
  });
});

describe("file write transcript filtering", () => {
  it("hides raw Codex patches and their write-tool cards from the chat timeline", () => {
    expect(isPatchAssistantMessage("*** Begin Patch\n*** Add File: src/app.ts\n+export {}\n*** End Patch")).toBe(true);
    expect(isPatchAssistantMessage("Implemented the requested feature.")).toBe(false);
    expect(isFileWriteTool("apply_patch")).toBe(true);
    expect(isFileWriteTool("fs.write_file")).toBe(true);
    expect(isFileWriteTool("search_replace")).toBe(true);
    expect(isFileWriteTool("fs.mkdir")).toBe(true);
    expect(isFileWriteTool("fs.rename")).toBe(true);
    expect(isFileWriteTool("fs.delete")).toBe(true);
    expect(isFileWriteTool("fs.copy")).toBe(true);
    expect(isFileWriteTool("fs.read_file")).toBe(false);
  });

  it("hides internal agent protocol echoes from the transcript", () => {
    expect(isInternalAgentProtocolMessage("先只提交 T1，证据严格使用 tool_call_id。")).toBe(true);
    expect(isInternalAgentProtocolMessage("已完成文件读取并继续实现。")).toBe(false);
  });
});

describe("runtime activity visibility", () => {
  it("only keeps the execution heartbeat visible while the task is still active", () => {
    expect(shouldShowRuntimeActivityPanel(true)).toBe(true);
    expect(shouldShowRuntimeActivityPanel(false)).toBe(false);
  });
});

describe("sidebar update reminder", () => {
  it("only shows a reminder when an update needs user attention", () => {
    expect(getSidebarUpdateReminder("available")).toBe("有更新");
    expect(getSidebarUpdateReminder("downloading")).toBe("下载中");
    expect(getSidebarUpdateReminder("downloaded")).toBe("可安装");
    expect(getSidebarUpdateReminder("up-to-date")).toBeNull();
    expect(getSidebarUpdateReminder("checking")).toBeNull();
  });
});

describe("tool activity summaries", () => {
  it("keeps a concise live action available for the inline running indicator", () => {
    const presentation = getToolActivityPresentation([
      makeToolCall({
        toolName: "shell.exec",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ command: "pnpm build" })
      })
    ]);

    expect(presentation.status).toBe("in_progress");
    expect(presentation.runningCall?.toolName).toBe("shell.exec");
    expect(presentation.summary).toEqual({
      title: "\u6b63\u5728\u8fd0\u884c pnpm build",
      detail: ""
    });
  });

  it("removes the live state after every tool has completed", () => {
    const presentation = getToolActivityPresentation([
      makeToolCall({ toolName: "shell.exec", argumentsJson: JSON.stringify({ command: "pnpm build" }) })
    ]);

    expect(presentation.status).toBe("completed");
    expect(presentation.runningCall).toBeUndefined();
  });

  it("keeps preflight blocks distinct from executed failures", () => {
    const presentation = getToolActivityPresentation([
      makeToolCall({
        status: "blocked",
        resultJson: JSON.stringify({ blocked: true, content: "Known ineffective strategy" })
      })
    ]);

    expect(presentation.status).toBe("blocked");
    expect(presentation.runningCall).toBeUndefined();
  });

  it("summarizes completed operations in user-facing categories", () => {
    const summary = getToolActivitySummary([
      makeToolCall({ id: "search", toolName: "code.search", argumentsJson: JSON.stringify({ query: "timeline" }) }),
      makeToolCall({ id: "read", toolName: "fs.read_file" }),
      makeToolCall({ id: "write", toolName: "apply_patch", argumentsJson: JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/App.tsx\n*** End Patch" }) }),
      makeToolCall({ id: "test", toolName: "shell.exec", argumentsJson: JSON.stringify({ command: "pnpm test" }) })
    ]);

    expect(summary).toEqual({
      title: "\u5df2\u5b8c\u6210\u67e5\u8be2\u4e0e\u8bfb\u53d6",
      detail: "\u67e5\u8be2 1 \u6b21 \u00b7 \u8bfb\u53d6 1 \u9879 \u00b7 \u5199\u5165 1 \u6b21\uff08\u6d89\u53ca 1 \u4e2a\u6587\u4ef6\uff09 \u00b7 \u9a8c\u8bc1 1 \u6b21"
    });
  });

  it("surfaces failed operations in the collapsed summary", () => {
    const summary = getToolActivitySummary([
      makeToolCall({ id: "failed", toolName: "shell.exec", status: "failed", argumentsJson: JSON.stringify({ command: "pnpm test" }) }),
      makeToolCall({ id: "read", toolName: "fs.read_file" })
    ]);

    expect(summary.title).toBe("\u90e8\u5206\u8bfb\u53d6\u4e0e\u9a8c\u8bc1\u672a\u5b8c\u6210");
    expect(summary.detail).toBe("\u5df2\u5c1d\u8bd5 2 \u6b21\u8bfb\u53d6\u4e0e\u9a8c\u8bc1 \u00b7 1 \u6b21\u5931\u8d25");
  });

  it("describes MCP calls as queries instead of exposing the tool name", () => {
    const summary = getToolActivitySummary([
      makeToolCall({ id: "mcp-1", toolName: "mcp.call" }),
      makeToolCall({ id: "mcp-2", toolName: "mcp.call", status: "failed" })
    ]);

    expect(summary).toEqual({
      title: "\u90e8\u5206\u67e5\u8be2\u672a\u5b8c\u6210",
      detail: "\u5df2\u5c1d\u8bd5 2 \u6b21\u67e5\u8be2 \u00b7 1 \u6b21\u5931\u8d25"
    });
  });

  it("labels search tools by their actual domain", () => {
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "code", toolName: "code.search", argumentsJson: JSON.stringify({ query: "timeline" }) })
    ])).toBe("代码搜索");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "knowledge", toolName: "knowledge.search", argumentsJson: JSON.stringify({ query: "手册" }) })
    ])).toBe("知识库搜索");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "knowledge-read", toolName: "knowledge.read", argumentsJson: JSON.stringify({ conceptId: "c1" }) })
    ])).toBe("读取知识库");
    expect(getConciseToolActivityLabel([
      makeToolCall({
        id: "web-search",
        toolName: "web_search.search_query",
        argumentsJson: JSON.stringify({ query: "Hawaii Pacific University" })
      })
    ])).toBe("浏览器搜索");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "open", toolName: "web_search.open_page", argumentsJson: JSON.stringify({ url: "https://example.com" }) })
    ])).toBe("打开网页");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "image", toolName: "image.generate" })
    ])).toBe("生成图片");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "db", toolName: "database.query" })
    ])).toBe("查询数据库");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "mkdir", toolName: "fs.mkdir", argumentsJson: JSON.stringify({ path: "docs" }) })
    ])).toBe("编辑了文件");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "diag", toolName: "code.diagnostics" })
    ])).toBe("验证项目");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "kb-add", toolName: "knowledge.add", argumentsJson: JSON.stringify({ title: "Note" }) })
    ])).toBe("写入知识库");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "todo", toolName: "todo.write", argumentsJson: JSON.stringify({ items: [] }) })
    ])).toBe("更新任务清单");
    expect(getConciseToolActivityLabel([
      makeToolCall({ id: "git-stage", toolName: "git.stage_file", argumentsJson: JSON.stringify({ path: "a.ts" }) })
    ])).toBe("Git 操作");

    expect(getConciseToolActivityLabel(
      [makeToolCall({
        id: "code",
        toolName: "code.search",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ query: "timeline" })
      })],
      makeToolCall({
        id: "code",
        toolName: "code.search",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ query: "timeline" })
      })
    )).toBe("正在代码搜索");
    expect(getConciseToolActivityLabel(
      [makeToolCall({
        id: "knowledge",
        toolName: "knowledge.search",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ query: "手册" })
      })],
      makeToolCall({
        id: "knowledge",
        toolName: "knowledge.search",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ query: "手册" })
      })
    )).toBe("正在知识库搜索");
    expect(getConciseToolActivityLabel(
      [makeToolCall({
        id: "web-search",
        toolName: "web_search.search_query",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ query: "Hawaii Pacific University" })
      })],
      makeToolCall({
        id: "web-search",
        toolName: "web_search.search_query",
        status: "running",
        completedAt: null,
        argumentsJson: JSON.stringify({ query: "Hawaii Pacific University" })
      })
    )).toBe("正在浏览器搜索");
  });
});

describe("tool timeline grouping", () => {
  it("uses the append-only timeline fast path without changing canonical entries", () => {
    const makeMessage = (id: string, createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: `turn-${id}`,
      role: id.startsWith("user") ? "user" : "assistant",
      content: id,
      metadataJson: null,
      createdAt
    });
    const firstMessages = [makeMessage("user-1", "2026-07-15T00:00:00.000Z")];
    const prompts: never[] = [];
    const firstInput = { messages: firstMessages, toolCalls: [], artifacts: [], prompts };
    const first = buildTimelineEntriesIncremental(firstInput, null);
    const nextMessages = [...firstMessages, makeMessage("assistant-1", "2026-07-15T00:00:01.000Z")];
    const nextInput = { ...firstInput, messages: nextMessages };
    const next = buildTimelineEntriesIncremental(nextInput, first.cache);

    expect(next.usedIncremental).toBe(true);
    expect(next.entries).toEqual(buildTimelineEntries(nextMessages, [], [], undefined, undefined, prompts));

    const editedMessages = [{ ...firstMessages[0] }, nextMessages[1]];
    const edited = buildTimelineEntriesIncremental({ ...nextInput, messages: editedMessages }, next.cache);
    expect(edited.usedIncremental).toBe(false);

    const outOfOrder = buildTimelineEntriesIncremental({
      ...nextInput,
      messages: [...nextMessages, makeMessage("assistant-old", "2026-07-14T23:59:59.000Z")]
    }, next.cache);
    expect(outOfOrder.usedIncremental).toBe(false);

    const toolCall = {
      id: "tool-1",
      threadId: "thread-1",
      turnRunId: "turn-user-1",
      toolName: "shell.exec",
      argumentsJson: "{}",
      resultJson: "{}",
      status: "completed",
      riskLevel: "low",
      approvalMode: "auto",
      startedAt: "2026-07-15T00:00:00.500Z",
      completedAt: "2026-07-15T00:00:00.600Z"
    } as const;
    expect(buildTimelineEntriesIncremental({
      ...nextInput,
      toolCalls: [toolCall]
    }, next.cache).usedIncremental).toBe(false);
  });

  it("collapses every completed history turn while leaving only the live turn open", () => {
    const sections = [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }];

    expect(getDefaultCollapsedConversationTurnIds(sections, "turn-3", true)).toEqual(["turn-1", "turn-2"]);
    expect(getDefaultCollapsedConversationTurnIds(sections, "turn-3", false)).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("closes every existing process as soon as a new task is submitted", () => {
    expect(getConversationTurnIdsToCollapseForNewSubmission([
      { id: "turn-1" },
      { id: "turn-2" }
    ])).toEqual(["turn-1", "turn-2"]);
  });

  it("closes only the process that just transitioned from running to finished", () => {
    expect(getConversationTurnIdToCollapseAfterExecution("turn-2", true, false)).toBe("turn-2");
    expect(getConversationTurnIdToCollapseAfterExecution("turn-2", false, false)).toBeNull();
    expect(getConversationTurnIdToCollapseAfterExecution("turn-2", true, true)).toBeNull();
  });

  it("keeps the file summary visible when a completed turn is collapsed", () => {
    const makeMessage = (id: string, role: MessageRecord["role"], createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: "turn-1",
      role,
      content: id,
      metadataJson: null,
      createdAt
    });
    const entries = buildTimelineEntries([
      makeMessage("user-1", "user", "2026-07-15T00:00:00.000Z"),
      makeMessage("assistant-1", "assistant", "2026-07-15T00:00:02.000Z")
    ], [makeToolCall({
      toolName: "apply_patch",
      argumentsJson: JSON.stringify({
        patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch"
      }),
      resultJson: JSON.stringify({
        changes: [{ path: "src/App.tsx", action: "update", additions: 1, deletions: 1 }]
      })
    })], []);
    const section = buildConversationTurnSections(entries)[0];
    const fileSummary = entries.find((entry) => entry.kind === "file-summary");
    const toolGroup = entries.find((entry) => entry.kind === "tool-group");

    expect(section).toBeDefined();
    expect(fileSummary).toBeDefined();
    expect(toolGroup).toBeDefined();
    expect(shouldKeepTimelineEntryWhenTurnCollapsed(fileSummary!, section, new Set([section!.id]))).toBe(true);
    expect(shouldKeepTimelineEntryWhenTurnCollapsed(toolGroup!, section, new Set([section!.id]))).toBe(false);
  });

  it("builds message, elapsed-control, and response sections for every user turn", () => {
    const makeMessage = (id: string, role: MessageRecord["role"], createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: `turn-${id}`,
      role,
      content: id,
      metadataJson: null,
      createdAt
    });
    const entries = buildTimelineEntries([
      makeMessage("user-1", "user", "2026-07-15T00:00:00.000Z"),
      {
        ...makeMessage("progress-1", "assistant", "2026-07-15T00:00:00.500Z"),
        metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: [] })
      },
      makeMessage("assistant-1", "assistant", "2026-07-15T00:00:01.000Z"),
      {
        ...makeMessage("guidance-1", "user", "2026-07-15T00:00:01.500Z"),
        turnRunId: "turn-user-1",
        metadataJson: JSON.stringify({ displayKind: "guidance" })
      },
      makeMessage("user-2", "user", "2026-07-15T00:00:02.000Z"),
      makeMessage("assistant-2", "assistant", "2026-07-15T00:00:03.000Z"),
      makeMessage("user-3", "user", "2026-07-15T00:00:04.000Z")
    ], [], []);

    expect(buildConversationTurnSections(entries)).toEqual([
      expect.objectContaining({
        id: "message-user-1",
        userEntryId: "message-user-1",
        summaryEntryId: "message-assistant-1",
        entryIds: ["message-user-1", "message-progress-1", "message-assistant-1", "message-guidance-1"],
        startedAt: "2026-07-15T00:00:00.000Z",
        completedAt: "2026-07-15T00:00:01.500Z"
      }),
      expect.objectContaining({
        id: "message-user-2",
        userEntryId: "message-user-2",
        summaryEntryId: "message-assistant-2",
        entryIds: ["message-user-2", "message-assistant-2"]
      }),
      expect.objectContaining({
        id: "message-user-3",
        userEntryId: "message-user-3",
        summaryEntryId: null,
        entryIds: ["message-user-3"]
      })
    ]);
  });

  it("interleaves each progress message before its tool group and keeps the final answer last", () => {
    const commentary: MessageRecord = {
      id: "commentary-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "I will inspect the renderer first.",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-1"] }),
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const final: MessageRecord = {
      ...commentary,
      id: "commentary-2",
      content: "The project uses an older solution format, so I will inspect its target framework.",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-2"] }),
      createdAt: "2026-07-15T00:00:02.000Z"
    };
    const answer: MessageRecord = {
      ...commentary,
      id: "final-1",
      content: "The renderer has been inspected.",
      metadataJson: null,
      createdAt: "2026-07-15T00:00:04.000Z"
    };

    const entries = buildTimelineEntries(
      [commentary, final, answer],
      [
        makeToolCall({ id: "tool-1", toolName: "shell.exec", startedAt: "2026-07-15T00:00:01.000Z" }),
        makeToolCall({ id: "tool-2", toolName: "fs.read_file", startedAt: "2026-07-15T00:00:03.000Z" })
      ],
      []
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "tool-group", "message", "tool-group", "message"]);
    expect(entries[0]).toMatchObject({ kind: "message", message: { id: "commentary-1" } });
    expect(entries[2]).toMatchObject({ kind: "message", message: { id: "commentary-2" } });
    expect(entries[4]).toMatchObject({ kind: "message", message: { id: "final-1" } });
  });

  it("anchors legacy tools after the nearest preceding message", () => {
    const message = (id: string, createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: id,
      metadataJson: null,
      createdAt
    });
    const entries = buildTimelineEntries(
      [
        message("progress-1", "2026-07-15T00:00:01.000Z"),
        message("progress-2", "2026-07-15T00:00:03.000Z"),
        message("progress-3", "2026-07-15T00:00:05.000Z")
      ],
      [
        makeToolCall({ id: "legacy-tool-1", startedAt: "2026-07-15T00:00:01.100Z", completedAt: "2026-07-15T00:00:02.000Z" }),
        makeToolCall({ id: "legacy-tool-2", startedAt: "2026-07-15T00:00:03.100Z", completedAt: "2026-07-15T00:00:04.000Z" }),
        makeToolCall({ id: "legacy-tool-3", startedAt: "2026-07-15T00:00:05.100Z", completedAt: "2026-07-15T00:00:06.000Z" })
      ],
      []
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "message", "tool-group", "message", "tool-group", "message", "tool-group"
    ]);
    expect(entries.filter((entry) => entry.kind === "tool-group").map((entry) => entry.toolCalls[0]?.id))
      .toEqual(["legacy-tool-1", "legacy-tool-2", "legacy-tool-3"]);
  });

  it("merges identical progress text and its later tool batches into one timeline segment", () => {
    const progress = (id: string, toolCallId: string, createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "我继续核对相关资料。",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: [toolCallId] }),
      createdAt
    });

    const visible = filterTranscriptMessages([
      progress("progress-1", "tool-1", "2026-07-15T00:00:01.000Z"),
      progress("progress-2", "tool-2", "2026-07-15T00:00:03.000Z")
    ], "running");

    expect(visible.map((message) => message.id)).toEqual(["progress-1"]);

    const entries = buildTimelineEntries(visible, [
      makeToolCall({ id: "tool-1", toolName: "browser.navigate", startedAt: "2026-07-15T00:00:02.000Z" }),
      makeToolCall({ id: "tool-2", toolName: "browser.navigate", startedAt: "2026-07-15T00:00:04.000Z" })
    ], []);

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "tool-group"]);
    expect(entries[1]).toMatchObject({
      kind: "tool-group",
      toolCalls: [{ id: "tool-1" }, { id: "tool-2" }]
    });
  });

  it("hides legacy internal tool-compatibility markers from the transcript", () => {
    const visible = filterTranscriptMessages([
      {
        id: "internal-tools",
        threadId: "thread-1",
        turnRunId: "turn-1",
        role: "assistant",
        content: "密码已修复，现在重新运行启动脚本。 [Executed tools: shell.exec]",
        metadataJson: null,
        createdAt: "2026-07-15T00:00:01.000Z"
      },
      {
        id: "result",
        threadId: "thread-1",
        turnRunId: "turn-1",
        role: "assistant",
        content: "已完成文件检查。",
        metadataJson: null,
        createdAt: "2026-07-15T00:00:02.000Z"
      }
    ]);

    expect(visible.map((message) => message.id)).toEqual(["result"]);
  });

  it("keeps a context compaction notice in chronological transcript order", () => {
    const message = (id: string, createdAt: string): MessageRecord => ({
      id,
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: id,
      metadataJson: null,
      createdAt
    });
    const entries = buildTimelineEntries(
      [
        message("before", "2026-07-15T00:00:00.000Z"),
        message("after", "2026-07-15T00:00:02.000Z")
      ],
      [],
      [],
      undefined,
      undefined,
      [],
      {
        turnRunId: "turn-1",
        contextWindow: 128_000,
        threshold: 100_000,
        target: 80_000,
        beforeTokens: 110_000,
        afterTokens: 40_000,
        messagesBefore: 30,
        messagesAfter: 12,
        createdAt: "2026-07-15T00:00:01.000Z"
      }
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "message",
      "context-compaction",
      "message"
    ]);
  });

  it("groups calls by turn and keeps legacy calls separate", () => {
    const entries = buildTimelineEntries(
      [],
      [
        makeToolCall({ id: "turn-1-read", turnRunId: "turn-1" }),
        makeToolCall({ id: "turn-1-search", turnRunId: "turn-1", toolName: "code.search" }),
        makeToolCall({ id: "turn-2-read", turnRunId: "turn-2", startedAt: "2026-07-15T00:01:00.000Z" }),
        makeToolCall({ id: "legacy", turnRunId: "", startedAt: "2026-07-15T00:02:00.000Z" })
      ],
      []
    );
    const toolGroups = entries.filter((entry) => entry.kind === "tool-group");

    expect(toolGroups).toHaveLength(3);
    expect(toolGroups.find((entry) => entry.id === "tool-group-turn-1")?.toolCalls).toHaveLength(2);
    expect(toolGroups.find((entry) => entry.id === "tool-group-legacy-legacy")?.toolCalls).toHaveLength(1);
  });

  it("merges hidden tool-only decisions within the same visible-message interval", () => {
    const firstAnchor: MessageRecord = {
      id: "batch-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "",
      metadataJson: JSON.stringify({ displayKind: "tool_batch", toolCallIds: ["tool-1", "tool-2"] }),
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const secondAnchor: MessageRecord = {
      ...firstAnchor,
      id: "batch-2",
      metadataJson: JSON.stringify({ displayKind: "tool_batch", toolCallIds: ["tool-3"] }),
      createdAt: "2026-07-15T00:00:03.000Z"
    };

    const entries = buildTimelineEntries(
      [firstAnchor, secondAnchor],
      [
        makeToolCall({ id: "tool-1", startedAt: "2026-07-15T00:00:01.000Z" }),
        makeToolCall({ id: "tool-2", startedAt: "2026-07-15T00:00:02.000Z" }),
        makeToolCall({ id: "tool-3", startedAt: "2026-07-15T00:00:04.000Z" })
      ],
      []
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["tool-group"]);
    expect(entries.map((entry) => entry.kind === "tool-group" ? entry.toolCalls.map((call) => call.id) : [])).toEqual([
      ["tool-1", "tool-2", "tool-3"]
    ]);
  });

  it("shows every completed and running tool call between two visible messages in one group", () => {
    const progress: MessageRecord = {
      id: "progress-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "I am checking the current page.",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-1"] }),
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const hiddenBatch: MessageRecord = {
      ...progress,
      id: "hidden-batch",
      content: "",
      metadataJson: JSON.stringify({ displayKind: "tool_batch", toolCallIds: ["tool-2"] }),
      createdAt: "2026-07-15T00:00:02.000Z"
    };
    const entries = buildTimelineEntries(
      [progress, hiddenBatch],
      [
        makeToolCall({ id: "tool-1", status: "completed", startedAt: "2026-07-15T00:00:01.000Z", completedAt: "2026-07-15T00:00:01.500Z" }),
        makeToolCall({ id: "tool-2", status: "completed", startedAt: "2026-07-15T00:00:03.000Z", completedAt: "2026-07-15T00:00:03.500Z" }),
        makeToolCall({ id: "tool-3", status: "running", startedAt: "2026-07-15T00:00:04.000Z", completedAt: null })
      ],
      [],
      undefined,
      "running"
    );

    const group = entries.find((entry) => entry.kind === "tool-group");
    expect(group?.kind).toBe("tool-group");
    expect(group?.kind === "tool-group" ? group.toolCalls.map((call) => [call.id, call.status]) : []).toEqual([
      ["tool-1", "completed"],
      ["tool-2", "completed"],
      ["tool-3", "running"]
    ]);
  });

  it("keeps file changes as a separate outcome summary", () => {
    const entries = buildTimelineEntries(
      [],
      [makeToolCall({
        toolName: "apply_patch",
        argumentsJson: JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch" })
      })],
      []
    );

    expect(entries.some((entry) => entry.kind === "tool-group")).toBe(true);
    expect(entries.some((entry) => entry.kind === "file-summary")).toBe(true);
  });
});

describe("optimistic user message reconciliation", () => {
  it("creates an immediately renderable empty snapshot for a new thread", () => {
    const thread: ThreadRecord = {
      id: "thread-new",
      title: "New task",
      mode: "chat",
      workspaceKind: "projectless",
      cwd: null,
      projectId: null,
      workspaceId: null,
      modelId: "model-1",
      providerId: "provider-1",
      status: "idle",
      selectedSkillIds: [],
      selectedPluginIds: [],
      knowledgeBaseIds: [],
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
      isPinned: false,
      pinnedAt: null,
      gpaStateJson: null,
      parentThreadId: null,
      rootThreadId: "thread-new",
      agentPath: "/root",
      agentRole: null,
      lastTaskMessage: null,
      multiAgentMode: "disabled"
    };

    expect(createOptimisticThreadSnapshot(thread)).toMatchObject({
      snapshotMode: "full",
      thread,
      messages: [],
      messageCount: 0,
      queuedMessages: [],
      toolCalls: [],
      subagents: [],
      queuedSubagentIds: []
    });
  });

  it("replaces an optimistic message with the persisted display message", () => {
    const optimistic: MessageRecord = {
      id: "optimistic-1",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: "Check the WebP submission controls",
      metadataJson: null,
      createdAt: "2026-07-15T01:00:00.000Z"
    };
    const persisted: MessageRecord = {
      ...optimistic,
      id: "persisted-1",
      content: "Check the WebP submission controls\n\n[attached skill context]",
      metadataJson: JSON.stringify({ displayContent: optimistic.content }),
      createdAt: "2026-07-15T01:00:02.000Z"
    };

    expect(reconcilePendingUserMessages([optimistic], [persisted])).toEqual([]);
  });

  it("matches persisted messages one-to-one when identical requests are sent", () => {
    const first: MessageRecord = {
      id: "optimistic-1",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: "Continue",
      metadataJson: null,
      createdAt: "2026-07-15T01:00:00.000Z"
    };
    const second: MessageRecord = { ...first, id: "optimistic-2", createdAt: "2026-07-15T01:00:01.000Z" };
    const persisted: MessageRecord = { ...first, id: "persisted-1", createdAt: "2026-07-15T01:00:02.000Z" };

    expect(reconcilePendingUserMessages([first, second], [persisted])).toEqual([second]);
  });

  it("consumes an API card optimistic title when its full persisted payload arrives", () => {
    const displayContent = "调用接口卡片「根据 OBS 地址下载附件」";
    const optimistic: MessageRecord = {
      id: "optimistic-api-card",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: displayContent,
      metadataJson: null,
      createdAt: "2026-08-04T01:00:00.000Z"
    };
    const persisted: MessageRecord = {
      ...optimistic,
      id: "persisted-api-card",
      content: "```api-card\n{\"url\":\"https://example.test/download\"}\n```",
      metadataJson: JSON.stringify({ displayContent }),
      createdAt: "2026-08-04T01:00:00.250Z"
    };

    const reconciliation = reconcilePendingUserMessagesDetailed([optimistic], [persisted]);
    const visibleMessages = mergeSnapshotRecords(
      [optimistic].filter((message) => !reconciliation.consumedIds.has(message.id)),
      [persisted],
      (message) => message.createdAt
    );

    expect(reconciliation.remaining).toEqual([]);
    expect(reconciliation.consumedIds).toEqual(new Set([optimistic.id]));
    expect(visibleMessages).toEqual([persisted]);
  });

  it("consumes only one API card optimistic message per persisted event", () => {
    const displayContent = "调用接口卡片「根据 OBS 地址下载附件」";
    const first: MessageRecord = {
      id: "optimistic-api-card-1",
      threadId: "thread-1",
      turnRunId: null,
      role: "user",
      content: displayContent,
      metadataJson: null,
      createdAt: "2026-08-04T01:00:00.000Z"
    };
    const second: MessageRecord = {
      ...first,
      id: "optimistic-api-card-2",
      createdAt: "2026-08-04T01:00:01.000Z"
    };
    const persisted: MessageRecord = {
      ...first,
      id: "persisted-api-card",
      content: "```api-card\n{\"url\":\"https://example.test/download\"}\n```",
      metadataJson: JSON.stringify({ displayContent }),
      createdAt: "2026-08-04T01:00:02.000Z"
    };

    const reconciliation = reconcilePendingUserMessagesDetailed([first, second], [persisted]);

    expect(reconciliation.remaining).toEqual([second]);
    expect(reconciliation.consumedIds).toEqual(new Set([first.id]));
  });
});

describe("subagent waiting status", () => {
  it("recognizes both canonical and compatibility wait tool names", () => {
    expect(isSubagentWaitTool("wait_agent")).toBe(true);
    expect(isSubagentWaitTool("multi_agents.wait")).toBe(true);
    expect(isSubagentWaitTool("spawn_agent")).toBe(false);
  });

  it("reports only active and queued subagents in the root waiting label", () => {
    const agents = [
      { id: "running", status: "running" as const },
      { id: "queued", status: "idle" as const },
      { id: "done", status: "completed" as const }
    ];

    expect(getSubagentWaitLabel(agents, new Set(["queued"]))).toBe("正在等待 2 个子智能体 · 1 运行 · 1 排队");
    expect(getSubagentWaitLabel([{ id: "input", status: "waiting" }], new Set())).toBe("正在等待 1 个子智能体 · 1 等待处理");
    expect(getSubagentWaitLabel([{ id: "done", status: "completed" }], new Set())).toBeNull();
  });

  it("keeps only live subagents in the execution disclosure", () => {
    const agents = [
      { id: "running", status: "running" as const },
      { id: "waiting", status: "waiting" as const },
      { id: "queued", status: "idle" as const },
      { id: "done", status: "completed" as const },
      { id: "failed", status: "failed" as const }
    ];

    expect(getActiveSubagents(agents, new Set(["queued"])).map((agent) => agent.id)).toEqual([
      "running",
      "waiting",
      "queued"
    ]);
  });
});

describe("assistant draft lifecycle", () => {
  const persistedFailure: MessageRecord = {
    id: "failure-message",
    threadId: "thread-1",
    turnRunId: "failed-turn",
    role: "assistant",
    content: "The task failed.",
    metadataJson: null,
    createdAt: "2026-07-27T07:25:27.191Z"
  };

  it("removes an uncommitted draft when its thread reaches a terminal state", () => {
    expect(shouldKeepAssistantDraft(
      { completed: false },
      [persistedFailure],
      "failed"
    )).toBe(false);
  });

  it("keeps only an unfinished draft while its thread is still executing", () => {
    expect(shouldKeepAssistantDraft(
      { completed: false },
      [],
      "running"
    )).toBe(true);
    expect(shouldKeepAssistantDraft(
      { completed: true, messageId: persistedFailure.id },
      [persistedFailure],
      "running"
    )).toBe(false);
  });

  it("shows an unfinished draft even when the same turn already has progress messages", () => {
    const commentary: MessageRecord = {
      ...persistedFailure,
      id: "progress-message",
      turnRunId: "active-turn",
      content: "我先核对资料。",
      metadataJson: JSON.stringify({ displayKind: "commentary", toolCallIds: ["tool-1"] })
    };
    const draft = {
      draftId: "draft-1",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "这是正在逐字生成的结论",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false,
    };

    expect(selectActiveAssistantDraft([draft], "thread-1", "running", [commentary])).toEqual(draft);
  });

  it("shows an empty draft immediately so a buffered provider still has a heartbeat", () => {
    const draft = {
      draftId: "draft-empty",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false
    };

    expect(selectActiveAssistantDraft([draft], "thread-1", "running", [])).toEqual(draft);
  });

  it("renders every incremental draft delta before the next checkpoint", () => {
    expect(reconcileAssistantDraftStreamUpdate(undefined, { content: "legacy" })).toEqual({ content: "legacy" });

    const initial = reconcileAssistantDraftStreamUpdate(undefined, {
      content: "",
      delta: "",
      deltaSequence: 1
    });
    const first = reconcileAssistantDraftStreamUpdate(initial?.buffer, {
      delta: "Hello",
      deltaSequence: 2
    });
    expect(first).toMatchObject({ content: "Hello", chunks: ["", "Hello"] });
    const second = reconcileAssistantDraftStreamUpdate(first?.buffer, {
      delta: " world",
      deltaSequence: 3
    });
    expect(second).toMatchObject({ content: "Hello world", chunks: ["", "Hello", " world"] });
    expect(reconcileAssistantDraftStreamUpdate(second?.buffer, {
      delta: " skipped",
      deltaSequence: 5
    })).toBeNull();
    expect(reconcileAssistantDraftStreamUpdate(second?.buffer, {
      content: "Hello world restored",
      delta: " restored",
      deltaSequence: 20
    })?.chunks).toEqual(["Hello world restored"]);
  });

  it("keeps streamed reasoning separate from the visible response", () => {
    const first = reconcileAssistantDraftReasoningUpdate(undefined, {
      delta: "Inspecting ",
      deltaSequence: 1
    });
    const second = reconcileAssistantDraftReasoningUpdate(first?.buffer, {
      delta: "the stream.",
      deltaSequence: 2
    });

    expect(second).toMatchObject({
      reasoning: "Inspecting the stream.",
      chunks: ["Inspecting ", "the stream."]
    });
    expect(reconcileAssistantDraftReasoningUpdate(second?.buffer, {
      reasoning: "Restored reasoning.",
      delta: "Restored reasoning.",
      deltaSequence: 20
    })?.chunks).toEqual(["Restored reasoning."]);
  });

  it("ignores late updates from an older model request in the same turn", () => {
    const newer = {
      draftId: "draft-2",
      sequence: 2,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "新的候选",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:29.000Z",
      completed: false
    };
    const older = { ...newer, draftId: "draft-1", sequence: 1, content: "迟到的旧候选" };

    expect(reconcileAssistantDraftUpdate({ [newer.draftId]: newer }, older)).toEqual({ [newer.draftId]: newer });
  });

  it("replaces an older same-thread draft when the next model request starts", () => {
    const older = {
      draftId: "draft-1",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "上一轮无效候选",
      phase: "retrying" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false
    };
    const newer = {
      ...older,
      draftId: "draft-2",
      sequence: 2,
      content: "",
      phase: "generating" as const,
      startedAt: "2026-07-27T07:25:29.000Z"
    };

    expect(reconcileAssistantDraftUpdate({ [older.draftId]: older }, newer)).toEqual({
      [newer.draftId]: newer
    });
  });

  it("removes a streamed draft as soon as runtime marks it discarded", () => {
    const draft = {
      draftId: "draft-1",
      sequence: 1,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "不会成为最终回复的候选内容",
      phase: "auditing" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false,
    };

    expect(reconcileAssistantDraftCompletion({ "draft-1": draft }, {
      turnRunId: "active-turn",
      draftId: "draft-1",
      discarded: true,
      suppressed: false
    })).toEqual({});
  });

  it("keeps a committed draft until its exact persisted message arrives", () => {
    expect(shouldKeepAssistantDraft(
      { completed: true, messageId: "final-message" },
      [],
      "completed"
    )).toBe(true);
    expect(shouldKeepAssistantDraft(
      { completed: true, messageId: "final-message" },
      [{ ...persistedFailure, id: "final-message" }],
      "completed"
    )).toBe(false);
  });

  it("marks the exact draft committed and retains its content until persistence catches up", () => {
    const draft = {
      draftId: "draft-final",
      sequence: 3,
      threadId: "thread-1",
      turnRunId: "active-turn",
      content: "完整的最终答复",
      phase: "auditing" as const,
      startedAt: "2026-07-27T07:25:28.000Z",
      completed: false
    };

    const reconciled = reconcileAssistantDraftCompletion({ [draft.draftId]: draft }, {
      turnRunId: draft.turnRunId,
      draftId: draft.draftId,
      messageId: "message-final",
      discarded: false,
      suppressed: false
    });

    expect(reconciled[draft.draftId]).toMatchObject({
      content: draft.content,
      completed: true,
      messageId: "message-final"
    });
  });

  it("renders only active user-visible streaming text", () => {
    expect(getAssistantDraftDisplayContent({ content: "第一段回复\n\n第二段正在生成" }))
      .toBe("第一段回复\n\n第二段正在生成");
    expect(getAssistantDraftDisplayContent({ content: "audit candidate" })).toBe("audit candidate");
    expect(getAssistantDraftDisplayContent({ content: '{"assistant_message":"内部协议",' })).toBe("");
    expect(getAssistantDraftDisplayContent({
      content: "正文\n<tool_calls>[{\"name\":\"fs.read_file\"}]</tool_calls>"
    })).toBe("正文\n");
  });

});

describe("incremental snapshot merging", () => {
  it("upserts runtime prompts without duplicates and keeps chronological order", () => {
    const earlier = makeUserInputPrompt({
      id: "prompt-earlier",
      createdAt: "2026-07-15T00:59:00.000Z"
    });
    const stale = makeUserInputPrompt({
      id: "prompt-live",
      title: "Stale title",
      status: "answered",
      createdAt: "2026-07-15T01:01:00.000Z"
    });
    const later = makeUserInputPrompt({
      id: "prompt-later",
      createdAt: "2026-07-15T01:02:00.000Z"
    });
    const runtimePrompt = makeUserInputPrompt({
      id: "prompt-live",
      title: "Current title",
      status: "pending",
      createdAt: "2026-07-15T01:01:00.000Z"
    });

    expect(upsertRuntimeUserInputPrompt([], runtimePrompt)).toEqual([runtimePrompt]);
    expect(upsertRuntimeUserInputPrompt([later, stale, earlier], runtimePrompt)).toEqual([
      earlier,
      runtimePrompt,
      later
    ]);
  });

  it("appends new records, applies updates, and keeps chronological order", () => {
    const existing = [
      { id: "tool-1", createdAt: "2026-07-15T01:00:00.000Z", status: "running" },
      { id: "tool-2", createdAt: "2026-07-15T01:02:00.000Z", status: "completed" }
    ];
    const changes = [
      { id: "tool-1", createdAt: "2026-07-15T01:00:00.000Z", status: "completed" },
      { id: "tool-3", createdAt: "2026-07-15T01:01:00.000Z", status: "completed" }
    ];

    expect(mergeSnapshotRecords(existing, changes, (item) => item.createdAt)).toEqual([
      { id: "tool-1", createdAt: "2026-07-15T01:00:00.000Z", status: "completed" },
      { id: "tool-3", createdAt: "2026-07-15T01:01:00.000Z", status: "completed" },
      { id: "tool-2", createdAt: "2026-07-15T01:02:00.000Z", status: "completed" }
    ]);
  });

  it("keeps artifact ordering newest first", () => {
    const existing = [{ id: "artifact-1", createdAt: "2026-07-15T01:00:00.000Z" }];
    const changes = [{ id: "artifact-2", createdAt: "2026-07-15T01:02:00.000Z" }];

    expect(mergeSnapshotRecords(existing, changes, (item) => item.createdAt, "descending"))
      .toEqual([{ id: "artifact-2", createdAt: "2026-07-15T01:02:00.000Z" }, existing[0]]);
  });

  it("keeps live tool calls ordered while replacing stale snapshot records", () => {
    const older: ToolCallSummary = {
      ...makeToolCall({ id: "tool-older", startedAt: "2026-07-15T00:00:00.000Z" }),
      resultSize: 2,
      hasFullResult: true
    };
    const running: ToolCallSummary = {
      ...makeToolCall({
        id: "tool-live",
        status: "running",
        resultJson: null,
        startedAt: "2026-07-15T00:00:02.000Z",
        completedAt: null
      }),
      resultSize: 0,
      hasFullResult: true
    };

    expect(upsertRuntimeToolCallSummary([older], running)).toEqual([older, running]);
  });

  it("completes an existing live tool without losing its arguments", () => {
    const running: ToolCallSummary = {
      ...makeToolCall({ status: "running", resultJson: null, completedAt: null }),
      resultSize: 0,
      hasFullResult: true
    };

    const [completed] = completeRuntimeToolCallSummary([running], {
      id: running.id,
      threadId: running.threadId,
      status: "completed",
      resultJson: "{\"ok\":true}",
      resultSize: 11,
      hasFullResult: true,
      completedAt: "2026-07-15T00:00:03.000Z"
    });

    expect(completed).toMatchObject({
      argumentsJson: running.argumentsJson,
      toolName: running.toolName,
      status: "completed",
      completedAt: "2026-07-15T00:00:03.000Z"
    });
  });

  it("creates a completed tool record when the start event was missed", () => {
    const [completed] = completeRuntimeToolCallSummary([], {
      id: "tool-recovered",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "code.search",
      status: "completed",
      resultJson: "{}",
      resultSize: 2,
      hasFullResult: true,
      completedAt: "2026-07-15T00:00:03.000Z"
    });

    expect(completed).toMatchObject({
      id: "tool-recovered",
      toolName: "code.search",
      status: "completed",
      startedAt: "2026-07-15T00:00:03.000Z"
    });
  });

  it("merges a persisted user message into a queued-turn snapshot immediately", () => {
    const queuedSnapshot: MessageRecord[] = [{
      id: "assistant-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant" as const,
      content: "Working...",
      metadataJson: null,
      createdAt: "2026-08-03T08:03:00.000Z"
    }];
    const persistedUserMessage: MessageRecord = {
      id: "user-2",
      threadId: "thread-1",
      turnRunId: "turn-2",
      role: "user",
      content: "Continue the deployment.",
      metadataJson: null,
      createdAt: "2026-08-03T08:03:01.000Z"
    };

    expect(mergeSnapshotRecords(queuedSnapshot, [persistedUserMessage], (message) => message.createdAt))
      .toEqual([queuedSnapshot[0], persistedUserMessage]);
  });

  it("keeps a completed runtime event over an older running snapshot", () => {
    const running = makeThread({ status: "running", updatedAt: "2026-08-03T07:58:26.000Z" });
    const completed = makeThread({ status: "completed", updatedAt: "2026-08-03T07:58:27.036Z" });

    expect(resolveLatestThreadRecord(running, completed)).toBe(completed);
    expect(resolveLatestThreadRecord(completed, running)).toBe(completed);
  });

  it("allows a newer running event to start a later turn after completion", () => {
    const completed = makeThread({ status: "completed", updatedAt: "2026-08-03T07:58:27.036Z" });
    const running = makeThread({ status: "running", updatedAt: "2026-08-03T08:03:10.000Z" });

    expect(resolveLatestThreadRecord(completed, running)).toBe(running);
  });

  it("drops a committed draft as soon as its persisted message is merged", () => {
    const finalMessage: MessageRecord = {
      id: "final-message",
      threadId: "thread-1",
      turnRunId: "turn-1",
      role: "assistant",
      content: "done",
      metadataJson: null,
      createdAt: "2026-08-03T07:58:26.969Z"
    };
    const messages = mergeSnapshotRecords([], [finalMessage], (message) => message.createdAt);

    expect(shouldKeepAssistantDraft(
      { completed: true, messageId: finalMessage.id },
      messages,
      "completed"
    )).toBe(false);
  });
});

describe("thread deletion feedback", () => {
  it("explains how to release a Windows-locked task output directory", () => {
    const message = getThreadDeleteFailureMessage(
      new Error("EBUSY: resource busy or locked, rmdir 'C:\\Users\\name\\.codexh\\outputs\\thread-1'")
    );

    expect(message).toContain("终端或预览");
    expect(message).toContain("完全退出并重新打开 CodeXH");
    expect(message).not.toContain("EBUSY");
  });
});

describe("desktop screenshot artifacts", () => {
  it("renders desktop screenshots as generated images in the timeline", () => {
    const entries = buildTimelineEntries([], [], [{
      id: "desktop-screenshot-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      messageId: null,
      toolCallId: null,
      artifactKind: "desktop-screenshot",
      displayName: "desktop-1.png",
      absolutePath: "C:\\output\\screenshots\\desktop-1.png",
      relativePath: "screenshots\\desktop-1.png",
      mimeType: "image/png",
      sizeBytes: 100,
      sha256: "hash",
      sourceKind: "desktop",
      isUserVisible: true,
      status: "ready",
      createdAt: "2026-08-31T00:00:00.000Z"
    }]);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: "file-summary",
        files: [expect.objectContaining({ kind: "generated-image", description: "桌面截图" })]
      })
    ]);
  });
});
