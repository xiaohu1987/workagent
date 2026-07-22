import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AppConfig,
  ModelProfile,
  ProviderDefinition,
  RuntimeToolCall,
  SkillMetadata,
  ToolSpecDefinition
} from "@shared-types";
import { modelJsonCandidates, tryParseModelJson } from "@shared-types";
import { McpManager, type McpToolDescriptor } from "@mcp-runtime";
import { ProviderFactory } from "@provider-adapters";
import matter from "gray-matter";
import {
  SkillsManager,
  normalizeUserSkillName,
  parseUserWorkflowDraft,
  renderUserWorkflowSkill
} from "@skills-runtime";

export const SKILL_LAB_ITERATIONS = 5;
export const SKILL_LAB_MIN_ITERATIONS = 1;
export const SKILL_LAB_MAX_ITERATIONS = 20;
const SKILL_LAB_MAX_TOOL_TURNS = 24;

export type SkillLabEvent =
  | {
      type: "skill-lab.progress";
      jobId: string;
      iteration: number;
      totalIterations: number;
      phase: string;
      summary: string;
      state: "running" | "tested";
    }
  | {
      type: "skill-lab.approval";
      jobId: string;
      approvalId: string;
      title: string;
      description: string;
      toolName: string;
    }
  | {
      type: "skill-lab.clarification";
      jobId: string;
      clarificationId: string;
      summary: string;
      questions: Array<{ id: string; question: string; required: boolean; options: string[]; allowOther: boolean }>;
    }
  | { type: "skill-lab.completed"; jobId: string; skill: SkillMetadata }
  | { type: "skill-lab.failed"; jobId: string; error: string }
  | { type: "skill-lab.cancelled"; jobId: string };

type SkillLabJob = {
  abort: AbortController;
  approvals: Map<string, (approved: boolean) => void>;
  clarifications: Map<string, (answers: Record<string, string> | null) => void>;
};

type SkillLabServices = {
  config: AppConfig;
  providerFactory: ProviderFactory;
  skills: SkillsManager;
  mcp: McpManager;
  skillsDraftsDir: string;
  refreshSkills: () => Promise<void>;
  listSkills: () => SkillMetadata[];
  emit: (event: SkillLabEvent) => void;
};

type McpToolEntry = {
  descriptor: McpToolDescriptor;
  spec: ToolSpecDefinition;
  readOnly: boolean;
};

type McpResourceEntry = {
  server: string;
  uri: string;
  name: string;
  description: string;
};

type SkillLabIteration = {
  draft: { name: string; description: string; workflow: string };
  qualityIssues: string[];
  changes: string[];
  nextGoal: string;
};

type SkillLabTestResult = {
  name: string;
  passed: boolean;
  detail: string;
};

type SkillLabClarification = {
  summary: string;
  questions: Array<{ id: string; question: string; required: boolean; options: string[]; allowOther: boolean }>;
};

type SkillLabOptimizationTarget = {
  skill: SkillMetadata;
  draft: SkillLabIteration["draft"];
  source: string;
};

export class SkillLabService {
  readonly #services: SkillLabServices;
  readonly #jobs = new Map<string, SkillLabJob>();

  public constructor(services: SkillLabServices) {
    this.#services = services;
  }

  public start(prompt: string, requestedName?: string, iterations?: number, targetSkillId?: string): string {
    const normalizedPrompt = prompt.trim() || (targetSkillId ? "继续测试并优化现有 Skill。" : "");
    if (!normalizedPrompt) throw new Error("技能实验室需求不能为空。");
    if (normalizedPrompt.length > 20_000) throw new Error("技能实验室需求不能超过 20000 个字符。");
    const iterationCount = normalizeIterationCount(iterations);
    const jobId = randomUUID();
    const job: SkillLabJob = { abort: new AbortController(), approvals: new Map(), clarifications: new Map() };
    this.#jobs.set(jobId, job);
    void this.#run(jobId, job, normalizedPrompt, requestedName, iterationCount, targetSkillId).finally(() => {
      this.#jobs.delete(jobId);
    });
    return jobId;
  }

  public cancel(jobId: string): void {
    const job = this.#jobs.get(jobId);
    if (!job) return;
    job.abort.abort();
    for (const resolve of job.approvals.values()) resolve(false);
    job.approvals.clear();
    for (const resolve of job.clarifications.values()) resolve(null);
    job.clarifications.clear();
  }

  public resolveApproval(jobId: string, approvalId: string, approved: boolean): void {
    const job = this.#jobs.get(jobId);
    const resolve = job?.approvals.get(approvalId);
    if (!resolve) return;
    job!.approvals.delete(approvalId);
    resolve(approved);
  }

  public resolveClarification(jobId: string, clarificationId: string, answers: Record<string, string>): void {
    const job = this.#jobs.get(jobId);
    const resolve = job?.clarifications.get(clarificationId);
    if (!resolve) return;
    job!.clarifications.delete(clarificationId);
    resolve(answers);
  }

  async #run(
    jobId: string,
    job: SkillLabJob,
    prompt: string,
    requestedName: string | undefined,
    iterationCount: number,
    targetSkillId?: string
  ): Promise<void> {
    try {
      const { provider, model } = resolveDefaultReasoningModel(this.#services.config);
      const optimizationTarget = targetSkillId ? await this.#loadOptimizationTarget(targetSkillId) : null;
      const clarificationPrompt = optimizationTarget
        ? [
            `用户对现有 Skill 的优化要求：\n${prompt}`,
            `当前 Skill：\n${renderUserWorkflowSkill(optimizationTarget.draft)}`
          ].join("\n\n")
        : prompt;
      prompt = await this.#clarifyRequirement(jobId, job, provider, model, clarificationPrompt);
      this.#assertNotAborted(job);
      const mcpTools = await this.#loadMcpTools();
      const mcpResources = await this.#services.mcp.listResources() as McpResourceEntry[];
      const skillCatalog = this.#services.skills.list()
        .filter((skill) => !skill.pluginId)
        .map((skill) => ({ id: skill.id, name: skill.qualifiedName, description: skill.description }));
      const availableTools = [
        buildSkillLoadSpec(),
        buildMcpListResourcesSpec(),
        buildMcpReadResourceSpec(),
        ...mcpTools.map((entry) => entry.spec)
      ];
      let draft: { name: string; description: string; workflow: string };
      let previousTests: SkillLabTestResult[];
      let transcript: Array<{
        role: "user" | "assistant" | "tool";
        content: string;
        toolCalls?: RuntimeToolCall[];
        toolCallId?: string;
      }> = [];

      if (optimizationTarget) {
        draft = optimizationTarget.draft;
        previousTests = await this.#testSkillDraft(job, provider, model, prompt, draft, availableTools);
        this.#services.emit({
          type: "skill-lab.progress",
          jobId,
          iteration: 0,
          totalIterations: iterationCount,
          phase: "已载入现有 Skill",
          summary: buildTestSummary(previousTests),
          state: "tested"
        });
        transcript.push({
          role: "user",
          content: buildLabPrompt(prompt, skillCatalog, mcpTools, mcpResources, draft, previousTests)
        });
      } else {
        this.#services.emit({
          type: "skill-lab.progress",
          jobId,
          iteration: 0,
          totalIterations: iterationCount,
          phase: "生成初始 Skill",
          summary: "正在根据澄清后的需求生成可运行的初始版本",
          state: "running"
        });
        transcript.push({
          role: "user",
          content: buildLabPrompt(prompt, skillCatalog, mcpTools, mcpResources, null, [])
        });
        const initialResult = await this.#runModelTurn(jobId, job, provider, model, availableTools, transcript);
        const initialDraft = await this.#parseOrRepairDraft(job, provider, model, initialResult.assistantMessage ?? "", requestedName || prompt.slice(0, 64));
        draft = requestedName?.trim()
          ? { ...initialDraft.draft, name: normalizeUserSkillName(requestedName) }
          : initialDraft.draft;
        previousTests = await this.#testSkillDraft(job, provider, model, prompt, draft, availableTools);
        this.#services.emit({
          type: "skill-lab.progress",
          jobId,
          iteration: 0,
          totalIterations: iterationCount,
          phase: "初始 Skill 已生成",
          summary: buildTestSummary(previousTests),
          state: "tested"
        });
        transcript.push({
          role: "assistant",
          content: initialResult.assistantMessage ?? "",
          toolCalls: initialResult.toolCalls.length ? initialResult.toolCalls : undefined
        });
      }

      for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
        this.#assertNotAborted(job);
        const iterationPrompt = await this.#clarifyRequirement(
          jobId,
          job,
          provider,
          model,
          buildLabPrompt(prompt, skillCatalog, mcpTools, mcpResources, draft, previousTests)
        );
        transcript.push({ role: "user", content: iterationPrompt });
        this.#services.emit({
          type: "skill-lab.progress",
          jobId,
          iteration,
          totalIterations: iterationCount,
          phase: phaseForIteration(iteration),
          summary: `正在运行第 ${iteration}/${iterationCount} 轮测试并完善现有 Skill`,
          state: "running"
        });
        const result = await this.#runModelTurn(jobId, job, provider, model, availableTools, transcript);
        const iterationResult = await this.#parseOrRepairDraft(job, provider, model, result.assistantMessage ?? "", requestedName || prompt.slice(0, 64));
        draft = optimizationTarget
          ? { ...iterationResult.draft, name: optimizationTarget.draft.name }
          : requestedName?.trim()
            ? { ...iterationResult.draft, name: normalizeUserSkillName(requestedName) }
            : iterationResult.draft;
        const tests = await this.#testSkillDraft(job, provider, model, prompt, draft, availableTools);
        previousTests = tests;
        this.#services.emit({
          type: "skill-lab.progress",
          jobId,
          iteration,
          totalIterations: iterationCount,
          phase: phaseForIteration(iteration),
          summary: buildIterationSummary(iterationResult, tests),
          state: "tested"
        });
        transcript.push({
          role: "assistant",
          content: result.assistantMessage ?? "",
          toolCalls: result.toolCalls.length ? result.toolCalls : undefined
        });
      }

      this.#assertNotAborted(job);
      const failedTests = previousTests.filter((test) => !test.passed);
      if (failedTests.length > 0) {
        throw new Error(`技能自检未通过：${failedTests.map((test) => test.detail).join("；")}`);
      }
      const directory = optimizationTarget
        ? path.dirname(optimizationTarget.skill.skillPath)
        : await reserveSkillDirectory(this.#services.skillsDraftsDir, draft.name);
      const skillPath = optimizationTarget?.skill.skillPath ?? path.join(directory, "SKILL.md");
      const temporaryPath = optimizationTarget ? path.join(directory, `.SKILL.${jobId}.tmp`) : null;
      let replacedExistingSkill = false;
      try {
        if (temporaryPath) {
          await fs.writeFile(temporaryPath, renderUserWorkflowSkill(draft), "utf8");
          await fs.rename(temporaryPath, skillPath);
          replacedExistingSkill = true;
        } else {
          await fs.writeFile(skillPath, renderUserWorkflowSkill(draft), "utf8");
        }
        await this.#services.refreshSkills();
        const skill = this.#services.listSkills().find((entry) => path.resolve(entry.skillPath) === path.resolve(skillPath));
        if (!skill) throw new Error("Skill 已生成，但未能载入 Skill 索引。");
        this.#services.emit({ type: "skill-lab.completed", jobId, skill });
      } catch (error) {
        if (temporaryPath) {
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
          if (replacedExistingSkill && optimizationTarget) {
            await fs.writeFile(skillPath, optimizationTarget.source, "utf8").catch(() => undefined);
          }
        } else {
          await fs.rm(directory, { recursive: true, force: true });
        }
        await this.#services.refreshSkills().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (job.abort.signal.aborted) {
        this.#services.emit({ type: "skill-lab.cancelled", jobId });
        return;
      }
      this.#services.emit({
        type: "skill-lab.failed",
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #loadOptimizationTarget(skillId: string): Promise<SkillLabOptimizationTarget> {
    await this.#services.refreshSkills();
    const skill = this.#services.listSkills().find((entry) => entry.id === skillId);
    if (!skill) throw new Error("要优化的用户技能不存在或已被删除。");
    if (skill.pluginId || skill.scope !== "user" || !isPathWithinDirectory(this.#services.skillsDraftsDir, skill.skillPath)) {
      throw new Error("技能实验室只能持续优化“用户技能”中的 Skill。");
    }
    const markdown = await fs.readFile(skill.skillPath, "utf8");
    const parsed = matter(markdown);
    const draft = parseUserWorkflowDraft(JSON.stringify({
      name: parsed.data.name,
      description: parsed.data.description,
      workflow: parsed.content
    }), skill.name);
    return { skill, draft, source: markdown };
  }

  async #runModelTurn(
    jobId: string,
    job: SkillLabJob,
    provider: ProviderDefinition,
    model: ModelProfile,
    availableTools: ToolSpecDefinition[],
    transcript: Array<{ role: "user" | "assistant" | "tool"; content: string; toolCalls?: RuntimeToolCall[]; toolCallId?: string }>
  ) {
    const adapter = this.#services.providerFactory.create(provider);
    const timeoutSignal = this.#services.config.timeouts.modelDecisionMs > 0
      ? AbortSignal.timeout(this.#services.config.timeouts.modelDecisionMs)
      : null;
    const abortSignal = timeoutSignal
      ? AbortSignal.any([job.abort.signal, timeoutSignal])
      : job.abort.signal;
    for (let attempt = 0; attempt < SKILL_LAB_MAX_TOOL_TURNS; attempt += 1) {
      this.#assertNotAborted(job);
      const decision = await adapter.runTurn({
        systemPrompt: buildLabSystemPrompt(),
        transcript,
        availableTools,
        model: { ...model, supportsStreaming: false },
        provider,
        stream: false,
        abortSignal
      });
      if (!decision.toolCalls.length) return decision;
      transcript.push({
        role: "assistant",
        content: decision.assistantMessage ?? "",
        toolCalls: decision.toolCalls
      });
      for (const call of decision.toolCalls) {
        const content = await this.#executeTool(jobId, job, call);
        transcript.push({ role: "tool", toolCallId: call.id, content });
      }
    }
    this.#assertNotAborted(job);
    transcript.push({
      role: "user",
      content: "工具探索阶段已经结束。禁止继续调用工具，请仅根据当前上下文返回本轮要求的结构化 Skill JSON。"
    });
    const finalDecision = await adapter.runTurn({
      systemPrompt: buildLabSystemPrompt(),
      transcript,
      availableTools: [],
      model: { ...model, supportsStreaming: false },
      provider,
      stream: false,
      abortSignal
    });
    if (finalDecision.toolCalls.length > 0) {
      throw new Error("模型在工具探索结束后仍未返回技能草稿，请重试。");
    }
    return finalDecision;
  }

  async #clarifyRequirement(
    jobId: string,
    job: SkillLabJob,
    provider: ProviderDefinition,
    model: ModelProfile,
    prompt: string
  ): Promise<string> {
    const adapter = this.#services.providerFactory.create(provider);
    const timeoutSignal = this.#services.config.timeouts.modelDecisionMs > 0
      ? AbortSignal.timeout(this.#services.config.timeouts.modelDecisionMs)
      : null;
    const abortSignal = timeoutSignal
      ? AbortSignal.any([job.abort.signal, timeoutSignal])
      : job.abort.signal;
    const decision = await adapter.runTurn({
      systemPrompt: [
        "你负责判断当前 Skill 生成或完善步骤是否必须向用户澄清。",
        "只返回 JSON：{\"summary\":\"你对目标的理解\",\"questions\":[{\"id\":\"q1\",\"question\":\"需要用户确认的问题\",\"required\":true,\"options\":[\"选项 A\",\"选项 B\"],\"allowOther\":true}]}。",
        "只有缺少的信息会实质影响工作流、工具选择或验收标准时才提出 1-3 个问题；能够依据现有上下文继续时 questions 必须为空。能提供选项时优先提供 2-5 个互斥选项，并始终允许其他（手填）。不要生成 Skill，不要调用工具。"
      ].join("\n"),
      transcript: [{ role: "user", content: prompt }],
      availableTools: [],
      model: { ...model, supportsStreaming: false },
      provider,
      stream: false,
      abortSignal
    });
    const clarification = parseSkillLabClarification(decision.assistantMessage ?? "", prompt);
    if (clarification.questions.length === 0) {
      return [prompt, `澄清检查：${clarification.summary}`, "无需用户补充，可以继续。"].join("\n\n");
    }
    const answers = await this.#requestClarification(jobId, job, clarification);
    this.#assertNotAborted(job);
    return [
      prompt,
      `需求澄清摘要：${clarification.summary}`,
      "用户补充：",
      ...clarification.questions.map((question) => `${question.question}\n${answers[question.id] ?? "未补充"}`)
    ].join("\n\n");
  }

  async #requestClarification(
    jobId: string,
    job: SkillLabJob,
    clarification: SkillLabClarification
  ): Promise<Record<string, string>> {
    const clarificationId = randomUUID();
    const promise = new Promise<Record<string, string> | null>((resolve) => {
      job.clarifications.set(clarificationId, resolve);
    });
    this.#services.emit({
      type: "skill-lab.clarification",
      jobId,
      clarificationId,
      summary: clarification.summary,
      questions: clarification.questions
    });
    try {
      const answers = await Promise.race([
        promise,
        new Promise<null>((resolve) => job.abort.signal.addEventListener("abort", () => resolve(null), { once: true }))
      ]);
      if (!answers) throw new Error("Skill lab cancelled.");
      return answers;
    } finally {
      job.clarifications.delete(clarificationId);
    }
  }

  async #testSkillDraft(
    job: SkillLabJob,
    provider: ProviderDefinition,
    model: ModelProfile,
    request: string,
    draft: { name: string; description: string; workflow: string },
    availableTools: ToolSpecDefinition[]
  ): Promise<SkillLabTestResult[]> {
    const staticTests = runSkillDraftTests(draft, availableTools);
    const adapter = this.#services.providerFactory.create(provider);
    const timeoutSignal = this.#services.config.timeouts.modelDecisionMs > 0
      ? AbortSignal.timeout(this.#services.config.timeouts.modelDecisionMs)
      : null;
    const abortSignal = timeoutSignal
      ? AbortSignal.any([job.abort.signal, timeoutSignal])
      : job.abort.signal;
    const decision = await adapter.runTurn({
      systemPrompt: [
        "你是 Skill 沙箱测试器，只测试现有 Skill，不修改它，也不调用任何工具。",
        "根据用户目标构造正常、边缘和失败恢复三类场景，逐项模拟执行 Skill 指令。",
        "只返回 JSON：{\"passed\":true,\"issues\":[\"失败原因\"],\"summary\":\"测试摘要\"}。",
        "只有三个场景都满足用户目标、工具约束、安全边界和验收标准时 passed 才能为 true。"
      ].join("\n"),
      transcript: [{
        role: "user",
        content: [
          `用户目标：\n${request}`,
          `待测试 Skill：\n${renderUserWorkflowSkill(draft)}`,
          `程序静态检查：\n${JSON.stringify(staticTests)}`
        ].join("\n\n")
      }],
      availableTools: [],
      model: { ...model, supportsStreaming: false },
      provider,
      stream: false,
      abortSignal
    });
    const dryRun = parseSkillDryRun(decision.assistantMessage ?? "");
    return [
      ...staticTests,
      {
        name: "沙箱试运行",
        passed: dryRun.valid ? dryRun.passed : staticTests.every((test) => test.passed),
        detail: dryRun.valid
          ? (dryRun.passed ? dryRun.summary : dryRun.issues.join("；") || dryRun.summary)
          : "测试模型未返回结构化结果，已保留静态检查结果"
      }
    ];
  }

  async #parseOrRepairDraft(
    job: SkillLabJob,
    provider: ProviderDefinition,
    model: ModelProfile,
    response: string,
    fallbackTitle: string
  ): Promise<SkillLabIteration> {
    try {
      return parseSkillLabIteration(response, fallbackTitle);
    } catch {
      const adapter = this.#services.providerFactory.create(provider);
      const repaired = await adapter.runTurn({
        systemPrompt: "将输入转换为有效的技能实验室 JSON。只返回 {\"draft\":{\"name\":\"lowercase-hyphen-name\",\"description\":\"能力和触发场景\",\"workflow\":\"Markdown 指令\"},\"qualityIssues\":[],\"changes\":[],\"nextGoal\":\"\"}，不要解释，不要调用工具。",
        transcript: [{
          role: "user",
          content: `原始模型输出：\n${response.slice(0, 30_000)}\n\n请保留其中有效的 Skill 内容并修正 JSON 格式。`
        }],
        availableTools: [],
        model: { ...model, supportsStreaming: false },
        provider,
        stream: false,
        abortSignal: job.abort.signal
      });
      const repairedResponse = repaired.assistantMessage ?? "";
      try {
        return parseSkillLabIteration(repairedResponse, fallbackTitle);
      } catch {
        // Some providers ignore the JSON-only instruction but still return a
        // complete SKILL.md. Parse both responses before treating it as a failure.
        return parseSkillLabIteration(`${response}\n\n${repairedResponse}`, fallbackTitle);
      }
    }
  }

  async #executeTool(jobId: string, job: SkillLabJob, call: RuntimeToolCall): Promise<string> {
    if (call.name === "skills.load") {
      const skillId = readToolString(call.arguments, "skill_id", "skillId");
      const skill = this.#services.skills.list().find((entry) => entry.id === skillId || entry.qualifiedName === skillId || entry.name === skillId);
      if (!skill) return JSON.stringify({ ok: false, error: "Skill not found" });
      const content = await fs.readFile(skill.skillPath, "utf8");
      return JSON.stringify({ ok: true, skill: skill.qualifiedName, instructions: content.slice(0, 24_000) });
    }
    if (call.name === "mcp.list_resources") {
      const server = readToolString(call.arguments, "server", "server_id", "serverId");
      const resources = await this.#services.mcp.listResources(server || undefined);
      return JSON.stringify({ ok: true, resources }).slice(0, 24_000);
    }
    if (call.name === "mcp.read_resource") {
      const server = readToolString(call.arguments, "server", "server_id", "serverId");
      const uri = readToolString(call.arguments, "uri");
      if (!server || !uri) return JSON.stringify({ ok: false, error: "server and uri are required" });
      const resources = await this.#services.mcp.listResources(server);
      if (!resources.some((resource) => resource.uri === uri)) {
        return JSON.stringify({ ok: false, error: "MCP resource is unavailable" });
      }
      const result = await this.#services.mcp.readResource(server, uri);
      return JSON.stringify(result).slice(0, 24_000);
    }
    const entry = await this.#loadMcpTools().then((tools) => tools.find((item) => item.spec.name === call.name));
    if (!entry) return JSON.stringify({ ok: false, error: `Tool ${call.name} is unavailable.` });
    if (!entry.readOnly) {
      const approved = await this.#requestApproval(jobId, job, call.name, entry.descriptor.name);
      if (!approved) return JSON.stringify({ ok: false, denied: true, error: "User denied this side-effecting tool." });
    }
    const result = await this.#services.mcp.callTool(entry.descriptor.server, entry.descriptor.name, call.arguments);
    return JSON.stringify(result).slice(0, 24_000);
  }

  async #requestApproval(jobId: string, job: SkillLabJob, toolName: string, descriptorName: string): Promise<boolean> {
    const approvalId = randomUUID();
    const promise = new Promise<boolean>((resolve) => job.approvals.set(approvalId, resolve));
    this.#services.emit({
      type: "skill-lab.approval",
      jobId,
      approvalId,
      title: "技能实验室请求调用副作用工具",
      description: `工具 ${descriptorName} 可能写入数据或影响外部系统。是否允许本轮调用？`,
      toolName
    });
    const timeout = setTimeout(() => this.resolveApproval(jobId, approvalId, false), 120_000);
    try {
      return await Promise.race([
        promise,
        new Promise<boolean>((resolve) => job.abort.signal.addEventListener("abort", () => resolve(false), { once: true }))
      ]);
    } finally {
      clearTimeout(timeout);
      job.approvals.delete(approvalId);
    }
  }

  async #loadMcpTools(): Promise<McpToolEntry[]> {
    const descriptors = await this.#services.mcp.listTools();
    return descriptors.map((descriptor) => ({
      descriptor,
      spec: {
        name: `mcp.${descriptor.server}.${descriptor.name}`,
        namespace: descriptor.server,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        riskLevel: descriptor.annotations?.destructiveHint ? "high" : "medium",
        source: "mcp"
      },
      readOnly: descriptor.annotations?.readOnlyHint === true && descriptor.annotations?.destructiveHint !== true
    }));
  }

  #assertNotAborted(job: SkillLabJob): void {
    if (job.abort.signal.aborted) throw new Error("Skill lab cancelled.");
  }
}

function resolveDefaultReasoningModel(config: AppConfig): { provider: ProviderDefinition; model: ModelProfile } {
  const provider = config.providers.find((entry) => entry.id === config.defaultProvider);
  const model = config.models.find((entry) => entry.id === config.defaultModel && entry.providerId === config.defaultProvider && entry.role === "reasoning");
  if (!provider || !model) throw new Error("未找到默认推理模型，请先配置可用的模型。");
  return { provider, model };
}

function buildSkillLoadSpec(): ToolSpecDefinition {
  return {
    name: "skills.load",
    description: "读取一个本地 Skill 的完整 SKILL.md 指令。",
    inputSchema: {
      type: "object",
      properties: { skill_id: { type: "string" } },
      required: ["skill_id"]
    },
    riskLevel: "low",
    source: "builtin"
  };
}

function buildMcpListResourcesSpec(): ToolSpecDefinition {
  return {
    name: "mcp.list_resources",
    description: "列出已启用的本地 MCP 服务可读取的资源。",
    inputSchema: {
      type: "object",
      properties: { server: { type: "string", description: "可选的 MCP server id" } }
    },
    riskLevel: "low",
    source: "builtin"
  };
}

function buildMcpReadResourceSpec(): ToolSpecDefinition {
  return {
    name: "mcp.read_resource",
    description: "读取已列出的本地 MCP 资源；仅允许读取，不允许写入。",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        uri: { type: "string" }
      },
      required: ["server", "uri"]
    },
    riskLevel: "low",
    source: "builtin"
  };
}

function buildLabSystemPrompt(): string {
  return [
    "你是技能实验室的 Skill 架构师。",
    "根据用户需求自动判断生成单一 Skill 或多个 Skill/MCP 协同的 Workflow Skill。",
    "需要上下文时先调用 skills.load 或只读 MCP 工具，不要编造不存在的工具。",
    "当上下文包含当前草稿和程序测试结果时，必须基于现有 Skill 定点修复失败项，不要从头重写或破坏已经通过测试的行为。",
    "每轮必须只返回一个 JSON 对象：{\"draft\":{\"name\":\"lowercase-hyphen-name\",\"description\":\"能力和触发场景\",\"workflow\":\"Markdown 指令\"},\"qualityIssues\":[\"问题\"],\"changes\":[\"本轮修改\"],\"nextGoal\":\"下一轮目标\"}。",
    "workflow 必须可复用、包含输入约束、执行步骤、工具名称、失败处理和验收标准，不得包含密码、Token 或真实业务数据。"
  ].join("\n");
}

function buildLabPrompt(
  request: string,
  skills: Array<{ id: string; name: string; description: string }>,
  mcpTools: McpToolEntry[],
  mcpResources: McpResourceEntry[],
  previous: { name: string; description: string; workflow: string } | null,
  previousTests: SkillLabTestResult[]
): string {
  const previousBlock = previous
    ? `\n当前草稿：\n${JSON.stringify(previous)}\n请继续审查并改进它。`
    : "\n这是第一轮，请先拆解需求并生成初稿。";
  return [
    `用户需求：\n${request}`,
    `本地 Skill 目录：\n${JSON.stringify(skills.slice(0, 120))}`,
    `可用 MCP 工具：\n${JSON.stringify(mcpTools.map((entry) => ({ name: entry.spec.name, description: entry.spec.description, readOnly: entry.readOnly })).slice(0, 120))}`,
    `可读取 MCP 资源：\n${JSON.stringify(mcpResources.slice(0, 120))}`,
    `程序上一轮自检：\n${JSON.stringify(previousTests)}`,
    previousBlock,
    "本轮重点：检查需求覆盖、可复用性、工具真实性、安全边界和失败恢复。"
  ].join("\n\n");
}

function readToolString(argumentsJson: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = argumentsJson[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseSkillLabClarification(text: string, fallbackPrompt: string): SkillLabClarification {
  for (const candidate of modelJsonCandidates(text)) {
    const value = tryParseModelJson(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const summary = readToolString(record, "summary", "understanding") || fallbackPrompt.slice(0, 300);
    const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
    const questions = rawQuestions.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const entryRecord = entry as Record<string, unknown>;
      const question = readToolString(entryRecord, "question", "text");
      if (!question) return [];
      const rawOptions = Array.isArray(entryRecord.options) ? entryRecord.options : [];
      const options = rawOptions
        .filter((option): option is string => typeof option === "string" && option.trim().length > 0)
        .map((option) => option.trim())
        .filter((option) => !isOtherChoice(option))
        .slice(0, 5);
      return [{
        id: readToolString(entryRecord, "id") || `q${index + 1}`,
        question,
        required: entryRecord.required !== false,
        options,
        allowOther: entryRecord.allowOther !== false
      }];
    }).slice(0, 3);
    if (questions.length > 0) return { summary, questions };
  }
  return {
    summary: fallbackPrompt.slice(0, 300),
    questions: []
  };
}

function isOtherChoice(value: string): boolean {
  return /^(?:其他|其它)(?:\s*(?:[（(].*[）)]|请说明|手填|自定义|补充))?$/u.test(value.trim());
}

function parseSkillDryRun(text: string): { valid: boolean; passed: boolean; issues: string[]; summary: string } {
  for (const candidate of modelJsonCandidates(text)) {
    const value = tryParseModelJson(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.passed !== "boolean") continue;
    return {
      valid: true,
      passed: record.passed,
      issues: readStringArray(record.issues),
      summary: readToolString(record, "summary") || (record.passed ? "沙箱试运行通过" : "沙箱试运行发现问题")
    };
  }
  return { valid: false, passed: false, issues: [], summary: "沙箱试运行结果无效" };
}

function normalizeIterationCount(value: number | undefined): number {
  if (value === undefined) return SKILL_LAB_ITERATIONS;
  if (!Number.isInteger(value) || value < SKILL_LAB_MIN_ITERATIONS || value > SKILL_LAB_MAX_ITERATIONS) {
    throw new Error(`迭代次数必须是 ${SKILL_LAB_MIN_ITERATIONS}-${SKILL_LAB_MAX_ITERATIONS} 之间的整数。`);
  }
  return value;
}

function phaseForIteration(iteration: number): string {
  return `第 ${iteration} 轮：测试并完善 Skill`;
}

function runSkillDraftTests(
  draft: { name: string; description: string; workflow: string },
  availableTools: ToolSpecDefinition[]
): SkillLabTestResult[] {
  const rendered = renderUserWorkflowSkill(draft);
  const availableToolNames = new Set(availableTools.map((tool) => tool.name));
  const referencedTools = [...new Set(rendered.match(/\bmcp\.[a-zA-Z0-9_.-]+/g) ?? [])];
  const unknownTools = referencedTools.filter((name) => !availableToolNames.has(name));
  const hasSecret = /(?:Bearer\s+[A-Za-z0-9._~-]{12,}|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b)/i.test(rendered);
  const validFormat = (() => {
    try {
      const parsed = matter(rendered);
      return typeof parsed.data.name === "string" && parsed.data.name.trim().length > 0 &&
        typeof parsed.data.description === "string" && parsed.data.description.trim().length > 0 &&
        parsed.content.trim().length > 0;
    } catch {
      return false;
    }
  })();
  return [
    { name: "Skill 格式", passed: validFormat, detail: validFormat ? "SKILL.md 格式有效" : "SKILL.md 格式无效" },
    {
      name: "必填内容",
      passed: draft.description.trim().length > 0 && draft.workflow.trim().length > 0,
      detail: draft.description.trim().length > 0 && draft.workflow.trim().length > 0 ? "描述和工作流内容完整" : "缺少描述或工作流内容"
    },
    { name: "工具引用", passed: unknownTools.length === 0, detail: unknownTools.length ? `引用了不存在的工具：${unknownTools.join(", ")}` : "工具引用有效" },
    { name: "安全检查", passed: !hasSecret, detail: hasSecret ? "检测到疑似密钥或令牌" : "未检测到密钥或令牌" }
  ];
}

function parseSkillLabIteration(text: string, fallbackTitle: string): SkillLabIteration {
  for (const candidate of modelJsonCandidates(text)) {
    const value = tryParseModelJson(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const record of collectDraftRecords(value as Record<string, unknown>)) {
      try {
        const draft = parseUserWorkflowDraft(JSON.stringify(record), fallbackTitle);
        return {
          draft,
          qualityIssues: readStringArray(record.qualityIssues),
          changes: readStringArray(record.changes),
          nextGoal: readToolString(record, "nextGoal", "next_goal")
        };
      } catch {
        const markdown = readToolString(record, "skill_markdown", "skillMd", "markdown");
        if (!markdown) continue;
        try {
          const parsed = matter(markdown);
          const draft = parseUserWorkflowDraft(JSON.stringify({
            name: parsed.data.name,
            description: parsed.data.description,
            workflow: parsed.content
          }), fallbackTitle);
          return { draft, qualityIssues: [], changes: [], nextGoal: "" };
        } catch {
          // Try the next nested record or JSON candidate.
        }
      }
    }
  }
  const markdownDraft = parseStandaloneSkillMarkdown(text, fallbackTitle);
  if (markdownDraft) {
    return { draft: markdownDraft, qualityIssues: [], changes: [], nextGoal: "" };
  }
  const plainTextDraft = parsePlainTextSkillDraft(text, fallbackTitle);
  if (plainTextDraft) {
    return { draft: plainTextDraft, qualityIssues: [], changes: [], nextGoal: "" };
  }
  throw new Error("模型未返回有效的技能实验室结构化结果。");
}

function parseStandaloneSkillMarkdown(text: string, fallbackTitle: string): SkillLabIteration["draft"] | null {
  const candidates = [text, ...extractMarkdownCodeBlocks(text)];
  for (const candidate of candidates) {
    const frontmatterStart = candidate.indexOf("---");
    if (frontmatterStart < 0) continue;
    const markdown = candidate.slice(frontmatterStart).trim();
    try {
      const parsed = matter(markdown);
      if (!parsed.content.trim()) continue;
      const draft = parseUserWorkflowDraft(JSON.stringify({
        name: parsed.data.name,
        description: parsed.data.description || `用于 ${fallbackTitle.trim().slice(0, 160)} 的可复用工作流`,
        workflow: parsed.content
      }), fallbackTitle);
      return draft;
    } catch {
      // Continue through other code blocks and model output formats.
    }
  }
  return null;
}

function extractMarkdownCodeBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:markdown|md|text)?\s*\r?\n([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block));
}

function parsePlainTextSkillDraft(text: string, fallbackTitle: string): SkillLabIteration["draft"] | null {
  const candidate = extractMarkdownCodeBlocks(text)[0] ?? text;
  const workflow = candidate
    .replace(/^\s*(?:这是|以下是|Here is|Sure[,!]?)[^\n]*\n+/i, "")
    .trim();
  if (workflow.length < 80 || !/(?:^#\s|^#{2,}\s|工作流|步骤|workflow|instructions?)/im.test(workflow)) return null;
  try {
    return parseUserWorkflowDraft(JSON.stringify({
      name: fallbackTitle,
      description: `用于 ${fallbackTitle.trim().slice(0, 160)} 的可复用工作流`,
      workflow
    }), fallbackTitle);
  } catch {
    return null;
  }
}

function collectDraftRecords(record: Record<string, unknown>, depth = 0): Record<string, unknown>[] {
  if (depth > 2) return [];
  const records = [record];
  for (const key of ["draft", "skill", "result", "output", "data", "content"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      records.push(...collectDraftRecords(nested as Record<string, unknown>, depth + 1));
    } else if (typeof nested === "string") {
      for (const candidate of modelJsonCandidates(nested)) {
        const parsed = tryParseModelJson(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          records.push(...collectDraftRecords(parsed as Record<string, unknown>, depth + 1));
        }
      }
    }
  }
  return records;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 4);
}

function buildIterationSummary(result: SkillLabIteration, tests: SkillLabTestResult[]): string {
  const passed = tests.filter((test) => test.passed).length;
  const failed = tests.filter((test) => !test.passed);
  if (failed.length > 0) return `程序自检 ${passed}/${tests.length} 通过：${failed.map((test) => test.detail).join("；")}`.slice(0, 240);
  const details = result.changes.length > 0 ? result.changes : result.qualityIssues;
  if (details.length > 0) return details.join("；").slice(0, 240);
  return result.nextGoal ? `已完成本轮，下一轮：${result.nextGoal}` : "已完成本轮结构化校验与优化。";
}

function buildTestSummary(tests: SkillLabTestResult[]): string {
  const passed = tests.filter((test) => test.passed).length;
  const failed = tests.filter((test) => !test.passed);
  return failed.length > 0
    ? `测试 ${passed}/${tests.length} 通过：${failed.map((test) => test.detail).join("；")}`.slice(0, 240)
    : `测试 ${tests.length}/${tests.length} 全部通过`;
}

function isPathWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function reserveSkillDirectory(root: string, baseName: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const normalized = normalizeUserSkillName(baseName);
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const directory = path.join(root, suffix === 1 ? normalized : `${normalized}-${suffix}`);
    try {
      await fs.mkdir(directory);
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法为技能实验室分配唯一目录。");
}
