import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { buildCodeSearchCommand, ToolRuntime, type ToolRuntimeContext } from "@tool-runtime";

describe("ToolRuntime", () => {
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
