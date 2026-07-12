import type { GpaStage, GpaState, ProviderTurnDecision } from "@shared-types";

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
    return {
      stage,
      fullAccess: parsed.fullAccess === true,
      knowledgeEnabled: parsed.knowledgeEnabled === true,
      awaitingConfirmation: parsed.awaitingConfirmation ?? null,
      planTasks: Array.isArray(parsed.planTasks) ? parsed.planTasks : [],
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
      "6) 停止并上报：需求变更/范围蔓延、技术方案不可行/阻塞、自检未通过且无法自行修复、需要用户做选型/优先级决策。"
    ].join("\n")
  };

  const analysisClarificationRule = state.stage === "goal" || state.stage === "plan"
    ? "\nFor GPA analysis, never leave a material unresolved choice only in assistant_message. If technology, scope, priority, irreversible impact, or acceptance criteria is not specified or needs confirmation, return the structured clarification field before asking the user to confirm the goal or plan."
    : "";
  const actClarificationRule = state.stage === "act"
    ? "\n7) Before any write, command, or external side effect, if a decision cannot be verified with the available context or tools and would affect the approach, scope, priority, irreversible actions, or acceptance criteria, return the structured clarification field. Ask exactly one mutually exclusive decision with 2-4 options, a recommended option, and concise descriptions. Set tool_calls to [] and end_turn to false. Never ask for facts that tools can determine. After an answer, revise the remaining PLAN before resuming ACT; after a skip, continue under the current plan and state the assumption in the final summary."
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

/** Converts explicit prose about unresolved GPA decisions into a safe input card. */
export function buildGpaTextClarificationFallback(
  stage: GpaStage,
  assistantMessage: string | undefined
): ProviderTurnDecision["clarification"] | undefined {
  if ((stage !== "goal" && stage !== "plan") || !assistantMessage) {
    return undefined;
  }

  const text = assistantMessage.replace(/\s+/g, " ");
  const hasUnresolvedDecision =
    /(?:\u672a\u6307\u5b9a|\u672a\u660e\u786e|\u672a\u786e\u8ba4|\u5f85\u786e\u8ba4|\u9700\u8981(?:\u5148)?(?:\u786e\u8ba4|\u660e\u786e|\u8865\u5145)|\u9700\u8981\u4f60\u786e\u8ba4|\u9700\u8981\u4f60\u8865\u5145|\u5173\u952e(?:\u95ee\u9898|\u4fe1\u606f|\u51b3\u7b56)|(?:need|needs|require|requires)\s+(?:your\s+)?(?:confirmation|input|decision)|(?:not\s+specified|to\s+be\s+confirmed))/i.test(text);
  if (!hasUnresolvedDecision) {
    return undefined;
  }

  const isTechnical = /(?:\u6280\u672f\u6808|\u524d\u7aef|\u540e\u7aef|\u6570\u636e\u5e93|\u67b6\u6784|framework|database|stack)/i.test(text);
  return isTechnical
    ? {
        title: "\u6280\u672f\u65b9\u6848\u5f85\u786e\u8ba4",
        question: "\u5f53\u524d\u76ee\u6807\u6216\u8ba1\u5212\u5305\u542b\u672a\u6307\u5b9a\u7684\u6280\u672f\u65b9\u6848\u3002\u8bf7\u8bf4\u660e\u4f60\u7684\u504f\u597d\uff0c\u6216\u9009\u62e9\u4e00\u4e2a\u7ee7\u7eed\u65b9\u5f0f\u3002",
        options: [
          { id: "provide_requirements", label: "\u6211\u6765\u6307\u5b9a\u6280\u672f\u6808", description: "\u586b\u5199\u524d\u7aef\u3001\u540e\u7aef\u3001\u6570\u636e\u5e93\u6216\u90e8\u7f72\u8981\u6c42\u3002", recommended: true },
          { id: "web_mvp", label: "\u6309\u901a\u7528 Web MVP \u5b9e\u73b0", description: "\u4f7f\u7528\u6210\u719f\u7684 Web \u6280\u672f\u6808\uff0c\u4f18\u5148\u4ea4\u4ed8\u53ef\u8fd0\u884c\u7248\u672c\u3002" },
          { id: "prototype", label: "\u5148\u505a\u672c\u5730\u6f14\u793a\u7248", description: "\u4ec5\u5b9e\u73b0\u6838\u5fc3\u754c\u9762\u548c\u6d41\u7a0b\uff0c\u4e0d\u63a5\u5165\u771f\u5b9e\u670d\u52a1\u3002" }
        ],
        allowFreeText: true
      }
    : {
        title: "\u5173\u952e\u9700\u6c42\u5f85\u786e\u8ba4",
        question: "\u5f53\u524d\u76ee\u6807\u6216\u8ba1\u5212\u5b58\u5728\u4f1a\u5f71\u54cd\u8303\u56f4\u6216\u9a8c\u6536\u7684\u672a\u51b3\u9879\u3002\u8bf7\u8865\u5145\u4f60\u7684\u8981\u6c42\uff0c\u6216\u9009\u62e9\u7ee7\u7eed\u65b9\u5f0f\u3002",
        options: [
          { id: "provide_requirements", label: "\u6211\u6765\u8865\u5145\u8981\u6c42", description: "\u8bf4\u660e\u8303\u56f4\u3001\u4f18\u5148\u7ea7\u6216\u9a8c\u6536\u6807\u51c6\u3002", recommended: true },
          { id: "recommended_scope", label: "\u6309\u63a8\u8350\u8303\u56f4\u89c4\u5212", description: "\u4f18\u5148\u5b8c\u6210\u6838\u5fc3\u529f\u80fd\u548c\u53ef\u9a8c\u8bc1\u4ea4\u4ed8\u7269\u3002" },
          { id: "continue_assumptions", label: "\u6309\u9ed8\u8ba4\u5047\u8bbe\u7ee7\u7eed", description: "\u7531 Agent \u8bb0\u5f55\u5408\u7406\u5047\u8bbe\u540e\u7ee7\u7eed\u3002" }
        ],
        allowFreeText: true
      };
}
