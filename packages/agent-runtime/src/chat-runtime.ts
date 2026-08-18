import type { MessageAttachment, ToolSpecDefinition } from "@shared-types";

export type ChatLocalAccess = "none" | "read" | "write" | "execute";

export interface RuntimeModeToolValidationInput {
  toolName: string;
  localWorkspaceInspectedBeforeDecision: boolean;
}

export interface RuntimeModeToolValidationResult {
  allowed: boolean;
  message?: string;
}

export interface ChatRuntimePolicy {
  mode: "chat";
  workspaceRoot: string;
  workspaceLabel: "task_output";
  localAccess: ChatLocalAccess;
  systemPrompt: string;
  projectInstructionRoot: null;
  filterTools: (tools: ToolSpecDefinition[]) => ToolSpecDefinition[];
  validateToolCall: (input: RuntimeModeToolValidationInput) => RuntimeModeToolValidationResult;
}

const CHAT_READ_TOOLS = new Set([
  "fs.read_file",
  "fs.read_directory"
]);

const CHAT_WRITE_TOOLS = new Set([
  ...CHAT_READ_TOOLS,
  "fs.write_file",
  "fs.mkdir",
  "fs.rename",
  "fs.delete",
  "fs.copy",
  "apply_patch",
  "search_replace"
]);

const CHAT_EXECUTE_TOOLS = new Set([
  ...CHAT_READ_TOOLS,
  "shell.exec",
  "shell.cancel_active"
]);

function isProjectOnlyTool(toolName: string): boolean {
  return toolName.startsWith("git.") || toolName.startsWith("code.") || toolName === "project.verify";
}

function requiredChatAccess(toolName: string): ChatLocalAccess | "project" | null {
  if (isProjectOnlyTool(toolName)) return "project";
  if (CHAT_WRITE_TOOLS.has(toolName) && !CHAT_READ_TOOLS.has(toolName)) return "write";
  if (CHAT_READ_TOOLS.has(toolName)) return "read";
  if (CHAT_EXECUTE_TOOLS.has(toolName)) {
    if (toolName === "shell.exec" || toolName === "shell.cancel_active") return "execute";
  }
  return null;
}

function accessAllows(actual: ChatLocalAccess, required: ChatLocalAccess | "project" | null): boolean {
  if (required === null) return true;
  if (required === "project") return false;
  // Execution is not an implicit file-write grant. A normal chat must ask to
  // create or save a file before any mutating filesystem tool is exposed.
  if (required === "write") return actual === "write";
  if (required === "execute") return actual === "write" || actual === "execute";
  const levels: Record<ChatLocalAccess, number> = { none: 0, read: 1, write: 2, execute: 3 };
  return levels[actual] >= levels[required];
}

function containsAttachedLocalContext(request: string, attachments: MessageAttachment[]): boolean {
  return attachments.some((attachment) => attachment.kind === "file") ||
    /\[(?:Attached file|Attached folder - required task context|Selected code)\]/i.test(request);
}

function containsExplicitLocalPath(request: string): boolean {
  return /(?:[A-Za-z]:\\[^\r\n]+|(?:^|\s)(?:\.\.?[\\/]|[\\/])[^\s\r\n]+)/m.test(request);
}

function isExplicitReadRequest(request: string): boolean {
  const chinese = /(?:^|[，。！？；\n])(?:请|请你|帮我|给我|麻烦|直接)?\s*(?:读取|查看|检查|分析|审查|总结|打开|搜索|查找).{0,24}(?:文件|目录|文件夹|路径|代码|脚本)/;
  const english = /(?:^|[.!?;\n])(?:please\s+|can you\s+|could you\s+|would you\s+)?(?:read|inspect|review|analy[sz]e|summari[sz]e|open|search)\b.{0,48}\b(?:file|folder|directory|path|code|script)\b/i;
  return chinese.test(request) || english.test(request);
}

function isExplicitWriteRequest(request: string, requestedDeliverableExtensions: string[]): boolean {
  const hasExplicitFormat = requestedDeliverableExtensions.length > 0;
  const chineseAction = /(?:^|[，。！？；\n])(?:请|请你|帮我|给我|麻烦|直接)?\s*(?:把.{0,48})?\s*(?:创建|新建|生成|导出|保存|写入)/;
  const chineseFileTarget = /(?:文件|文档|附件|表格|工作簿|\.?(?:md|markdown|xlsx?|excel|docx?|word|pdf|pptx?|csv)\b)/i;
  const englishAction = /(?:^|[.!?;\n])(?:please\s+|can you\s+|could you\s+|would you\s+)?(?:create|generate|export|save|write)\b/i;
  const englishFileTarget = /\b(?:file|document|attachment|workbook|spreadsheet|\.?(?:md|markdown|xlsx?|excel|docx?|word|pdf|pptx?|csv))\b/i;

  // Mentioning a format is not authorization. Ordinary chat writes only when
  // the user asks to persist a concrete file/document, with a format or name.
  if (hasExplicitFormat) {
    return (chineseAction.test(request) && chineseFileTarget.test(request)) ||
      (englishAction.test(request) && englishFileTarget.test(request));
  }
  return (chineseAction.test(request) && /(?:文件|文档|附件|路径|[A-Za-z]:\\|\/[\w.-]+\.[A-Za-z0-9]{1,8})/.test(request)) ||
    (englishAction.test(request) && /\b(?:file|document|attachment|path)\b|(?:[A-Za-z]:\\|\/)[^\s]+\.[A-Za-z0-9]{1,8}/i.test(request));
}

function isExplicitExecuteRequest(request: string): boolean {
  const chinese = /(?:^|[，。！？；\n])(?:请|请你|帮我|给我|麻烦|直接)?\s*(?:运行|执行|启动|构建|编译|测试|部署)(?:.{0,24}(?:命令|脚本|代码|程序|测试|构建|服务|项目))?/;
  const english = /(?:^|[.!?;\n])(?:please\s+|can you\s+|could you\s+|would you\s+)?(?:run|execute|start|build|compile|test|deploy)\b(?:.{0,48}\b(?:command|script|code|program|tests?|build|server|app)\b)?/i;
  return chinese.test(request) || english.test(request);
}

export function resolveChatLocalAccess(input: {
  request: string;
  attachments?: MessageAttachment[];
  requestedDeliverableExtensions?: string[];
}): ChatLocalAccess {
  const request = input.request.trim();
  const attachments = input.attachments ?? [];
  if (isExplicitWriteRequest(request, input.requestedDeliverableExtensions ?? [])) return "write";
  if (isExplicitExecuteRequest(request)) return "execute";
  if (
    containsAttachedLocalContext(request, attachments) ||
    (containsExplicitLocalPath(request) && isExplicitReadRequest(request)) ||
    isExplicitReadRequest(request)
  ) {
    return "read";
  }
  return "none";
}

export function buildChatRuntimePrompt(localAccess: ChatLocalAccess): string {
  const accessInstruction = localAccess === "none"
    ? "This request does not authorize local file or command access. Do not inspect the task output directory, search code, run shell commands, or use Git merely to confirm context."
    : localAccess === "read"
      ? "The user explicitly requested local reading. Read only the named or attached files and folders; do not treat them as a project repository."
      : localAccess === "write"
        ? "The user explicitly requested a file deliverable or edit. Use the task output directory for new deliverables and access only files relevant to that request."
        : "The user explicitly requested local execution. Commands run from the task output directory; do not create, edit, rename, or delete files unless the request also explicitly asks for a file deliverable.";
  return [
    "## Ordinary Chat Runtime",
    "This is an ordinary chat without a project workspace. The local working directory is only this task's output directory.",
    accessInstruction,
    "Git operations, repository verification, project instructions, and project GPA files require a project chat."
  ].join("\n");
}

export function createChatRuntimePolicy(input: {
  outputDir: string;
  request: string;
  attachments?: MessageAttachment[];
  requestedDeliverableExtensions?: string[];
}): ChatRuntimePolicy {
  const localAccess = resolveChatLocalAccess(input);
  const validateToolCall = ({ toolName }: RuntimeModeToolValidationInput): RuntimeModeToolValidationResult => {
    const required = requiredChatAccess(toolName);
    if (accessAllows(localAccess, required)) return { allowed: true };
    if (required === "project") {
      return {
        allowed: false,
        message: "This is an ordinary chat without a project repository. Git, repository diff, and project verification require a project chat with an explicit project folder."
      };
    }
    return {
      allowed: false,
      message: "The current ordinary-chat request did not authorize local file or command access. Answer from the conversation and selected external sources without inspecting the task output directory."
    };
  };
  return {
    mode: "chat",
    workspaceRoot: input.outputDir,
    workspaceLabel: "task_output",
    localAccess,
    systemPrompt: buildChatRuntimePrompt(localAccess),
    projectInstructionRoot: null,
    filterTools: (tools) => tools.filter((tool) => validateToolCall({
      toolName: tool.name,
      localWorkspaceInspectedBeforeDecision: false
    }).allowed),
    validateToolCall
  };
}
