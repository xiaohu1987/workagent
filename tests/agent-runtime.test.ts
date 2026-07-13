import { describe, expect, it } from "vitest";
import {
  createToolCallFingerprint,
  classifySuccessfulToolEvidence,
  validateActCompletion,
  buildActCompletionRecoveryInstruction,
  isProgressOnlyAssistantMessage,
  buildExecutionRecoveryInstruction,
  buildStrategySwitchInstruction,
  buildRepeatedTaskRecoveryMessage,
  buildRuntimeFailureRecoveryMessage,
  buildRuntimeTranscript,
  AgentModelCompatibilityError,
  compactTranscriptForContext,
  CONTEXT_COMPACTION_THRESHOLD,
  shouldFinishGpaAnalysisTurn,
  parseGpaPlanTasks,
  buildGpaTextClarificationQuestions,
  getAddedPatchFiles,
  getToolCallTaskKey,
  retargetStaleBrowserObservationToolCall,
  formatAvailableTools,
  isAgentToolEnabled,
  prioritizeUserInputToolCall,
  MAX_REPEATED_TASK_FAILURES,
  MAX_MODEL_TIMEOUT_RETRIES,
  parseGpaState,
  parseMultimodalIntentClassification,
  buildMultimodalIntentClassifySystemPrompt,
  buildMultimodalIntentClassifyTranscript
} from "@agent-runtime";

describe("createToolCallFingerprint", () => {
  it("stops only after five consecutive failures of the same tool task", () => {
    expect(MAX_REPEATED_TASK_FAILURES).toBe(5);
  });

  it("treats equivalent tool arguments as the same call", () => {
    expect(createToolCallFingerprint("read", { path: ".", depth: 1 })).toBe(
      createToolCallFingerprint("read", { depth: 1, path: "." })
    );
  });

  it("keeps different tools and arguments distinct", () => {
    const fingerprint = createToolCallFingerprint("read", { path: "." });

    expect(fingerprint).not.toBe(createToolCallFingerprint("read", { path: "src" }));
    expect(fingerprint).not.toBe(createToolCallFingerprint("read_file", { path: "." }));
  });

  it("groups patch retries by their target file instead of patch text", () => {
    const firstAttempt = "*** Begin Patch\n*** Add File: css/style.css\nbody {}\n*** End Patch";
    const retry = "*** Begin Patch\n*** Add File: css/style.css\n+body {}\n*** End Patch";

    expect(getToolCallTaskKey("apply_patch", { patch: firstAttempt })).toBe(
      getToolCallTaskKey("apply_patch", { patch: retry })
    );
  });

  it("identifies files created by an Add File patch", () => {
    expect(
      getAddedPatchFiles({
        patch: "*** Begin Patch\n*** Add File: js/renderer.js\n+export {}\n*** Add File: css/game.css\n+.game {}\n*** End Patch"
      })
    ).toEqual(["js/renderer.js", "css/game.css"]);
  });
});

describe("stale browser tab recovery", () => {
  const tabs = [
    { id: "old-tab", threadId: "thread", title: "Old", url: "http://127.0.0.1:8000", isActive: false, createdAt: "now", updatedAt: "now" },
    { id: "active-tab", threadId: "thread", title: "Current", url: "http://127.0.0.1:8000", isActive: true, createdAt: "now", updatedAt: "now" }
  ];

  it("retargets repeated read-only browser operations to the active tab", () => {
    const retargeted = retargetStaleBrowserObservationToolCall(
      { id: "call", name: "browser.inspect_page", arguments: { tabId: "old-tab" } },
      tabs
    );

    expect(retargeted?.arguments.tabId).toBe("active-tab");
  });

  it("does not retarget browser actions with side effects", () => {
    expect(retargetStaleBrowserObservationToolCall(
      { id: "call", name: "browser.click", arguments: { tabId: "old-tab", elementId: "xh-1" } },
      tabs
    )).toBeNull();
  });
});

describe("ACT execution recovery", () => {
  it("forces the next model turn to make a real tool call without reporting a task failure", () => {
    const instruction = buildExecutionRecoveryInstruction({
      attempt: 2,
      reason: "The decision did not execute a tool.",
      bootstrapWorkspace: true
    });

    expect(instruction).toContain("fs.read_directory");
    expect(instruction).toContain("call apply_patch");
    expect(instruction).toContain("Do not write progress prose");
    expect(instruction).not.toContain("failed");
  });
});

describe("Agent model compatibility failures", () => {
  it("explains tool calling must be enabled without forcing a model switch", () => {
    const message = buildRuntimeFailureRecoveryMessage(
      new AgentModelCompatibilityError("Unreliable Model", 2, "Tool calling is disabled for this model.")
    );

    expect(message).toContain("Unreliable Model");
    expect(message).toContain("开启工具调用");
    expect(message).not.toContain("切换到支持工具调用");
  });

  it("keeps protocol exhaustion recoverable without telling the user to switch models", () => {
    const message = buildRuntimeFailureRecoveryMessage(
      new Error("Agent decision protocol failed repeatedly: invalid JSON decision")
    );

    expect(message).toContain("invalid JSON decision");
    expect(message).toContain("稍后重试");
    expect(message).not.toContain("切换");
  });
});

describe("model decision timeout retries", () => {
  it("defaults to five automatic timeout retries before stopping", () => {
    expect(MAX_MODEL_TIMEOUT_RETRIES).toBe(5);
  });
});

describe("Agent capability compatibility", () => {
  const baseModel = {
    id: "legacy-model",
    providerId: "provider",
    displayName: "Legacy model",
    contextWindow: 8_192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsParallelToolCalls: false,
    supportsJsonOutput: true,
    supportsMultimodalInput: false,
    supportsReasoningSummary: false
  };

  it("keeps tool calling enabled for an unverified legacy model", () => {
    expect(isAgentToolEnabled(baseModel)).toBe(true);
  });

  it("does not disable tools after a runtime capability downgrade", () => {
    expect(isAgentToolEnabled({ ...baseModel, agentCapability: "unsupported" })).toBe(true);
    expect(isAgentToolEnabled({ ...baseModel, supportsToolCalling: false })).toBe(false);
  });
});

describe("context compaction", () => {
  it("keeps the full persisted history for context compaction instead of silently dropping older messages", () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "tool" as const,
      content: `message ${index}`,
      metadataJson: null
    }));

    expect(buildRuntimeTranscript(history as any)).toHaveLength(25);
  });

  it("compresses the transcript before it reaches the model context limit", () => {
    const transcript = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message ${index} ${"x".repeat(500)}`
    }));
    const result = compactTranscriptForContext(transcript, 2_000, "system instructions");

    expect(CONTEXT_COMPACTION_THRESHOLD).toBe(0.9);
    expect(result.compacted).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.transcript.length).toBeLessThan(transcript.length);
    expect(result.transcript[0]?.content).toContain("内部上下文压缩摘要");
  });

  it("leaves a small transcript unchanged", () => {
    const transcript = [{ role: "user" as const, content: "short request" }];
    const result = compactTranscriptForContext(transcript, 128_000, "system instructions");

    expect(result.compacted).toBe(false);
    expect(result.transcript).toBe(transcript);
  });

  it.each([64_000, 128_000])("uses 90 percent of a %i-token model window as the threshold", (contextWindow) => {
    const thresholdTokens = Math.floor(contextWindow * CONTEXT_COMPACTION_THRESHOLD);
    const belowThreshold = [{
      role: "user" as const,
      content: "x".repeat(Math.floor((thresholdTokens - 1) * 2.8))
    }];
    const atThreshold = [{
      role: "user" as const,
      content: "x".repeat(Math.ceil(thresholdTokens * 2.8))
    }];

    expect(compactTranscriptForContext(belowThreshold, contextWindow, "").compacted).toBe(false);
    expect(compactTranscriptForContext(atThreshold, contextWindow, "").compacted).toBe(true);
  });

  it("keeps recent native tool-call metadata during compaction", () => {
    const transcript = [
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `older message ${index} ${"x".repeat(600)}`
      })),
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "native-call", name: "fs.read_directory", arguments: { path: "." } }]
      },
      {
        role: "tool" as const,
        content: `fs.read_directory\n${"result ".repeat(180)}`,
        toolCallId: "native-call"
      }
    ];
    const result = compactTranscriptForContext(transcript, 2_000, "system instructions");

    expect(result.compacted).toBe(true);
    expect(result.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCalls: [expect.objectContaining({ id: "native-call" })] }),
      expect.objectContaining({ role: "tool", toolCallId: "native-call" })
    ]));
  });

  it("keeps a complete large native tool batch during compaction", () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: `native-call-${index}`,
      name: "fs.read_file",
      arguments: { path: `src/file-${index}.ts` }
    }));
    const transcript = [
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `older message ${index} ${"x".repeat(600)}`
      })),
      { role: "assistant" as const, content: "", toolCalls: calls },
      ...calls.map((call) => ({
        role: "tool" as const,
        toolCallId: call.id,
        content: `fs.read_file\n${call.arguments.path}\n${"result ".repeat(80)}`
      }))
    ];
    const result = compactTranscriptForContext(transcript, 2_000, "system instructions");
    const retainedEnvelope = result.transcript.find((message) => message.toolCalls?.[0]?.id === "native-call-0");
    const retainedResultIds = result.transcript
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId);

    expect(result.compacted).toBe(true);
    expect(retainedEnvelope?.toolCalls).toHaveLength(10);
    expect(retainedResultIds).toEqual(calls.map((call) => call.id));
  });
});

describe("native tool prompt budget", () => {
  const tools = [{
    name: "fs.read_directory",
    description: "List project files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path." } },
      required: ["path"]
    },
    riskLevel: "low" as const
  }];

  it("does not duplicate function schemas in a native provider prompt", () => {
    const prompt = formatAvailableTools(tools, { includeSchemas: false });

    expect(prompt).toContain("fs.read_directory");
    expect(prompt).not.toContain("Input schema");
    expect(prompt).not.toContain("Directory path.");
  });

  it("keeps schemas available for the text-protocol fallback", () => {
    expect(formatAvailableTools(tools)).toContain("Input schema");
  });
});

describe("GPA analysis turn completion", () => {
  it("ends a structured GOAL or PLAN reply even when the provider leaves end_turn false", () => {
    const decision = { isStructured: true, toolCalls: [] };

    expect(shouldFinishGpaAnalysisTurn("goal", decision)).toBe(true);
    expect(shouldFinishGpaAnalysisTurn("plan", decision)).toBe(true);
    expect(shouldFinishGpaAnalysisTurn("act", decision)).toBe(false);
  });

  it("does not complete an analysis stage when a tool call still needs blocking", () => {
    expect(
      shouldFinishGpaAnalysisTurn("plan", {
        isStructured: true,
        toolCalls: [{ id: "call-1", name: "fs.read_directory", arguments: { path: "." } }]
      })
    ).toBe(false);
  });
});

describe("GPA ACT completion evidence", () => {
  const planTasks = [{ id: "T1", title: "Create the game", done: false }];

  it("rejects an empty-directory read followed by a claimed completion", () => {
    const observation = classifySuccessfulToolEvidence({
      toolCallId: "read-empty",
      toolName: "fs.read_directory",
      hasPriorDelivery: false
    });
    const result = validateActCompletion({
      decision: {
        assistantMessage: "好的，计划已确认。开始实施！正在获取数据。",
        toolCalls: [],
        endTurn: true,
        goalCompleted: true,
        completedTaskIds: ["T1"],
        completionEvidence: [{ taskId: "T1", toolCallId: "read-empty", kind: "observation" }]
      },
      planTasks,
      successfulEvidence: [observation]
    });

    expect(result.valid).toBe(false);
    expect(result.missingDelivery).toBe(true);
    expect(result.missingVerification).toBe(true);
    expect(result.reasons).toContain("The assistant message is progress commentary, not a final summary.");
  });

  it("accepts completed plan tasks backed by verified delivery and verification calls", () => {
    const delivery = classifySuccessfulToolEvidence({
      toolCallId: "patch-1",
      toolRecordId: "record-patch-1",
      toolName: "apply_patch",
      hasPriorDelivery: false,
      requiresVerifiedPath: true,
      verifiedPaths: ["C:\\project\\index.html"]
    });
    const verification = classifySuccessfulToolEvidence({
      toolCallId: "test-1",
      toolName: "shell.exec",
      hasPriorDelivery: true
    });
    const result = validateActCompletion({
      decision: {
        assistantMessage: "游戏已经实现并通过测试。",
        toolCalls: [],
        endTurn: true,
        goalCompleted: true,
        completedTaskIds: ["T1"],
        completionEvidence: [
          { taskId: "T1", toolCallId: "record-patch-1", kind: "delivery" },
          { taskId: "T1", toolCallId: "test-1", kind: "verification" }
        ]
      },
      planTasks,
      successfulEvidence: [delivery, verification]
    });

    expect(result).toMatchObject({
      valid: true,
      missingTaskIds: [],
      missingEvidenceTaskIds: [],
      missingDelivery: false,
      missingVerification: false
    });
  });

  it("requires desktop and mobile browser evidence for frontend GPA work", () => {
    const delivery = classifySuccessfulToolEvidence({
      toolCallId: "patch-ui",
      toolName: "apply_patch",
      hasPriorDelivery: false,
      requiresVerifiedPath: true,
      verifiedPaths: ["C:\\project\\src\\App.tsx"]
    });
    const verification = classifySuccessfulToolEvidence({
      toolCallId: "assert-desktop",
      toolName: "browser.assert_page",
      hasPriorDelivery: true
    });
    const result = validateActCompletion({
      decision: {
        assistantMessage: "界面已实现，并通过桌面截图视觉检查。",
        toolCalls: [],
        endTurn: true,
        goalCompleted: true,
        completedTaskIds: ["T1"],
        completionEvidence: [
          { taskId: "T1", toolCallId: "patch-ui", kind: "delivery" },
          { taskId: "T1", toolCallId: "assert-desktop", kind: "verification" }
        ]
      },
      planTasks,
      successfulEvidence: [delivery, verification],
      browserVerification: {
        desktopOnly: false,
        canvasRequired: false,
        desktopAssertionCount: 1,
        mobileAssertionCount: 0,
        desktopScreenshotCount: 1,
        mobileScreenshotCount: 0,
        screenshotAttachmentCount: 1,
        modelSupportsMultimodalInput: true
      }
    });

    expect(result.valid).toBe(false);
    expect(result.missingBrowserVerification).toEqual(["mobile page assertions", "mobile screenshot"]);
  });

  it("accepts deterministic browser verification for a non-multimodal model when disclosed", () => {
    const delivery = classifySuccessfulToolEvidence({
      toolCallId: "patch-ui",
      toolName: "apply_patch",
      hasPriorDelivery: false,
      requiresVerifiedPath: true,
      verifiedPaths: ["C:\\project\\index.html"]
    });
    const verification = classifySuccessfulToolEvidence({
      toolCallId: "assert-page",
      toolName: "browser.assert_page",
      hasPriorDelivery: true
    });
    const result = validateActCompletion({
      decision: {
        assistantMessage: "页面实现并通过确定性断言。未执行视觉模型检查（model_not_multimodal）。",
        toolCalls: [],
        endTurn: true,
        goalCompleted: true,
        completedTaskIds: ["T1"],
        completionEvidence: [
          { taskId: "T1", toolCallId: "patch-ui", kind: "delivery" },
          { taskId: "T1", toolCallId: "assert-page", kind: "verification" }
        ]
      },
      planTasks,
      successfulEvidence: [delivery, verification],
      browserVerification: {
        desktopOnly: false,
        canvasRequired: false,
        desktopAssertionCount: 1,
        mobileAssertionCount: 1,
        desktopScreenshotCount: 1,
        mobileScreenshotCount: 1,
        screenshotAttachmentCount: 0,
        modelSupportsMultimodalInput: false,
        visualSkippedReason: "model_not_multimodal"
      }
    });

    expect(result.valid).toBe(true);
  });

  it("does not count a file mutation as delivery when its target path was not verified", () => {
    const delivery = classifySuccessfulToolEvidence({
      toolCallId: "patch-missing",
      toolName: "apply_patch",
      hasPriorDelivery: false,
      requiresVerifiedPath: true,
      verifiedPaths: []
    });

    expect(delivery.kinds).not.toContain("delivery");
  });

  it("rejects unknown or mismatched evidence references", () => {
    const result = validateActCompletion({
      decision: {
        assistantMessage: "任务已完成。",
        toolCalls: [],
        endTurn: true,
        goalCompleted: true,
        completedTaskIds: ["T1"],
        completionEvidence: [{ taskId: "T1", toolCallId: "missing", kind: "delivery" }]
      },
      planTasks,
      successfulEvidence: []
    });

    expect(result.valid).toBe(false);
    expect(result.invalidEvidenceToolCallIds).toEqual(["missing"]);
    expect(result.missingEvidenceTaskIds).toEqual(["T1"]);
  });

  it("builds a concrete next step instead of accepting progress prose", () => {
    const result = validateActCompletion({
      decision: {
        assistantMessage: "接下来我会创建文件。",
        toolCalls: [],
        endTurn: true,
        goalCompleted: true
      },
      planTasks,
      successfulEvidence: []
    });
    const instruction = buildActCompletionRecoveryInstruction(result);

    expect(isProgressOnlyAssistantMessage("<event type=\"commentary\">正在读取文件</event>")).toBe(true);
    expect(isProgressOnlyAssistantMessage("任务已经完成并通过全部测试。")).toBe(false);
    expect(instruction).toContain("Call the next delivery tool now");
    expect(instruction).toContain("completed_task_ids");
  });
});

describe("GPA plan validation", () => {
  it("extracts visible task lines before allowing a PLAN confirmation", () => {
    expect(parseGpaPlanTasks("T1: Create the game board\nT2: Add battle actions")).toEqual([
      { id: "T1", title: "Create the game board", done: false },
      { id: "T2", title: "Add battle actions", done: false }
    ]);
  });

  it("prefers Markdown T-task headings over numbered acceptance criteria", () => {
    const content = [
      "### T1: 获取宝可梦图鉴数据",
      "### T2: 实现属性克制表",
      "## 验收标准",
      "1. 图鉴中可查看 151 只宝可梦",
      "2. 对战支持属性克制"
    ].join("\n");

    expect(parseGpaPlanTasks(content)).toEqual([
      { id: "T1", title: "获取宝可梦图鉴数据", done: false },
      { id: "T2", title: "实现属性克制表", done: false }
    ]);
  });

  it("promotes numbered unresolved PLAN questions into four input-card questions", () => {
    const content = [
      "⏳ 请确认计划：特别需要确认：",
      "1. 技术栈是否同意使用纯前端 HTML/CSS/JS？",
      "2. 数据范围是否只限初代 151 只？",
      "3. 队伍选择是「玩家 vs AI」还是「玩家 vs 玩家（同屏）」？",
      "4. 是否需要添加宝可梦配招（技能）系统，还是简化为「使用本系最强攻击」？"
    ].join("\n");
    const questions = buildGpaTextClarificationQuestions("plan", content);

    expect(questions).toHaveLength(4);
    expect(questions[0]).toMatchObject({
      prompt: "技术栈是否同意使用纯前端 HTML/CSS/JS？",
      options: [expect.objectContaining({ id: "yes" }), expect.objectContaining({ id: "no" })]
    });
    expect(questions[2]?.options?.map((option) => option.label)).toEqual([
      "玩家 vs AI",
      "玩家 vs 玩家（同屏）"
    ]);
    expect(questions[3]?.options?.map((option) => option.label)).toEqual([
      "添加宝可梦配招（技能）系统",
      "使用本系最强攻击"
    ]);
  });

  it("does not promote an ordinary PLAN confirmation without explicit questions", () => {
    expect(
      buildGpaTextClarificationQuestions("plan", "请确认计划，确认后进入执行阶段。")
    ).toEqual([]);
  });

  it("rejects prose that does not contain an executable task list", () => {
    expect(parseGpaPlanTasks("I will create a complete game and test it.")).toEqual([]);
  });

  it("does not restore a stale PLAN confirmation without plan tasks", () => {
    expect(
      parseGpaState(JSON.stringify({
        stage: "plan",
        fullAccess: false,
        awaitingConfirmation: "plan",
        planTasks: [],
        updatedAt: "2026-07-13T12:20:20.652Z"
      }))
    ).toMatchObject({ stage: "plan", awaitingConfirmation: null, planTasks: [] });
  });
});

describe("GPA user-input tool batches", () => {
  it("keeps only the user-input call while a turn is waiting", () => {
    const calls = [
      { id: "read", name: "fs.read_directory", arguments: { path: "." } },
      { id: "input", name: "request_user_input", arguments: { title: "Choose" } },
      { id: "patch", name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** End Patch" } }
    ];

    expect(prioritizeUserInputToolCall(calls)).toEqual([calls[1]]);
  });

  it("does not change a regular native tool batch", () => {
    const calls = [
      { id: "read", name: "fs.read_directory", arguments: { path: "." } },
      { id: "search", name: "code.search", arguments: { pattern: "TODO" } }
    ];

    expect(prioritizeUserInputToolCall(calls)).toBe(calls);
  });
});

describe("strategy switching", () => {
  it("blocks the same failed patch and directs the model to inspect before a different patch", () => {
    const instruction = buildStrategySwitchInstruction({
      toolName: "apply_patch",
      taskKey: "apply_patch:src/app.ts",
      attempts: 2,
      lastError: "Patch context did not match"
    });

    expect(instruction).toContain("will not execute");
    expect(instruction).toContain("Inspect the target file");
    expect(instruction).toContain("materially different");
  });

  it("uses a different diagnostic route after a failed file read", () => {
    const instruction = buildStrategySwitchInstruction({
      toolName: "fs.read_file",
      taskKey: "fs.read_file:missing.ts",
      attempts: 2,
      lastError: "ENOENT"
    });

    expect(instruction).toContain("fs.read_directory");
    expect(instruction).toContain("corrected path");
  });
});

describe("failure recovery messages", () => {
  it("gives a concrete recovery path for repeated executable failures", () => {
    const message = buildRepeatedTaskRecoveryMessage({
      taskKey: "apply_patch:src/app.ts",
      attempts: 5,
      lastError: "Permission denied"
    });

    expect(message).toContain("建议");
    expect(message).toContain("权限");
    expect(message).toContain("重新发送任务");
  });

  it("gives an actionable recovery path for runtime errors", () => {
    const message = buildRuntimeFailureRecoveryMessage(new Error("Invalid workspace path"));

    expect(message).toContain("项目路径");
    expect(message).toContain("重新提交");
  });
});

describe("GPA access state", () => {
  it("persists full access independently from the GPA stage", () => {
    expect(
      parseGpaState(
        JSON.stringify({
          stage: "off",
          fullAccess: true,
          awaitingConfirmation: null,
          planTasks: [],
          updatedAt: "2026-01-01T00:00:00.000Z"
        })
      )
    ).toMatchObject({ stage: "off", fullAccess: true });
  });

  it("defaults full access to disabled for existing tasks", () => {
    expect(parseGpaState(null).fullAccess).toBe(false);
  });
});

describe("multimodal intent classification", () => {
  it("parses plain intent JSON and fenced payloads", () => {
    expect(
      parseMultimodalIntentClassification(
        '{"intent":"image","prompt":"生成一张二次元美女跳舞的图片"}'
      )
    ).toEqual({
      intent: "image",
      prompt: "生成一张二次元美女跳舞的图片",
      parseOk: true
    });

    expect(
      parseMultimodalIntentClassification(`\`\`\`json
{"intent":"video","prompt":"美女跳舞"}
\`\`\``)
    ).toEqual({
      intent: "video",
      prompt: "美女跳舞",
      parseOk: true
    });
  });

  it("treats missing prompt or invalid payload as none without crashing", () => {
    expect(parseMultimodalIntentClassification('{"intent":"image","prompt":""}')).toEqual({
      intent: "none",
      prompt: "",
      parseOk: false
    });
    expect(parseMultimodalIntentClassification("今天星期几")).toEqual({
      intent: "none",
      prompt: "",
      parseOk: false
    });
    expect(parseMultimodalIntentClassification('{"intent":"none","prompt":""}')).toEqual({
      intent: "none",
      prompt: "",
      parseOk: true
    });
  });

  it("parses intent JSON that previously would be swallowed by Agent decision parsing", () => {
    const raw = '{"intent":"image","prompt":"生成一张二次元美女跳舞的图片"}';
    // Simulate provider parse keeping lightweight JSON as assistant text
    expect(parseMultimodalIntentClassification(raw)).toEqual({
      intent: "image",
      prompt: "生成一张二次元美女跳舞的图片",
      parseOk: true
    });
  });

  it("repairs malformed model intent JSON before validating its fields", () => {
    expect(parseMultimodalIntentClassification("{intent: 'image', prompt: 'city skyline',}")).toEqual({
      intent: "image",
      prompt: "city skyline",
      parseOk: true
    });
    expect(parseMultimodalIntentClassification("{intent: 'video', prompt: 'short clip'")).toEqual({
      intent: "video",
      prompt: "short clip",
      parseOk: true
    });
  });
});
