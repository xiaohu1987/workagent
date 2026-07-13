import type { GpaStage, GpaState, UserInputOption, UserInputQuestion } from "@shared-types";

export const DEFAULT_GPA_STATE: GpaState = {
  stage: "off",
  fullAccess: false,
  knowledgeEnabled: false,
  awaitingConfirmation: null,
  planTasks: [],
  updatedAt: new Date(0).toISOString()
};

const STAGE_LABELS: Record<GpaStage, string> = {
  off: "关闭",
  goal: "目标 GOAL",
  plan: "计划 PLAN",
  act: "执行 ACT"
};

export function gpaStageLabel(stage: GpaStage): string {
  return STAGE_LABELS[stage];
}

export function parseGpaState(json: string | null | undefined): GpaState {
  if (!json) {
    return { ...DEFAULT_GPA_STATE, updatedAt: new Date().toISOString() };
  }
  try {
    const parsed = JSON.parse(json) as Partial<GpaState>;
    const stage: GpaStage =
      parsed.stage === "goal" || parsed.stage === "plan" || parsed.stage === "act"
        ? parsed.stage
        : "off";
    const planTasks = Array.isArray(parsed.planTasks) ? parsed.planTasks : [];
    // A PLAN confirmation is meaningful only after a visible, parsed task list
    // has been persisted. Clear stale states written by older runtimes.
    const awaitingConfirmation =
      parsed.awaitingConfirmation === "plan" && planTasks.length === 0
        ? null
        : parsed.awaitingConfirmation ?? null;
    return {
      stage,
      fullAccess: parsed.fullAccess === true,
      knowledgeEnabled: parsed.knowledgeEnabled === true,
      awaitingConfirmation,
      planTasks,
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    };
  } catch {
    return { ...DEFAULT_GPA_STATE, updatedAt: new Date().toISOString() };
  }
}

/**
 * GOAL / PLAN 阶段是纯分析与规划阶段，严禁任何工具调用（代码级强制）。
 * ACT 阶段与关闭状态才允许工具执行。
 */
export function gpaStageAllowsTools(state: GpaState): boolean {
  return state.stage === "off" || state.stage === "act";
}

export function buildGpaSystemDirective(state: GpaState): string {
  if (state.stage === "off") {
    return "";
  }

  const header = `你正在运行 GPA（Goal-Plan-Act）工作流，当前阶段为【${gpaStageLabel(
    state.stage
  )}】。严格遵守 doc/GPA.md 的核心铁律：阶段不可跳、执行不可超、异常不可瞒、质量不可降、用户不可绕。`;

  const rules: Record<Exclude<GpaStage, "off">, string> = {
    goal: [
      "【GOAL 目标解析】只做分析：不写代码、不创建/修改文件、不调用任何工具、不假设未明确的信息。",
      "1) 用一句话清晰重述用户真实目标，消除歧义；",
      "2) 列出 3-5 条可量化的成功标准（必须能用「是/否」验证）；",
      "3) 识别约束：技术栈、时间/资源、输出格式、明确排除的范围（什么不做）；",
      "4) 若信息不足，提出 ≤3 个澄清问题；",
      "5) 结尾必须输出：⏳ 请确认目标，或补充信息后进入计划阶段。"
    ].join("\n"),
    plan: [
      "【PLAN 计划拆解】只做规划：不实际执行任何代码或文件操作，不调用工具。",
      "1) 将目标拆分为原子任务（单一职责、可独立完成、有明确交付物）；",
      "2) 每个任务包含：ID（T1/T2…）、名称（动词开头）、动作、交付物、依赖、验收标准、工作量（小 ≤30min / 中 ≤2h / 大 >2h）；",
      "3) 标注关键路径与可并行任务；",
      "4) 识别风险点及应对预案；",
      "5) 结尾必须输出：⏳ 请确认计划，或提出修改意见。"
    ].join("\n"),
    act: [
      "【ACT 执行与反馈】按计划范围执行，不擅自扩展。",
      "1) 准备：检查前置任务是否完成，确认工具/环境/数据就绪，条件不满足立即停止并上报；",
      "2) 执行：每次只执行当前一个任务；编写代码遵循单一职责、清晰命名、必要注释；",
      "3) 自检：对照验收标准逐项检查（标准1 ✅/❌ …），不达标不得标完成；",
      "4) 记录：输出 `✅ 任务 {ID} 完成`、交付物摘要、遇到的问题与解决方案、对后续任务的影响；",
      "5) 汇报：输出当前任务结果与下一步计划；如需用户决策，列出明确选项；",
      "6) 停止并上报：需求变更/范围蔓延、技术方案不可行/阻塞、自检未通过且无法自行修复、需要用户做选型/优先级决策。",
      "7) 最终完成时必须返回 completed_task_ids，覆盖已确认 PLAN 的全部任务；completion_evidence 必须按任务引用真实成功的 tool_call_id，并区分 observation、delivery、verification。没有交付和验证证据时不得声明 goal_completed。"
    ].join("\n")
  };

  const analysisClarificationRule = state.stage === "goal" || state.stage === "plan"
    ? "\nFor GPA analysis, the only permitted tool is request_user_input. If technology, scope, priority, irreversible impact, or acceptance criteria cannot be safely resolved from the available context, call request_user_input once with one to three short questions and options. Do not put questions in assistant_message and do not use a clarification field. After its tool result, incorporate every answer and continue the same analysis stage."
    : "";
  const actClarificationRule = state.stage === "act"
    ? "\n7) Before any write, command, or external side effect, if a material decision cannot be verified with the available context or tools, call request_user_input with one to three concise questions and options. Never ask for facts that tools can determine. After its tool result, continue from the verified context; revise the plan only when the answers materially change it."
    : "";
  return `${header}\n\n${rules[state.stage]}${analysisClarificationRule}${actClarificationRule}`;
}

/** 识别用户以简短确认语推进阶段（与「确认」按钮的长指令区分，避免误触发） */
export function detectGpaConfirmation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return /^(确认|好的|好耶|ok|okay|开始|继续|yes|go|可以|批准|同意|done|继续吧|没问题|收到|行)/i.test(trimmed);
}

export function nextStageAfterConfirmation(stage: GpaStage): GpaStage {
  if (stage === "goal") {
    return "plan";
  }
  if (stage === "plan") {
    return "act";
  }
  return stage;
}

/** Extracts user-visible GPA plan tasks from the PLAN response. */
export function parseGpaPlanTasks(content: string): GpaState["planTasks"] {
  const tasks: GpaState["planTasks"] = [];
  const seenIds = new Set<string>();
  const lines = content.split(/\r?\n/);

  const appendTask = (idValue: string, titleValue: string) => {
    const id = idValue.toUpperCase();
    const title = titleValue
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .trim();
    if (!title || seenIds.has(id)) return;
    seenIds.add(id);
    tasks.push({ id, title: title.slice(0, 180), done: false });
  };

  // Prefer explicit T-ids, including Markdown headings such as `### T1:`.
  for (const line of lines) {
    const match = line.match(/^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(T\d+)\s*[:：.\-]\s*(.+?)\s*$/i);
    if (!match) continue;
    appendTask(match[1], match[2]);
    if (tasks.length >= 20) break;
  }

  // Keep compatibility with simple numbered plans, but never mix acceptance
  // criteria into a plan that already provided explicit T-ids.
  if (tasks.length === 0) {
    for (const line of lines) {
      const match = line.match(/^\s*(?:[-*+]\s*)?(\d+)\s*[.)、]\s*(.+?)\s*$/);
      if (!match) continue;
      appendTask(`T${match[1]}`, match[2]);
      if (tasks.length >= 20) break;
    }
  }

  return tasks;
}

function clarificationOptions(question: string): UserInputOption[] {
  const addOrSimplify = question.match(
    /是否(?:需要)?(.+?)[，,]\s*还是(?:简化为)?\s*[「“"]?(.+?)[」”"]?\s*[？?]$/
  );
  if (addOrSimplify) {
    return [
      { id: "option_1", label: addOrSimplify[1].trim(), recommended: true },
      { id: "option_2", label: addOrSimplify[2].trim() }
    ];
  }

  const eitherOr = question.match(
    /(?:选择是|采用|是)\s*[「“"]?(.+?)[」”"]?\s*还是\s*[「“"]?(.+?)[」”"]?\s*[？?]$/
  );
  if (eitherOr) {
    return [
      { id: "option_1", label: eitherOr[1].trim(), recommended: true },
      { id: "option_2", label: eitherOr[2].trim() }
    ];
  }

  const yesOrNo = question.match(/是否(.+?)[？?]$/);
  if (yesOrNo) {
    const proposal = yesOrNo[1].trim();
    return [
      {
        id: "yes",
        label: proposal.startsWith("同意") ? proposal : `是，${proposal.replace(/^只限/, "仅限")}`,
        recommended: true
      },
      { id: "no", label: "否，我来指定其他方案" }
    ];
  }

  return [
    { id: "recommended", label: "按推荐方案继续", recommended: true },
    { id: "custom", label: "我来补充具体要求" }
  ];
}

/** Promotes numbered questions embedded in GOAL/PLAN prose into input cards. */
export function buildGpaTextClarificationQuestions(
  stage: GpaStage,
  assistantMessage: string | undefined
): UserInputQuestion[] {
  if ((stage !== "goal" && stage !== "plan") || !assistantMessage) {
    return [];
  }
  if (!/(?:特别需要确认|需要确认|请确认以下|待确认|需要你确认|需要您确认)/i.test(assistantMessage)) {
    return [];
  }

  const questions = assistantMessage
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(?:[-*+]\s*)?(?:\d+[.、)]\s*)?(.{3,}?[？?])\s*$/);
      return match ? [match[1].trim()] : [];
    })
    .slice(0, 4);

  return questions.map((question, index) => ({
    id: `gpa_text_clarification_${index + 1}`,
    label: question.replace(/[？?]$/, "").slice(0, 48),
    prompt: question,
    options: clarificationOptions(question),
    allowFreeText: true
  }));
}

export function canEnterGpaAct(state: GpaState): boolean {
  return state.stage === "plan" && state.planTasks.length > 0;
}
