import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  ApprovalMode,
  ArtifactRecord,
  BrowserAssertionCheck,
  BrowserAssertionResult,
  BrowserViewport,
  MessageAttachment,
  BrowserTabRecord,
  KnowledgeBaseRecord,
  RuntimeToolCall,
  SubagentResultEnvelope,
  SubagentWaitResult,
  ThreadRecord,
  ProjectExecutionPolicy,
  ToolResult,
  ToolSearchResult,
  ToolSpecDefinition,
  UserInputQuestion
} from "@shared-types";
import { extractMcpRepositoryToolResult } from "@mcp-runtime";
import { applyCodexPatch } from "./handlers/applyPatch";
import { astDiffSources, extractSymbols, isAstSupportedPath, languageFromPath } from "./ast";
import { prepareShellCommandForWebFrontend } from "./web-shell-policy";
import {
  pageForModel,
  truncatePageText
} from "./browser-page-sanitize";

export {
  isPythonScaffoldingCommand,
  isWebFrontendTaskText,
  prepareShellCommandForWebFrontend,
  rewritePythonHttpServer,
  WEB_FRONTEND_PYTHON_BLOCK_MESSAGE
} from "./web-shell-policy";
export {
  BROWSER_PAGE_TEXT_LIMIT,
  pageForModel,
  sanitizeBrowserToolJson,
  truncatePageText
} from "./browser-page-sanitize";

export const MAX_CODE_SEARCH_RESULT_LINES = 500;

export interface ToolRuntimeContext {
  cwd: string;
  appHome: string;
  threadId: string;
  turnRunId: string;
  toolCallId?: string;
  approvalMode: ApprovalMode;
  executionPolicy?: ProjectExecutionPolicy;
  /** SHA-256 versions captured by fs.read_file during the current Agent turn. */
  expectedFileVersions?: ReadonlyMap<string, string>;
  browserTabs: BrowserTabRecord[];
  knowledgeBases: KnowledgeBaseRecord[];
  searchKnowledge: (query: string, knowledgeBaseIds?: string[]) => Promise<any[]>;
  readKnowledgeConcept: (conceptId: string) => Promise<any | null>;
  listFiles: (dir: string) => Promise<string[]>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  runTerminalCommand?: (command: string) => Promise<TerminalCommandResult>;
  cancelActiveTerminalCommands?: (reason?: string) => Promise<void> | void;
  requestApproval: (input: {
    title: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    payload: Record<string, unknown>;
  }) => Promise<boolean>;
  requestUserInput: (input: {
    title: string;
    questions: UserInputQuestion[];
  }) => Promise<Record<string, string>>;
  requestUserInputEnabled?: boolean;
  /** When true, block Python scaffolding for HTML/CSS/JS delivery tasks. */
  webFrontendGuard?: boolean;
  spawnChildAgent: (input: { prompt: string; role: string; modelId?: string }) => Promise<{
    threadId: string;
    agentPath: string;
    status: ThreadRecord["status"];
  }>;
  sendAgentMessage: (input: { agent: string; message: string }) => Promise<SubagentResultEnvelope>;
  followupAgentTask: (input: { agent: string; prompt: string }) => Promise<SubagentResultEnvelope>;
  waitForSubagents: (input: { agents?: string[]; timeoutMs?: number }) => Promise<SubagentWaitResult>;
  interruptAgent: (agent: string) => Promise<SubagentResultEnvelope>;
  listSubagents: () => Promise<ThreadRecord[]>;
  webSearch: (query: string) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  openPage: (url: string) => Promise<{ title: string; url: string; text: string }>;
  findInPage: (url: string, pattern: string) => Promise<string[]>;
  listBrowserTabs: () => Promise<BrowserTabRecord[]>;
  openBrowserTab: (url: string) => Promise<{
    tab: BrowserTabRecord;
    page: { title: string; url: string; text: string };
    reused?: boolean;
  }>;
  navigateBrowserTab: (tabId: string, url: string) => Promise<{ tab: BrowserTabRecord; page: { title: string; url: string; text: string } }>;
  reloadBrowserTab: (tabId: string) => Promise<{ tab: BrowserTabRecord; page: { title: string; url: string; text: string } }>;
  goBackBrowserTab: (tabId: string) => Promise<{ tab: BrowserTabRecord; page: { title: string; url: string; text: string } }>;
  goForwardBrowserTab: (tabId: string) => Promise<{ tab: BrowserTabRecord; page: { title: string; url: string; text: string } }>;
  focusBrowserTab: (tabId: string) => Promise<BrowserTabRecord>;
  readBrowserPageText: (tabId: string) => Promise<{ tab: BrowserTabRecord; text: string; title: string; url: string }>;
  inspectBrowserPage: (tabId: string) => Promise<any>;
  inspectBrowserTarget: (tabId: string, elementId: string) => Promise<{ name: string; requiresApproval: boolean; description: string }>;
  clickBrowserElement: (tabId: string, elementId: string) => Promise<any>;
  fillBrowserElement: (tabId: string, elementId: string, value: string) => Promise<any>;
  selectBrowserOption: (tabId: string, elementId: string, value: string) => Promise<any>;
  scrollBrowserPage: (tabId: string, deltaY: number) => Promise<any>;
  pressBrowserKey: (tabId: string, key: string) => Promise<any>;
  waitForBrowserPage: (tabId: string, input: { text?: string; elementId?: string; timeoutMs?: number }) => Promise<any>;
  setBrowserViewport: (tabId: string, viewport: BrowserViewport | null) => Promise<any>;
  assertBrowserPage: (tabId: string, checks: BrowserAssertionCheck[]) => Promise<{
    title: string;
    url: string;
    viewport: BrowserViewport;
    passed: boolean;
    results: BrowserAssertionResult[];
  }>;
  captureBrowserScreenshot: (tabId: string, fullPage?: boolean) => Promise<{
    title: string;
    url: string;
    filePath: string;
    width: number;
    height: number;
    viewport: BrowserViewport;
    fullPage: boolean;
    capturedAt: string;
    attachment: MessageAttachment;
    artifact: ArtifactRecord;
  }>;
  emitBrowserVerificationEvent?: (type: "browser.verification_started" | "browser.assertion_completed" | "browser.screenshot_attached" | "browser.verification_completed", payload: Record<string, unknown>) => Promise<void>;
  captureBrowserSnapshot: (tabId: string) => Promise<{
    filePath: string;
    title: string;
    url: string;
    text: string;
    artifact: ArtifactRecord;
  }>;
  getThreadOutputDir: () => Promise<string>;
  /**
   * Generate an image with the app's configured default image model.
   * Returns null-shaped errors via thrown Error or { ok:false } from the tool handler.
   */
  generateImageWithDefaultModel?: (input: {
    prompt: string;
    toolCallId?: string | null;
  }) => Promise<{
    fileName: string;
    absolutePath: string;
    mimeType: string;
    modelId: string;
    providerId: string;
    modelDisplayName: string;
    generationProtocol?: string;
    attachment: MessageAttachment;
    artifact: ArtifactRecord;
  }>;
  generateVideoWithDefaultModel?: (input: {
    prompt: string;
    toolCallId?: string | null;
  }) => Promise<{
    fileName: string;
    absolutePath: string;
    mimeType: string;
    modelId: string;
    providerId: string;
    modelDisplayName: string;
    attachment: MessageAttachment;
    artifact: ArtifactRecord;
  }>;
  abortSignal?: AbortSignal;
  listMcpResources: (server?: string) => Promise<any[]>;
  listMcpResourceTemplates: (server?: string) => Promise<any[]>;
  listMcpTools: (server?: string) => Promise<Array<{ server: string; name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }>>;
  readMcpResource: (server: string, uri: string) => Promise<any>;
  listMcpPrompts: (server?: string) => Promise<any[]>;
  getMcpPrompt: (server: string, name: string, args?: Record<string, string>) => Promise<any>;
  getMcpToolApprovalMode: (server: string, tool: string) => "auto" | "prompt" | "writes" | "approve";
  callMcpTool: (server: string, tool: string, argumentsJson: Record<string, unknown>) => Promise<any>;
  databaseSourceIds?: string[];
  listDatabaseSources?: () => Promise<Array<{ id: string; name: string; engine: string; host: string; port: number; database: string }>>;
  describeDatabaseSchema?: (sourceId: string, schema?: string) => Promise<any>;
  queryDatabase?: (sourceId: string, sql: string, parameters: unknown[], maxRows?: number) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number; durationMs: number }>;
  executeDatabase?: (sourceId: string, sql: string, parameters: unknown[], operation: "insert" | "update" | "delete") => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number; durationMs: number }>;
  deferredToolSpecs?: ToolSpecDefinition[];
  hiddenToolNames?: string[];
  /** Hard runtime guard for child agents; hiding schemas alone is insufficient. */
  readOnlyAgent?: boolean;
  loadSkill?: (skillId: string) => Promise<{ skill: { qualifiedName: string; domain?: string; scope: string }; content: string }>;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolRuntimeContext,
  runtime: ToolRuntime
) => Promise<ToolResult>;

interface ToolRegistration {
  spec: ToolSpecDefinition;
  handler: ToolHandler;
}

type TerminalCommandResult = {
  output: string;
  localUrl?: string;
  stalled?: boolean;
  diagnosis?: string;
};

const TOOL_ALIASES: Record<string, string> = {
  read: "fs.read_directory",
  read_file: "fs.read_file",
  read_directory: "fs.read_directory",
  list_directory: "fs.read_directory",
  write_file: "fs.write_file",
  applypatch: "apply_patch",
  execute_command: "shell.exec",
  image_gen: "image.generate",
  imagegen: "image.generate",
  "image-gen": "image.generate",
  generate_image: "image.generate",
  video_gen: "video.generate",
  videogen: "video.generate",
  "video-gen": "video.generate",
  generate_video: "video.generate"
};

const CHILD_READ_ONLY_FORBIDDEN_TOOLS = new Set([
  "apply_patch", "fs.write_file", "shell.exec", "shell.cancel_active", "request_permissions", "request_user_input", "mcp.call", "database.list_sources", "database.describe_schema", "database.query", "database.insert", "database.update", "database.delete", "database.federated_query",
  "image.generate", "video.generate",
  "git.stage_file", "git.stage_all", "git.unstage_file", "git.revert_file", "git.apply_hunk",
  "git.commit", "git.push", "git.pull", "git.create_pr", "git.worktree_add", "git.worktree_remove",
  "browser.open_tab", "browser.click", "browser.fill", "browser.select_option", "browser.press_key",
  "browser.navigate", "browser.reload", "browser.back", "browser.forward", "browser.go_back", "browser.go_forward",
  "browser.focus_tab", "browser.scroll", "browser.set_viewport", "browser.capture_screenshot", "browser.capture_snapshot"
]);

export function canonicalizeToolName(name: string): string {
  const trimmed = name.trim();
  return TOOL_ALIASES[trimmed] ?? TOOL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export class ToolRuntime {
  readonly #registry = new Map<string, ToolRegistration>();

  public constructor(private readonly deferredToolThreshold = 100) {
    registerBuiltinTools(this);
  }

  public register(spec: ToolSpecDefinition, handler: ToolHandler): void {
    if (this.#registry.has(fullyQualifiedName(spec))) {
      throw new Error(`Duplicate tool registration: ${fullyQualifiedName(spec)}`);
    }
    this.#registry.set(fullyQualifiedName(spec), { spec, handler });
  }

  public listToolSpecs(extra: ToolSpecDefinition[] = []): {
    direct: ToolSpecDefinition[];
    deferred: ToolSpecDefinition[];
  } {
    const builtins = [...this.#registry.values()].map((entry) => entry.spec);
    const combined = [...builtins, ...extra];
    const direct = combined.filter((spec) => spec.exposure !== "deferred");
    const deferred = combined.filter((spec) => spec.exposure === "deferred");

    if (direct.length > this.deferredToolThreshold) {
      return {
        direct: combined.filter((spec) => spec.name === "tool_search"),
        deferred: combined.filter((spec) => spec.name !== "tool_search")
      };
    }

    return { direct, deferred };
  }

  public async execute(
    call: RuntimeToolCall,
    ctx: ToolRuntimeContext
  ): Promise<ToolResult> {
    const canonicalName = canonicalizeToolName(call.name);
    if (ctx.readOnlyAgent && CHILD_READ_ONLY_FORBIDDEN_TOOLS.has(canonicalName)) {
      return {
        ok: false,
        content: `Child agents are read-only; ${canonicalName} is unavailable.`
      };
    }
    let registration =
      this.#registry.get(call.name) ||
      this.#registry.get(canonicalizeToolName(call.name)) ||
      this.#registry.get(call.name.replace(/^([^:]+)\./, "$1:"));
    if (!registration && TOOL_ALIASES[call.name]) {
      registration = this.#registry.get(TOOL_ALIASES[call.name]);
    }
    if (!registration) {
      throw new Error(`Unknown tool: ${call.name}`);
    }

    const argumentsValue = normalizeToolArguments(call.arguments);
    const validationErrors = validateToolArguments(registration.spec.inputSchema, argumentsValue);
    if (validationErrors.length > 0) {
      return {
        ok: false,
        content:
          `Invalid arguments for ${registration.spec.name}: ${validationErrors.join(" ")} ` +
          "Correct the arguments and call the same listed tool again."
      };
    }

    return registration.handler(argumentsValue, ctx, this);
  }

  public searchTools(query: string, extra: ToolSpecDefinition[] = []): ToolSearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const specs = [...this.#registry.values()].map((entry) => entry.spec).concat(extra);

    return specs
      .map((spec) => {
        const haystack = `${fullyQualifiedName(spec)} ${spec.description}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return {
          name: fullyQualifiedName(spec),
          description: spec.description,
          score,
          source: spec.source ?? "builtin"
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
  }
}

function normalizeToolArguments(argumentsValue: unknown): Record<string, unknown> {
  if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
    return normalizeLegacyToolArguments(argumentsValue as Record<string, unknown>);
  }
  if (typeof argumentsValue !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsValue);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalizeLegacyToolArguments(parsed as Record<string, unknown>);
    }
  } catch {
    // Tool validation below will report missing required fields in the normal way.
  }
  return {};
}

function normalizeLegacyToolArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  if (typeof argumentsValue.patch !== "string" && typeof argumentsValue.patch_content === "string") {
    return { ...argumentsValue, patch: argumentsValue.patch_content };
  }
  return argumentsValue;
}

function validateToolArguments(schema: Record<string, unknown>, value: Record<string, unknown>): string[] {
  return validateJsonSchemaValue(schema, value, "arguments");
}

function validateJsonSchemaValue(schema: Record<string, unknown>, value: unknown, label: string): string[] {
  if (Array.isArray(schema.anyOf)) {
    const alternatives = schema.anyOf.filter(isRecord);
    if (alternatives.some((alternative) => validateJsonSchemaValue(alternative, value, label).length === 0)) {
      return [];
    }
    return [`${label} does not match any accepted argument format.`];
  }

  const errors: string[] = [];
  const type = typeof schema.type === "string" ? schema.type : undefined;
  const actualType = jsonValueType(value);
  if (type && !matchesJsonSchemaType(type, value)) {
    return [`${label} must be ${articleFor(type)} ${type}.`];
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${label} must be one of: ${schema.enum.map(String).join(", ")}.`);
  }

  if ((type === "object" || (!type && schema.properties)) && actualType === "object") {
    const record = value as Record<string, unknown>;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
    for (const key of required) {
      if (!(key in record) || record[key] === undefined || record[key] === null) {
        errors.push(`${label}.${key} is required.`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in record) || record[key] === undefined) continue;
      if (isRecord(propertySchema)) {
        errors.push(...validateJsonSchemaValue(propertySchema, record[key], `${label}.${key}`));
      }
    }
  }

  if (type === "array" && Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchemaValue(schema.items as Record<string, unknown>, item, `${label}[${index}]`));
    });
  }

  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function jsonValueType(value: unknown): "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value as "string" | "number" | "boolean";
}

function matchesJsonSchemaType(type: string, value: unknown): boolean {
  const actualType = jsonValueType(value);
  return type === "number"
    ? actualType === "number" || actualType === "integer"
    : actualType === type;
}

function articleFor(type: string): string {
  return /^[aeiou]/i.test(type) ? "an" : "a";
}

function registerBuiltinTools(runtime: ToolRuntime): void {
  runtime.register(
    {
      name: "skills.load",
      description: "Load the complete SKILL.md instructions for a listed skill before using that skill. Explicitly selected skills should be loaded first when relevant.",
      inputSchema: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            description: "The exact skill_id from the Available Skills catalog."
          }
        },
        required: ["skill_id"]
      },
      riskLevel: "low",
      parallelSafe: true
    },
    async (args, ctx) => {
      if (!ctx.loadSkill) {
        return { ok: false, content: "Skill loading is not available for this task." };
      }
      const loaded = await ctx.loadSkill(String(args.skill_id ?? ""));
      return {
        ok: true,
        content: `# Loaded Skill: ${loaded.skill.qualifiedName}\nDomain: ${loaded.skill.domain ?? "通用"}\n\n${loaded.content}`,
        json: {
          skill: loaded.skill.qualifiedName,
          domain: loaded.skill.domain ?? "通用",
          instructions: loaded.content
        }
      };
    }
  );

  runtime.register(
    {
      name: "tool_search",
      description: "Search built-in and deferred tools by keyword.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      },
      riskLevel: "low",
      parallelSafe: true
    },
    async (args, ctx, self) => {
      const hidden = new Set(ctx.hiddenToolNames ?? []);
      const results = self.searchTools(String(args.query ?? ""), ctx.deferredToolSpecs)
        .filter((entry) => !hidden.has(entry.name));
      return { ok: true, content: JSON.stringify(results, null, 2), json: { results } };
    }
  );

  runtime.register(
    {
      name: "fs.read_file",
      description:
        "Read a UTF-8 text file from disk. Optional offset (1-based line) and limit (line count) return a numbered slice. For large files prefer code.outline first.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "1-based start line (optional)" },
          limit: { type: "number", description: "Max lines to return (optional)" }
        },
        required: ["path"]
      },
      riskLevel: "low",
      parallelSafe: true
    },
    async (args, ctx) => {
      const filePath = resolveFromCwd(ctx.cwd, String(args.path));
      const content = await ctx.readFile(filePath);
      const lines = content.split(/\r?\n/);
      const totalLines = lines.length;
      const rawOffset = Number(args.offset);
      const rawLimit = Number(args.limit);
      const hasSlice =
        (Number.isFinite(rawOffset) && rawOffset >= 1) ||
        (Number.isFinite(rawLimit) && rawLimit > 0);
      if (!hasSlice) {
        return { ok: true, content, json: { path: filePath, content, totalLines, sha256: sha256(content) } };
      }
      const startLine = Number.isFinite(rawOffset) && rawOffset >= 1 ? Math.floor(rawOffset) : 1;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : totalLines;
      const slice = lines.slice(startLine - 1, startLine - 1 + limit);
      const endLine = startLine - 1 + slice.length;
      const numbered = slice
        .map((line, index) => `${String(startLine + index).padStart(6, " ")}|${line}`)
        .join("\n");
      const header = `File ${filePath} lines ${startLine}-${endLine} of ${totalLines}`;
      return {
        ok: true,
        content: `${header}\n${numbered}`,
        json: { path: filePath, totalLines, startLine, endLine, content: numbered, sha256: sha256(content) }
      };
    }
  );

  runtime.register(
    spec(
      "code.outline",
      "List code symbols (functions/classes) with line ranges for a source file. Use before reading large files.",
      ["path"],
      "low"
    ),
    async (args, ctx) => {
      const relativePath = String(args.path ?? "");
      const filePath = resolveFromCwd(ctx.cwd, relativePath);
      const language = languageFromPath(filePath);
      if (!language) {
        return {
          ok: false,
          content: `Unsupported language for outline: ${relativePath || filePath}`
        };
      }
      const source = await ctx.readFile(filePath);
      const symbols = await extractSymbols(source, language);
      const lines = symbols.map(
        (symbol) =>
          `${symbol.kind} ${symbol.name} @${symbol.startLine}-${symbol.endLine}`
      );
      const content =
        lines.length > 0
          ? `Outline ${relativePath || filePath} (${language})\n${lines.join("\n")}`
          : `Outline ${relativePath || filePath} (${language}): no symbols found.`;
      return {
        ok: true,
        content,
        json: {
          path: relativePath || filePath,
          language,
          symbols: symbols.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            startLine: symbol.startLine,
            endLine: symbol.endLine
          }))
        }
      };
    }
  );

  runtime.register(
    spec(
      "fs.write_file",
      "Write a UTF-8 text file to disk.",
      ["path", "content"],
      "medium"
    ),
    async (args, ctx) => {
      const filePath = resolveFromCwd(ctx.cwd, String(args.path));
      const content = String(args.content ?? "");
      const approved = await ctx.requestApproval({
        title: "写入文件",
        description: filePath,
        riskLevel: "medium",
        payload: { path: filePath }
      });
      if (!approved) {
        return { ok: false, content: "写入文件被拒绝。" };
      }
      let before = "";
      try {
        before = await ctx.readFile(filePath);
      } catch {
        // A new file has no prior text snapshot.
      }
      await ctx.writeFile(filePath, content);
      const relativePath = path.relative(ctx.cwd, filePath).split(path.sep).join("/");
      return {
        ok: true,
        content: `Wrote ${filePath}`,
        json: {
          path: filePath,
          snapshots: [createTextSnapshot(relativePath, before, content)]
        }
      };
    }
  );

  runtime.register(
    spec("fs.read_directory", "List direct children under a directory.", ["path"], "low"),
    async (args, ctx) => {
      const target = resolveFromCwd(ctx.cwd, String(args.path ?? "."));
      const entries = await ctx.listFiles(target);
      const content = entries.length > 0
        ? `Directory listing succeeded:\n${entries.join("\n")}`
        : "Directory listing succeeded. The selected project folder is empty. Create the requested files now with apply_patch; do not list this directory again.";
      return { ok: true, content, json: { path: target, entries } };
    }
  );

  runtime.register(
    spec("code.search", "Search the current workspace for a keyword.", ["pattern"], "low"),
    async (args, ctx) => {
      const command = buildCodeSearchCommand(String(args.pattern ?? ""), ctx.cwd);
      const terminal = await runShell(command, ctx);
      const outputLines = terminal.output.replace(/\r\n/g, "\n").split("\n");
      const output = outputLines.length > MAX_CODE_SEARCH_RESULT_LINES
        ? `${outputLines.slice(0, MAX_CODE_SEARCH_RESULT_LINES).join("\n")}\n...[search output truncated]`
        : terminal.output;
      return { ok: true, content: output, json: { pattern: args.pattern, output } };
    }
  );

  runtime.register(
    spec(
      "code.ast_diff",
      "Compare two versions of a source file at the AST/entity level (functions, classes, methods). Pass path; optionally against another file path. Without against, compares the working tree file to git HEAD (or empty if untracked).",
      ["path"],
      "low"
    ),
    async (args, ctx) => {
      const relativePath = String(args.path ?? "");
      const filePath = resolveFromCwd(ctx.cwd, relativePath);
      const after = await fs.readFile(filePath, "utf8");
      let before = "";
      let againstLabel = "empty";

      if (typeof args.against === "string" && args.against.trim()) {
        const againstPath = resolveFromCwd(ctx.cwd, String(args.against));
        before = await fs.readFile(againstPath, "utf8");
        againstLabel = String(args.against);
      } else {
        try {
          const posixPath = relativePath.replace(/\\/g, "/");
          before = (await runShell(`git show HEAD:${escapeDoubleQuotes(posixPath)}`, ctx)).output;
          againstLabel = "HEAD";
        } catch {
          before = "";
          againstLabel = "empty";
        }
      }

      const result = await astDiffSources(before, after, relativePath);
      const header = `AST diff ${relativePath} vs ${againstLabel} (${result.language ?? "unsupported"})`;
      const content = `${header}\n${result.summary}`;
      return {
        ok: true,
        content,
        json: {
          path: relativePath,
          against: againstLabel,
          language: result.language,
          entities: result.entities,
          summary: result.summary
        }
      };
    }
  );

  runtime.register(
    spec("shell.exec", "Run a shell command inside the current workspace.", ["command"], "high"),
    async (args, ctx) => {
      let command = String(args.command ?? "");
      if (ctx.webFrontendGuard) {
        const prepared = prepareShellCommandForWebFrontend(command);
        if (!prepared.ok) {
          return { ok: false, content: prepared.error ?? "Command blocked for web frontend task." };
        }
        command = prepared.command;
      } else {
        // Always prefer http-server over python -m http.server when present.
        const prepared = prepareShellCommandForWebFrontend(command);
        if (prepared.rewritten) {
          command = prepared.command;
        }
      }
      const approved = await ctx.requestApproval({
        title: "执行命令",
        description: command,
        riskLevel: "high",
        payload: { command }
      });
      if (!approved) {
        return { ok: false, content: "命令执行被拒绝。" };
      }
      const terminal = await runShell(command, ctx);
      return {
        ok: terminal.stalled !== true,
        content: terminal.output,
        json: {
          command,
          output: terminal.output,
          localUrl: terminal.localUrl,
          stalled: terminal.stalled,
          diagnosis: terminal.diagnosis
        }
      };
    }
  );

  runtime.register(
    spec(
      "apply_patch",
      "Apply a Codex patch. Pass arguments.patch as raw text beginning with *** Begin Patch and ending with *** End Patch. Use *** Add File: relative/path for new files.",
      ["patch"],
      "high"
    ),
    async (args, ctx) => {
      const patchText = normalizeApplyPatchInput(args);
      const requiresApproval = /^\*\*\* Delete File:/m.test(patchText) || ctx.executionPolicy?.mode !== "controlled";
      const approved = !requiresApproval || await ctx.requestApproval({
        title: "应用补丁",
        description: "将对多个文件写入或删除内容。",
        riskLevel: "high",
        payload: { patchPreview: patchText.slice(0, 500) }
      });
      if (!approved) {
        return { ok: false, content: "补丁应用被拒绝。" };
      }
      let result: Awaited<ReturnType<typeof applyCodexPatch>>;
      try {
        result = await applyCodexPatch(patchText, ctx.cwd, { expectedVersions: ctx.expectedFileVersions });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          content: buildApplyPatchFailureMessage(reason)
        };
      }
      const symbolLines = result.changes
        .flatMap((change) =>
          (change.symbols ?? []).map(
            (symbol) => `${change.path}: ${symbol.change} ${symbol.kind} ${symbol.name}`
          )
        )
        .slice(0, 40);
      const content = [
        "Patch committed atomically.",
        result.touched.join("\n"),
        symbolLines.length > 0 ? `Entity changes:\n${symbolLines.join("\n")}` : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        ok: true,
        content,
        json: { touched: result.touched, changes: result.changes, transaction: result.transaction, snapshots: result.snapshots }
      };
    }
  );

  runtime.register(
    spec(
      "project.verify",
      "Run configured safe project verification commands. Without an explicit project policy, this runs package.json typecheck and test scripts when present. It never installs dependencies or starts a persistent service.",
      [],
      "low"
    ),
    async (_args, ctx) => runProjectVerification(ctx)
  );

  runtime.register(
    spec(
      "git.status",
      "Read git status for the current repository. Returns a clear notice when the workspace is not a git repo.",
      [],
      "low"
    ),
    async (_args, ctx) => {
      const probe = await probeGitRepository(ctx);
      if (!probe.isGitRepository) {
        return gitNotRepositoryResult();
      }
      const output = (await runShell("git status --short --branch", ctx)).output;
      return { ok: true, content: output, json: { output, isGitRepository: true } };
    }
  );

  runtime.register(
    spec(
      "git.diff",
      "Read git diff for the current repository. Returns a clear notice when the workspace is not a git repo.",
      [],
      "low"
    ),
    async (_args, ctx) => {
      const probe = await probeGitRepository(ctx);
      if (!probe.isGitRepository) {
        return gitNotRepositoryResult();
      }
      const output = (await runShell("git diff --no-ext-diff", ctx)).output;
      const astSummary = await buildGitDiffAstSummary(ctx, output);
      const astText =
        astSummary.length > 0
          ? `\n\nAST entity summary:\n${astSummary
              .map((entry) => `${entry.path}\n${entry.summary}`)
              .join("\n\n")}`
          : "";
      return {
        ok: true,
        content: `${output}${astText}`,
        json: {
          output,
          isGitRepository: true,
          astSummary: astSummary.length > 0 ? astSummary : undefined
        }
      };
    }
  );

  runtime.register(
    spec("git.commit", "Create a git commit with a message.", ["message"], "high"),
    async (args, ctx) => {
      const probe = await probeGitRepository(ctx);
      if (!probe.isGitRepository) {
        return { ...gitNotRepositoryResult(), ok: false };
      }
      const message = String(args.message ?? "");
      const approved = await ctx.requestApproval({
        title: "创建提交",
        description: message,
        riskLevel: "high",
        payload: { message }
      });
      if (!approved) {
        return { ok: false, content: "提交被拒绝。" };
      }
      const output = (await runShell(`git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`, ctx)).output;
      return { ok: true, content: output, json: { output } };
    }
  );

  runtime.register(
    spec("git.worktree_list", "List git worktrees for the current repository.", [], "low"),
    async (_args, ctx) => {
      const probe = await probeGitRepository(ctx);
      if (!probe.isGitRepository) {
        return gitNotRepositoryResult();
      }
      const output = (await runShell("git worktree list --porcelain", ctx)).output;
      return { ok: true, content: output, json: { output, isGitRepository: true } };
    }
  );

  runtime.register(
    spec("git.worktree_add", "Create a git worktree for a branch.", ["path", "branch"], "high"),
    async (args, ctx) => {
      const probe = await probeGitRepository(ctx);
      if (!probe.isGitRepository) {
        return { ...gitNotRepositoryResult(), ok: false };
      }
      const targetPath = resolveFromCwd(ctx.cwd, String(args.path ?? ""));
      const branch = String(args.branch ?? "");
      const base = typeof args.base === "string" ? args.base : "HEAD";
      const command = `git worktree add "${escapeDoubleQuotes(targetPath)}" -b "${escapeDoubleQuotes(branch)}" "${escapeDoubleQuotes(base)}"`;
      const approved = await ctx.requestApproval({
        title: "创建 worktree",
        description: command,
        riskLevel: "high",
        payload: { path: targetPath, branch, base }
      });
      if (!approved) {
        return { ok: false, content: "创建 worktree 被拒绝。" };
      }
      const output = (await runShell(command, ctx)).output;
      return { ok: true, content: output, json: { path: targetPath, branch, base, output } };
    }
  );

  runtime.register(
    spec("git.worktree_remove", "Remove a git worktree path.", ["path"], "high"),
    async (args, ctx) => {
      const probe = await probeGitRepository(ctx);
      if (!probe.isGitRepository) {
        return { ...gitNotRepositoryResult(), ok: false };
      }
      const targetPath = resolveFromCwd(ctx.cwd, String(args.path ?? ""));
      const command = `git worktree remove "${escapeDoubleQuotes(targetPath)}" --force`;
      const approved = await ctx.requestApproval({
        title: "移除 worktree",
        description: command,
        riskLevel: "high",
        payload: { path: targetPath }
      });
      if (!approved) {
        return { ok: false, content: "移除 worktree 被拒绝。" };
      }
      const output = (await runShell(command, ctx)).output;
      return { ok: true, content: output, json: { path: targetPath, output } };
    }
  );

  runtime.register(
    spec("knowledge.search", "Search local knowledge chunks. Results include chunk id, source path, locator, excerpt, and score; search before reading.", ["query"], "low"),
    async (args, ctx) => {
      const results = await ctx.searchKnowledge(String(args.query ?? ""), Array.isArray(args.knowledgeBaseIds) ? args.knowledgeBaseIds.map(String) : undefined);
      return {
        ok: true,
        content: JSON.stringify(results, null, 2),
        json: { results }
      };
    }
  );

  runtime.register(
    spec("knowledge.read", "Read one local knowledge chunk by its id after search.", ["conceptId"], "low"),
    async (args, ctx) => {
      const concept = await ctx.readKnowledgeConcept(String(args.conceptId ?? ""));
      return {
        ok: !!concept,
        content: concept ? concept.content ?? concept.body ?? JSON.stringify(concept, null, 2) : "Not found",
        json: { concept }
      };
    }
  );

  runtime.register(
    spec("web_search.search_query", "Search the web for a topic.", ["query"], "low"),
    async (args, ctx) => {
      const results = await ctx.webSearch(String(args.query ?? ""));
      if (results.length === 0) {
        return {
          ok: true,
          content:
            "No search results are currently available. Do not retry the same query, invent a URL, or add a year the user did not request. Explain this limitation clearly and end the task.",
          json: { results, unavailable: true }
        };
      }
      return { ok: true, content: JSON.stringify(results, null, 2), json: { results } };
    }
  );

  runtime.register(
    spec("web_search.open_page", "Open a web page and extract text.", ["url"], "medium"),
    async (args, ctx) => {
      const page = await ctx.openPage(String(args.url ?? ""));
      const forModel = pageForModel(page) ?? { text: "" };
      const text = truncatePageText(String(forModel.text ?? ""));
      return { ok: true, content: text, json: forModel };
    }
  );

  runtime.register(
    spec("web_search.find_in_page", "Find text inside a previously opened page URL.", ["url", "pattern"], "low"),
    async (args, ctx) => {
      const matches = await ctx.findInPage(String(args.url ?? ""), String(args.pattern ?? ""));
      return { ok: true, content: matches.join("\n"), json: { matches } };
    }
  );

  runtime.register(
    spec("browser.open_tab", "Open a browser tab in the thread workspace.", ["url"], "medium"),
    async (args, ctx) => {
      const url = String(args.url ?? "");
      const approved = await ctx.requestApproval({
        title: "打开浏览器标签",
        description: url,
        riskLevel: "medium",
        payload: { url }
      });
      if (!approved) {
        return { ok: false, content: "打开浏览器标签被拒绝。" };
      }
      const result = await ctx.openBrowserTab(url);
      return {
        ok: true,
        content: `${result.tab.title}\n${result.tab.url}${result.reused ? "\n(reused existing tab)" : ""}`,
        json: {
          tab: result.tab,
          page: pageForModel(result.page),
          reused: result.reused === true
        }
      };
    }
  );

  runtime.register(
    spec("browser.navigate", "Navigate an existing browser tab to a new URL.", ["tabId", "url"], "medium"),
    async (args, ctx) => {
      const tabId = String(args.tabId ?? "");
      const url = String(args.url ?? "");
      const approved = await ctx.requestApproval({
        title: "浏览器导航",
        description: `${tabId} -> ${url}`,
        riskLevel: "medium",
        payload: { tabId, url }
      });
      if (!approved) {
        return { ok: false, content: "浏览器导航被拒绝。" };
      }
      const result = await ctx.navigateBrowserTab(tabId, url);
      return {
        ok: true,
        content: `${result.tab.title}\n${result.tab.url}`,
        json: { tab: result.tab, page: pageForModel(result.page) }
      };
    }
  );

  runtime.register(
    spec("browser.reload", "Reload a browser tab.", ["tabId"], "low"),
    async (args, ctx) => {
      const result = await ctx.reloadBrowserTab(String(args.tabId ?? ""));
      const text = truncatePageText(result.page.text ?? "");
      return {
        ok: true,
        content: text,
        json: { tab: result.tab, page: pageForModel(result.page) }
      };
    }
  );

  runtime.register(
    spec("browser.go_back", "Go back in a browser tab history.", ["tabId"], "low"),
    async (args, ctx) => {
      const result = await ctx.goBackBrowserTab(String(args.tabId ?? ""));
      const text = truncatePageText(result.page.text ?? "");
      return {
        ok: true,
        content: text,
        json: { tab: result.tab, page: pageForModel(result.page) }
      };
    }
  );

  runtime.register(
    spec("browser.go_forward", "Go forward in a browser tab history.", ["tabId"], "low"),
    async (args, ctx) => {
      const result = await ctx.goForwardBrowserTab(String(args.tabId ?? ""));
      const text = truncatePageText(result.page.text ?? "");
      return {
        ok: true,
        content: text,
        json: { tab: result.tab, page: pageForModel(result.page) }
      };
    }
  );

  runtime.register(
    spec("browser.list_tabs", "List browser tabs for the current thread.", [], "low"),
    async (_args, ctx) => {
      const tabs = await ctx.listBrowserTabs();
      return {
        ok: true,
        content: tabs.map((tab) => `${tab.id} ${tab.isActive ? "*" : "-"} ${tab.title} ${tab.url}`).join("\n"),
        json: { tabs }
      };
    }
  );

  runtime.register(
    spec("browser.focus_tab", "Focus an existing browser tab.", ["tabId"], "low"),
    async (args, ctx) => {
      const tab = await ctx.focusBrowserTab(String(args.tabId ?? ""));
      return { ok: true, content: `${tab.title}\n${tab.url}`, json: { tab } };
    }
  );

  runtime.register(
    spec("browser.read_page_text", "Read the current text content of a browser tab.", ["tabId"], "low"),
    async (args, ctx) => {
      const page = await ctx.readBrowserPageText(String(args.tabId ?? ""));
      const forModel = pageForModel(page) ?? { text: "" };
      const text = truncatePageText(String(forModel.text ?? ""));
      return { ok: true, content: text, json: forModel };
    }
  );

  runtime.register(
    spec("browser.capture_snapshot", "Save the current browser tab as an HTML snapshot artifact.", ["tabId"], "medium"),
    async (args, ctx) => {
      const snapshot = await ctx.captureBrowserSnapshot(String(args.tabId ?? ""));
      return {
        ok: true,
        content: `${snapshot.title}\n${snapshot.filePath}`,
        json: snapshot,
        artifacts: [snapshot.artifact]
      };
    }
  );

  runtime.register(
    {
      name: "request_user_input",
      description: "Request user input for one to four short, material decisions and wait for the response. Use only when the task cannot safely proceed without the user's choice. Provide 2-3 mutually exclusive options for each question; free-form input is available automatically.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                prompt: { type: "string" },
                allowFreeText: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    anyOf: [
                      { type: "string" },
                      {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          label: { type: "string" },
                          description: { type: "string" },
                          recommended: { type: "boolean" }
                        },
                        required: ["id", "label"]
                      }
                    ]
                  }
                }
              },
              required: ["id", "label", "prompt", "options"]
            }
          }
        },
        required: ["title", "questions"]
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      if (ctx.requestUserInputEnabled !== true) {
        return { ok: false, content: "request_user_input is only available while GPA mode is active." };
      }

      const rawQuestions = Array.isArray(args.questions) ? args.questions.slice(0, 4) : [];
      const questions = rawQuestions.map((question, index) => ({
        id: String((question as any).id ?? `q${index + 1}`),
        label: String((question as any).label ?? `Q${index + 1}`),
        prompt: String((question as any).prompt ?? ""),
        options: Array.isArray((question as any).options)
          ? (question as any).options.slice(0, 4).map((option: unknown, optionIndex: number) => typeof option === "string"
            ? { id: `option_${optionIndex + 1}`, label: option }
            : {
                id: String((option as any)?.id ?? `option_${optionIndex + 1}`),
                label: String((option as any)?.label ?? "选项"),
                description: typeof (option as any)?.description === "string" ? (option as any).description : undefined,
                recommended: (option as any)?.recommended === true
              })
          : [],
        allowFreeText: true
      }));
      if (questions.length === 0 || questions.some((question) => question.options.length === 0)) {
        return { ok: false, content: "request_user_input requires one to four questions with non-empty options." };
      }
      const answers = await ctx.requestUserInput({
        title: String(args.title ?? "Need input"),
        questions
      });
      const selections = questions.map((question) => {
        const value = answers[question.id] ?? "";
        const option = question.options?.find((item: { id: string }) => item.id === value);
        const note = answers[`${question.id}__note`]?.replace(/^__note__:/, "") ?? "";
        return {
          question: question.prompt,
          answer: option?.label ?? value.replace(/^__custom__:/, ""),
          note: note || undefined
        };
      });
      return {
        ok: true,
        content: JSON.stringify({ answers, selections }, null, 2),
        json: { answers, selections }
      };
    }
  );

  runtime.register(
    spec("request_permissions", "Request a one-off permission approval.", ["title", "description"], "medium"),
    async (args, ctx) => {
      const approved = await ctx.requestApproval({
        title: String(args.title ?? "Permission request"),
        description: String(args.description ?? ""),
        riskLevel: "medium",
        payload: args
      });
      return { ok: approved, content: approved ? "Approved" : "Denied", json: { approved } };
    }
  );

  runtime.register(
    spec("multi_agents.spawn", "Spawn a bounded child agent session for independent research, review, or diagnosis.", ["prompt", "role"], "medium"),
    async (args, ctx) => {
      const child = await ctx.spawnChildAgent({
        prompt: String(args.prompt ?? ""),
        role: String(args.role ?? "implementer"),
        modelId: typeof args.modelId === "string" ? args.modelId : undefined
      });
      return {
        ok: true,
        content: `Spawned ${child.agentPath} (${child.status})`,
        json: child
      };
    }
  );

  runtime.register(
    spec("shell.cancel_active", "Stop active shell commands for the current task after diagnosis confirms they should be interrupted.", [], "medium"),
    async (args, ctx) => {
      if (!ctx.cancelActiveTerminalCommands) {
        return { ok: false, content: "No active terminal command controller is available." };
      }
      const reason = typeof args.reason === "string" ? args.reason : "Cancelled after diagnostic review.";
      const approved = await ctx.requestApproval({
        title: "Stop active command",
        description: reason,
        riskLevel: "medium",
        payload: { reason }
      });
      if (!approved) {
        return { ok: false, content: "Stopping the active command was denied." };
      }
      await ctx.cancelActiveTerminalCommands(reason);
      return { ok: true, content: "Requested termination of active shell commands.", json: { reason } };
    }
  );

  runtime.register(
    spec("multi_agents.send_message", "Queue additional context for an existing child agent without starting a turn.", ["agent", "message"], "low"),
    async (args, ctx) => {
      const result = await ctx.sendAgentMessage({
        agent: String(args.agent ?? ""),
        message: String(args.message ?? "")
      });
      return { ok: true, content: JSON.stringify(result), json: { ...result } };
    }
  );

  runtime.register(
    spec("multi_agents.followup_task", "Resume an existing child agent with a bounded follow-up task.", ["agent", "prompt"], "low"),
    async (args, ctx) => {
      const result = await ctx.followupAgentTask({ agent: String(args.agent ?? ""), prompt: String(args.prompt ?? "") });
      return { ok: result.status !== "failed", content: JSON.stringify(result), json: { ...result } };
    }
  );

  runtime.register(
    {
      name: "multi_agents.wait",
      description: "Wait for one or more child agents to reach a terminal state.",
      inputSchema: {
        type: "object",
        properties: {
          agents: { type: "array", items: { type: "string" } },
          timeoutMs: { type: "integer", minimum: 250, maximum: 30000 }
        },
        required: []
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      const agents = Array.isArray(args.agents) ? args.agents.map(String) : undefined;
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
      const result = await ctx.waitForSubagents({ agents, timeoutMs });
      return {
        // A timeout is a valid status update, not a failed tool execution. The
        // root runtime decides whether it must continue waiting.
        ok: true,
        content: JSON.stringify(result),
        json: { agents: result.agents, timedOut: result.timedOut }
      };
    }
  );

  runtime.register(
    spec("multi_agents.interrupt", "Interrupt an existing child agent while preserving its context.", ["agent"], "medium"),
    async (args, ctx) => {
      const result = await ctx.interruptAgent(String(args.agent ?? ""));
      return { ok: true, content: JSON.stringify(result), json: { ...result } };
    }
  );

  runtime.register(
    spec("multi_agents.list", "List the current child-agent tree and statuses.", [], "low"),
    async (_args, ctx) => {
      const agents = await ctx.listSubagents();
      return { ok: true, content: JSON.stringify(agents), json: { agents } };
    }
  );

  runtime.register(
    spec("mcp.list_tools", "List discoverable tools from enabled MCP servers before calling mcp.call.", [], "low"),
    async (args, ctx) => {
      const tools = await ctx.listMcpTools(typeof args.server === "string" ? args.server : undefined);
      return { ok: true, content: JSON.stringify(tools, null, 2), json: { tools } };
    }
  );

  runtime.register(
    spec("list_mcp_prompts", "List reusable prompts from configured MCP servers.", [], "low"),
    async (args, ctx) => {
      const prompts = await ctx.listMcpPrompts(typeof args.server === "string" ? args.server : undefined);
      return { ok: true, content: JSON.stringify(prompts, null, 2), json: { prompts } };
    }
  );

  runtime.register(
    spec("get_mcp_prompt", "Get a reusable prompt from an MCP server.", ["server", "name"], "low"),
    async (args, ctx) => {
      const prompt = await ctx.getMcpPrompt(
        String(args.server ?? ""),
        String(args.name ?? ""),
        (args.arguments as Record<string, string>) ?? {}
      );
      return { ok: true, content: JSON.stringify(prompt, null, 2), json: { prompt } };
    }
  );

  runtime.register(
    spec("browser.inspect_page", "Inspect the visible browser page before interacting. Returns page text and interactive element ids.", ["tabId"], "low"),
    async (args, ctx) => {
      const page = await ctx.inspectBrowserPage(String(args.tabId ?? ""));
      return { ok: true, content: JSON.stringify(page, null, 2), json: page };
    }
  );

  runtime.register(
    spec("browser.click", "Click an element id returned by browser.inspect_page. Inspect first and do not guess ids.", ["tabId", "elementId"], "medium"),
    async (args, ctx) => {
      const tabId = String(args.tabId ?? "");
      const elementId = String(args.elementId ?? "");
      const target = await ctx.inspectBrowserTarget(tabId, elementId);
      if (target.requiresApproval) {
        const approved = await ctx.requestApproval({
          title: "确认浏览器提交操作",
          description: target.description,
          riskLevel: "high",
          payload: { tabId, elementId, action: "click" }
        });
        if (!approved) return { ok: false, content: "Browser action was denied by the user." };
      }
      const page = await ctx.clickBrowserElement(tabId, elementId);
      return { ok: true, content: `${page.title}\n${page.url}`, json: page };
    }
  );

  runtime.register(
    spec("browser.fill", "Fill an editable element id returned by browser.inspect_page. This does not submit the form.", ["tabId", "elementId", "value"], "low"),
    async (args, ctx) => {
      const page = await ctx.fillBrowserElement(String(args.tabId ?? ""), String(args.elementId ?? ""), String(args.value ?? ""));
      return { ok: true, content: `${page.title}\n${page.url}`, json: page };
    }
  );

  runtime.register(
    spec("browser.select_option", "Select an option in a select element returned by browser.inspect_page.", ["tabId", "elementId", "value"], "low"),
    async (args, ctx) => {
      const page = await ctx.selectBrowserOption(String(args.tabId ?? ""), String(args.elementId ?? ""), String(args.value ?? ""));
      return { ok: true, content: `${page.title}\n${page.url}`, json: page };
    }
  );

  runtime.register(
    {
      name: "browser.scroll",
      description: "Scroll the visible browser page by a vertical pixel delta.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          deltaY: { type: "number" }
        },
        required: ["tabId", "deltaY"]
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      const page = await ctx.scrollBrowserPage(String(args.tabId ?? ""), Number(args.deltaY ?? 0));
      return { ok: true, content: `${page.title}\n${page.url}`, json: page };
    }
  );

  runtime.register(
    spec("browser.press_key", "Press a key in the visible browser tab. Enter requires confirmation because it may submit a form.", ["tabId", "key"], "medium"),
    async (args, ctx) => {
      const tabId = String(args.tabId ?? "");
      const key = String(args.key ?? "");
      if (key.toLowerCase() === "enter") {
        const approved = await ctx.requestApproval({
          title: "确认浏览器提交操作",
          description: "Press Enter in the active browser page.",
          riskLevel: "high",
          payload: { tabId, key, action: "press_key" }
        });
        if (!approved) return { ok: false, content: "Browser key press was denied by the user." };
      }
      const page = await ctx.pressBrowserKey(tabId, key);
      return { ok: true, content: `${page.title}\n${page.url}`, json: page };
    }
  );

  runtime.register(
    {
      name: "browser.wait_for",
      description: "Wait for text or an element id to appear after a browser action.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          text: { type: "string" },
          elementId: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["tabId"]
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      const result = await ctx.waitForBrowserPage(String(args.tabId ?? ""), {
        text: typeof args.text === "string" ? args.text : undefined,
        elementId: typeof args.elementId === "string" ? args.elementId : undefined,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined
      });
      return { ok: true, content: JSON.stringify(result), json: result };
    }
  );

  runtime.register(
    {
      name: "browser.set_viewport",
      description: "Set the browser verification viewport without reopening the current tab. Use 1440x900 for desktop and 390x844 for mobile. Set reset=true to restore the default.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          width: { type: "number", minimum: 320, maximum: 3840 },
          height: { type: "number", minimum: 320, maximum: 2160 },
          reset: { type: "boolean" }
        },
        required: ["tabId"]
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      const tabId = String(args.tabId ?? "");
      const reset = args.reset === true;
      const viewport = reset ? null : {
        width: Number(args.width ?? 1440),
        height: Number(args.height ?? 900),
        deviceScaleFactor: 1,
        mobile: Number(args.width ?? 1440) <= 500
      };
      const result = await ctx.setBrowserViewport(tabId, viewport);
      await ctx.emitBrowserVerificationEvent?.("browser.verification_started", { tabId, viewport: result.viewport });
      return { ok: true, content: JSON.stringify(result), json: result };
    }
  );

  runtime.register(
    {
      name: "browser.assert_page",
      description: "Run deterministic assertions against the current rendered browser page. Checks support url, title, text, element, images_loaded, no_horizontal_overflow, canvas_nonblank, and no_severe_console_errors.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          checks: { type: "array", minItems: 1, items: { type: "object" } }
        },
        required: ["tabId", "checks"]
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      const tabId = String(args.tabId ?? "");
      const checks = Array.isArray(args.checks) ? args.checks as BrowserAssertionCheck[] : [];
      const result = await ctx.assertBrowserPage(tabId, checks);
      await ctx.emitBrowserVerificationEvent?.("browser.assertion_completed", { tabId, ...result });
      return { ok: result.passed, content: JSON.stringify(result), json: result };
    }
  );

  runtime.register(
    {
      name: "browser.capture_screenshot",
      description: "Capture the current rendered browser page as a PNG verification artifact and image attachment.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          fullPage: { type: "boolean" }
        },
        required: ["tabId"]
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      const screenshot = await ctx.captureBrowserScreenshot(String(args.tabId ?? ""), args.fullPage === true);
      await ctx.emitBrowserVerificationEvent?.("browser.screenshot_attached", {
        tabId: String(args.tabId ?? ""),
        artifact: screenshot.artifact,
        attachment: screenshot.attachment,
        viewport: screenshot.viewport,
        width: screenshot.width,
        height: screenshot.height,
        fullPage: screenshot.fullPage
      });
      return {
        ok: true,
        content: `${screenshot.title}\n${screenshot.filePath}`,
        json: screenshot,
        artifacts: [screenshot.artifact],
        attachments: [screenshot.attachment]
      };
    }
  );

  runtime.register(
    {
      name: "image.generate",
      description:
        "Generate an image with the app's configured default image model from Settings → Multimodal. Use when the user asks to create, draw, or generate a picture.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed English or Chinese image prompt: subject, composition, style, lighting, and constraints."
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 4,
            default: 1,
            description:
              "Number of separate images to generate. Default to 1; use 2 when the user requests multiple images without an exact number."
          }
        },
        required: ["prompt"]
      },
      riskLevel: "medium",
      parallelSafe: false
    },
    async (args, ctx) => {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) {
        return { ok: false, content: "prompt 不能为空。请提供具体的生图描述。" };
      }
      if (!ctx.generateImageWithDefaultModel) {
        return {
          ok: false,
          content:
            "当前会话未接入图片生成。请到「设置 → 多模态」启用图片生成，并指定默认图片模型后再试。"
        };
      }
      try {
        const rawCount = Number(args.count ?? 1);
        const count = Number.isFinite(rawCount)
          ? Math.min(4, Math.max(1, Math.trunc(rawCount)))
          : 1;
        const results = [];
        for (let index = 0; index < count; index += 1) {
          results.push(await ctx.generateImageWithDefaultModel({
            prompt,
            toolCallId: ctx.toolCallId ?? null
          }));
        }
        const first = results[0]!;
        return {
          ok: true,
          content:
            `已使用默认图片模型 ${first.modelDisplayName} (${first.modelId}) 生成 ${count} 张图片。\n` +
            `文件：${results.map((item) => item.fileName).join("、")}`,
          json: {
            count,
            fileName: first.fileName,
            fileNames: results.map((item) => item.fileName),
            absolutePath: first.absolutePath,
            absolutePaths: results.map((item) => item.absolutePath),
            mimeType: first.mimeType,
            modelId: first.modelId,
            providerId: first.providerId,
            modelDisplayName: first.modelDisplayName,
            generationProtocol: first.generationProtocol,
            attachment: first.attachment,
            attachments: results.map((item) => item.attachment),
            artifactId: first.artifact.id,
            artifactIds: results.map((item) => item.artifact.id)
          },
          artifacts: results.map((item) => item.artifact)
        };
      } catch (error) {
        return {
          ok: false,
          content: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );

  runtime.register(
    {
      name: "video.generate",
      description:
        "Generate a video with the app's configured default video model from Settings → Multimodal. Use when the user asks to create or generate a video.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Detailed English or Chinese video prompt: subject, motion, scene, camera, style, and duration constraints."
          }
        },
        required: ["prompt"]
      },
      riskLevel: "medium",
      parallelSafe: false
    },
    async (args, ctx) => {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) {
        return { ok: false, content: "prompt 不能为空。请提供具体的视频描述。" };
      }
      if (!ctx.generateVideoWithDefaultModel) {
        return {
          ok: false,
          content:
            "当前会话未接入视频生成。请到「设置 → 多模态」启用视频生成，并指定默认视频模型后再试。"
        };
      }
      try {
        const result = await ctx.generateVideoWithDefaultModel({
          prompt,
          toolCallId: ctx.toolCallId ?? null
        });
        return {
          ok: true,
          content:
            `已使用默认视频模型 ${result.modelDisplayName} (${result.modelId}) 生成视频。\n` +
            `文件：${result.fileName}\n路径：${result.absolutePath}`,
          json: {
            fileName: result.fileName,
            absolutePath: result.absolutePath,
            mimeType: result.mimeType,
            modelId: result.modelId,
            providerId: result.providerId,
            modelDisplayName: result.modelDisplayName,
            attachment: result.attachment,
            artifactId: result.artifact.id
          },
          artifacts: [result.artifact]
        };
      } catch (error) {
        return {
          ok: false,
          content: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );

  runtime.register(
    spec("list_mcp_resources", "List resources from configured MCP servers.", [], "low"),
    async (args, ctx) => {
      const resources = await ctx.listMcpResources(typeof args.server === "string" ? args.server : undefined);
      return { ok: true, content: JSON.stringify(resources, null, 2), json: { resources } };
    }
  );

  runtime.register(
    spec("list_mcp_resource_templates", "List MCP resource templates.", [], "low"),
    async (args, ctx) => {
      const templates = await ctx.listMcpResourceTemplates(typeof args.server === "string" ? args.server : undefined);
      return { ok: true, content: JSON.stringify(templates, null, 2), json: { templates } };
    }
  );

  runtime.register(
    spec("read_mcp_resource", "Read one MCP resource.", ["server", "uri"], "low"),
    async (args, ctx) => {
      const resource = await ctx.readMcpResource(String(args.server ?? ""), String(args.uri ?? ""));
      return { ok: true, content: JSON.stringify(resource, null, 2), json: { resource } };
    }
  );

  runtime.register(
    spec("database.list_sources", "List configured database sources available to this chat and their configured permissions.", [], "low"),
    async (_args, ctx) => {
      const sources = await ctx.listDatabaseSources?.() ?? [];
      return { ok: true, content: JSON.stringify(sources, null, 2), json: { sources } };
    }
  );

  runtime.register(
    {
      name: "database.describe_schema",
      description: "Read visible schemas, tables, and columns from one configured database source.",
      inputSchema: { type: "object", properties: { sourceId: { type: "string" }, schema: { type: "string" } }, required: ["sourceId"] },
      riskLevel: "low"
    },
    async (args, ctx) => {
      if (!ctx.describeDatabaseSchema) return { ok: false, content: "Database access is unavailable." };
      const result = await ctx.describeDatabaseSchema(String(args.sourceId), typeof args.schema === "string" ? args.schema : undefined);
      return { ok: true, content: JSON.stringify(result, null, 2), json: result };
    }
  );

  runtime.register(
    {
      name: "database.query",
      description: "Execute one parameterized SELECT query against a configured database source. The configured per-connection row limit is always enforced, with a maximum of 1,000 rows.",
      inputSchema: { type: "object", properties: { sourceId: { type: "string" }, sql: { type: "string" }, parameters: { type: "array" }, maxRows: { type: "number" } }, required: ["sourceId", "sql"] },
      riskLevel: "low"
    },
    async (args, ctx) => executeDatabaseQuery(args, ctx)
  );

  for (const operation of ["insert", "update", "delete"] as const) {
    runtime.register(
      {
        name: `database.${operation}`,
        description: `Execute one parameterized ${operation.toUpperCase()} statement against a configured database source. This requires the connection permission and explicit user confirmation.`,
        inputSchema: { type: "object", properties: { sourceId: { type: "string" }, sql: { type: "string" }, parameters: { type: "array" } }, required: ["sourceId", "sql"] },
        riskLevel: "high"
      },
      async (args, ctx) => executeDatabaseMutation(operation, args, ctx)
    );
  }

  runtime.register(
    {
      name: "database.federated_query",
      description: "Run bounded read-only source queries and join their results in memory. Supports inner and left equality joins.",
      inputSchema: { type: "object", properties: { sources: { type: "array" }, joins: { type: "array" }, select: { type: "array" }, groupBy: { type: "array" }, aggregates: { type: "array" }, orderBy: { type: "string" }, orderDirection: { type: "string" }, limit: { type: "number" } }, required: ["sources", "joins"] },
      riskLevel: "low"
    },
    async (args, ctx) => executeFederatedQuery(args, ctx)
  );

  runtime.register(
    {
      name: "mcp.call",
      description: "Call a tool on a configured MCP server. For repository inspection tools, use their path, cursor, maxResults, and maxDepth arguments; start shallow and continue with nextCursor instead of requesting a whole repository.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string" },
          tool: { type: "string" },
          arguments: { type: "object" }
        },
        required: ["server", "tool", "arguments"]
      },
      riskLevel: "high"
    },
    async (args, ctx) => {
      const server = String(args.server ?? "");
      const tool = String(args.tool ?? "");
      const tools = await ctx.listMcpTools(server);
      if (!tools.some((entry) => entry.server === server && entry.name === tool)) {
        return { ok: false, content: `MCP tool ${server}:${tool} is not in the discovered tool directory.` };
      }
      const approvalMode = ctx.getMcpToolApprovalMode?.(server, tool) ?? "prompt";
      const selectedTool = tools.find((entry) => entry.server === server && entry.name === tool);
      const requiresApproval = approvalMode === "approve" || approvalMode === "prompt" ||
        (approvalMode === "writes" && selectedTool?.annotations?.readOnlyHint !== true);
      if (requiresApproval) {
        const approved = await ctx.requestApproval({
          title: "调用 MCP 工具",
          description: `${server}:${tool}`,
          riskLevel: approvalMode === "approve" ? "high" : "medium",
          payload: { ...args, approvalMode }
        });
        if (!approved) {
          return { ok: false, content: "MCP 调用被拒绝。" };
        }
      }
      const result = await ctx.callMcpTool(
        server,
        tool,
        (args.arguments as Record<string, unknown>) ?? {}
      );
      const repository = extractMcpRepositoryToolResult(result);
      return {
        ok: true,
        content: JSON.stringify(result, null, 2),
        json: { result, ...(repository ? { repository } : {}) }
      };
    }
  );
}

async function executeDatabaseQuery(args: Record<string, unknown>, ctx: ToolRuntimeContext): Promise<ToolResult> {
  if (!ctx.queryDatabase) return { ok: false, content: "Database access is unavailable." };
  const result = await ctx.queryDatabase(
    String(args.sourceId ?? ""),
    String(args.sql ?? ""),
    Array.isArray(args.parameters) ? args.parameters : [],
    typeof args.maxRows === "number" ? args.maxRows : undefined
  );
  return compactDatabaseResult(result);
}

async function executeDatabaseMutation(operation: "insert" | "update" | "delete", args: Record<string, unknown>, ctx: ToolRuntimeContext): Promise<ToolResult> {
  if (!ctx.executeDatabase) return { ok: false, content: "Database access is unavailable." };
  const sourceId = String(args.sourceId ?? "");
  const sql = String(args.sql ?? "");
  const approved = await ctx.requestApproval({
    title: `执行数据库${operation === "insert" ? "新增" : operation === "update" ? "更新" : "删除"}`,
    description: `${sourceId}: ${sql.slice(0, 240)}`,
    riskLevel: "high",
    payload: { sourceId, operation, sql: sql.slice(0, 1_000) }
  });
  if (!approved) return { ok: false, content: "Database mutation was denied." };
  const result = await ctx.executeDatabase(sourceId, sql, Array.isArray(args.parameters) ? args.parameters : [], operation);
  return compactDatabaseResult(result);
}

async function executeFederatedQuery(args: Record<string, unknown>, ctx: ToolRuntimeContext): Promise<ToolResult> {
  if (!ctx.queryDatabase) return { ok: false, content: "Database access is unavailable." };
  const sources = Array.isArray(args.sources) ? args.sources : [];
  if (sources.length < 2) return { ok: false, content: "Federated queries require at least two source queries." };
  if (sources.length > 8) return { ok: false, content: "A federated query supports at most eight source queries." };
  const results = await Promise.all(sources.map(async (entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each source must be an object.");
    const source = entry as Record<string, unknown>;
    const alias = typeof source.alias === "string" ? source.alias.trim() : "";
    const sourceId = typeof source.sourceId === "string" ? source.sourceId.trim() : "";
    const sql = typeof source.sql === "string" ? source.sql : "";
    if (!alias || !sourceId || !sql) throw new Error("Each source requires alias, sourceId, and sql.");
    const query = await ctx.queryDatabase!(sourceId, sql, Array.isArray(source.parameters) ? source.parameters : [], 1_000);
    return { alias, rows: query.rows };
  }));
  const totalRows = results.reduce((total, result) => total + result.rows.length, 0);
  if (totalRows > 5_000) return { ok: false, content: "Federated input exceeds the 5,000 row limit." };
  const byAlias = new Map(results.map((result) => [result.alias, result.rows]));
  const joins = Array.isArray(args.joins) ? args.joins : [];
  if (joins.length !== sources.length - 1) return { ok: false, content: "Federated queries require one join for each source after the first." };
  let joined: Array<Record<string, unknown>> = results[0]!.rows.map((row) => prefixRow(results[0]!.alias, row));
  const joinedAliases = new Set([results[0]!.alias]);
  for (const join of joins) {
    if (!join || typeof join !== "object" || Array.isArray(join)) return { ok: false, content: "Each join must be an object." };
    const item = join as Record<string, unknown>;
    const leftAlias = String(item.leftAlias ?? ""); const leftColumn = String(item.leftColumn ?? "");
    const rightAlias = String(item.rightAlias ?? ""); const rightColumn = String(item.rightColumn ?? "");
    const kind = item.kind === "left" ? "left" : "inner";
    if (!joinedAliases.has(leftAlias) || joinedAliases.has(rightAlias) || !byAlias.has(rightAlias) || !leftColumn || !rightColumn) return { ok: false, content: "Joins must extend the joined sources with explicit aliases and columns." };
    const index = new Map<string, Array<Record<string, unknown>>>();
    for (const row of byAlias.get(rightAlias)!) { const key = federationKey(row[rightColumn]); if (key !== null) (index.get(key) ?? index.set(key, []).get(key)!).push(row); }
    const next: Array<Record<string, unknown>> = [];
    for (const row of joined) {
      const matches = index.get(federationKey(row[`${leftAlias}.${leftColumn}`]) ?? "") ?? [];
      if (matches.length) for (const match of matches) next.push({ ...row, ...prefixRow(rightAlias, match) });
      else if (kind === "left") next.push(row);
      if (next.length >= 1_000) break;
    }
    joined = next; joinedAliases.add(rightAlias);
  }
  const aggregates = Array.isArray(args.aggregates) ? args.aggregates : [];
  const groupBy = Array.isArray(args.groupBy) ? args.groupBy.filter((field): field is string => typeof field === "string") : [];
  if (aggregates.length > 0) joined = aggregateFederatedRows(joined, groupBy, aggregates);
  const select = Array.isArray(args.select) ? args.select.filter((field): field is string => typeof field === "string") : [];
  if (select.length > 0) joined = joined.map((row) => Object.fromEntries(select.map((field) => [field, row[field]])));
  const orderBy = typeof args.orderBy === "string" ? args.orderBy : "";
  if (orderBy) joined.sort((left, right) => String(left[orderBy] ?? "").localeCompare(String(right[orderBy] ?? "")) * (args.orderDirection === "desc" ? -1 : 1));
  const limit = Math.min(Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 200), 1_000);
  return compactDatabaseResult({ rows: joined.slice(0, limit), rowCount: joined.length, durationMs: 0 }, { federated: true, sourceCount: results.length });
}

function prefixRow(alias: string, row: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(row).map(([key, value]) => [`${alias}.${key}`, value])); }
function federationKey(value: unknown): string | null { if (value === null || value === undefined) return null; if (typeof value === "number") return `number:${String(value)}`; return `${typeof value}:${String(value)}`; }
function aggregateFederatedRows(rows: Array<Record<string, unknown>>, groupBy: string[], aggregates: unknown[]): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = JSON.stringify(groupBy.map((field) => row[field] ?? null));
    const output = groups.get(key) ?? Object.fromEntries(groupBy.map((field) => [field, row[field]]));
    for (const aggregate of aggregates) {
      if (!aggregate || typeof aggregate !== "object" || Array.isArray(aggregate)) continue;
      const item = aggregate as Record<string, unknown>; const op = String(item.op ?? "count").toLowerCase(); const field = String(item.field ?? ""); const alias = String(item.as ?? `${op}_${field || "rows"}`); const value = row[field];
      if (op === "count") output[alias] = Number(output[alias] ?? 0) + 1;
      else if (op === "sum" || op === "avg") { output[`__sum_${alias}`] = Number(output[`__sum_${alias}`] ?? 0) + Number(value ?? 0); output[`__count_${alias}`] = Number(output[`__count_${alias}`] ?? 0) + (value == null ? 0 : 1); output[alias] = op === "sum" ? output[`__sum_${alias}`] : Number(output[`__sum_${alias}`]) / Math.max(1, Number(output[`__count_${alias}`])); }
      else if (op === "min" || op === "max") { const current = output[alias]; if (current === undefined || (op === "min" ? String(value) < String(current) : String(value) > String(current))) output[alias] = value; }
    }
    groups.set(key, output);
  }
  return [...groups.values()].map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("__"))));
}
function compactDatabaseResult(result: { rows: Array<Record<string, unknown>>; rowCount: number; durationMs: number }, extra: Record<string, unknown> = {}): ToolResult {
  const rows = result.rows.slice(0, 200); const json = { ...extra, rows, rowCount: result.rowCount, returnedRows: rows.length, durationMs: result.durationMs, truncated: result.rows.length > rows.length };
  const content = JSON.stringify(json, null, 2);
  return { ok: true, content: content.length > 50_000 ? `${content.slice(0, 50_000)}\n[Database result truncated]` : content, json };
}

function spec(
  name: string,
  description: string,
  required: string[],
  riskLevel: "low" | "medium" | "high",
  exposure?: ToolSpecDefinition["exposure"]
): ToolSpecDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: required.reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = { type: key === "questions" ? "array" : "string" };
        return accumulator;
      }, {}),
      required
    },
    riskLevel,
    exposure
  };
}

function fullyQualifiedName(spec: ToolSpecDefinition): string {
  return spec.namespace ? `${spec.namespace}:${spec.name}` : spec.name;
}

function resolveFromCwd(cwd: string, targetPath: string): string {
  return resolveWorkspacePath(cwd, targetPath);
}

const FILE_SNAPSHOT_TEXT_LIMIT = 512_000;

function createTextSnapshot(path: string, before: string, after: string) {
  return {
    path: path.replace(/\\/g, "/"),
    before: before.slice(0, FILE_SNAPSHOT_TEXT_LIMIT),
    after: after.slice(0, FILE_SNAPSHOT_TEXT_LIMIT),
    beforeTruncated: before.length > FILE_SNAPSHOT_TEXT_LIMIT,
    afterTruncated: after.length > FILE_SNAPSHOT_TEXT_LIMIT
  };
}

export function buildApplyPatchFailureMessage(reason: string): string {
  if (/^Ambiguous patch hunk matched \d+ locations;/i.test(reason)) {
    return [
      "Patch was not applied because its target text appears in multiple locations.",
      `Details: ${reason}`,
      "Read the target function or component, then create one minimal *** Update File patch with unique surrounding lines copied from the current file.",
      "Do not resend this patch unchanged."
    ].join("\n");
  }

  if (/Patch hunk context\/removal block was not found in the target file\./i.test(reason)) {
    return [
      "Patch was not applied because the target file no longer contains the exact text used by the patch.",
      `Details: ${reason}`,
      "Read the exact target file now, then create one minimal *** Update File patch using text copied from its current contents.",
      "Do not resend this patch unchanged."
    ].join("\n");
  }

  return [
    `Patch was not applied: ${reason}`,
    "Re-read the intended target file, then submit only canonical Codex patch syntax:",
    "*** Begin Patch",
    "*** Update File: relative/path.ext",
    "@@",
    "-exact current text",
    "+replacement text",
    "*** End Patch",
    "Unsupported headings such as *** Changed Range are invalid."
  ].join("\n");
}

function normalizeApplyPatchInput(args: Record<string, unknown>): string {
  const value = args.patch ?? args.patch_content ?? args.patchText;
  if (typeof value !== "string") {
    return "";
  }

  const text = value.trim();
  const beginIndex = text.indexOf("*** Begin Patch");
  const canonical = beginIndex >= 0 ? text.slice(beginIndex) : text;
  if (canonical.startsWith("*** Begin Patch")) {
    return canonical;
  }

  return convertUnifiedAddPatch(canonical, args.file_path);
}

function convertUnifiedAddPatch(text: string, requestedPath: unknown): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const oldPath = lines.find((line) => line.startsWith("--- "))?.slice(4).trim();
  const newPath = lines.find((line) => line.startsWith("+++ "))?.slice(4).trim();
  if (oldPath !== "/dev/null" || !newPath) {
    return text;
  }

  const hunkIndex = lines.findIndex((line) => line.startsWith("@@"));
  if (hunkIndex < 0) {
    return text;
  }
  const content = lines.slice(hunkIndex + 1);
  while (content.at(-1) === "") {
    content.pop();
  }
  if (content.some((line) => line && !line.startsWith("+"))) {
    return text;
  }
  const pathValue = typeof requestedPath === "string" && requestedPath.trim() ? requestedPath : newPath.replace(/^[ab]\//, "");
  const relativePath = pathValue.replace(/^[/\\]+/, "").replace(/^[^/\\]+:[/\\]+/, "");
  return [
    "*** Begin Patch",
    `*** Add File: ${relativePath}`,
    ...content,
    "*** End Patch"
  ].join("\n");
}

function resolveWorkspacePath(rootDir: string, targetPath: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error("File path is outside the project folder.");
}

function escapePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildCodeSearchCommand(
  pattern: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string {
  const binaryExtensions = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "pdf", "zip", "7z", "rar",
    "tar", "gz", "woff", "woff2", "ttf", "otf", "eot", "mp3", "wav", "ogg", "mp4", "webm",
    "mov", "avi", "wasm", "exe", "dll", "bin"
  ];
  const rgBinaryGlobs = binaryExtensions.map((extension) => `--glob '!*.${extension}'`).join(" ");
  const grepBinaryExcludes = binaryExtensions.map((extension) => `--exclude='*.${extension}'`).join(" ");
  if (platform === "win32") {
    const escapedPattern = escapePowerShell(pattern);
    const escapedCwd = escapePowerShell(cwd);
    const rg = `rg -n --hidden --max-filesize 5M --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' --glob '!.git/**' ${rgBinaryGlobs} -- '${escapedPattern}' '${escapedCwd}' | Select-Object -First ${MAX_CODE_SEARCH_RESULT_LINES}`;
    const grep = `grep -RIn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git ${grepBinaryExcludes} -- '${escapedPattern}' '${escapedCwd}' | Select-Object -First ${MAX_CODE_SEARCH_RESULT_LINES}`;
    const excludedExtensions = binaryExtensions.map((extension) => `'.${extension}'`).join(",");
    const selectString = `Get-ChildItem -Path '${escapedCwd}' -Recurse -File | Where-Object { $_.Length -le 5MB -and @(${excludedExtensions}) -notcontains $_.Extension.ToLowerInvariant() -and $_.FullName -notmatch '[\\\\/](node_modules|dist|build|\\.git)[\\\\/]' } | Select-String -Pattern '${escapedPattern}' | Select-Object -First ${MAX_CODE_SEARCH_RESULT_LINES} | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }`;
    return `if (Get-Command rg -ErrorAction SilentlyContinue) { ${rg}; if ($LASTEXITCODE -eq 1) { exit 0 } } elseif (Get-Command grep -ErrorAction SilentlyContinue) { ${grep}; if ($LASTEXITCODE -eq 1) { exit 0 } } else { ${selectString} }`;
  }

  const escapedPattern = escapePosixShell(pattern);
  const escapedCwd = escapePosixShell(cwd);
  const rg = `rg -n --hidden --max-filesize 5M --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' --glob '!.git/**' ${rgBinaryGlobs} -- ${escapedPattern} ${escapedCwd} | head -n ${MAX_CODE_SEARCH_RESULT_LINES}`;
  const grep = `grep -RIn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git ${grepBinaryExcludes} -- ${escapedPattern} ${escapedCwd} | head -n ${MAX_CODE_SEARCH_RESULT_LINES}`;
  const findBinaryExcludes = binaryExtensions.map((extension) => `! -iname '*.${extension}'`).join(" ");
  return `if command -v rg >/dev/null 2>&1; then ${rg}; elif command -v grep >/dev/null 2>&1; then ${grep}; else find ${escapedCwd} -type f -size -5M -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.git/*' ${findBinaryExcludes} -exec sh -c 'grep -n -- "$1" "$2" 2>/dev/null && printf "%s\\n" "$2"' _ ${escapedPattern} {} \\; | head -n ${MAX_CODE_SEARCH_RESULT_LINES}; fi`;
}

async function runProjectVerification(ctx: ToolRuntimeContext): Promise<ToolResult> {
  const commands = await resolveVerificationCommands(ctx);
  if (commands.length === 0) {
    return {
      ok: true,
      content: "No safe project verification command is configured or discoverable. The change remains unverified.",
      json: { commands, passed: false, unverified: true, output: "No safe verification command found." }
    };
  }

  const outputs: string[] = [];
  for (const command of commands) {
    try {
      const terminal = await runShell(command, ctx);
      outputs.push(`$ ${command}\n${terminal.output}`.trim());
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      outputs.push(`$ ${command}\n${output}`.trim());
      return {
        ok: false,
        content: `Verification failed: ${command}\n${output}`,
        json: { commands, passed: false, failedCommand: command, exitCode: null, output: outputs.join("\n\n") }
      };
    }
  }
  return {
    ok: true,
    content: `Verification passed:\n${outputs.join("\n\n")}`,
    json: { commands, passed: true, output: outputs.join("\n\n") }
  };
}

async function resolveVerificationCommands(ctx: ToolRuntimeContext): Promise<string[]> {
  const configured = ctx.executionPolicy?.verificationCommands?.filter(isSafeVerificationCommand) ?? [];
  if (configured.length > 0) return configured;

  let packageJson: { scripts?: Record<string, unknown> } | null = null;
  try {
    packageJson = JSON.parse(await ctx.readFile(path.join(ctx.cwd, "package.json"))) as { scripts?: Record<string, unknown> };
  } catch {
    return [];
  }
  const scripts = packageJson.scripts ?? {};
  const runner = await preferredNodePackageRunner(ctx);
  return ["typecheck", "test"]
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => `${runner} run ${name}`);
}

async function preferredNodePackageRunner(ctx: ToolRuntimeContext): Promise<"pnpm" | "npm"> {
  try {
    await ctx.readFile(path.join(ctx.cwd, "pnpm-lock.yaml"));
    return "pnpm";
  } catch {
    return "npm";
  }
}

function isSafeVerificationCommand(command: string): boolean {
  const normalized = command.trim();
  return Boolean(normalized) &&
    !/[;&|<>\r\n]/.test(normalized) &&
    !/\b(?:install|add|remove|publish|start|dev|serve)\b/i.test(normalized);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function escapePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

async function buildGitDiffAstSummary(
  ctx: ToolRuntimeContext,
  diffOutput: string
): Promise<Array<{ path: string; language: string | null; entities: unknown[]; summary: string }>> {
  const paths = new Set<string>();
  for (const line of diffOutput.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) {
      paths.add(match[2]);
    }
  }

  const summaries: Array<{ path: string; language: string | null; entities: unknown[]; summary: string }> = [];
  for (const relativePath of paths) {
    if (!isAstSupportedPath(relativePath)) {
      continue;
    }
    try {
      const after = await fs.readFile(resolveFromCwd(ctx.cwd, relativePath), "utf8");
      let before = "";
      try {
        before = (await runShell(`git show HEAD:${escapeDoubleQuotes(relativePath)}`, ctx)).output;
      } catch {
        before = "";
      }
      const result = await astDiffSources(before, after, relativePath);
      if (result.entities.length === 0) {
        continue;
      }
      summaries.push({
        path: relativePath,
        language: result.language,
        entities: result.entities,
        summary: result.summary
      });
    } catch {
      // skip unreadable files
    }
  }
  return summaries;
}

async function probeGitRepository(ctx: ToolRuntimeContext): Promise<{ isGitRepository: boolean }> {
  try {
    const output = (await runShell("git rev-parse --is-inside-work-tree", ctx)).output.trim().toLowerCase();
    return { isGitRepository: output === "true" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) {
      return { isGitRepository: false };
    }
    // Unexpected git failures still mean we should not pretend this is a repo.
    return { isGitRepository: false };
  }
}

function gitNotRepositoryResult(): ToolResult {
  return {
    ok: true,
    content:
      "当前工作区不是 git 仓库（未找到 .git）。请改用 fs/code 工具查看项目文件，或先在该目录执行 git init。",
    json: { isGitRepository: false }
  };
}

async function runShell(command: string, ctx: ToolRuntimeContext): Promise<TerminalCommandResult> {
  if (ctx.runTerminalCommand) {
    return ctx.runTerminalCommand(command);
  }
  if (process.platform === "win32") {
    return { output: await runCommand("powershell", ["-NoProfile", "-Command", command], ctx.cwd) };
  }
  return { output: await runCommand("sh", ["-lc", command], ctx.cwd) };
}

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with code ${code}`));
    });
  });
}
