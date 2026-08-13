import type { ToolSpecDefinition } from "@shared-types";
import type {
  RuntimeModeToolValidationInput,
  RuntimeModeToolValidationResult
} from "./chat-runtime";

export const PROJECT_MCP_PRIORITY_RECOVERY_MESSAGE = [
  "This is a project task with an authoritative local workspace, but no successful local workspace inspection has been shown to the model yet.",
  "The MCP call was blocked. First call fs.read_directory with {\"path\":\".\"}, then use code.search or fs.read_file against the current project.",
  "Only reconsider repository MCP after reading that local evidence. Do not use a globally enabled MCP repository as a substitute for the current project."
].join(" ");

export class ProjectWorkspaceMissingError extends Error {
  public constructor() {
    super("This project chat has no project folder. Create or reopen the task with an explicit project directory instead of using the task output directory as a project.");
    this.name = "ProjectWorkspaceMissingError";
  }
}

export interface ProjectRuntimePolicy {
  mode: "project";
  workspaceRoot: string;
  workspaceLabel: "project";
  localAccess: null;
  systemPrompt: string;
  projectInstructionRoot: string;
  filterTools: (tools: ToolSpecDefinition[]) => ToolSpecDefinition[];
  validateToolCall: (input: RuntimeModeToolValidationInput) => RuntimeModeToolValidationResult;
}

export function validateProjectMcpPriority(input: {
  toolName: string;
  projectMode: boolean;
  projectCwd: string | null;
  explicitlySelectedMcp: boolean;
  explicitlyRequestedMcp: boolean;
  localWorkspaceInspectedBeforeDecision: boolean;
}): RuntimeModeToolValidationResult {
  if (input.toolName !== "mcp.call") return { allowed: true };
  if (!input.projectMode || !input.projectCwd) return { allowed: true };
  if (input.explicitlySelectedMcp || input.explicitlyRequestedMcp) return { allowed: true };
  if (input.localWorkspaceInspectedBeforeDecision) return { allowed: true };
  return { allowed: false, message: PROJECT_MCP_PRIORITY_RECOVERY_MESSAGE };
}

export interface RuntimeWorkspacePriorityContext {
  mode: "project" | "chat";
  cwd: string | null;
  localWorkspaceFirst: boolean;
}

export function buildProjectWorkspacePriorityPrompt(
  context: RuntimeWorkspacePriorityContext
): string | null {
  if (context.mode !== "project" || !context.cwd) return null;
  const lines = [
    "## Current Project Workspace",
    `The current project path is ${JSON.stringify(context.cwd)}.`,
    "For questions about this project's code, repository, files, modules, or behavior, this local workspace is the authoritative source."
  ];
  if (context.localWorkspaceFirst) {
    lines.push(
      "Inspect the local workspace with fs.read_directory, code.search, code.outline, git.status, git.diff, or fs.read_file before calling mcp.call.",
      "Do not use a globally enabled repository MCP server as a substitute for the current project. Use repository MCP only after local evidence shows it is needed.",
      "When delegating project inspection, state this as local-workspace-first with MCP available as a fallback. Do not turn it into a blanket MCP prohibition unless the user explicitly requested that restriction."
    );
  } else {
    lines.push(
      "The user explicitly selected or requested MCP for this turn, so that explicit request may override the normal local-workspace-first lookup order."
    );
  }
  return lines.join("\n");
}

export function createProjectRuntimePolicy(input: {
  cwd: string | null;
  explicitlySelectedMcp: boolean;
  explicitlyRequestedMcp: boolean;
}): ProjectRuntimePolicy {
  if (!input.cwd) throw new ProjectWorkspaceMissingError();
  const workspaceRoot = input.cwd;
  const systemPrompt = buildProjectWorkspacePriorityPrompt({
    mode: "project",
    cwd: workspaceRoot,
    localWorkspaceFirst: !input.explicitlySelectedMcp && !input.explicitlyRequestedMcp
  })! + "\n\nProject completion policy: when this task changes source code, run the relevant unit tests and wait for a successful result before claiming completion. The final summary must include a test report stating the command, pass status, and concise result. Builds, typechecks, file read-back, and claimed tests do not replace successful unit-test evidence.";
  return {
    mode: "project",
    workspaceRoot,
    workspaceLabel: "project",
    localAccess: null,
    systemPrompt,
    projectInstructionRoot: workspaceRoot,
    filterTools: (tools) => tools,
    validateToolCall: ({ toolName, localWorkspaceInspectedBeforeDecision }) => validateProjectMcpPriority({
      toolName,
      projectMode: true,
      projectCwd: workspaceRoot,
      explicitlySelectedMcp: input.explicitlySelectedMcp,
      explicitlyRequestedMcp: input.explicitlyRequestedMcp,
      localWorkspaceInspectedBeforeDecision
    })
  };
}
