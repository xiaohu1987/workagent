import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  McpServerConfig,
  PluginHookDeclaration,
  PluginManifestSummary,
  PluginRecord
} from "@shared-types";
import type { SkillRootDefinition } from "@skills-runtime";

interface RawPluginManifest {
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  repository?: string;
  skills?: string;
  hooks?: string | Record<string, unknown>;
  mcpServers?: string | Record<string, unknown>;
  interface?: {
    displayName?: string;
  };
}

interface PluginManifestDocument {
  installPath: string;
  manifestPath: string;
  pluginId: string;
  raw: RawPluginManifest;
}

interface PluginStartupContext {
  content: string | null;
  source: "skill" | "hook" | "manifest" | "none";
  manifest: PluginManifestSummary | null;
}

export class PluginRuntime {
  public async installFromSource(
    source: string,
    installedDir: string
  ): Promise<PluginRecord> {
    const normalized = normalizePluginSource(source);
    const localName = repoNameFromSource(normalized);
    const targetDir = path.join(installedDir, localName);

    if (await exists(targetDir)) {
      if (await exists(path.join(targetDir, ".git"))) {
        await runCommand("git", ["-C", targetDir, "pull", "--ff-only"], installedDir);
      }
    } else if (await exists(source)) {
      await fs.cp(source, targetDir, { recursive: true });
    } else {
      await runCommand("git", ["clone", "--depth", "1", normalized, targetDir], installedDir);
    }

    const plugin = await this.readInstalledPlugin(targetDir, normalized);
    if (!plugin) {
      throw new Error(`Installed source ${source} is missing .codex-plugin/plugin.json.`);
    }
    return plugin;
  }

  public async discoverInstalledPlugins(installedDir: string): Promise<PluginRecord[]> {
    if (!(await exists(installedDir))) {
      return [];
    }

    const entries = await fs.readdir(installedDir, { withFileTypes: true });
    const plugins: PluginRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const plugin = await this.readInstalledPlugin(path.join(installedDir, entry.name));
      if (plugin) {
        plugins.push(plugin);
      }
    }

    return plugins.sort((left, right) => left.name.localeCompare(right.name));
  }

  public async readManifest(installPath: string): Promise<PluginManifestSummary | null> {
    const document = await this.loadManifestDocument(installPath);
    if (!document) {
      return null;
    }

    const skillsDir = document.raw.skills
      ? path.resolve(installPath, document.raw.skills)
      : path.join(installPath, "skills");
    const hooksFile = await resolveHooksFile(document);
    const hooks = await readPluginHookDeclarations(document, hooksFile);
    const mcpServers = await readPluginMcpServers(document);

    return {
      id: document.pluginId,
      name: document.raw.interface?.displayName ?? document.raw.name ?? document.pluginId,
      version: document.raw.version ?? "0.0.0",
      description: document.raw.description,
      skillsDir: (await exists(skillsDir)) ? skillsDir : null,
      hooksFile,
      repository: document.raw.repository ?? document.raw.homepage ?? null,
      mcpServers,
      hooks
    };
  }

  public async collectPluginSkillRoots(
    plugins: PluginRecord[],
    enabledPluginIds?: string[]
  ): Promise<SkillRootDefinition[]> {
    const enabled = enabledPluginIds ? new Set(enabledPluginIds) : null;
    const roots: SkillRootDefinition[] = [];

    for (const plugin of plugins) {
      if (enabled && !enabled.has(plugin.id)) {
        continue;
      }

      const manifest = await this.readManifest(plugin.installPath);
      if (!manifest?.skillsDir) {
        continue;
      }

      roots.push({
        path: manifest.skillsDir,
        scope: "user",
        pluginId: plugin.id
      });
    }

    return roots;
  }

  public async collectPluginMcpServers(
    plugins: PluginRecord[],
    enabledPluginIds?: string[]
  ): Promise<McpServerConfig[]> {
    const enabled = enabledPluginIds ? new Set(enabledPluginIds) : null;
    const servers: McpServerConfig[] = [];

    for (const plugin of plugins) {
      if (enabled && !enabled.has(plugin.id)) {
        continue;
      }

      const manifest = await this.readManifest(plugin.installPath);
      if (!manifest) {
        continue;
      }

      servers.push(...manifest.mcpServers);
    }

    return servers;
  }

  public async buildWorkflowPackBootstrap(plugin: PluginRecord): Promise<string | null> {
    const startupContext = await this.collectStartupContext(plugin);
    return startupContext.content;
  }

  public async collectStartupContext(plugin: PluginRecord): Promise<PluginStartupContext> {
    const manifest = await this.readManifest(plugin.installPath);
    const preferredPaths = [
      path.join(plugin.installPath, "skills", "using-superpowers", "SKILL.md"),
      path.join(plugin.installPath, "skills", "getting-started", "SKILL.md")
    ];

    for (const skillPath of preferredPaths) {
      if (await exists(skillPath)) {
        return {
          content: await fs.readFile(skillPath, "utf8"),
          source: "skill",
          manifest
        };
      }
    }

    const sessionStartHooks =
      manifest?.hooks.filter((hook) => hook.eventName.toLowerCase() === "sessionstart") ?? [];
    if (manifest && sessionStartHooks.length > 0) {
      const lines = [
        `Workflow Pack: ${manifest.name}`,
        manifest.description ?? "",
        `Native startup context adapted from ${sessionStartHooks.length} SessionStart hook(s).`,
        ...sessionStartHooks
          .slice(0, 4)
          .map((hook) => `- ${hook.statusMessage ?? hook.command ?? hook.matcher ?? "SessionStart hook"}`)
      ].filter(Boolean);
      return {
        content: lines.join("\n"),
        source: "hook",
        manifest
      };
    }

    if (!manifest) {
      return {
        content: null,
        source: "none",
        manifest: null
      };
    }

    return {
      content: [
        `Workflow Pack: ${manifest.name}`,
        manifest.description ?? "",
        manifest.mcpServers.length > 0
          ? `Provides ${manifest.mcpServers.length} plugin MCP server(s).`
          : "",
        "Use the plugin-provided skills before acting when they match the task."
      ]
        .filter(Boolean)
        .join("\n"),
      source: "manifest",
      manifest
    };
  }

  private async readInstalledPlugin(installPath: string, source?: string): Promise<PluginRecord | null> {
    const document = await this.loadManifestDocument(installPath);
    if (!document) {
      return null;
    }
    const id = document.pluginId;
    const record: PluginRecord = {
      id,
      name: document.raw.interface?.displayName ?? document.raw.name ?? id,
      version: document.raw.version ?? "0.0.0",
      manifestPath: document.manifestPath,
      installPath,
      enabled: true,
      source: source ?? document.raw.repository ?? document.raw.homepage ?? installPath
    };
    return record;
  }

  private async loadManifestDocument(installPath: string): Promise<PluginManifestDocument | null> {
    const manifestPath = path.join(installPath, ".codex-plugin", "plugin.json");
    if (!(await exists(manifestPath))) {
      return null;
    }

    const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RawPluginManifest;
    return {
      installPath,
      manifestPath,
      pluginId: slugify(raw.name ?? path.basename(installPath)),
      raw
    };
  }
}

export async function hashDirectory(dirPath: string): Promise<string> {
  const hash = createHash("sha256");
  await walkAndHash(dirPath, hash, dirPath);
  return hash.digest("hex");
}

async function walkAndHash(dirPath: string, hash: ReturnType<typeof createHash>, root: string): Promise<void> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const nextPath = path.join(dirPath, entry.name);
    const relative = path.relative(root, nextPath);
    hash.update(relative);
    if (entry.isDirectory()) {
      await walkAndHash(nextPath, hash, root);
    } else if (entry.isFile()) {
      hash.update(await fs.readFile(nextPath));
    }
  }
}

function normalizePluginSource(source: string): string {
  if (/^https?:\/\//i.test(source) || /^git@/i.test(source)) {
    return source;
  }
  if (/^[^/]+\/[^/]+$/i.test(source)) {
    return `https://github.com/${source}.git`;
  }
  return source;
}

function repoNameFromSource(source: string): string {
  const cleaned = source.replace(/\.git$/i, "").replace(/[\\/]+$/, "");
  return cleaned.split(/[\\/]/).pop() ?? "plugin";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Command failed with code ${code}`));
    });
  });
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveHooksFile(document: PluginManifestDocument): Promise<string | null> {
  const configured = document.raw.hooks;
  if (typeof configured === "string") {
    const resolved = path.resolve(document.installPath, configured);
    return (await exists(resolved)) ? resolved : null;
  }

  const fallbackFiles = [
    path.join(document.installPath, "hooks", "hooks-codex.json"),
    path.join(document.installPath, "hooks.json")
  ];

  for (const filePath of fallbackFiles) {
    if (await exists(filePath)) {
      return filePath;
    }
  }

  return typeof configured === "object" && configured ? document.manifestPath : null;
}

async function readPluginHookDeclarations(
  document: PluginManifestDocument,
  hooksFile: string | null
): Promise<PluginHookDeclaration[]> {
  const configured = document.raw.hooks;
  const source = typeof configured === "object" && configured
    ? configured
    : hooksFile && hooksFile !== document.manifestPath
      ? JSON.parse(await fs.readFile(hooksFile, "utf8"))
      : null;

  if (!source) {
    return [];
  }

  return parsePluginHookDeclarations(source, hooksFile ?? document.manifestPath);
}

function parsePluginHookDeclarations(
  source: unknown,
  sourcePath: string
): PluginHookDeclaration[] {
  if (!source || typeof source !== "object") {
    return [];
  }

  const declarations: PluginHookDeclaration[] = [];
  const root = source as Record<string, unknown>;

  if (Array.isArray(root.hooks)) {
    root.hooks.forEach((hook, index) => {
      const declaration = normalizeHookDeclaration(hook, sourcePath, "Hook", index, 0, null);
      if (declaration) {
        declarations.push(declaration);
      }
    });
  }

  for (const [eventName, groups] of Object.entries(root)) {
    if (eventName === "hooks" || eventName === "state") {
      continue;
    }

    if (Array.isArray(groups)) {
      groups.forEach((group, groupIndex) => {
        declarations.push(...parseMatcherGroup(eventName, group, sourcePath, groupIndex));
      });
      continue;
    }

    if (groups && typeof groups === "object") {
      declarations.push(...parseMatcherGroup(eventName, groups, sourcePath, 0));
    }
  }

  return declarations;
}

function parseMatcherGroup(
  eventName: string,
  group: unknown,
  sourcePath: string,
  groupIndex: number
): PluginHookDeclaration[] {
  if (!group || typeof group !== "object") {
    return [];
  }

  const typedGroup = group as Record<string, unknown>;
  const matcher = typeof typedGroup.matcher === "string" ? typedGroup.matcher : null;
  const hooks = Array.isArray(typedGroup.hooks) ? typedGroup.hooks : [typedGroup];

  return hooks
    .map((hook, hookIndex) =>
      normalizeHookDeclaration(hook, sourcePath, eventName, groupIndex, hookIndex, matcher)
    )
    .filter((hook): hook is PluginHookDeclaration => !!hook);
}

function normalizeHookDeclaration(
  hook: unknown,
  sourcePath: string,
  eventName: string,
  groupIndex: number,
  hookIndex: number,
  matcher: string | null
): PluginHookDeclaration | null {
  if (!hook || typeof hook !== "object") {
    return null;
  }

  const typedHook = hook as Record<string, unknown>;
  const command = typeof typedHook.command === "string" ? typedHook.command : null;
  const commandWindows = typeof typedHook.commandWindows === "string"
    ? typedHook.commandWindows
    : null;
  if (!command && !commandWindows) {
    return null;
  }

  return {
    key: `${sourcePath}:${eventName}:${groupIndex}:${hookIndex}`,
    eventName,
    matcher,
    command,
    commandWindows,
    statusMessage: typeof typedHook.statusMessage === "string" ? typedHook.statusMessage : null,
    timeoutSec: typeof typedHook.timeout === "number" ? typedHook.timeout : null,
    sourcePath
  };
}

async function readPluginMcpServers(document: PluginManifestDocument): Promise<McpServerConfig[]> {
  const declaration = await resolvePluginMcpDeclaration(document);
  if (!declaration || typeof declaration !== "object") {
    return [];
  }

  const entries = extractMcpServerEntries(declaration);
  const servers: McpServerConfig[] = [];
  for (const [serverName, rawConfig] of Object.entries(entries)) {
    const parsed = normalizeMcpServerConfig(document, serverName, rawConfig);
    if (parsed) {
      servers.push(parsed);
    }
  }

  return servers;
}

async function resolvePluginMcpDeclaration(
  document: PluginManifestDocument
): Promise<Record<string, unknown> | null> {
  const configured = document.raw.mcpServers;
  if (typeof configured === "string") {
    const configPath = path.resolve(document.installPath, configured);
    if (!(await exists(configPath))) {
      return null;
    }
    return JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  }

  if (configured && typeof configured === "object") {
    return configured;
  }

  const defaultPath = path.join(document.installPath, ".mcp.json");
  if (!(await exists(defaultPath))) {
    return null;
  }
  return JSON.parse(await fs.readFile(defaultPath, "utf8")) as Record<string, unknown>;
}

function extractMcpServerEntries(source: Record<string, unknown>): Record<string, unknown> {
  if (source.mcpServers && typeof source.mcpServers === "object" && !Array.isArray(source.mcpServers)) {
    return source.mcpServers as Record<string, unknown>;
  }
  return source;
}

function normalizeMcpServerConfig(
  document: PluginManifestDocument,
  serverName: string,
  rawConfig: unknown
): McpServerConfig | null {
  if (!rawConfig || typeof rawConfig !== "object") {
    return null;
  }

  const typed = rawConfig as Record<string, unknown>;
  const command = typeof typed.command === "string"
    ? resolveExecutablePath(document.installPath, typed.command)
    : undefined;
  const url = typeof typed.url === "string" ? typed.url : undefined;
  const transport = typeof typed.transport === "string"
    ? typed.transport
    : typeof typed.type === "string"
      ? typed.type
      : command
        ? "stdio"
        : url
          ? "streamable_http"
          : undefined;

  if (!command && !url) {
    return null;
  }
  // Plugins may declare remote endpoints, but credentials must be attached by the
  // local user configuration rather than travelling in an installable manifest.
  if (url && (typed.auth !== undefined || typed.headers !== undefined || typed.bearerTokenEnvVar !== undefined)) {
    return null;
  }

  return {
    id: `${document.pluginId}:${slugify(serverName)}`,
    name: serverName,
    description: typeof typed.description === "string" ? typed.description : undefined,
    command,
    args: Array.isArray(typed.args) ? typed.args.map(String) : undefined,
    env: normalizeEnv(typed.env),
    cwd: typeof typed.cwd === "string"
      ? path.resolve(document.installPath, typed.cwd)
      : command
        ? document.installPath
        : undefined,
    url,
    transport,
    source: "plugin",
    pluginId: document.pluginId,
    enabled: typed.enabled !== false
  };
}

function normalizeEnv(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, String(value)])
  );
}

function resolveExecutablePath(root: string, value: string): string {
  if (/^\.\.?([\\/]|$)/.test(value)) {
    return path.resolve(root, value);
  }
  return value;
}
