import type { ThreadRecord } from "@shared-types";

const FILE_EXTENSIONS = new Set([
  "bat", "c", "cc", "cjs", "cmd", "cpp", "cs", "css", "csv", "env", "go", "h", "html", "hpp", "java",
  "js", "json", "jsx", "kt", "kts", "less", "lock", "lua", "md", "mdx", "mjs", "php", "properties", "ps1",
  "py", "rb", "rs", "sass", "scss", "sh", "sql", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml"
]);

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

function normalizeDelegationPrompt(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDelegationRole(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\W_]+/g, "");
}
