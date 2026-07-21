import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRuntime } from "@plugin-runtime";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexh-plugin-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("PluginRuntime", () => {
  it("installs from a local source directory and discovers plugin skill roots", async () => {
    const sourceRoot = await makeTempDir();
    const installedRoot = await makeTempDir();
    const pluginSource = path.join(sourceRoot, "superpowers");

    await fs.mkdir(path.join(pluginSource, ".codex-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginSource, "hooks"), { recursive: true });
    await fs.mkdir(path.join(pluginSource, "skills", "using-superpowers"), { recursive: true });
    await fs.writeFile(
      path.join(pluginSource, ".codex-plugin", "plugin.json"),
      JSON.stringify(
        {
          name: "superpowers",
          version: "1.2.3",
          description: "Workflow pack",
          skills: "skills",
          hooks: "./hooks/hooks-codex.json",
          mcpServers: "./.mcp.json"
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(pluginSource, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            repoInfo: {
              command: "node",
              args: ["server.js"]
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(pluginSource, "hooks", "hooks-codex.json"),
      JSON.stringify(
        {
          SessionStart: [
            {
              matcher: ".*",
              hooks: [
                {
                  type: "command",
                  command: "python start.py",
                  statusMessage: "Loading superpowers",
                  timeout: 5
                }
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(pluginSource, "skills", "using-superpowers", "SKILL.md"),
      "---\nname: using-superpowers\ndescription: bootstrap\n---\nUse superpowers first.\n",
      "utf8"
    );

    const runtime = new PluginRuntime();
    const progress: Array<{ percent: number; stage: string }> = [];
    const installed = await runtime.installFromSource(pluginSource, installedRoot, (event) => progress.push(event));
    const plugins = await runtime.discoverInstalledPlugins(installedRoot);
    const roots = await runtime.collectPluginSkillRoots(plugins, [installed.id]);
    const manifest = await runtime.readManifest(installed.installPath);
    const mcpServers = await runtime.collectPluginMcpServers(plugins, [installed.id]);
    const bootstrap = await runtime.buildWorkflowPackBootstrap(installed);

    expect(installed.id).toBe("superpowers");
    expect(plugins).toHaveLength(1);
    expect(roots[0]?.pluginId).toBe("superpowers");
    expect(manifest?.hooks[0]?.eventName).toBe("SessionStart");
    expect(manifest?.mcpServers[0]?.id).toBe("superpowers:repoinfo");
    expect(mcpServers[0]?.command).toBe("node");
    expect(bootstrap).toContain("Use superpowers first");
    expect(progress.map((event) => event.percent)).toEqual([5, 35, 72, 80]);
  });
});
