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
  "aspnet-core": "使用当前官方实践开发、审查和升级 ASP.NET Core、Blazor、MVC、Web API、SignalR 与 gRPC 应用。",
  "artifact-writer": "生成和导出 Markdown、JSON、CSV、Word、PPT、Excel、PDF 等交付文件。",
  "automation-loop": "设计和调试带轮次上限、校验与续跑控制的自动化任务循环。",
  "babysit-pr": "持续跟踪 GitHub 拉取请求、审查意见、CI 状态与可合并性。",
  brainstorming: "在创意设计、功能开发或行为修改前梳理需求、目标和方案。",
  "chatgpt-apps": "开发和排查由 MCP 服务与组件界面组成的 ChatGPT Apps SDK 应用。",
  "chat-ux-guard": "保障聊天流式输出、思考状态、自动滚动和附件交互的体验质量。",
  "cli-creator": "根据 API 文档、OpenAPI、SDK 或现有脚本创建可复用的命令行工具。",
  "cloudflare-deploy": "把应用部署到 Cloudflare Workers、Pages 及相关平台服务。",
  "code-breaking-changes": "检查代码改动是否引入破坏性兼容问题。",
  "code-review": "对拉取请求或代码改动执行最终代码审查。",
  "code-review-change-size": "评估代码改动规模，避免变更过大而难以审查。",
  "code-review-context": "检查模型或审查流程获得的上下文是否足够。",
  "code-review-testing": "为代码审查补充测试策略、测试用例和覆盖检查。",
  "codex-bug": "分析 OpenAI Codex 仓库的 GitHub 缺陷报告并判断下一步处理方式。",
  "codex-issue-digest": "按标签、领域和时间范围汇总 OpenAI Codex 的 GitHub Issue。",
  "codex-pr-body": "更新一个或多个拉取请求的标题与说明内容。",
  "design-taste-frontend": "为落地页、作品集和界面改版提供高质量前端设计约束与审查。",
  "define-goal": "把模糊意图整理为具体、可衡量且有明确成功标准的目标。",
  "dispatching-parallel-agents": "将相互独立的任务拆分并分派给多个并行 Agent。",
  "excel-csv-data-analyst": "分析 Excel 和 CSV 数据，生成统计结论、图表和可复用脚本。",
  "executing-plans": "按既定实施计划执行工作，并在关键节点进行审查。",
  "file-protocol": "生成和校验可下载的结构化文件输出，避免只在聊天中粘贴内容。",
  figma: "读取 Figma 设计上下文、截图、变量和素材，并把设计节点转换为生产代码。",
  "figma-code-connect-components": "使用 Code Connect 建立 Figma 组件与代码组件之间的映射。",
  "figma-create-design-system-rules": "根据当前代码库生成项目专用的 Figma 设计系统规则。",
  "figma-create-new-file": "创建新的 Figma Design 或 FigJam 文件，为后续画布操作准备工作区。",
  "figma-generate-design": "从代码或需求在 Figma 中分段创建或更新完整页面、视图与多区块布局。",
  "figma-generate-library": "从代码库构建或更新 Figma 变量、主题、组件库和设计系统基础。",
  "figma-implement-design": "把 Figma 设计高保真转换为可用于生产的界面与组件代码。",
  "figma-use": "在执行 Figma 画布读写前加载必需约束，安全调用 use_figma 工具。",
  "finishing-a-development-branch": "在开发完成后指导合并、创建 PR 或清理分支等收尾操作。",
  "gh-address-comments": "使用 GitHub CLI 读取并处理当前分支 PR 的审查意见和 Issue 评论。",
  "gh-fix-ci": "使用 GitHub CLI 定位 GitHub Actions 检查失败并在确认方案后修复。",
  "hatch-pet": "创建、修复、验证并打包 Codex 动态宠物及透明精灵图。",
  imagegen: "生成或编辑位图图像，包括插画、纹理、产品图和透明背景素材。",
  generate_image: "当用户要画图/生成图片时，加载本技能并调用 image.generate，使用设置里的默认图片模型。",
  generate_video: "当用户要生成视频时，加载本技能并调用 video.generate，使用设置里的默认视频模型。",
  "image-gen-ops": "处理图像生成接口调用、参数模板、结果解析和渲染输出。",
  "jupyter-notebook": "创建和编辑用于实验、数据探索或教程的 Jupyter Notebook。",
  "knowledge-importer": "把本地文档导入知识库并构建 OKF 知识包。",
  linear: "读取、创建和更新 Linear 中的 Issue、项目及团队工作流。",
  "migrate-to-codex": "把受支持的指令、Skill、Agent 和 MCP 配置迁移到 Codex。",
  "model-config-guard": "检查模型供应商、接口格式、输入输出能力和启用状态的配置一致性。",
  "multimodal-router": "根据文本、图片或视频任务选择合适的模型路径和工具调用方式。",
  "netlify-deploy": "使用 Netlify CLI 部署、托管、发布或关联网站与代码仓库。",
  "notion-knowledge-capture": "把对话、笔记和决策整理为结构化 Notion 知识页、教程或 FAQ。",
  "notion-meeting-intelligence": "结合 Notion 上下文准备会议议程、预读材料和参会人定制内容。",
  "notion-research-documentation": "跨 Notion 来源检索资料并生成带引用的报告、比较或文档。",
  "notion-spec-to-implementation": "把 Notion 产品需求和功能规格转换为实施计划、任务与进度跟踪。",
  "openai-docs": "查询和使用 OpenAI 官方产品、API 与 Codex 文档。",
  "path-types": "为 Codex Rust 代码选择和迁移合适的操作系统路径类型。",
  pdf: "读取、创建和审查 PDF，并通过页面渲染检查版式与视觉结果。",
  "plan-and-patch": "检查仓库、谨慎修改代码并验证改动结果。",
  playwright: "通过 Playwright 自动操作真实浏览器，完成页面流程、截图、抓取与调试。",
  "playwright-interactive": "通过持久浏览器或 Electron 会话进行快速交互式界面调试。",
  "plugin-creator": "创建或更新 Codex 插件目录、清单和个人插件市场配置。",
  "prompt-library": "提供编程、写作、图像生成、任务规划和文件输出的可复用提示词模板。",
  "pushing-ci-changes": "处理 GitHub Actions 相关改动、推送失败和上传权限问题。",
  "receiving-code-review": "收到代码审查反馈后进行技术核实，再决定如何修改。",
  "render-deploy": "分析项目并生成 Render Blueprint，将应用部署到 Render 平台。",
  "release-checklist": "在发布前检查桌面应用配置、构建、测试、打包和冒烟验证。",
  "remote-tests": "指导使用远程执行器运行测试并分析测试结果。",
  "requesting-code-review": "在完成功能或合并前请求并准备代码审查。",
  "sandbox-safety": "评估命令执行风险并应用沙箱安全策略和审计规则。",
  "scheduler-task": "创建、暂停、恢复和审计定时任务或 Cron 类任务。",
  screenshot: "在应用内截图能力不可用时截取桌面、窗口或指定屏幕区域。",
  "security-best-practices": "按语言和框架执行安全最佳实践审查并提出安全默认改进建议。",
  "security-ownership-map": "基于 Git 历史分析敏感代码所有权、巴士因子和安全维护风险。",
  "security-threat-model": "针对代码库识别信任边界、资产、攻击路径并生成威胁模型。",
  sentry: "只读查询 Sentry Issue、事件和生产环境健康数据并汇总近期错误。",
  "skill-creator": "创建或更新扩展 Codex 能力的专业 Skill。",
  "skill-installer": "从精选列表或 GitHub 仓库安装 Codex Skill。",
  speech: "通过 OpenAI Audio API 生成旁白、无障碍朗读、语音提示或批量语音。",
  "subagent-driven-development": "在当前会话中通过多个子 Agent 并行执行实施计划。",
  "systematic-debugging": "遇到缺陷、测试失败或异常行为时进行系统化排查。",
  "test-driven-development": "在实现功能或修复缺陷前先编写测试并按测试驱动开发。",
  "test-tui": "交互式测试 Codex TUI 的操作与显示效果。",
  transcribe: "把音频或视频中的语音转成文字，并可选进行说话人分离与标注。",
  "update-v8-version": "更新 Codex 的 V8 或 rusty_v8 版本并验证构建与候选发布流程。",
  "using-git-worktrees": "在功能开发前创建和管理隔离的 Git Worktree。",
  "using-superpowers": "在会话开始时发现并选择适用的 Skill 工作流。",
  "vercel-deploy": "把应用和网站部署到 Vercel，并创建预览或正式发布链接。",
  "verification-before-completion": "在宣称任务完成前运行验证并以实际结果为依据。",
  "winui-app": "使用 C#、WinUI 3 和 Windows App SDK 开发、设计及排查现代 Windows 桌面应用。",
  "writing-plans": "在动手修改前，把需求整理为可执行的多步骤计划。",
  "writing-skills": "编写、修改和验证 Skill 本身的内容与使用方式。",
  yeet: "仅在明确要求时一次性完成 Git 暂存、提交、推送并创建 GitHub PR。"
};

const SKILL_DOMAIN_OVERRIDES: Record<string, string> = {
  "aspnet-core": "编程",
  "chatgpt-apps": "编程",
  "cli-creator": "编程",
  "cloudflare-deploy": "交付运维",
  "define-goal": "规划",
  figma: "前端",
  "figma-code-connect-components": "前端",
  "figma-create-design-system-rules": "前端",
  "figma-create-new-file": "前端",
  "figma-generate-design": "前端",
  "figma-generate-library": "前端",
  "figma-implement-design": "前端",
  "figma-use": "前端",
  "gh-address-comments": "代码协作",
  "gh-fix-ci": "代码协作",
  "hatch-pet": "多媒体",
  "jupyter-notebook": "数据",
  linear: "项目协作",
  "migrate-to-codex": "系统",
  "netlify-deploy": "交付运维",
  "notion-knowledge-capture": "文档",
  "notion-meeting-intelligence": "文档",
  "notion-research-documentation": "文档",
  "notion-spec-to-implementation": "规划",
  pdf: "文档",
  playwright: "测试",
  "playwright-interactive": "测试",
  "render-deploy": "交付运维",
  screenshot: "多媒体",
  "security-best-practices": "安全",
  "security-ownership-map": "安全",
  "security-threat-model": "安全",
  sentry: "交付运维",
  speech: "多媒体",
  transcribe: "多媒体",
  "vercel-deploy": "交付运维",
  "winui-app": "编程",
  yeet: "代码协作"
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
    domain: resolveSkillDomain({ name, description, scope: root.scope, pluginId: root.pluginId, frontmatter: parsed.data }),
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

function resolveSkillDomain(input: {
  name: string;
  description: string;
  scope: SkillScope;
  pluginId?: string;
  frontmatter: Record<string, unknown>;
}): string {
  if (input.pluginId) {
    return "第三方/插件";
  }
  if (input.scope === "system") {
    // Keep programming system skills distinguishable from generic system helpers.
    const source = `${input.name} ${input.description}`.toLowerCase();
    if (/(plan-and-patch|patch|programming|repo|code)/.test(source)) {
      return "编程";
    }
    return "系统";
  }

  const domainOverride = SKILL_DOMAIN_OVERRIDES[input.name];
  if (domainOverride) {
    return domainOverride;
  }

  const declared = input.frontmatter.domain ?? input.frontmatter.category;
  if (typeof declared === "string" && declared.trim()) {
    return normalizeSkillDomain(declared.trim(), input.name, input.description);
  }
  const tags = input.frontmatter.tags;
  if (Array.isArray(tags) && typeof tags[0] === "string" && tags[0].trim()) {
    return normalizeSkillDomain(tags[0].trim(), input.name, input.description);
  }

  return normalizeSkillDomain("通用", input.name, input.description);
}

/** Canonicalize skill category/domain labels used by ranking. */
export function normalizeSkillDomain(
  declared: string,
  name = "",
  description = ""
): string {
  const trimmed = declared.trim();
  if (trimmed === "质量保障") {
    return "测试";
  }
  if (trimmed === "输出与文件") {
    return "前端";
  }

  const identity = `${name} ${description}`.toLowerCase();
  if (
    /(plan-and-patch|verification-before-completion|systematic-debugging|test-driven-development|executing-plans|writing-plans)/.test(
      identity
    )
  ) {
    if (/(verification|debug|testing|tdd|test)/.test(identity)) {
      return "测试";
    }
    return "编程";
  }

  if (trimmed && trimmed !== "通用") {
    return trimmed;
  }

  const source = `${trimmed} ${identity}`;
  if (/(react|vue|frontend|css|ui|design|前端|界面)/.test(source)) return "前端";
  if (/(test|testing|vitest|playwright|测试)/.test(source)) return "测试";
  if (/(git|pr|review|commit|github|代码审查)/.test(source)) return "代码协作";
  if (/(excel|csv|data|数据库|数据)/.test(source)) return "数据";
  if (/(image|图像|图片|视觉)/.test(source)) return "多媒体";
  if (/(deploy|release|ci|cd|发布)/.test(source)) return "交付运维";
  if (/(plan|brainstorm|规划|需求)/.test(source)) return "规划";
  return "通用";
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
