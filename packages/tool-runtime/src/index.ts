import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  ApprovalMode,
  ArtifactRecord,
  BrowserTabRecord,
  KnowledgeBaseRecord,
  RuntimeToolCall,
  ToolResult,
  ToolSearchResult,
  ToolSpecDefinition,
  UserInputQuestion
} from "@shared-types";
import { applyCodexPatch } from "./handlers/applyPatch";

export interface ToolRuntimeContext {
  cwd: string;
  appHome: string;
  threadId: string;
  turnRunId: string;
  approvalMode: ApprovalMode;
  browserTabs: BrowserTabRecord[];
  knowledgeBases: KnowledgeBaseRecord[];
  searchKnowledge: (query: string, knowledgeBaseIds?: string[]) => Promise<any[]>;
  readKnowledgeConcept: (conceptId: string) => Promise<any | null>;
  listFiles: (dir: string) => Promise<string[]>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  runTerminalCommand?: (command: string) => Promise<TerminalCommandResult>;
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
  gpaPlanClarification?: boolean;
  spawnChildAgent: (input: { prompt: string; role: string; modelId?: string }) => Promise<string>;
  webSearch: (query: string) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  openPage: (url: string) => Promise<{ title: string; url: string; text: string }>;
  findInPage: (url: string, pattern: string) => Promise<string[]>;
  listBrowserTabs: () => Promise<BrowserTabRecord[]>;
  openBrowserTab: (url: string) => Promise<{ tab: BrowserTabRecord; page: { title: string; url: string; text: string } }>;
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
  captureBrowserScreenshot: (tabId: string) => Promise<{ title: string; url: string; filePath: string; artifact: ArtifactRecord }>;
  captureBrowserSnapshot: (tabId: string) => Promise<{
    filePath: string;
    title: string;
    url: string;
    text: string;
    artifact: ArtifactRecord;
  }>;
  getThreadOutputDir: () => Promise<string>;
  listMcpResources: (server?: string) => Promise<any[]>;
  listMcpResourceTemplates: (server?: string) => Promise<any[]>;
  listMcpTools: (server?: string) => Promise<Array<{ server: string; name: string; description: string; inputSchema: Record<string, unknown> }>>;
  readMcpResource: (server: string, uri: string) => Promise<any>;
  callMcpTool: (server: string, tool: string, argumentsJson: Record<string, unknown>) => Promise<any>;
  deferredToolSpecs?: ToolSpecDefinition[];
  hiddenToolNames?: string[];
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
};

const TOOL_ALIASES: Record<string, string> = {
  read: "fs.read_directory",
  read_file: "fs.read_file",
  read_directory: "fs.read_directory",
  list_directory: "fs.read_directory",
  write_file: "fs.write_file",
  applypatch: "apply_patch",
  execute_command: "shell.exec"
};

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
    let registration =
      this.#registry.get(call.name) ||
      this.#registry.get(call.name.replace(/^([^:]+)\./, "$1:"));
    if (!registration && TOOL_ALIASES[call.name]) {
      registration = this.#registry.get(TOOL_ALIASES[call.name]);
    }
    if (!registration) {
      throw new Error(`Unknown tool: ${call.name}`);
    }

    return registration.handler(normalizeToolArguments(call.arguments), ctx, this);
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
    return argumentsValue as Record<string, unknown>;
  }
  if (typeof argumentsValue !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsValue);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Tool validation below will report missing required fields in the normal way.
  }
  return {};
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
    spec("fs.read_file", "Read a UTF-8 text file from disk.", ["path"], "low"),
    async (args, ctx) => {
      const filePath = resolveFromCwd(ctx.cwd, String(args.path));
      const content = await ctx.readFile(filePath);
      return { ok: true, content, json: { path: filePath, content } };
    }
  );

  runtime.register(
    spec(
      "fs.write_file",
      "Write a UTF-8 text file to disk.",
      ["path", "content"],
      "medium",
      "deferred"
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
      await ctx.writeFile(filePath, content);
      return { ok: true, content: `Wrote ${filePath}`, json: { path: filePath } };
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
      const output = terminal.output;
      return { ok: true, content: output, json: { pattern: args.pattern, output } };
    }
  );

  runtime.register(
    spec("shell.exec", "Run a shell command inside the current workspace.", ["command"], "high"),
    async (args, ctx) => {
      const command = String(args.command ?? "");
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
        ok: true,
        content: terminal.output,
        json: { command, output: terminal.output, localUrl: terminal.localUrl }
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
      const approved = await ctx.requestApproval({
        title: "应用补丁",
        description: "将对多个文件写入或删除内容。",
        riskLevel: "high",
        payload: { patchPreview: patchText.slice(0, 500) }
      });
      if (!approved) {
        return { ok: false, content: "补丁应用被拒绝。" };
      }
      const touched = await applyCodexPatch(patchText, ctx.cwd);
      return { ok: true, content: touched.join("\n"), json: { touched } };
    }
  );

  runtime.register(
    spec("git.status", "Read git status for the current repository.", [], "low"),
    async (_args, ctx) => {
      const output = (await runShell("git status --short --branch", ctx)).output;
      return { ok: true, content: output, json: { output } };
    }
  );

  runtime.register(
    spec("git.diff", "Read git diff for the current repository.", [], "low"),
    async (_args, ctx) => {
      const output = (await runShell("git diff --no-ext-diff", ctx)).output;
      return { ok: true, content: output, json: { output } };
    }
  );

  runtime.register(
    spec("git.commit", "Create a git commit with a message.", ["message"], "high"),
    async (args, ctx) => {
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
      const output = (await runShell("git worktree list --porcelain", ctx)).output;
      return { ok: true, content: output, json: { output } };
    }
  );

  runtime.register(
    spec("git.worktree_add", "Create a git worktree for a branch.", ["path", "branch"], "high"),
    async (args, ctx) => {
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
      return { ok: true, content: page.text, json: page };
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
        content: `${result.tab.title}\n${result.tab.url}`,
        json: result
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
        json: result
      };
    }
  );

  runtime.register(
    spec("browser.reload", "Reload a browser tab.", ["tabId"], "low"),
    async (args, ctx) => {
      const result = await ctx.reloadBrowserTab(String(args.tabId ?? ""));
      return { ok: true, content: result.page.text, json: result };
    }
  );

  runtime.register(
    spec("browser.go_back", "Go back in a browser tab history.", ["tabId"], "low"),
    async (args, ctx) => {
      const result = await ctx.goBackBrowserTab(String(args.tabId ?? ""));
      return { ok: true, content: result.page.text, json: result };
    }
  );

  runtime.register(
    spec("browser.go_forward", "Go forward in a browser tab history.", ["tabId"], "low"),
    async (args, ctx) => {
      const result = await ctx.goForwardBrowserTab(String(args.tabId ?? ""));
      return { ok: true, content: result.page.text, json: result };
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
      return { ok: true, content: page.text, json: page };
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
      description: "Ask the user for one concise decision when the task cannot proceed safely without a choice. In GPA ACT, use it only for material plan uncertainty and provide 2-4 mutually exclusive options.",
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
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                      description: { type: "string" },
                      recommended: { type: "boolean" }
                    },
                    required: ["id", "label"]
                  }
                }
              },
              required: ["id", "label", "prompt"]
            }
          }
        },
        required: ["title", "questions"]
      },
      riskLevel: "low"
    },
    async (args, ctx) => {
      const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
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
          : undefined,
        allowFreeText: (question as any).allowFreeText === true
      }));
      const gpaPlanClarification = ctx.gpaPlanClarification === true;
      const effectiveQuestions = gpaPlanClarification
        ? questions.slice(0, 1).map((question) => ({ ...question, allowFreeText: true }))
        : questions;
      const answers = await ctx.requestUserInput({
        title: String(args.title ?? "Need input"),
        questions: effectiveQuestions
      });
      const skipped = Object.values(answers).includes("__skip__");
      const selections = effectiveQuestions.map((question) => {
        const value = answers[question.id] ?? "";
        const option = question.options?.find((item: { id: string }) => item.id === value);
        const note = answers[`${question.id}__note`]?.replace(/^__note__:/, "") ?? "";
        return {
          question: question.prompt,
          answer: value === "__skip__"
            ? "Keep the current plan and assumptions."
            : option?.label ?? value.replace(/^__custom__:/, ""),
          note: note || undefined
        };
      });
      return {
        ok: true,
        content: JSON.stringify({ answers, selections, skipped }, null, 2),
        json: { answers, selections, skipped, gpaPlanClarification }
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
    spec("multi_agents.spawn", "Spawn a child agent session.", ["prompt", "role"], "medium"),
    async (args, ctx) => {
      const childThreadId = await ctx.spawnChildAgent({
        prompt: String(args.prompt ?? ""),
        role: String(args.role ?? "implementer"),
        modelId: typeof args.modelId === "string" ? args.modelId : undefined
      });
      return {
        ok: true,
        content: `Spawned child thread ${childThreadId}`,
        json: { childThreadId }
      };
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
    spec("browser.scroll", "Scroll the visible browser page by a vertical pixel delta.", ["tabId", "deltaY"], "low"),
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
    spec("browser.wait_for", "Wait for text or an element id to appear after a browser action.", ["tabId"], "low"),
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
    spec("browser.capture_screenshot", "Capture the visible browser tab as a PNG artifact.", ["tabId"], "low"),
    async (args, ctx) => {
      const screenshot = await ctx.captureBrowserScreenshot(String(args.tabId ?? ""));
      return {
        ok: true,
        content: `${screenshot.title}\n${screenshot.filePath}`,
        json: screenshot,
        artifacts: [screenshot.artifact]
      };
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
    spec("mcp.call", "Call a tool on a configured MCP server.", ["server", "tool", "arguments"], "high"),
    async (args, ctx) => {
      const server = String(args.server ?? "");
      const tool = String(args.tool ?? "");
      const tools = await ctx.listMcpTools(server);
      if (!tools.some((entry) => entry.server === server && entry.name === tool)) {
        return { ok: false, content: `MCP tool ${server}:${tool} is not in the discovered tool directory.` };
      }
      const approved = await ctx.requestApproval({
        title: "调用 MCP 工具",
        description: `${server}:${tool}`,
        riskLevel: "high",
        payload: args
      });
      if (!approved) {
        return { ok: false, content: "MCP 调用被拒绝。" };
      }
      const result = await ctx.callMcpTool(
        server,
        tool,
        (args.arguments as Record<string, unknown>) ?? {}
      );
      return { ok: true, content: JSON.stringify(result, null, 2), json: { result } };
    }
  );
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
  if (path.isAbsolute(targetPath)) {
    throw new Error("File paths must be relative to the project folder.");
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, targetPath);
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
  if (platform === "win32") {
    const escapedPattern = escapePowerShell(pattern);
    const escapedCwd = escapePowerShell(cwd);
    const rg = `rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' --glob '!.git/**' -- '${escapedPattern}' '${escapedCwd}'`;
    const grep = `grep -RIn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git -- '${escapedPattern}' '${escapedCwd}'`;
    const selectString = `Get-ChildItem -Path '${escapedCwd}' -Recurse -File -Exclude node_modules,dist,build | Select-String -Pattern '${escapedPattern}' | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }`;
    return `if (Get-Command rg -ErrorAction SilentlyContinue) { ${rg}; if ($LASTEXITCODE -eq 1) { exit 0 } } elseif (Get-Command grep -ErrorAction SilentlyContinue) { ${grep}; if ($LASTEXITCODE -eq 1) { exit 0 } } else { ${selectString} }`;
  }

  const escapedPattern = escapePosixShell(pattern);
  const escapedCwd = escapePosixShell(cwd);
  const rg = `rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' --glob '!.git/**' -- ${escapedPattern} ${escapedCwd}`;
  const grep = `grep -RIn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git -- ${escapedPattern} ${escapedCwd}`;
  return `if command -v rg >/dev/null 2>&1; then ${rg}; elif command -v grep >/dev/null 2>&1; then ${grep}; else find ${escapedCwd} -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.git/*' -exec sh -c 'grep -n -- "$1" "$2" 2>/dev/null && printf "%s\\n" "$2"' _ ${escapedPattern} {} \\;; fi`;
}

function escapePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeDoubleQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
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
