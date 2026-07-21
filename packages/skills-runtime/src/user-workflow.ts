import { modelJsonCandidates, tryParseModelJson } from "@shared-types";

export interface UserWorkflowSource {
  title: string;
  messages: Array<{ role: string; content: string }>;
  toolCalls: Array<{ name: string; argumentsJson: string; resultJson: string | null; status: string }>;
}

export interface UserWorkflowDraft {
  name: string;
  description: string;
  workflow: string;
}

const MAX_SOURCE_CHARS = 70_000;
const MAX_WORKFLOW_CHARS = 20_000;

export function buildUserWorkflowPrompt(source: UserWorkflowSource): string {
  const sections = [
    `聊天标题：${sanitizeWorkflowText(source.title)}`,
    "聊天消息：",
    ...source.messages.map((message) => `[${message.role}] ${sanitizeWorkflowText(message.content)}`),
    "工具调用：",
    ...source.toolCalls.map((call) => [
      `[${call.status}] ${call.name}`,
      `arguments: ${sanitizeWorkflowText(call.argumentsJson)}`,
      call.resultJson ? `result: ${sanitizeWorkflowText(call.resultJson)}` : ""
    ].filter(Boolean).join("\n"))
  ];
  const transcript = sections.join("\n\n").slice(0, MAX_SOURCE_CHARS);
  return [
    "把下面的历史聊天提炼为一个可复用的用户 Skill。只输出一个 JSON 对象，不要使用 Markdown 代码围栏。",
    "JSON 格式：",
    '{"name":"lowercase-hyphen-name","description":"说明技能做什么以及何时使用","workflow":"Markdown 格式的执行说明"}',
    "要求：",
    "1. name 只能使用小写字母、数字和连字符，长度不超过 64。",
    "2. description 必须同时说明能力和触发场景，便于未来聊天自动匹配。",
    "3. workflow 使用祈使句，按实际执行顺序保留 Skill、MCP、插件、数据库和其他工具的准确名称、关键参数与验证步骤。",
    "4. 将一次性任务内容抽象为可复用的输入变量或判断条件，不要照抄具体业务数据。",
    "5. 不得输出密码、API Key、令牌、凭据、个人绝对路径或聊天中的其他敏感值。",
    "6. 不要编造聊天中没有出现过的工具、前置条件或执行结果。",
    "7. workflow 保持精炼，不要包含 README、安装指南、变更记录或创建过程说明。",
    "历史聊天：",
    transcript
  ].join("\n\n");
}

export function parseUserWorkflowDraft(text: string, fallbackTitle: string): UserWorkflowDraft {
  let value: Record<string, unknown> | null = null;
  for (const candidate of modelJsonCandidates(text)) {
    const parsed = tryParseModelJson(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      value = parsed as Record<string, unknown>;
      break;
    }
  }
  if (!value) throw new Error("模型未返回有效的用户技能 JSON。");

  const name = normalizeUserSkillName(readString(value.name) || fallbackTitle);
  const description = compactDescription(sanitizeWorkflowText(readString(value.description), 500));
  let workflow = readString(value.workflow) || readString(value.instructions) || readString(value.content);
  workflow = sanitizeWorkflowText(workflow.replace(/^---[\s\S]*?---\s*/u, "").trim(), MAX_WORKFLOW_CHARS);
  if (!description) throw new Error("模型返回的用户技能缺少描述。");
  if (!workflow) throw new Error("模型返回的用户技能缺少工作流说明。");
  if (workflow.length > MAX_WORKFLOW_CHARS) workflow = workflow.slice(0, MAX_WORKFLOW_CHARS).trimEnd();
  if (!/^#\s/m.test(workflow)) workflow = `# ${titleFromSkillName(name)}\n\n${workflow}`;
  return { name, description, workflow };
}

export function renderUserWorkflowSkill(draft: UserWorkflowDraft): string {
  return [
    "---",
    `name: ${normalizeUserSkillName(draft.name)}`,
    `description: ${JSON.stringify(compactDescription(draft.description))}`,
    "---",
    "",
    draft.workflow.trim(),
    ""
  ].join("\n");
}

export function normalizeUserSkillName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return normalized || `workflow-${Date.now().toString(36)}`;
}

function sanitizeWorkflowText(value: string, maxChars = 8_000): string {
  return value
    .replace(/(["'])(password|passwd|pwd|api[_-]?key|token|secret)\1\s*:\s*(["'])[^"']*\3/gi, '"$2":"[redacted]"')
    .replace(/\b(password|passwd|pwd|api[_-]?key|token|secret)\b\s*([=:])\s*[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted-token]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\/gi, "<user-path>\\")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi, "Bearer [redacted]")
    .slice(0, maxChars);
}

function compactDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function titleFromSkillName(name: string): string {
  return name.split("-").filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}
