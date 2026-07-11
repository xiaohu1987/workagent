import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import type { SkillMetadata, SkillScope } from "@shared-types";

const SKILL_FILE = "SKILL.md";
const METADATA_FILE = path.join("agents", "openai.yaml");
const MAX_SCAN_DEPTH = 6;

const CHINESE_SKILL_DESCRIPTIONS: Record<string, string> = {
  "artifact-writer": "生成和导出 Markdown、JSON、CSV、Word、PPT、Excel、PDF 等交付文件。",
  "automation-loop": "设计和调试带轮次上限、校验与续跑控制的自动化任务循环。",
  "babysit-pr": "持续跟踪 GitHub 拉取请求、审查意见、CI 状态与可合并性。",
  brainstorming: "在创意设计、功能开发或行为修改前梳理需求、目标和方案。",
  "chat-ux-guard": "保障聊天流式输出、思考状态、自动滚动和附件交互的体验质量。",
  "code-breaking-changes": "检查代码改动是否引入破坏性兼容问题。",
  "code-review": "对拉取请求或代码改动执行最终代码审查。",
  "code-review-change-size": "评估代码改动规模，避免变更过大而难以审查。",
  "code-review-context": "检查模型或审查流程获得的上下文是否足够。",
  "code-review-testing": "为代码审查补充测试策略、测试用例和覆盖检查。",
  "codex-bug": "分析 OpenAI Codex 仓库的 GitHub 缺陷报告并判断下一步处理方式。",
  "codex-issue-digest": "按标签、领域和时间范围汇总 OpenAI Codex 的 GitHub Issue。",
  "codex-pr-body": "更新一个或多个拉取请求的标题与说明内容。",
  "design-taste-frontend": "为落地页、作品集和界面改版提供高质量前端设计约束与审查。",
  "dispatching-parallel-agents": "将相互独立的任务拆分并分派给多个并行 Agent。",
  "excel-csv-data-analyst": "分析 Excel 和 CSV 数据，生成统计结论、图表和可复用脚本。",
  "executing-plans": "按既定实施计划执行工作，并在关键节点进行审查。",
  "file-protocol": "生成和校验可下载的结构化文件输出，避免只在聊天中粘贴内容。",
  "finishing-a-development-branch": "在开发完成后指导合并、创建 PR 或清理分支等收尾操作。",
  imagegen: "生成或编辑位图图像，包括插画、纹理、产品图和透明背景素材。",
  "image-gen-ops": "处理图像生成接口调用、参数模板、结果解析和渲染输出。",
  "knowledge-importer": "把本地文档导入知识库并构建 OKF 知识包。",
  "model-config-guard": "检查模型供应商、接口格式、输入输出能力和启用状态的配置一致性。",
  "multimodal-router": "根据文本、图片或视频任务选择合适的模型路径和工具调用方式。",
  "openai-docs": "查询和使用 OpenAI 官方产品、API 与 Codex 文档。",
  "path-types": "为 Codex Rust 代码选择和迁移合适的操作系统路径类型。",
  "plan-and-patch": "检查仓库、谨慎修改代码并验证改动结果。",
  "plugin-creator": "创建或更新 Codex 插件目录、清单和个人插件市场配置。",
  "prompt-library": "提供编程、写作、图像生成、任务规划和文件输出的可复用提示词模板。",
  "pushing-ci-changes": "处理 GitHub Actions 相关改动、推送失败和上传权限问题。",
  "receiving-code-review": "收到代码审查反馈后进行技术核实，再决定如何修改。",
  "release-checklist": "在发布前检查桌面应用配置、构建、测试、打包和冒烟验证。",
  "remote-tests": "指导使用远程执行器运行测试并分析测试结果。",
  "requesting-code-review": "在完成功能或合并前请求并准备代码审查。",
  "sandbox-safety": "评估命令执行风险并应用沙箱安全策略和审计规则。",
  "scheduler-task": "创建、暂停、恢复和审计定时任务或 Cron 类任务。",
  "skill-creator": "创建或更新扩展 Codex 能力的专业 Skill。",
  "skill-installer": "从精选列表或 GitHub 仓库安装 Codex Skill。",
  "subagent-driven-development": "在当前会话中通过多个子 Agent 并行执行实施计划。",
  "systematic-debugging": "遇到缺陷、测试失败或异常行为时进行系统化排查。",
  "test-driven-development": "在实现功能或修复缺陷前先编写测试并按测试驱动开发。",
  "test-tui": "交互式测试 Codex TUI 的操作与显示效果。",
  "update-v8-version": "更新 Codex 的 V8 或 rusty_v8 版本并验证构建与候选发布流程。",
  "using-git-worktrees": "在功能开发前创建和管理隔离的 Git Worktree。",
  "using-superpowers": "在会话开始时发现并选择适用的 Skill 工作流。",
  "verification-before-completion": "在宣称任务完成前运行验证并以实际结果为依据。",
  "writing-plans": "在动手修改前，把需求整理为可执行的多步骤计划。",
  "writing-skills": "编写、修改和验证 Skill 本身的内容与使用方式。"
};

export interface SkillRootDefinition {
  path: string;
  scope: SkillScope;
  pluginId?: string;
}

interface OpenAiMetadataFile {
  interface?: {
    display_name?: string;
    short_description?: string;
    default_prompt?: string;
    brand_color?: string;
  };
  dependencies?: {
    tools?: Array<{
      type?: string;
      value?: string;
      description?: string;
      transport?: string;
      command?: string;
      url?: string;
    }>;
  };
  policy?: {
    allow_implicit_invocation?: boolean;
    products?: string[];
  };
}

export function discoverSkillRoots(appHome: string, cwd?: string | null): SkillRootDefinition[] {
  const roots: SkillRootDefinition[] = [
    { path: path.join(appHome, "skills", "system"), scope: "system" },
    { path: path.join(appHome, "skills", "imported"), scope: "user" },
    { path: path.join(appHome, "skills", "installed"), scope: "user" },
    { path: path.join(appHome, "skills", "drafts"), scope: "user" }
  ];

  if (cwd) {
    roots.unshift(
      { path: path.join(cwd, ".codexh", "skills"), scope: "repo" },
      { path: path.join(cwd, ".agents", "skills"), scope: "repo" },
      { path: path.join(cwd, ".codex", "skills"), scope: "repo" }
    );
  }

  return roots;
}

export async function loadSkillsFromRoots(
  roots: SkillRootDefinition[]
): Promise<SkillMetadata[]> {
  const discovered = new Map<string, SkillMetadata>();

  for (const root of roots) {
    const skills = await scanSkillRoot(root);
    for (const skill of skills) {
      if (!discovered.has(skill.skillPath)) {
        discovered.set(skill.skillPath, skill);
      }
    }
  }

  return [...discovered.values()].sort((left, right) => {
    const scopeRank = (scope: SkillScope): number => {
      switch (scope) {
        case "repo":
          return 0;
        case "user":
          return 1;
        case "system":
          return 2;
        case "admin":
          return 3;
      }
    };

    return (
      scopeRank(left.scope) - scopeRank(right.scope) ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    );
  });
}

async function scanSkillRoot(root: SkillRootDefinition): Promise<SkillMetadata[]> {
  try {
    await fs.access(root.path);
  } catch {
    return [];
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root.path, depth: 0 }];
  const skills: SkillMetadata[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current.dir, { withFileTypes: true });
    const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === SKILL_FILE);

    if (hasSkillFile) {
      const skill = await readSkillDirectory(current.dir, root);
      if (skill) {
        skills.push(skill);
      }
      continue;
    }

    if (current.depth >= MAX_SCAN_DEPTH) {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return skills;
}

async function readSkillDirectory(
  skillDir: string,
  root: SkillRootDefinition
): Promise<SkillMetadata | null> {
  const skillPath = path.join(skillDir, SKILL_FILE);
  const content = await fs.readFile(skillPath, "utf8");
  const parsed = matter(content);
  const metadata = await readOptionalMetadataFile(skillDir);
  const name = typeof parsed.data.name === "string" && parsed.data.name.trim().length > 0
    ? parsed.data.name.trim()
    : path.basename(skillDir);
  const sourceDescription = typeof parsed.data.description === "string"
    ? parsed.data.description.trim()
    : "";

  if (!sourceDescription) {
    return null;
  }

  const chineseDescription = CHINESE_SKILL_DESCRIPTIONS[name];
  const description = chineseDescription ?? sourceDescription;

  const hash = createHash("sha256").update(content).digest("hex");
  const namespace = root.pluginId ? `${root.pluginId}:${name}` : name;

  return {
    id: hash,
    name,
    qualifiedName: namespace,
    description,
    shortDescription:
      chineseDescription ??
      (typeof parsed.data.metadata?.["short-description"] === "string"
        ? parsed.data.metadata["short-description"]
        : metadata?.interface?.short_description),
    scope: root.scope,
    rootPath: root.path,
    skillPath,
    metadataPath: metadata ? path.join(skillDir, METADATA_FILE) : null,
    pluginId: root.pluginId,
    defaultPrompt: metadata?.interface?.default_prompt,
    displayName: metadata?.interface?.display_name,
    brandColor: metadata?.interface?.brand_color,
    dependencies: metadata?.dependencies?.tools ?? [],
    allowImplicitInvocation: metadata?.policy?.allow_implicit_invocation ?? true,
    products: metadata?.policy?.products ?? [],
    contentHash: hash
  };
}

async function readOptionalMetadataFile(
  skillDir: string
): Promise<OpenAiMetadataFile | null> {
  const metadataPath = path.join(skillDir, METADATA_FILE);

  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return YAML.parse(raw) as OpenAiMetadataFile;
  } catch {
    return null;
  }
}
