import { describe, expect, it, vi } from "vitest";
import {
  buildBackgroundLaunchCommand,
  isLocalServerCommand,
  redirectStaticHtmlLaunch,
  TerminalRuntime
} from "../apps/desktop/src/main/terminal-runtime";

describe("TerminalRuntime local servers", () => {
  it("detects foreground local development server commands", () => {
    expect(isLocalServerCommand("npx http-server -p 8000 -c-1")).toBe(true);
    expect(isLocalServerCommand("python -m http.server 8000")).toBe(true);
    expect(isLocalServerCommand("python -c \"import socketserver; httpd = socketserver.TCPServer(('127.0.0.1', 8080), h); httpd.serve_forever()\"")).toBe(true);
    expect(isLocalServerCommand("pnpm dev")).toBe(true);
    expect(isLocalServerCommand("Start-Process python -ArgumentList '-m http.server 8000'")).toBe(false);
    expect(isLocalServerCommand("git status --short")).toBe(false);
  });

  it("launches a Windows server command through a detached PowerShell process", () => {
    const launch = buildBackgroundLaunchCommand("npx http-server -p 8000", "D:\\project");

    expect(launch).toContain("Start-Process");
    expect(launch).toContain("-EncodedCommand");
    expect(launch).toContain("-WorkingDirectory 'D:\\project'");
  });

  it("redirects direct HTML launches to a local HTTP server", () => {
    expect(redirectStaticHtmlLaunch("Start-Process (Resolve-Path 'index.html').Path")).toBe(
      "npx http-server . -p 8000 -c-1"
    );
    expect(redirectStaticHtmlLaunch("Start-Process \"index.html\"")).toBe(
      "npx http-server . -p 8000 -c-1"
    );
    expect(redirectStaticHtmlLaunch("git status --short")).toBeUndefined();
  });
});

describe("TerminalRuntime idle command observation", () => {
  it("reports a quiet live process as running instead of timing it out", async () => {
    const runtime = new TerminalRuntime(25);
    const onIdle = vi.fn().mockResolvedValue("No concrete failure evidence was found.");

    try {
      const result = await runtime.execute(
        "quiet-command-thread",
        process.cwd(),
        'node -e "setTimeout(() => {}, 1000)"',
        () => undefined,
        undefined,
        "default",
        onIdle
      );

      expect(onIdle).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ running: true, idleForMs: 25 });
      expect(result.output).toContain("inactivity observation, not a timeout or failure");
    } finally {
      runtime.cancelCommands("quiet-command-thread", "Test cleanup.");
      await runtime.close("quiet-command-thread");
    }
  });
});

describe("web frontend shell policy", () => {
  it("rewrites python http.server and blocks python scaffolding", async () => {
    const {
      prepareShellCommandForWebFrontend,
      rewritePythonHttpServer,
      isPythonScaffoldingCommand
    } = await import("../packages/tool-runtime/src/web-shell-policy");

    expect(rewritePythonHttpServer("python -m http.server 8765")).toBe(
      "npx http-server . -p 8765 -c-1"
    );
    expect(
      isPythonScaffoldingCommand(
        "python -c \"from pathlib import Path; Path('index.html').write_text('<html>')\""
      )
    ).toBe(true);
    expect(
      prepareShellCommandForWebFrontend(
        "python -c \"from pathlib import Path; Path('index.html').write_text('x')\""
      ).ok
    ).toBe(false);
    expect(prepareShellCommandForWebFrontend("python -m http.server 8000")).toEqual({
      ok: true,
      command: "npx http-server . -p 8000 -c-1",
      rewritten: true
    });
    // Read-only validators must not be blocked.
    expect(isPythonScaffoldingCommand("python scripts/validate_game.py")).toBe(false);
    expect(prepareShellCommandForWebFrontend("python scripts/validate_game.py").ok).toBe(true);
    expect(isPythonScaffoldingCommand("python -c \"print(1+1)\"")).toBe(false);
    expect(isPythonScaffoldingCommand("python write_index.py")).toBe(true);
  });

  it("adapts clear CMD syntax and blocks shell-based file writes on Windows", async () => {
    const { prepareShellCommandForWindows } = await import("../packages/tool-runtime/src/web-shell-policy");

    expect(prepareShellCommandForWindows('dir /b *.md 2>nul || echo "no md files"', true)).toEqual({
      ok: true,
      command: `& cmd.exe /d /s /c 'dir /b *.md 2>nul || echo "no md files"'`,
      rewritten: true
    });
    expect(prepareShellCommandForWindows("Set-Content -Path notes.md -Value 'draft'", true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("apply_patch")
    });
    expect(prepareShellCommandForWindows("python -c \"open('notes.md', 'w').write('draft')\"", true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("apply_patch")
    });
    expect(prepareShellCommandForWindows("Get-ChildItem -Name", true)).toEqual({
      ok: true,
      command: "Get-ChildItem -Name"
    });
  });
});
