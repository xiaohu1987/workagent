import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { buildCodeSearchCommand, ToolRuntime, canonicalizeToolName, type ToolRuntimeContext } from "@tool-runtime";

describe("canonicalizeToolName", () => {
  it("maps common image/video aliases to builtin multimodal tools", () => {
    expect(canonicalizeToolName("image_gen")).toBe("image.generate");
    expect(canonicalizeToolName("imagegen")).toBe("image.generate");
    expect(canonicalizeToolName("generate_image")).toBe("image.generate");
    expect(canonicalizeToolName("video_gen")).toBe("video.generate");
    expect(canonicalizeToolName("image.generate")).toBe("image.generate");
  });
});

describe("ToolRuntime", () => {
  it("normalizes up to three GPA user-input questions into one structured tool result", async () => {
    const requestUserInput = vi.fn().mockResolvedValue({ approach: "recommended", scope: "minimal" });
    const runtime = new ToolRuntime();

    const result = await runtime.execute(
      {
        id: "gpa-clarification",
        name: "request_user_input",
        arguments: {
          title: "Choose the implementation approach",
          questions: [
            {
              id: "approach",
              label: "Implementation approach",
              prompt: "Which approach should be used?",
              options: [
                { id: "recommended", label: "Use the recommended approach", description: "Lower maintenance", recommended: true },
                { id: "alternative", label: "Use the alternative approach" }
              ]
            },
            {
              id: "scope",
              label: "Scope",
              prompt: "Which scope should be used?",
              options: [{ id: "minimal", label: "Minimal", description: "Core workflow only" }]
            }
          ]
        }
      },
      { cwd: process.cwd(), requestUserInput, requestUserInputEnabled: true } as unknown as ToolRuntimeContext
    );

    expect(requestUserInput).toHaveBeenCalledWith(expect.objectContaining({
      questions: [
        expect.objectContaining({ id: "approach", allowFreeText: true }),
        expect.objectContaining({ id: "scope", allowFreeText: true })
      ]
    }));
    expect(result.json).toMatchObject({
      selections: [
        { answer: "Use the recommended approach" },
        { answer: "Minimal" }
      ]
    });
  });

  it("keeps legacy string GPA options compatible with schema validation", async () => {
    const requestUserInput = vi.fn().mockResolvedValue({ approach: "option_2" });
    const runtime = new ToolRuntime();

    const result = await runtime.execute(
      {
        id: "legacy-gpa-options",
        name: "request_user_input",
        arguments: {
          title: "Choose an approach",
          questions: [{
            id: "approach",
            label: "Approach",
            prompt: "Which approach should be used?",
            options: ["Option A", "Option B"]
          }]
        }
      },
      { cwd: process.cwd(), requestUserInput, requestUserInputEnabled: true } as unknown as ToolRuntimeContext
    );

    expect(requestUserInput).toHaveBeenCalledWith(expect.objectContaining({
      questions: [expect.objectContaining({
        options: [{ id: "option_1", label: "Option A" }, { id: "option_2", label: "Option B" }]
      })]
    }));
    expect(result.json).toMatchObject({ selections: [{ answer: "Option B" }] });
  });

  it("rejects request_user_input outside GPA mode", async () => {
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      {
        id: "gpa-skip",
        name: "request_user_input",
        arguments: {
          title: "Decision",
          questions: [{
            id: "choice",
            label: "Choice",
            prompt: "Choose",
            options: [{ id: "one", label: "One" }]
          }]
        }
      },
      {
        cwd: process.cwd(),
        requestUserInputEnabled: false,
        requestUserInput: vi.fn()
      } as unknown as ToolRuntimeContext
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.content).toContain("only available while GPA mode is active");
  });

  it("prefers rg and falls back to grep for Windows workspace searches", () => {
    const command = buildCodeSearchCommand("TODO", "C:\\workspace", "win32");

    expect(command).toContain("Get-Command rg");
    expect(command).toContain("elseif (Get-Command grep");
    expect(command).toContain("--glob '!node_modules/**'");
    expect(command).toContain("--exclude-dir=node_modules");
  });

  it("prefers rg and falls back to grep for Unix workspace searches", () => {
    const command = buildCodeSearchCommand("TODO", "/workspace", "linux");

    expect(command).toContain("command -v rg");
    expect(command).toContain("elif command -v grep");
    expect(command).toContain("--glob '!node_modules/**'");
    expect(command).toContain("--exclude-dir=node_modules");
  });

  it("maps legacy read_file to the file reader", async () => {
    const readFile = vi.fn().mockResolvedValue("contents");
    const runtime = new ToolRuntime();
    const context = {
      cwd: process.cwd(),
      readFile
    } as unknown as ToolRuntimeContext;

    const result = await runtime.execute(
      { id: "call-1", name: "read_file", arguments: { path: "notes.txt" } },
      context
    );

    expect(result).toMatchObject({ ok: true, content: "contents" });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("treats an unavailable web search as a successful, actionable result", async () => {
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "search-unavailable", name: "web_search.search_query", arguments: { query: "台风巴威 最新消息" } },
      { cwd: process.cwd(), webSearch: vi.fn().mockResolvedValue([]) } as unknown as ToolRuntimeContext
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Do not retry the same query");
    expect(result.json).toMatchObject({ unavailable: true, results: [] });
  });

  it("unwraps JSON-stringified tool arguments before calling a handler", async () => {
    const webSearch = vi.fn().mockResolvedValue([
      { title: "台风巴威", url: "https://example.com/bavi", snippet: "result" }
    ]);
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      {
        id: "stringified-search",
        name: "web_search.search_query",
        arguments: "{\"query\":\"台风巴威 2026 最新路径\"}" as unknown as Record<string, unknown>
      },
      { cwd: process.cwd(), webSearch } as unknown as ToolRuntimeContext
    );

    expect(webSearch).toHaveBeenCalledWith("台风巴威 2026 最新路径");
    expect(result.ok).toBe(true);
  });

  it("lists MCP tools and blocks calls outside the discovered directory", async () => {
    const runtime = new ToolRuntime();
    const listMcpTools = vi.fn().mockResolvedValue([
      { server: "stocks", name: "market_cap", description: "Read market cap", inputSchema: { type: "object" } }
    ]);
    const context = { cwd: process.cwd(), listMcpTools, requestApproval: vi.fn().mockResolvedValue(true) } as unknown as ToolRuntimeContext;

    const directory = await runtime.execute({ id: "mcp-directory", name: "mcp.list_tools", arguments: {} }, context);
    const blocked = await runtime.execute(
      { id: "mcp-blocked", name: "mcp.call", arguments: { server: "stocks", tool: "missing", arguments: {} } },
      context
    );

    expect(directory.ok).toBe(true);
    expect(directory.content).toContain("market_cap");
    expect(blocked).toMatchObject({ ok: false });
  });

  it("accepts object arguments for a discovered MCP tool", async () => {
    const callMcpTool = vi.fn().mockResolvedValue({ value: 42 });
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      {
        id: "mcp-object-args",
        name: "mcp.call",
        arguments: { server: "stocks", tool: "market_cap", arguments: { symbol: "SSE:301236" } }
      },
      {
        cwd: process.cwd(),
        listMcpTools: vi.fn().mockResolvedValue([
          { server: "stocks", name: "market_cap", description: "Read market cap", inputSchema: { type: "object" } }
        ]),
        requestApproval: vi.fn().mockResolvedValue(true),
        callMcpTool
      } as unknown as ToolRuntimeContext
    );

    expect(result.ok).toBe(true);
    expect(callMcpTool).toHaveBeenCalledWith("stocks", "market_cap", { symbol: "SSE:301236" });
  });

  it("maps read to the project directory reader instead of knowledge.read", async () => {
    const listFiles = vi.fn().mockResolvedValue(["hello.txt"]);
    const runtime = new ToolRuntime();
    const context = {
      cwd: process.cwd(),
      listFiles
    } as unknown as ToolRuntimeContext;

    const result = await runtime.execute(
      { id: "call-directory", name: "read", arguments: { path: "." } },
      context
    );

    expect(result).toMatchObject({ ok: true, content: "Directory listing succeeded:\nhello.txt" });
    expect(listFiles).toHaveBeenCalledWith(process.cwd());
  });

  it("maps execute_command to the workspace shell executor", async () => {
    const requestApproval = vi.fn().mockResolvedValue(true);
    const runTerminalCommand = vi.fn().mockResolvedValue({
      output: "tool output",
      localUrl: "http://127.0.0.1:8000"
    });
    const runtime = new ToolRuntime();
    const context = {
      cwd: process.cwd(),
      requestApproval,
      runTerminalCommand
    } as unknown as ToolRuntimeContext;

    const result = await runtime.execute(
      { id: "call-command", name: "execute_command", arguments: { command: "echo tool-alias" } },
      context
    );

    expect(result.ok).toBe(true);
    expect(result.content).toBe("tool output");
    expect(result.json).toMatchObject({ localUrl: "http://127.0.0.1:8000" });
    expect(runTerminalCommand).toHaveBeenCalledWith("echo tool-alias");
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ title: "执行命令", payload: { command: "echo tool-alias" } })
    );
  });

  it("rejects invalid tool arguments before requesting approval or executing", async () => {
    const requestApproval = vi.fn();
    const runTerminalCommand = vi.fn();
    const runtime = new ToolRuntime();

    const result = await runtime.execute(
      { id: "invalid-command", name: "shell.exec", arguments: { command: 42 } },
      { cwd: process.cwd(), requestApproval, runTerminalCommand } as unknown as ToolRuntimeContext
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.content).toContain("arguments.command must be a string");
    expect(result.content).toContain("Correct the arguments");
    expect(requestApproval).not.toHaveBeenCalled();
    expect(runTerminalCommand).not.toHaveBeenCalled();
  });

  it("accepts numeric browser scroll deltas and rejects string values", async () => {
    const scrollBrowserPage = vi.fn().mockResolvedValue({ title: "Page", url: "https://example.com" });
    const runtime = new ToolRuntime();
    const context = { cwd: process.cwd(), scrollBrowserPage } as unknown as ToolRuntimeContext;

    const valid = await runtime.execute(
      { id: "scroll-valid", name: "browser.scroll", arguments: { tabId: "tab-1", deltaY: 480 } },
      context
    );
    const invalid = await runtime.execute(
      { id: "scroll-invalid", name: "browser.scroll", arguments: { tabId: "tab-1", deltaY: "480" } },
      context
    );

    expect(valid.ok).toBe(true);
    expect(scrollBrowserPage).toHaveBeenCalledWith("tab-1", 480);
    expect(invalid).toMatchObject({ ok: false });
    expect(invalid.content).toContain("arguments.deltaY must be a number");
  });

  it("makes an empty directory an explicit successful result", async () => {
    const runtime = new ToolRuntime();
    const context = {
      cwd: process.cwd(),
      listFiles: vi.fn().mockResolvedValue([])
    } as unknown as ToolRuntimeContext;

    const result = await runtime.execute(
      { id: "call-empty-directory", name: "fs.read_directory", arguments: { path: "." } },
      context
    );

    expect(result.content).toContain("folder is empty");
    expect(result.content).toContain("apply_patch");
  });

  it("keeps direct file editing on the apply_patch workflow", () => {
    const { direct, deferred } = new ToolRuntime().listToolSpecs();

    expect(direct.map((tool) => tool.name)).toContain("apply_patch");
    expect(direct.map((tool) => tool.name)).not.toContain("fs.write_file");
    expect(deferred.map((tool) => tool.name)).toContain("fs.write_file");
  });

  it("loads selected Skill instructions through the skills.load tool", async () => {
    const loadSkill = vi.fn().mockResolvedValue({
      skill: { qualifiedName: "data-skill", domain: "数据分析", scope: "user" },
      content: "Use the data workflow."
    });
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "skill-load", name: "skills.load", arguments: { skill_id: "skill-1" } },
      { cwd: process.cwd(), loadSkill } as unknown as ToolRuntimeContext
    );

    expect(loadSkill).toHaveBeenCalledWith("skill-1");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("# Loaded Skill: data-skill");
    expect(result.content).toContain("Use the data workflow.");
  });

  it("rejects direct file paths outside the project folder", async () => {
    const readFile = vi.fn();
    const runtime = new ToolRuntime();
    const context = {
      cwd: process.cwd(),
      readFile
    } as unknown as ToolRuntimeContext;

    await expect(
      runtime.execute(
        { id: "call-2", name: "fs.read_file", arguments: { path: path.resolve(process.cwd(), "..", "outside.txt") } },
        context
      )
    ).rejects.toThrow("relative to the project folder");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("accepts a model's patch_content Git diff when it adds one file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const runtime = new ToolRuntime();
    const context = {
      cwd: root,
      requestApproval: vi.fn().mockResolvedValue(true)
    } as unknown as ToolRuntimeContext;

    try {
      const result = await runtime.execute(
        {
          id: "call-3",
          name: "apply_patch",
          arguments: {
            file_path: "hello.txt",
            patch_content: "--- /dev/null\n+++ hello.txt\n@@ -0,0 +1 @@\n+hello\n"
          }
        },
        context
      );

      expect(result.ok).toBe(true);
      await expect(fs.readFile(path.join(root, "hello.txt"), "utf8")).resolves.toBe("hello\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a canonical Codex patch passed in the patch argument", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const runtime = new ToolRuntime();
    const context = {
      cwd: root,
      requestApproval: vi.fn().mockResolvedValue(true)
    } as unknown as ToolRuntimeContext;

    try {
      const result = await runtime.execute(
        {
          id: "call-4",
          name: "apply_patch",
          arguments: {
            patch: "*** Begin Patch\n*** Add File: index.html\n+<h1>Created</h1>\n*** End Patch"
          }
        },
        context
      );

      expect(result.ok).toBe(true);
      await expect(fs.readFile(path.join(root, "index.html"), "utf8")).resolves.toBe("<h1>Created</h1>\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
