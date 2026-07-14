import { describe, expect, it } from "vitest";
import {
  buildBackgroundLaunchCommand,
  isLocalServerCommand,
  redirectStaticHtmlLaunch
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
});
