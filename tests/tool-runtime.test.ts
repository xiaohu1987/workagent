import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  buildCodeSearchCommand,
  MAX_CODE_SEARCH_RESULT_LINES,
  ToolRuntime,
  buildApplyPatchFailureMessage,
  canonicalizeToolName,
  parseVerificationDiagnostics,
  type ToolRuntimeContext
} from "@tool-runtime";

describe("canonicalizeToolName", () => {
  it("maps common image/video aliases to builtin multimodal tools", () => {
    expect(canonicalizeToolName("image_gen")).toBe("image.generate");
    expect(canonicalizeToolName("imagegen")).toBe("image.generate");
    expect(canonicalizeToolName("generate_image")).toBe("image.generate");
    expect(canonicalizeToolName("video_gen")).toBe("video.generate");
    expect(canonicalizeToolName("image.generate")).toBe("image.generate");
  });
});

describe("apply-patch failures", () => {
  it("explains how to resolve an ambiguous hunk match", () => {
    const message = buildApplyPatchFailureMessage(
      "Ambiguous patch hunk matched 85 locations; add more unique context or target a specific symbol."
    );

    expect(message).toContain("appears in multiple locations");
    expect(message).toContain("target function or component");
    expect(message).toContain("unique surrounding lines");
    expect(message).toContain("Do not resend this patch unchanged");
    expect(message).not.toContain("Unsupported headings");
  });

  it("preserves the provider ID when a custom child model is selected", async () => {
    const runtime = new ToolRuntime();
    const spawnChildAgent = vi.fn().mockResolvedValue({
      threadId: "child-1",
      agentPath: "/root/reviewer",
      status: "running"
    });

    await runtime.execute(
      {
        id: "agent-spawn-custom-model",
        name: "spawn_agent",
        arguments: { prompt: "Review the failing tests.", model: "grok-4.5", provider: "provider-5" }
      },
      { cwd: process.cwd(), spawnChildAgent } as unknown as ToolRuntimeContext
    );

    expect(spawnChildAgent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "grok-4.5",
      providerId: "provider-5"
    }));
  });

  it("treats a missing removal block as stale file context instead of invalid syntax", () => {
    const message = buildApplyPatchFailureMessage(
      "Patch hunk context/removal block was not found in the target file."
    );

    expect(message).toContain("no longer contains the exact text");
    expect(message).toContain("Read the exact target file now");
    expect(message).toContain("Do not resend this patch unchanged");
    expect(message).not.toContain("Unsupported headings");
  });

  it("explains how to repair a no-edit update hunk", () => {
    const message = buildApplyPatchFailureMessage(
      "Patch hunk contains no edits and its surrounding anchors were not found."
    );

    expect(message).toContain("did not contain explicit additions or removals");
    expect(message).toContain("Prefix unchanged context with one space");
    expect(message).toContain("Do not resend the same raw source block unchanged");
  });
});

describe("ToolRuntime", () => {
  it("hard-blocks mutating tools for read-only child agents", async () => {
    const runtime = new ToolRuntime();
    const context = { cwd: process.cwd(), readOnlyAgent: true } as unknown as ToolRuntimeContext;

    const patch = await runtime.execute({
      id: "child-patch",
      name: "apply_patch",
      arguments: { patch: "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch" }
    }, context);
    const command = await runtime.execute({
      id: "child-command",
      name: "shell.exec",
      arguments: { command: "echo should-not-run" }
    }, context);
    const cancel = await runtime.execute({
      id: "child-cancel-command",
      name: "shell.cancel_active",
      arguments: {}
    }, context);
    const browser = await runtime.execute({
      id: "child-browser",
      name: "browser.open_tab",
      arguments: { url: "https://example.com" }
    }, context);
    const image = await runtime.execute({
      id: "child-image",
      name: "image.generate",
      arguments: { prompt: "should-not-generate" }
    }, context);
    const install = await runtime.execute({
      id: "child-skill-install",
      name: "skills.install",
      arguments: { source: "owner/repository" }
    }, context);

    expect(patch.ok).toBe(false);
    expect(patch.content).toContain("read-only");
    expect(command.ok).toBe(false);
    expect(command.content).toContain("read-only");
    expect(cancel.ok).toBe(false);
    expect(cancel.content).toContain("read-only");
    expect(browser.ok).toBe(false);
    expect(browser.content).toContain("read-only");
    expect(image.ok).toBe(false);
    expect(image.content).toContain("read-only");
    expect(install.ok).toBe(false);
    expect(install.content).toContain("read-only");
  });

  it("surfaces an explicit timeout from multi-agent wait", async () => {
    const runtime = new ToolRuntime();
    const waitForSubagents = vi.fn().mockResolvedValue({ agents: [], timedOut: true });
    const result = await runtime.execute(
      { id: "agent-wait", name: "multi_agents.wait", arguments: { timeoutMs: 250 } },
      { cwd: process.cwd(), waitForSubagents } as unknown as ToolRuntimeContext
    );

    expect(waitForSubagents).toHaveBeenCalledWith({ agents: undefined, timeoutMs: 250 });
    expect(result.ok).toBe(true);
    expect(result.json).toMatchObject({ agents: [], timedOut: true });
  });

  it("reports a capacity-limited child as queued instead of failing the tool call", async () => {
    const runtime = new ToolRuntime();
    const spawnChildAgent = vi.fn().mockResolvedValue({
      threadId: "child-4",
      agentPath: "/root/reviewer-4",
      status: "idle",
      queued: true
    });

    const result = await runtime.execute(
      { id: "agent-spawn-queued", name: "spawn_agent", arguments: { prompt: "Review the patch." } },
      { cwd: process.cwd(), spawnChildAgent } as unknown as ToolRuntimeContext
    );

    expect(result).toMatchObject({ ok: true, json: { queued: true } });
    expect(result.content).toContain("Queued /root/reviewer-4");
  });

  it("defaults image generation to one image and honors a requested count", async () => {
    let sequence = 0;
    const generateImageWithDefaultModel = vi.fn(async () => {
      sequence += 1;
      return {
        fileName: `image-${sequence}.png`,
        absolutePath: `C:\\outputs\\image-${sequence}.png`,
        mimeType: "image/png",
        modelId: "image-model",
        providerId: "provider",
        modelDisplayName: "Image Model",
        attachment: { id: `attachment-${sequence}`, kind: "image", name: `image-${sequence}.png` },
        artifact: { id: `artifact-${sequence}` }
      };
    });
    const runtime = new ToolRuntime();
    const context = {
      cwd: process.cwd(),
      generateImageWithDefaultModel
    } as unknown as ToolRuntimeContext;

    const single = await runtime.execute(
      { id: "image-single", name: "image.generate", arguments: { prompt: "a cat" } },
      context
    );
    const multiple = await runtime.execute(
      { id: "image-multiple", name: "image.generate", arguments: { prompt: "a dog", count: 3 } },
      context
    );

    expect(generateImageWithDefaultModel).toHaveBeenCalledTimes(4);
    expect(single.json).toMatchObject({ count: 1, fileNames: ["image-1.png"] });
    expect(multiple.json).toMatchObject({
      count: 3,
      fileNames: ["image-2.png", "image-3.png", "image-4.png"]
    });
    expect(multiple.artifacts).toHaveLength(3);
  });

  it("normalizes up to four GPA user-input questions into one structured tool result", async () => {
    const requestUserInput = vi.fn().mockResolvedValue({
      approach: "recommended",
      scope: "minimal",
      battle: "ai",
      moves: "simple"
    });
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
            },
            {
              id: "battle",
              label: "Battle mode",
              prompt: "Which battle mode should be used?",
              options: [{ id: "ai", label: "Player vs AI" }]
            },
            {
              id: "moves",
              label: "Move system",
              prompt: "Which move system should be used?",
              options: [{ id: "simple", label: "Simplified moves" }]
            }
          ]
        }
      },
      { cwd: process.cwd(), requestUserInput, requestUserInputEnabled: true } as unknown as ToolRuntimeContext
    );

    expect(requestUserInput).toHaveBeenCalledWith(expect.objectContaining({
      questions: [
        expect.objectContaining({ id: "approach", allowFreeText: true }),
        expect.objectContaining({ id: "scope", allowFreeText: true }),
        expect.objectContaining({ id: "battle", allowFreeText: true }),
        expect.objectContaining({ id: "moves", allowFreeText: true })
      ]
    }));
    expect(result.json).toMatchObject({
      selections: [
        { answer: "Use the recommended approach" },
        { answer: "Minimal" },
        { answer: "Player vs AI" },
        { answer: "Simplified moves" }
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

  it("accepts request_user_input outside GPA mode as a generic clarification", async () => {
    const runtime = new ToolRuntime();
    const requestUserInput = vi.fn().mockResolvedValue({ choice: "one" });
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
        requestUserInput
      } as unknown as ToolRuntimeContext
    );

    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, json: { selections: [{ answer: "One" }] } });
  });

  it("prefers rg and falls back to grep for Windows workspace searches", () => {
    const command = buildCodeSearchCommand("TODO", "C:\\workspace", "win32");

    expect(command).toContain("Get-Command rg");
    expect(command).toContain("elseif (Get-Command grep");
    expect(command).toContain("--glob '!node_modules/**'");
    expect(command).toContain("--exclude-dir=node_modules");
    expect(command).toContain("--max-filesize 5M");
    expect(command).toContain("--glob '!*.png'");
    expect(command).toContain("Select-Object -First 500");
    expect(command).toContain("'[\\\\/](node_modules|dist|build|\\.git)[\\\\/]'");
  });

  it("prefers rg and falls back to grep for Unix workspace searches", () => {
    const command = buildCodeSearchCommand("TODO", "/workspace", "linux");

    expect(command).toContain("command -v rg");
    expect(command).toContain("elif command -v grep");
    expect(command).toContain("--glob '!node_modules/**'");
    expect(command).toContain("--exclude-dir=node_modules");
    expect(command).toContain("--max-filesize 5M");
    expect(command).toContain("--glob '!*.png'");
    expect(command).toContain("head -n 500");
  });

  it("caps code search output even when the shell returns more lines", async () => {
    const runtime = new ToolRuntime();
    const output = Array.from({ length: 700 }, (_, index) => `result-${index}`).join("\n");
    const result = await runtime.execute(
      { id: "search-1", name: "code.search", arguments: { pattern: "result" } },
      {
        cwd: process.cwd(),
        runTerminalCommand: vi.fn().mockResolvedValue({ output })
      } as unknown as ToolRuntimeContext
    );

    expect(result.ok).toBe(true);
    expect(result.content.split("\n")).toHaveLength(MAX_CODE_SEARCH_RESULT_LINES + 1);
    expect(result.content).toContain("[search output truncated]");
    expect(result.content).not.toContain("result-699");
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

  it("treats a live command with no recent output as running instead of timed out", async () => {
    const runTerminalCommand = vi.fn().mockResolvedValue({
      output: "The process is still running. This is an inactivity observation, not a timeout or failure.",
      running: true,
      idleForMs: 300_000
    });
    const runtime = new ToolRuntime();

    const result = await runtime.execute(
      { id: "quiet-download", name: "shell.exec", arguments: { command: "download large-file" } },
      {
        cwd: process.cwd(),
        requestApproval: vi.fn().mockResolvedValue(true),
        runTerminalCommand
      } as unknown as ToolRuntimeContext
    );

    expect(result.ok).toBe(true);
    expect(result.json).toMatchObject({ running: true, idleForMs: 300_000 });
    expect(result.content).toContain("not a timeout or failure");
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

  it("returns a SHA-256 version for file reads and permits controlled non-destructive patches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-version-"));
    const filePath = path.join(root, "note.txt");
    await fs.writeFile(filePath, "before\n", "utf8");
    const requestApproval = vi.fn().mockResolvedValue(true);
    const runtime = new ToolRuntime();
    const context = {
      cwd: root,
      readFile: (target: string) => fs.readFile(target, "utf8"),
      requestApproval,
      executionPolicy: { mode: "controlled", autoVerify: true }
    } as unknown as ToolRuntimeContext;

    try {
      const read = await runtime.execute({ id: "read", name: "fs.read_file", arguments: { path: "note.txt" } }, context);
      expect(read.json?.sha256).toMatch(/^[a-f0-9]{64}$/);
      context.expectedFileVersions = new Map([[filePath, String(read.json?.sha256)]]);
      const patched = await runtime.execute({
        id: "patch",
        name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Update File: note.txt\n@@\n-before\n+after\n*** End Patch" }
      }, context);
      expect(patched.ok).toBe(true);
      expect(patched.json?.transaction).toMatchObject({ committed: true });
      expect(requestApproval).not.toHaveBeenCalled();
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("after\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs only discovered typecheck and test scripts through project.verify", async () => {
    const runTerminalCommand = vi.fn().mockResolvedValue({ output: "ok" });
    const readFile = vi.fn(async (target: string) => {
      if (target.endsWith("package.json")) {
        return JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run", dev: "vite" } });
      }
      if (target.endsWith("pnpm-lock.yaml")) return "lockfileVersion: '9.0'";
      throw new Error("not found");
    });
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "verify", name: "project.verify", arguments: {} },
      { cwd: "C:\\workspace", readFile, runTerminalCommand } as unknown as ToolRuntimeContext
    );

    expect(result).toMatchObject({ ok: true, json: { commands: ["pnpm run typecheck", "pnpm run test"], passed: true } });
    expect(runTerminalCommand).toHaveBeenNthCalledWith(1, "pnpm run typecheck");
    expect(runTerminalCommand).toHaveBeenNthCalledWith(2, "pnpm run test");
  });

  it("reports project.verify as unexecuted when no verification command is available", async () => {
    const runTerminalCommand = vi.fn();
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "verify-empty", name: "project.verify", arguments: {} },
      {
        cwd: "C:\\workspace",
        readFile: vi.fn().mockRejectedValue(new Error("package.json not found")),
        runTerminalCommand
      } as unknown as ToolRuntimeContext
    );

    expect(result).toMatchObject({
      ok: true,
      json: { commands: [], passed: false, unverified: true, executed: false }
    });
    expect(result.content).toContain("remains unverified");
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

  it("sets verification viewports and returns screenshot attachments", async () => {
    const runtime = new ToolRuntime();
    const setBrowserViewport = vi.fn().mockResolvedValue({
      tabId: "tab-1",
      viewport: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }
    });
    const captureBrowserScreenshot = vi.fn().mockResolvedValue({
      title: "Preview",
      url: "http://127.0.0.1:3000",
      filePath: "C:\\output\\browser\\preview.png",
      width: 390,
      height: 844,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      fullPage: false,
      capturedAt: "2026-07-13T00:00:00.000Z",
      attachment: {
        id: "attachment-1",
        kind: "image",
        name: "preview.png",
        mimeType: "image/png",
        absolutePath: "C:\\output\\browser\\preview.png",
        sizeBytes: 1234,
        width: 390,
        height: 844,
        source: "generated"
      },
      artifact: {
        id: "artifact-1",
        threadId: "thread-1",
        turnRunId: "turn-1",
        messageId: null,
        toolCallId: null,
        artifactKind: "browser-screenshot",
        displayName: "preview.png",
        absolutePath: "C:\\output\\browser\\preview.png",
        relativePath: "browser\\preview.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        sha256: "hash",
        sourceKind: "browser",
        isUserVisible: true,
        status: "ready",
        createdAt: "2026-07-13T00:00:00.000Z"
      }
    });
    const emitBrowserVerificationEvent = vi.fn().mockResolvedValue(undefined);
    const context = {
      cwd: process.cwd(),
      setBrowserViewport,
      captureBrowserScreenshot,
      emitBrowserVerificationEvent
    } as unknown as ToolRuntimeContext;

    const viewport = await runtime.execute({
      id: "viewport-mobile",
      name: "browser.set_viewport",
      arguments: { tabId: "tab-1", width: 390, height: 844 }
    }, context);
    const screenshot = await runtime.execute({
      id: "screenshot-mobile",
      name: "browser.capture_screenshot",
      arguments: { tabId: "tab-1" }
    }, context);

    expect(viewport.ok).toBe(true);
    expect(setBrowserViewport).toHaveBeenCalledWith("tab-1", expect.objectContaining({ width: 390, height: 844, mobile: true }));
    expect(screenshot.attachments).toEqual([expect.objectContaining({ kind: "image", width: 390, height: 844 })]);
    expect(screenshot.artifacts).toHaveLength(1);
    expect(emitBrowserVerificationEvent).toHaveBeenCalledWith("browser.screenshot_attached", expect.objectContaining({ tabId: "tab-1" }));
  });

  it("fails browser.assert_page when a deterministic assertion fails", async () => {
    const runtime = new ToolRuntime();
    const assertBrowserPage = vi.fn().mockResolvedValue({
      title: "Preview",
      url: "http://127.0.0.1:3000",
      viewport: { width: 1440, height: 900 },
      passed: false,
      results: [{ check: { type: "text", value: "Ready" }, passed: false, message: "text did not match" }]
    });
    const result = await runtime.execute({
      id: "assert-page",
      name: "browser.assert_page",
      arguments: { tabId: "tab-1", checks: [{ type: "text", value: "Ready" }] }
    }, { cwd: process.cwd(), assertBrowserPage } as unknown as ToolRuntimeContext);

    expect(result.ok).toBe(false);
    expect(result.json).toMatchObject({ passed: false });
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

    expect(result.content).toBe("Directory listing succeeded. The directory is empty.");
    expect(result.content).not.toContain("project");
  });

  it("exposes managed writing and extension installation tools directly", () => {
    const { direct, deferred } = new ToolRuntime().listToolSpecs();

    expect(direct.map((tool) => tool.name)).toContain("apply_patch");
    expect(direct.map((tool) => tool.name)).toContain("fs.write_file");
    expect(direct.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "skills.install",
      "plugins.install",
      "mcp.install"
    ]));
    expect(deferred.map((tool) => tool.name)).not.toContain("fs.write_file");
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

  it("accepts project-internal absolute file paths and rejects paths outside the project folder", async () => {
    const readFile = vi.fn();
    const runtime = new ToolRuntime();
    const insidePath = path.join(process.cwd(), "inside.txt");
    const context = {
      cwd: process.cwd(),
      readFile: readFile.mockResolvedValue("inside")
    } as unknown as ToolRuntimeContext;

    const inside = await runtime.execute(
      { id: "call-inside", name: "fs.read_file", arguments: { path: insidePath } },
      context
    );

    expect(inside).toMatchObject({ ok: true, content: "inside" });
    expect(readFile).toHaveBeenCalledWith(insidePath);

    await expect(
      runtime.execute(
        { id: "call-2", name: "fs.read_file", arguments: { path: path.resolve(process.cwd(), "..", "outside.txt") } },
        context
      )
    ).rejects.toThrow("outside the project folder");
    expect(readFile).toHaveBeenCalledTimes(1);
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

  it("accepts a patch wrapped in a markdown code fence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const runtime = new ToolRuntime();
    const context = {
      cwd: root,
      requestApproval: vi.fn().mockResolvedValue(true)
    } as unknown as ToolRuntimeContext;

    try {
      const result = await runtime.execute(
        {
          id: "fenced-patch",
          name: "apply_patch",
          arguments: {
            patch: "```diff\n*** Begin Patch\n*** Add File: fenced.html\n+<h1>Fenced</h1>\n*** End Patch\n```"
          }
        },
        context
      );

      expect(result.ok).toBe(true);
      await expect(fs.readFile(path.join(root, "fenced.html"), "utf8")).resolves.toBe("<h1>Fenced</h1>\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("repairs header variants and a missing End Patch terminator", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const runtime = new ToolRuntime();
    const context = {
      cwd: root,
      requestApproval: vi.fn().mockResolvedValue(true)
    } as unknown as ToolRuntimeContext;

    try {
      const result = await runtime.execute(
        {
          id: "loose-patch",
          name: "apply_patch",
          arguments: {
            patch: "***Begin Patch\n***Add File：loose.txt\n+loose\n"
          }
        },
        context
      );

      expect(result.ok).toBe(true);
      await expect(fs.readFile(path.join(root, "loose.txt"), "utf8")).resolves.toBe("loose\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefixes Add File content lines that miss the + marker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const runtime = new ToolRuntime();
    const context = {
      cwd: root,
      requestApproval: vi.fn().mockResolvedValue(true)
    } as unknown as ToolRuntimeContext;

    try {
      const result = await runtime.execute(
        {
          id: "raw-add-patch",
          name: "apply_patch",
          arguments: {
            patch: "*** Begin Patch\n*** Add File: raw.txt\nfirst line\n\nthird line\n*** End Patch"
          }
        },
        context
      );

      expect(result.ok).toBe(true);
      await expect(fs.readFile(path.join(root, "raw.txt"), "utf8")).resolves.toBe("first line\n\nthird line\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("converts a unified update diff into a canonical patch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const filePath = path.join(root, "note.txt");
    await fs.writeFile(filePath, "before\n", "utf8");
    const runtime = new ToolRuntime();

    try {
      const result = await runtime.execute(
        {
          id: "unified-update",
          name: "apply_patch",
          arguments: {
            patch: "--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n"
          }
        },
        { cwd: root, requestApproval: vi.fn().mockResolvedValue(true) } as unknown as ToolRuntimeContext
      );

      expect(result.ok).toBe(true);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("after\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts project-internal absolute paths in canonical patches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const filePath = path.join(root, "index.html");
    await fs.writeFile(filePath, "<h1>Before</h1>\n", "utf8");
    const runtime = new ToolRuntime();

    try {
      const result = await runtime.execute(
        {
          id: "absolute-patch",
          name: "apply_patch",
          arguments: {
            patch: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-<h1>Before</h1>\n+<h1>After</h1>\n*** End Patch`
          }
        },
        { cwd: root, requestApproval: vi.fn().mockResolvedValue(true) } as unknown as ToolRuntimeContext
      );

      expect(result.ok).toBe(true);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("<h1>After</h1>\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns canonical recovery guidance for an invalid patch", async () => {
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      {
        id: "invalid-patch",
        name: "apply_patch",
        arguments: { patch: "*** Begin Patch\n*** Changed Range: 35\n*** End Patch" }
      },
      { cwd: process.cwd(), requestApproval: vi.fn().mockResolvedValue(true) } as unknown as ToolRuntimeContext
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.content).toContain("Unsupported patch line: *** Changed Range: 35");
    expect(result.content).toContain("*** Begin Patch");
    expect(result.content).toContain("Re-read the intended target file");
  });

  it("supports fs.read_file offset/limit and code.outline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-tool-runtime-"));
    const runtime = new ToolRuntime();
    const filePath = path.join(root, "sample.js");
    await fs.writeFile(
      filePath,
      ["function alpha() {}", "function beta() {}", "function gamma() {}"].join("\n"),
      "utf8"
    );
    const context = {
      cwd: root,
      readFile: (target: string) => fs.readFile(target, "utf8")
    } as unknown as ToolRuntimeContext;

    try {
      const slice = await runtime.execute(
        {
          id: "read-slice",
          name: "fs.read_file",
          arguments: { path: "sample.js", offset: 2, limit: 1 }
        },
        context
      );
      expect(slice.ok).toBe(true);
      expect(slice.content).toContain("lines 2-2 of 3");
      expect(slice.content).toContain("function beta()");
      expect(slice.json).toMatchObject({ startLine: 2, endLine: 2, totalLines: 3 });

      const outline = await runtime.execute(
        {
          id: "outline",
          name: "code.outline",
          arguments: { path: "sample.js" }
        },
        context
      );
      expect(outline.ok).toBe(true);
      expect(outline.content).toContain("function alpha");
      expect(outline.content).toContain("function beta");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("browser page sanitize", () => {
  it("strips html and truncates text for model payloads", async () => {
    const { pageForModel, sanitizeBrowserToolJson } = await import("@tool-runtime");
    const page = pageForModel({
      title: "Demo",
      url: "http://127.0.0.1/",
      text: "x".repeat(20_000),
      html: "<html><body>huge</body></html>"
    });
    expect(page).toBeTruthy();
    expect(page?.html).toBeUndefined();
    expect(String(page?.text).length).toBeLessThan(20_000);
    expect(String(page?.text)).toContain("truncated");

    const sanitized = sanitizeBrowserToolJson({
      tab: { id: "1" },
      page: {
        title: "Demo",
        url: "http://127.0.0.1/",
        text: "hello",
        html: "<html></html>"
      }
    }) as { page: { html?: string; text: string } };
    expect(sanitized.page.html).toBeUndefined();
    expect(sanitized.page.text).toBe("hello");
  });

  it("returns a clear notice for git.status when the workspace is not a git repo", async () => {
    const runTerminalCommand = vi.fn().mockRejectedValue(
      new Error("fatal: not a git repository (or any of the parent directories): .git")
    );
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "git-status", name: "git.status", arguments: {} },
      { cwd: process.cwd(), runTerminalCommand } as unknown as ToolRuntimeContext
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("不是 git 仓库");
    expect(result.json).toMatchObject({ isGitRepository: false });
    expect(runTerminalCommand).toHaveBeenCalledWith("git rev-parse --is-inside-work-tree");
    expect(runTerminalCommand).not.toHaveBeenCalledWith("git status --short --branch");
  });

  it("stages a file after approval", async () => {
    const runTerminalCommand = vi.fn(async (command: string) => {
      if (command === "git rev-parse --is-inside-work-tree") return { output: "true\n" };
      return { output: "" };
    });
    const requestApproval = vi.fn().mockResolvedValue(true);
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "git-stage", name: "git.stage_file", arguments: { path: "src/App.tsx" } },
      {
        cwd: process.cwd(),
        runTerminalCommand,
        requestApproval
      } as unknown as ToolRuntimeContext
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("已暂存");
    expect(requestApproval).toHaveBeenCalled();
    expect(runTerminalCommand).toHaveBeenCalledWith(expect.stringContaining("git add --"));
  });

  it("rejects git.stage_file when approval is denied", async () => {
    const runTerminalCommand = vi.fn(async (command: string) => {
      if (command === "git rev-parse --is-inside-work-tree") return { output: "true\n" };
      return { output: "" };
    });
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "git-stage-deny", name: "git.stage_file", arguments: { path: "src/App.tsx" } },
      {
        cwd: process.cwd(),
        runTerminalCommand,
        requestApproval: vi.fn().mockResolvedValue(false)
      } as unknown as ToolRuntimeContext
    );

    expect(result.ok).toBe(false);
    expect(runTerminalCommand).not.toHaveBeenCalledWith(expect.stringContaining("git add --"));
  });

  it("rejects fs.delete when approval is denied", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-delete-deny-"));
    await fs.writeFile(path.join(cwd, "keep.txt"), "x", "utf8");
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "delete-deny", name: "fs.delete", arguments: { path: "keep.txt" } },
      {
        cwd,
        requestApproval: vi.fn().mockResolvedValue(false)
      } as unknown as ToolRuntimeContext
    );
    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(cwd, "keep.txt"), "utf8")).toBe("x");
  });

  it("creates directories with fs.mkdir after approval", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-mkdir-"));
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      { id: "mkdir", name: "fs.mkdir", arguments: { path: "nested/dir" } },
      {
        cwd,
        requestApproval: vi.fn().mockResolvedValue(true)
      } as unknown as ToolRuntimeContext
    );
    expect(result.ok).toBe(true);
    expect((await fs.stat(path.join(cwd, "nested", "dir"))).isDirectory()).toBe(true);
  });

  it("writes and reads thread todos", async () => {
    const items = [{ id: "T1", content: "Implement tools", status: "in_progress" as const }];
    const runtime = new ToolRuntime();
    const write = await runtime.execute(
      { id: "todo-write", name: "todo.write", arguments: { items } },
      {
        cwd: process.cwd(),
        writeThreadTodos: vi.fn().mockResolvedValue(undefined),
        readThreadTodos: vi.fn().mockResolvedValue(items)
      } as unknown as ToolRuntimeContext
    );
    const read = await runtime.execute(
      { id: "todo-read", name: "todo.read", arguments: {} },
      {
        cwd: process.cwd(),
        readThreadTodos: vi.fn().mockResolvedValue(items)
      } as unknown as ToolRuntimeContext
    );
    expect(write.ok).toBe(true);
    expect(read.content).toContain("T1");
  });

  it("adds a knowledge note after approval", async () => {
    const addKnowledgeNote = vi.fn().mockResolvedValue({
      documentId: "doc-1",
      knowledgeBaseId: "kb-1",
      sourcePath: "agent-notes/1.md"
    });
    const runtime = new ToolRuntime();
    const result = await runtime.execute(
      {
        id: "knowledge-add",
        name: "knowledge.add",
        arguments: { title: "Note", content: "Remember this." }
      },
      {
        cwd: process.cwd(),
        requestApproval: vi.fn().mockResolvedValue(true),
        addKnowledgeNote
      } as unknown as ToolRuntimeContext
    );
    expect(result.ok).toBe(true);
    expect(addKnowledgeNote).toHaveBeenCalledWith({
      title: "Note",
      content: "Remember this.",
      knowledgeBaseId: undefined
    });
  });

  it("parses compiler diagnostics from verification output", () => {
    const diagnostics = parseVerificationDiagnostics(
      "src/App.tsx(12,4): error TS2304: Cannot find name 'foo'."
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        file: "src/App.tsx",
        line: 12,
        column: 4,
        message: "Cannot find name 'foo'."
      })
    ]);
  });
});
