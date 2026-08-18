export type LiveEditPreviewToolCall = {
  toolName: string;
  argumentsJson?: string | null;
};

export function getLiveEditWriteTargets(toolCall: LiveEditPreviewToolCall): string[] {
  if (toolCall.toolName !== "apply_patch" && toolCall.toolName !== "fs.write_file" && toolCall.toolName !== "search_replace") {
    return [];
  }

  const input = parseArguments(toolCall.argumentsJson);
  if (toolCall.toolName === "fs.write_file") {
    return uniquePaths([input.path, input.filePath]);
  }

  if (toolCall.toolName === "search_replace") {
    return uniquePaths([input.file_path, input.filePath, input.path]);
  }

  return uniquePaths(
    typeof input.patch === "string"
      ? [...input.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1])
      : []
  );
}

function parseArguments(argumentsJson: string | null | undefined): Record<string, unknown> {
  if (!argumentsJson) return {};
  try {
    const value = JSON.parse(argumentsJson);
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function uniquePaths(values: unknown[]): string[] {
  const paths = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const path = value.trim();
    if (path) paths.add(path);
  }
  return [...paths];
}
