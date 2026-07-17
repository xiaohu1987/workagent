import * as cheerio from "cheerio";
import type { GpaStage, GpaState, UserInputOption, UserInputQuestion } from "@shared-types";

export const DEFAULT_GPA_STATE: GpaState = {
  stage: "off",
  fullAccess: false,
  knowledgeEnabled: false,
  awaitingConfirmation: null,
  confirmationExpiresAt: null,
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
    const planTasks = normalizeSequentialPlanTasks(
      Array.isArray(parsed.planTasks) ? parsed.planTasks : []
    );
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
      // GPA confirmations wait for an explicit user decision. Ignore deadlines
      // persisted by older versions so a restored plan cannot auto-continue.
      confirmationExpiresAt: null,
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

/**
 * GPA plans execute in order. A completed task can only advance the first
 * unfinished item, preventing later tasks from bypassing their prerequisites.
 */
export function applyCompletedPlanTasks(state: GpaState, completedTaskIds: string[]): GpaState {
  if (!completedTaskIds.length || !state.planTasks.length) {
    return state;
  }
  const completed = new Set(
    completedTaskIds.map((id) => id.trim().toUpperCase()).filter(Boolean)
  );
  const currentTask = state.planTasks.find((task) => !task.done);
  if (!currentTask || !completed.has(currentTask.id.toUpperCase())) {
    return state;
  }
  let changed = false;
  const planTasks = state.planTasks.map((task) => {
    if (task.id !== currentTask.id || task.done) {
      return task;
    }
    changed = true;
    return { ...task, done: true };
  });
  return changed ? { ...state, planTasks } : state;
}

export function normalizeSequentialPlanTasks(tasks: GpaState["planTasks"]): GpaState["planTasks"] {
  let encounteredPendingTask = false;
  let changed = false;
  const normalized = tasks.map((task) => {
    if (!task.done) {
      encounteredPendingTask = true;
      return task;
    }
    if (!encounteredPendingTask) {
      return task;
    }
    changed = true;
    return { ...task, done: false };
  });
  return changed ? normalized : tasks;
}

export interface GpaCompletedTaskDeclaration {
  taskIds: string[];
  text: string;
}

/**
 * Finds explicit ACT progress statements such as `T1 completed` or
 * `任务 T2 和 T3 已完成`. Generic progress prose is intentionally ignored.
 *
 * Intentionally does NOT treat bare 实现/验证/处理 as completion — those words
 * appear in "开始实现…" / "剩余任务是验证…" and must not mark plan tasks done.
 */
export function parseGpaCompletedTaskDeclarations(
  content: string,
  planTasks: GpaState["planTasks"]
): GpaCompletedTaskDeclaration[] {
  if (!content.trim() || planTasks.length === 0) {
    return [];
  }

  const knownTaskIds = new Set(planTasks.map((task) => task.id.toUpperCase()));
  // Require an explicit "done" signal: completed/finished/done/implemented/verified,
  // or 完成/已完成/已实现/已验证. Bare 实现/验证 alone is too common in future-tense ACT prose.
  const completion =
    /(?:\b(?:complete(?:d)?|finished|done|implemented|verified)\b|(?:\u2705|\u2611\ufe0f?)|(?:\u5df2\s*)?(?:\u5b8c\u6210)|(?:\u5df2\s*(?:\u5b9e\u73b0|\u9a8c\u8bc1|\u5904\u7406)))/i;
  const negatedCompletion =
    /(?:(?:\u5c1a)?\u672a|\u672a\u80fd|not|incomplete|pending|todo|remaining|\u5269\u4f59)\s*(?:\u5b8c\u6210|\u5b9e\u73b0|\u9a8c\u8bc1|\u5904\u7406|\u4efb\u52a1|complete(?:d)?|finished|done|implemented|verified)?/i;
  const futureIntent =
    /(?:\u5f00\u59cb|\u51c6\u5907|\u5373\u5c06|\u63a5\u4e0b\u6765|\u8986\u76d6|\b(?:starting|going to|about to|will|covering|implementing|verifying)\b)/i;
  const declarations: GpaCompletedTaskDeclaration[] = [];

  for (const rawSegment of content.split(/[\r\n\u3002\uff01!?;\uff1b]+/)) {
    const text = rawSegment.trim();
    if (!text || !completion.test(text) || negatedCompletion.test(text) || futureIntent.test(text)) {
      continue;
    }
    const taskIds = [...text.matchAll(/\bT\s*(\d+)\b/gi)]
      .map((match) => `T${match[1]}`.toUpperCase())
      .filter((id, index, values) => knownTaskIds.has(id) && values.indexOf(id) === index);
    if (taskIds.length > 0) {
      declarations.push({ taskIds, text });
    }
  }

  return declarations;
}

export function buildGpaSystemDirective(
  state: GpaState,
  options?: { webFrontendTask?: boolean }
): string {
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
      "7) 每一轮 ACT decision 都必须包含 completed_task_ids：未完成新任务时返回 []；完成任务时返回累计已完成的全部任务 ID（不要攒到最后才一次性提交）。",
      "8) 当前计划项通过验收后，必须先提交包含该 ID 的 decision，才可以开始后续计划项。每个 decision 只能新增完成当前最早未完成的一个任务；不得跳过中间任务、提前标记收尾或验收任务完成。不要让文件操作或进度文案替代计划状态更新。",
      "9) 最终完成时必须返回 completed_task_ids，覆盖已确认 PLAN 的全部任务；completion_evidence 必须按任务引用真实成功的 tool_call_id，并区分 observation、delivery、verification。没有交付和验证证据时不得声明 goal_completed。"
    ].join("\n")
  };

  const analysisClarificationRule = state.stage === "goal" || state.stage === "plan"
    ? "\nFor GPA analysis, the only permitted tool is request_user_input. If technology, scope, priority, irreversible impact, or acceptance criteria cannot be safely resolved from the available context, call request_user_input once with one to three short questions and options. Do not put questions in assistant_message and do not use a clarification field. After its tool result, incorporate every answer and continue the same analysis stage."
    : "";
  const actClarificationRule = state.stage === "act"
    ? "\n9) Before any write, command, or external side effect, if a material decision cannot be verified with the available context or tools, call request_user_input with one to three concise questions and options. Never ask for facts that tools can determine. After its tool result, continue from the verified context; revise the plan only when the answers materially change it."
    : "";
  const webFrontendRule = state.stage === "act" && options?.webFrontendTask
    ? "\n【网页/前端任务约束】禁止用 Python（python -c / *.py）生成或改写 HTML/CSS/JS。请使用 apply_patch 或 fs.write_file。优先顺序建议：先用 fs/code 定位并写出改动，再按需预览验证；完成前须有浏览器断言/截图等验证证据。"
    : "";
  const planTaskIdContract = state.stage === "plan"
    ? "\n[PLAN task ID contract]\nEvery atomic task heading must use exactly `### T1: Task title`. Continue with T2, T3, and so on without gaps or duplicates. Start at T1. Do not create new numbered task lists in critical-path, risk, summary, or deliverable sections; reference the existing T-IDs inline instead. A PLAN that violates this format will be rejected and must be rewritten."
    : "";
  return `${header}\n\n${rules[state.stage]}${analysisClarificationRule}${actClarificationRule}${webFrontendRule}${planTaskIdContract}`;
}

/** GPA workflow is project-workspace only; chat threads may only turn it off. */
export function canStartGpaStage(
  threadMode: string | null | undefined,
  stage: GpaStage
): boolean {
  if (stage === "off") {
    return true;
  }
  return threadMode === "project";
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

export function parseCanonicalGpaPlanTasks(content: string): GpaState["planTasks"] {
  const tasks: GpaState["planTasks"] = [];
  const seenIds = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*###\s+(T\d+)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const id = match[1].toUpperCase();
    const title = match[2].replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!title || seenIds.has(id)) {
      return [];
    }
    seenIds.add(id);
    tasks.push({ id, title: title.slice(0, 180), done: false });
  }
  return tasks.length > 0 && tasks.every((task, index) => task.id === `T${index + 1}`)
    ? tasks
    : [];
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

  // Some models emit task headings without a colon, such as
  // `#### T1 Build the project skeleton`.
  for (const line of lines) {
    const match = line.match(
      /^\s*#{1,6}\s*(T\d+)(?:\s*[:\uFF1A-]\s*|\s+)(.+?)\s*$/i
    );
    if (!match) continue;
    appendTask(match[1], match[2]);
    if (tasks.length >= 20) break;
  }

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

  // Chinese labels such as `任务1：` / `步骤2：` used by some local models.
  if (tasks.length === 0) {
    for (const line of lines) {
      const match = line.match(
        /^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:任务|步骤|计划)\s*(\d+)\s*[:：.\-、]\s*(.+?)\s*$/i
      );
      if (!match) continue;
      appendTask(`T${match[1]}`, match[2]);
      if (tasks.length >= 20) break;
    }
  }

  return tasks;
}

export function reconcileGpaPlanTasks(
  currentTasks: GpaState["planTasks"],
  planBody: string
): GpaState["planTasks"] {
  const parsedTasks = parseGpaPlanTasks(planBody);
  if (parsedTasks.length <= currentTasks.length) {
    return currentTasks;
  }

  const completedStableTasks = new Set(
    currentTasks
      .filter((task) => task.done)
      .map((task) => `${task.id.toUpperCase()}\u0000${task.title.trim()}`)
  );
  return parsedTasks.map((task) => ({
    ...task,
    done: completedStableTasks.has(`${task.id.toUpperCase()}\u0000${task.title.trim()}`)
  }));
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

export interface EmbeddedRequestUserInput {
  title: string;
  questions: UserInputQuestion[];
  /** Assistant prose with the embedded XML/tool markup removed. */
  cleanedContent: string;
}

function splitOptionLabels(raw: string): string[] {
  return raw
    .split(/[、,，;/|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function readCheerioAttr(
  element: cheerio.Cheerio<cheerio.Element>,
  ...names: string[]
): string {
  for (const name of names) {
    const value = element.attr(name)?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

/**
 * Models sometimes paste `<request_user_input>` XML into assistant_message
 * instead of issuing a real tool call. Recover those into structured questions
 * with cheerio (tolerant HTML/XML fragment parsing).
 */
export function parseEmbeddedRequestUserInput(
  assistantMessage: string | undefined
): EmbeddedRequestUserInput | null {
  if (!assistantMessage || !/<request_user_input\b/i.test(assistantMessage)) {
    return null;
  }

  // Isolate the tool-shaped fragment so surrounding Markdown is not rewritten.
  const blockMatch = assistantMessage.match(
    /<request_user_input\b[\s\S]*?<\/request_user_input>/i
  );
  if (!blockMatch) {
    return null;
  }

  const $ = cheerio.load(blockMatch[0], {
    xml: {
      xmlMode: true,
      decodeEntities: true
    }
  });
  const root = $("request_user_input").first();
  if (root.length === 0) {
    return null;
  }

  const title = readCheerioAttr(root, "title") || "需要确认几个设计选项";
  const questions: UserInputQuestion[] = [];

  root.find("question").each((index, node) => {
    if (questions.length >= 4) {
      return false;
    }
    const question = $(node);
    const id = readCheerioAttr(question, "id") || `q${index + 1}`;
    const label = readCheerioAttr(question, "label") || `选项 ${index + 1}`;
    const prompt = readCheerioAttr(question, "prompt") || label;
    const nestedOptions = question
      .find("option")
      .toArray()
      .map((optionNode) => {
        const option = $(optionNode);
        return readCheerioAttr(option, "label") || option.text().trim();
      })
      .filter(Boolean);
    const optionLabels =
      nestedOptions.length > 0
        ? nestedOptions.slice(0, 4)
        : splitOptionLabels(readCheerioAttr(question, "options"));
    if (!prompt || optionLabels.length === 0) {
      return;
    }
    questions.push({
      id,
      label: label.slice(0, 48),
      prompt,
      options: optionLabels.map((optionLabel, optionIndex) => ({
        id: `option_${optionIndex + 1}`,
        label: optionLabel,
        recommended: optionIndex === 0
      })),
      allowFreeText: true
    });
  });

  if (questions.length === 0) {
    return null;
  }

  const cleanedContent = assistantMessage
    .replace(blockMatch[0], "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, questions, cleanedContent };
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

/**
 * PLAN often lists risks with predetermined mitigations and silent defaults.
 * Promote those into an explicit confirmation card so users can challenge them.
 */
export function buildGpaRiskClarificationQuestions(
  stage: GpaStage,
  assistantMessage: string | undefined
): UserInputQuestion[] {
  if (stage !== "plan" || !assistantMessage) {
    return [];
  }
  if (!/(?:风险点|⚠️\s*风险|风险\s*[&＆]\s*预案)/i.test(assistantMessage)) {
    return [];
  }

  const questions: UserInputQuestion[] = [];
  const defaultSection = assistantMessage.match(
    /技术选型[（(]?默认[）)]?[\s\S]{0,600}?(?=\n#{1,3}\s|\n---|\n```|$)/i
  )?.[0];
  if (defaultSection) {
    const defaults = [...defaultSection.matchAll(/^\s*[-*+]\s*\*\*(.+?)\*\*\s*[:：]\s*(.+?)\s*$/gm)]
      .map((match) => ({ label: match[1].trim(), value: match[2].replace(/\*\*/g, "").trim() }))
      .filter((item) => item.label && item.value)
      .slice(0, 3);
    for (const [index, item] of defaults.entries()) {
      questions.push({
        id: `gpa_default_${index + 1}`,
        label: item.label.slice(0, 48),
        prompt: `${item.label}是否按默认「${item.value}」执行？`,
        options: [
          { id: "accept", label: `是，采用「${item.value}」`, recommended: true },
          { id: "custom", label: "否，我来指定其他方案" }
        ],
        allowFreeText: true
      });
    }
  }

  const riskRows = [...assistantMessage.matchAll(
    /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm
  )]
    .map((match) => ({
      risk: match[1].replace(/\*\*/g, "").trim(),
      impact: match[2].replace(/\*\*/g, "").trim(),
      plan: match[3].replace(/\*\*/g, "").replace(/`/g, "").trim()
    }))
    .filter((row) =>
      row.risk &&
      row.plan &&
      !/^(?:-+:?|风险|影响|预案)$/i.test(row.risk) &&
      !/^(?:-+:?|影响)$/i.test(row.impact)
    )
    .slice(0, 2);

  if (riskRows.length > 0 && questions.length < 4) {
    const summary = riskRows
      .map((row) => `${row.risk} → ${row.plan}`)
      .join("；");
    questions.push({
      id: "gpa_risk_mitigation",
      label: "风险应对预案",
      prompt: `是否接受以下风险应对预案？${summary}`,
      options: [
        { id: "accept", label: "接受这些预案，按此执行", recommended: true },
        { id: "revise", label: "需要调整风险应对方案" }
      ],
      allowFreeText: true
    });
  }

  return questions.slice(0, 4);
}

export function canEnterGpaAct(state: GpaState): boolean {
  return state.stage === "plan" && state.planTasks.length > 0;
}
