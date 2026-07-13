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
