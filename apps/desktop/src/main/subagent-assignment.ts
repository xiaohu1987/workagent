import type { ThreadRecord } from "@shared-types";

const FILE_EXTENSIONS = new Set([
  "bat", "c", "cc", "cjs", "cmd", "cpp", "cs", "css", "csv", "env", "go", "h", "html", "hpp", "java",
  "js", "json", "jsx", "kt", "kts", "less", "lock", "lua", "md", "mdx", "mjs", "php", "properties", "ps1",
  "py", "rb", "rs", "sass", "scss", "sh", "sql", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml"
]);

const CHINESE_MCP_PROHIBITION = /(?:不要|禁止|不得|不准|切勿|别)\s*(?:再\s*)?(?:使用|调用|访问|查询|用)?\s*MCP(?:\s*(?:工具|服务|服务器))?(?!\s*(?:作为|来)?\s*(?:替代|代替))/gi;
const ENGLISH_MCP_PROHIBITION = /(?:(?:do\s+not|don't|never|must\s+not)\s+(?:use|call|query|access)|avoid\s+(?:using|calling|querying|accessing))\s+(?:the\s+)?MCP(?:\s+(?:tools|tool|servers|server))?(?!\s+(?:as\s+)?a?\s*(?:substitute|replacement))/gi;

const CHINESE_LOCAL_FIRST_MCP_POLICY = "优先检查当前本地工作区；本地证据不足时可以使用 MCP，但不能用 MCP 替代当前项目代码";
const ENGLISH_LOCAL_FIRST_MCP_POLICY = "Inspect the current local workspace first; use MCP when local evidence is insufficient, but not as a substitute for the current project";

export function isOverlappingSubagentAssignment(
  input: { prompt: string; role: string },
  existing: Pick<ThreadRecord, "agentRole" | "lastTaskMessage">
): boolean {
  const requestedRole = normalizeDelegationRole(input.role);
  const existingRole = normalizeDelegationRole(existing.agentRole ?? "");
  const requestedPrompt = normalizeDelegationPrompt(input.prompt);
  const existingPrompt = normalizeDelegationPrompt(existing.lastTaskMessage ?? "");
  if (requestedRole && requestedRole === existingRole && requestedPrompt && requestedPrompt === existingPrompt) return true;

  const requestedFiles = extractDelegatedFileScopes(input.prompt);
  const existingFiles = extractDelegatedFileScopes(existing.lastTaskMessage ?? "");
  let sharedFiles = 0;
  for (const file of requestedFiles) if (existingFiles.has(file)) sharedFiles += 1;
  return sharedFiles >= 2;
}

export function extractDelegatedFileScopes(prompt: string): Set<string> {
  const scopes = new Set<string>();
  const normalized = prompt.toLowerCase().replace(/\\/g, "/");
  for (const match of normalized.matchAll(/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+(?:\.[a-z0-9_-]+)+/g)) {
    const candidate = match[0];
    if (FILE_EXTENSIONS.has(candidate.slice(candidate.lastIndexOf(".") + 1))) scopes.add(candidate);
  }
  return scopes;
}

export function isExplicitMcpProhibition(input: string): boolean {
  if (!/mcp/i.test(input)) return false;
  const clauses = input.split(/[\r\n，。！？；,!?;]/).map((clause) => clause.trim()).filter(Boolean);
  return clauses.some((clause) => {
    if (/^(?:为什么|为何|怎么|如何|why\b|how\b)/i.test(clause)) return false;
    if (/(?:没有|没)\s*(?:有)?\s*(?:说|要求).{0,12}(?:不要|禁止|不得|不准|别).{0,12}mcp/i.test(clause)) return false;
    return matchesMcpProhibition(clause);
  });
}

export function normalizeSubagentMcpPolicy(
  prompt: string,
  input: { projectMode: boolean; userExplicitlyForbidsMcp: boolean }
): string {
  if (!input.projectMode || input.userExplicitlyForbidsMcp || !matchesMcpProhibition(prompt)) {
    return prompt;
  }
  const replacement = /[\u3400-\u9fff]/.test(prompt)
    ? CHINESE_LOCAL_FIRST_MCP_POLICY
    : ENGLISH_LOCAL_FIRST_MCP_POLICY;
  return prompt
    .replace(CHINESE_MCP_PROHIBITION, replacement)
    .replace(ENGLISH_MCP_PROHIBITION, replacement);
}

function matchesMcpProhibition(value: string): boolean {
  CHINESE_MCP_PROHIBITION.lastIndex = 0;
  ENGLISH_MCP_PROHIBITION.lastIndex = 0;
  return CHINESE_MCP_PROHIBITION.test(value) || ENGLISH_MCP_PROHIBITION.test(value);
}

function normalizeDelegationPrompt(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDelegationRole(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\W_]+/g, "");
}
