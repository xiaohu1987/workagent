import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import TOML from "@iarna/toml";
import { normalizeRuntimeTimeouts } from "@shared-types";
import type {
  AppConfig,
  ApprovalResolutionMode,
  ApprovalRequest,
  ArtifactRecord,
  BrowserTabRecord,
  ContextCompactionRecord,
  KnowledgeBaseRecord,
  KnowledgeBaseSummary,
  KnowledgeConcept,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeImportSource,
  McpServerConfig,
  MessageAttachment,
  MessageRecord,
  ModelProfile,
  PluginRecord,
  ProjectPluginBinding,
  RememberedApprovalRecord,
  QueuedMessageRecord,
  ProviderDefinition,
  RuntimeEvent,
  ThreadRecord,
  ToolCallRecord,
  TurnRunRecord,
  UserInputPrompt
} from "@shared-types";

export interface HomeLayout {
  root: string;
  configFile: string;
  dbFile: string;
  outputsDir: string;
  attachmentsDir: string;
  logsDir: string;
  tmpDir: string;
  cacheDir: string;
  globalKnowledgeDir: string;
  globalBundlesDir: string;
  skillsSystemDir: string;
  skillsInstalledDir: string;
  skillsImportedDir: string;
  skillsDraftsDir: string;
  pluginsInstalledDir: string;
  pluginsDisabledDir: string;
}

export interface ThreadSearchResult {
  thread: ThreadRecord;
  snippet: string | null;
  score: number;
}

export async function ensureHomeLayout(): Promise<HomeLayout> {
  const root = path.join(os.homedir(), ".codexh");
  const layout: HomeLayout = {
    root,
    configFile: path.join(root, "config.toml"),
    dbFile: path.join(root, "codexh.sqlite"),
    outputsDir: path.join(root, "outputs"),
    attachmentsDir: path.join(root, "attachments"),
    logsDir: path.join(root, "logs"),
    tmpDir: path.join(root, "tmp"),
    cacheDir: path.join(root, "cache"),
    globalKnowledgeDir: path.join(root, "knowledge", "global"),
    globalBundlesDir: path.join(root, "knowledge", "global", "bundles"),
    skillsSystemDir: path.join(root, "skills", "system"),
    skillsInstalledDir: path.join(root, "skills", "installed"),
    skillsImportedDir: path.join(root, "skills", "imported"),
    skillsDraftsDir: path.join(root, "skills", "drafts"),
    pluginsInstalledDir: path.join(root, "plugins", "installed"),
    pluginsDisabledDir: path.join(root, "plugins", "disabled")
  };

  await Promise.all([
    fs.mkdir(layout.outputsDir, { recursive: true }),
    fs.mkdir(layout.attachmentsDir, { recursive: true }),
    fs.mkdir(layout.logsDir, { recursive: true }),
    fs.mkdir(layout.tmpDir, { recursive: true }),
    fs.mkdir(layout.cacheDir, { recursive: true }),
    fs.mkdir(layout.globalBundlesDir, { recursive: true }),
    fs.mkdir(layout.skillsSystemDir, { recursive: true }),
    fs.mkdir(layout.skillsInstalledDir, { recursive: true }),
    fs.mkdir(layout.skillsImportedDir, { recursive: true }),
    fs.mkdir(layout.skillsDraftsDir, { recursive: true }),
    fs.mkdir(layout.pluginsInstalledDir, { recursive: true }),
    fs.mkdir(layout.pluginsDisabledDir, { recursive: true })
  ]);

  await seedSystemSkills(layout.skillsSystemDir);
  if (!(await exists(layout.configFile))) {
    await saveConfig(layout.configFile, defaultConfig());
  }

  return layout;
}

export function defaultConfig(): AppConfig {
  const providers: ProviderDefinition[] = [
    { id: "mock", type: "mock" },
    {
      id: "openai",
      type: "openai-compatible",
      apiKeyEnv: "OPENAI_API_KEY"
    },
    {
      id: "anthropic",
      type: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY"
    },
    {
      id: "gemini",
      type: "gemini",
      apiKeyEnv: "GEMINI_API_KEY"
    }
  ];

  const models: ModelProfile[] = [
    {
      id: "mock-codexh",
      providerId: "mock",
      displayName: "Mock codexh",
      contextWindow: 64_000,
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: false,
      role: "reasoning",
      supportsImageGeneration: false,
      supportsVideoGeneration: false,
      agentCapability: "verified",
      supportsReasoningSummary: true,
      defaultTemperature: 0.2,
      defaultMaxOutputTokens: 2_048
    },
    {
      id: "gpt-4.1-mini",
      providerId: "openai",
      displayName: "GPT-4.1 mini",
      contextWindow: 128_000,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsJsonOutput: true,
      supportsMultimodalInput: true,
      role: "reasoning",
      supportsImageGeneration: false,
      supportsVideoGeneration: false,
      supportsReasoningSummary: true,
      defaultTemperature: 0.2,
      defaultMaxOutputTokens: 4_096
    }
  ];

  return {
    defaultModel: "mock-codexh",
    defaultProvider: "mock",
    providers,
    models,
    routing: {},
    multimodal: {
      image: { enabled: true },
      video: { enabled: true }
    },
    desktop: {
      theme: "system",
      approvals: "prompt",
      inAppBrowser: true
    },
    timeouts: normalizeRuntimeTimeouts(),
    mcpServers: []
  };
}

function readMultimodalModels(value: unknown): Array<{ id: string; displayName?: string }> {
  if (!Array.isArray(value)) return [];
  const models: Array<{ id: string; displayName?: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    models.push({
      id,
      displayName: typeof item.displayName === 'string' ? item.displayName : undefined
    });
  }
  return models;
}

function readModalityDefaults(
  value: unknown,
  role: 'image' | 'video',
  models: ModelProfile[]
): { enabled: boolean; defaultProviderId?: string; defaultModelId?: string } {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const enabled = source.enabled !== false;

  let defaultProviderId = typeof source.defaultProviderId === 'string' ? source.defaultProviderId.trim() : '';
  let defaultModelId = typeof source.defaultModelId === 'string' ? source.defaultModelId.trim() : '';

  if (Array.isArray(source.providers)) {
    for (const entry of source.providers) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      for (const modelEntry of readMultimodalModels(item.models)) {
        const matched = models.find((model) => model.id === modelEntry.id);
        if (matched) {
          matched.role = role;
          if (!defaultModelId) {
            defaultModelId = matched.id;
            defaultProviderId = matched.providerId;
          }
        }
      }
    }
  } else if (Array.isArray(source.models)) {
    for (const modelEntry of readMultimodalModels(source.models)) {
      const matched = models.find((model) => model.id === modelEntry.id);
      if (matched) {
        matched.role = role;
        if (!defaultModelId) {
          defaultModelId = matched.id;
          defaultProviderId = matched.providerId;
        }
      }
    }
  }

  const roleModels = models.filter((model) => model.role === role);
  if (defaultModelId && !defaultProviderId) {
    const owner = roleModels.find((model) => model.id === defaultModelId);
    defaultProviderId = owner?.providerId ?? '';
  }

  const defaultOk = roleModels.some(
    (model) => model.id === defaultModelId && model.providerId === defaultProviderId
  );
  if (!defaultOk) {
    const first = roleModels[0];
    defaultProviderId = first?.providerId;
    defaultModelId = first?.id;
  }

  return {
    enabled,
    defaultProviderId: defaultProviderId || undefined,
    defaultModelId: defaultModelId || undefined
  };
}

export async function loadConfig(configFile: string): Promise<AppConfig> {
  const raw = await fs.readFile(configFile, 'utf8');
  const parsed = TOML.parse(raw) as any;
  const providers = Object.entries(parsed.providers ?? {}).map(([id, value]) => ({
    id,
    ...(value as Record<string, unknown>)
  })) as ProviderDefinition[];
  const models = Object.entries(parsed.models ?? {}).map(([id, value]) => {
    const entry = value as Record<string, unknown>;
    const role =
      entry.role === 'image' || entry.role === 'video' || entry.role === 'reasoning'
        ? entry.role
        : undefined;
    return {
      id,
      ...entry,
      role
    };
  }) as ModelProfile[];

  const image = readModalityDefaults(parsed.multimodal?.image, 'image', models);
  const video = readModalityDefaults(parsed.multimodal?.video, 'video', models);

  return {
    defaultModel: parsed.defaultModel ?? 'mock-codexh',
    defaultProvider: parsed.defaultProvider ?? 'mock',
    providers,
    models,
    routing: parsed.routing ?? {},
    multimodal: { image, video },
    desktop: {
      theme: parsed.desktop?.theme ?? 'system',
      approvals: parsed.desktop?.approvals ?? 'prompt',
      inAppBrowser: parsed.desktop?.inAppBrowser ?? true
    },
    timeouts: normalizeRuntimeTimeouts(parsed.timeouts),
    mcpServers: ((parsed.mcpServers ?? []) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id),
      name: String(item.name ?? item.id),
      description: typeof item.description === 'string' ? item.description : undefined,
      command: typeof item.command === 'string' ? item.command : undefined,
      args: Array.isArray(item.args) ? item.args.map(String) : undefined,
      env: item.env as Record<string, string> | undefined,
      cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
      url: typeof item.url === 'string' ? item.url : undefined,
      transport: typeof item.transport === 'string' ? item.transport : undefined,
      auth: normalizeMcpAuth(item.auth),
      defaultToolsApprovalMode: normalizeMcpApprovalMode(item.defaultToolsApprovalMode),
      tools: normalizeMcpTools(item.tools),
      source: 'config',
      enabled: item.enabled !== false
    })) satisfies McpServerConfig[]
  };
}

export async function saveConfig(configFile: string, config: AppConfig): Promise<void> {
  const tomlObject = {
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
    routing: config.routing,
    multimodal: config.multimodal,
    desktop: config.desktop,
    timeouts: normalizeRuntimeTimeouts(config.timeouts),
    providers: Object.fromEntries(config.providers.map((provider) => [provider.id, provider])),
    models: Object.fromEntries(config.models.map((model) => [model.id, model])),
    mcpServers: config.mcpServers.map((server) => ({
      id: server.id,
      name: server.name,
      description: server.description,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      transport: server.transport,
      auth: server.auth,
      defaultToolsApprovalMode: server.defaultToolsApprovalMode,
      tools: server.tools,
      enabled: server.enabled
    }))
  };

  await fs.writeFile(configFile, TOML.stringify(tomlObject as any), "utf8");
}

function normalizeMcpAuth(value: unknown): McpServerConfig["auth"] {
  if (!value || typeof value !== "object") return { mode: "none" };
  const auth = value as Record<string, unknown>;
  const mode = auth.mode === "bearer_env" || auth.mode === "oauth" ? auth.mode : "none";
  return {
    mode,
    bearerTokenEnvVar: typeof auth.bearerTokenEnvVar === "string" ? auth.bearerTokenEnvVar : undefined,
    oauthClientId: typeof auth.oauthClientId === "string" ? auth.oauthClientId : undefined,
    oauthResource: typeof auth.oauthResource === "string" ? auth.oauthResource : undefined,
    oauthScopes: Array.isArray(auth.oauthScopes) ? auth.oauthScopes.map(String) : undefined
  };
}

function normalizeMcpApprovalMode(value: unknown): McpServerConfig["defaultToolsApprovalMode"] {
  return value === "auto" || value === "writes" || value === "approve" || value === "prompt" ? value : "prompt";
}

function normalizeMcpTools(value: unknown): McpServerConfig["tools"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, raw]) => {
    const policy = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return [name, {
      enabled: policy.enabled !== false ? undefined : false,
      approvalMode: normalizeMcpApprovalMode(policy.approvalMode)
    }];
  }));
}

export class DatabaseService {
  readonly #db: DatabaseSync;

  public constructor(dbFile: string) {
    this.#db = new DatabaseSync(dbFile);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.bootstrap();
  }

  public close(): void {
    this.#db.close();
  }

  private bootstrap(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        workspace_kind TEXT NOT NULL,
        cwd TEXT,
        project_id TEXT,
        workspace_id TEXT,
        model_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        status TEXT NOT NULL,
        selected_skill_ids_json TEXT NOT NULL,
        knowledge_base_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        pinned_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_run_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queued_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        content TEXT NOT NULL,
        display_content TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turn_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        resolved_model_snapshot_json TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS approval_records (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_run_id TEXT NOT NULL,
        tool_call_id TEXT,
        project_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        scope TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        approval_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        resolution_mode TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS user_input_prompts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'generic',
        allow_skip INTEGER NOT NULL DEFAULT 0,
        questions_json TEXT NOT NULL,
        status TEXT NOT NULL,
        answers_json TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_run_id TEXT,
        message_id TEXT,
        tool_call_id TEXT,
        artifact_kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        relative_path TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        source_kind TEXT NOT NULL,
        is_user_visible INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id TEXT,
        display_name TEXT NOT NULL,
        bundle_root TEXT NOT NULL,
        okf_version TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_import_runs (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        source_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_concepts (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        source_document_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_path TEXT NOT NULL,
        bundle_relative_path TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5 (
        concept_id UNINDEXED,
        title,
        description,
        tags,
        body
      );
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL, source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL, title TEXT NOT NULL, mime_hint TEXT NOT NULL,
        status TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL, document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        source_path TEXT NOT NULL, locator TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunk_fts USING fts5 (
        chunk_id UNINDEXED, title, content, source_path, locator
      );
      CREATE TABLE IF NOT EXISTS browser_tabs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        is_active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        thread_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        install_path TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_versions (
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        source_hash TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, version)
      );
      CREATE TABLE IF NOT EXISTS project_plugin_bindings (
        project_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        settings_json TEXT,
        PRIMARY KEY (project_id, plugin_id)
      );
      CREATE TABLE IF NOT EXISTS plugin_hook_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        hook_name TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remembered_approvals (
        scope_key TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        project_id TEXT,
        approval_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumns();
  }

  private ensureColumns(): void {
    this.ensureColumn("approval_records", "project_id", "TEXT");
    this.ensureColumn("approval_records", "approval_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("approval_records", "resolution_mode", "TEXT");
    this.ensureColumn("approval_records", "resolved_at", "TEXT");
    this.ensureColumn("threads", "gpa_state_json", "TEXT");
    this.ensureColumn("threads", "is_pinned", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("threads", "pinned_at", "TEXT");
    this.ensureColumn("user_input_prompts", "kind", "TEXT NOT NULL DEFAULT 'generic'");
    this.ensureColumn("user_input_prompts", "allow_skip", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("user_input_prompts", "answers_json", "TEXT");
    this.ensureColumn("user_input_prompts", "answered_at", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  public listThreads(): ThreadRecord[] {
    return this.#db
      .prepare("SELECT * FROM threads ORDER BY is_pinned DESC, pinned_at DESC, created_at DESC, rowid DESC")
      .all()
      .map(mapThreadRow);
  }

  public searchThreads(query: string, limit = 50): ThreadSearchResult[] {
    const normalizedQuery = query.trim();
    const threads = this.listThreads();
    if (!normalizedQuery) {
      return threads.slice(0, limit).map((thread) => ({ thread, snippet: null, score: 0 }));
    }

    const messages = this.#db
      .prepare("SELECT thread_id, content FROM messages ORDER BY created_at DESC")
      .all() as Array<{ thread_id: string; content: string }>;
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const bestByThread = new Map<string, ThreadSearchResult>();

    for (const thread of threads) {
      const score = fuzzyMatchScore(thread.title, normalizedQuery);
      if (score > 0) bestByThread.set(thread.id, { thread, snippet: null, score: score + 120 });
    }
    for (const message of messages) {
      const thread = threadById.get(message.thread_id);
      if (!thread) continue;
      const score = fuzzyMatchScore(message.content, normalizedQuery);
      const previous = bestByThread.get(thread.id);
      if (score > 0 && (!previous || score > previous.score)) {
        bestByThread.set(thread.id, { thread, snippet: createSearchSnippet(message.content, normalizedQuery), score });
      }
    }

    return [...bestByThread.values()]
      .sort((left, right) => right.score - left.score || right.thread.updatedAt.localeCompare(left.thread.updatedAt))
      .slice(0, limit);
  }

  public createThread(input: {
    title: string;
    mode: ThreadRecord["mode"];
    workspaceKind: ThreadRecord["workspaceKind"];
    cwd?: string | null;
    modelId: string;
    providerId: string;
  }): ThreadRecord {
    const now = nowIso();
    const thread: ThreadRecord = {
      id: randomUUID(),
      title: input.title,
      mode: input.mode,
      workspaceKind: input.workspaceKind,
      cwd: input.cwd ?? null,
      projectId: input.cwd ? hashPath(input.cwd) : null,
      workspaceId: input.cwd ? hashPath(input.cwd) : null,
      modelId: input.modelId,
      providerId: input.providerId,
      status: "idle",
      selectedSkillIds: [],
      knowledgeBaseIds: [],
      createdAt: now,
      updatedAt: now,
      isPinned: false,
      pinnedAt: null,
      gpaStateJson: null
    };

    this.#db
      .prepare(`
        INSERT INTO threads (
          id, title, mode, workspace_kind, cwd, project_id, workspace_id,
          model_id, provider_id, status, selected_skill_ids_json,
          knowledge_base_ids_json, created_at, updated_at, is_pinned, pinned_at, gpa_state_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        thread.id,
        thread.title,
        thread.mode,
        thread.workspaceKind,
        thread.cwd,
        thread.projectId,
        thread.workspaceId,
        thread.modelId,
        thread.providerId,
        thread.status,
        JSON.stringify(thread.selectedSkillIds),
        JSON.stringify(thread.knowledgeBaseIds),
        thread.createdAt,
        thread.updatedAt,
        Number(thread.isPinned),
        thread.pinnedAt,
        thread.gpaStateJson
      );

    return thread;
  }

  public getThread(threadId: string): ThreadRecord {
    const row = this.#db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
    if (!row) {
      throw new Error(`Thread ${threadId} not found.`);
    }
    return mapThreadRow(row);
  }

  public updateThread(threadId: string, patch: Partial<ThreadRecord>): ThreadRecord {
    const current = this.getThread(threadId);
    const next: ThreadRecord = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? nowIso()
    };

    this.#db
      .prepare(`
        UPDATE threads
        SET title = ?, mode = ?, workspace_kind = ?, cwd = ?, project_id = ?, workspace_id = ?,
            model_id = ?, provider_id = ?, status = ?, selected_skill_ids_json = ?,
            knowledge_base_ids_json = ?, updated_at = ?, is_pinned = ?, pinned_at = ?, gpa_state_json = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.mode,
        next.workspaceKind,
        next.cwd,
        next.projectId,
        next.workspaceId,
        next.modelId,
        next.providerId,
        next.status,
        JSON.stringify(next.selectedSkillIds),
        JSON.stringify(next.knowledgeBaseIds),
        next.updatedAt,
        Number(next.isPinned),
        next.pinnedAt,
        next.gpaStateJson,
        threadId
      );

    return next;
  }

  public interruptThreadExecution(threadId: string): ThreadRecord {
    const completedAt = nowIso();
    this.#db.exec("BEGIN");
    try {
      this.#db
        .prepare(
          `UPDATE turn_runs
           SET status = 'interrupted', completed_at = ?, error_message = NULL
           WHERE thread_id = ?
             AND status IN ('pending_init', 'running', 'waiting_tool', 'waiting_approval', 'waiting_user_input', 'compacting')`
        )
        .run(completedAt, threadId);
      this.#db
        .prepare(
          `UPDATE tool_calls
           SET status = 'failed', completed_at = ?
           WHERE thread_id = ? AND status IN ('pending', 'running')`
        )
        .run(completedAt, threadId);
      this.#db
        .prepare(
          `UPDATE user_input_prompts
           SET status = 'cancelled', answered_at = ?
           WHERE thread_id = ? AND status = 'pending'`
        )
        .run(completedAt, threadId);
      const thread = this.updateThread(threadId, { status: "idle", updatedAt: completedAt });
      this.#db.exec("COMMIT");
      return thread;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public recoverInterruptedThreads(): void {
    this.#db.prepare("UPDATE queued_messages SET status = 'queued' WHERE status = 'dispatching'").run();
    const runningThreadIds = this.#db
      .prepare("SELECT id FROM threads WHERE status IN ('running', 'waiting')")
      .all() as Array<{ id: string }>;
    for (const { id } of runningThreadIds) {
      this.interruptThreadExecution(id);
    }
    this.#db
      .prepare(
        `UPDATE tool_calls
         SET status = 'failed', completed_at = ?
         WHERE status IN ('pending', 'running')
           AND turn_run_id IN (
             SELECT id FROM turn_runs
             WHERE status IN ('interrupted', 'aborted', 'completed', 'failed')
           )`
      )
      .run(nowIso());
  }

  public deleteThread(threadId: string): ThreadRecord | null {
    const row = this.#db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
    if (!row) {
      return null;
    }

    const thread = mapThreadRow(row);
    const threadScopedTables = [
      "messages",
      "queued_messages",
      "turn_runs",
      "tool_calls",
      "approval_records",
      "user_input_prompts",
      "artifacts",
      "browser_tabs",
      "runtime_events"
    ];

    this.#db.exec("BEGIN");
    try {
      for (const table of threadScopedTables) {
        this.#db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId);
      }
      this.#db.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    return thread;
  }

  public listMessages(threadId: string): MessageRecord[] {
    return this.#db
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId)
      .map(mapMessageRow);
  }

  public enqueueQueuedMessage(input: Omit<QueuedMessageRecord, "id" | "status" | "createdAt">): QueuedMessageRecord {
    const record: QueuedMessageRecord = {
      ...input,
      id: randomUUID(),
      status: "queued",
      createdAt: nowIso()
    };
    this.#db
      .prepare(
        `INSERT INTO queued_messages (id, thread_id, content, display_content, attachments_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.threadId,
        record.content,
        record.displayContent,
        JSON.stringify(record.attachments),
        record.status,
        record.createdAt
      );
    return record;
  }

  public listQueuedMessages(threadId: string): QueuedMessageRecord[] {
    return this.#db
      .prepare("SELECT * FROM queued_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(threadId)
      .map(mapQueuedMessageRow);
  }

  public listQueuedMessageThreadIds(): string[] {
    return (this.#db
      .prepare("SELECT DISTINCT thread_id FROM queued_messages WHERE status = 'queued'")
      .all() as Array<{ thread_id: string }>)
      .map((row) => row.thread_id);
  }

  public claimNextQueuedMessage(threadId: string): QueuedMessageRecord | null {
    this.#db.exec("BEGIN");
    try {
      const row = this.#db
        .prepare("SELECT * FROM queued_messages WHERE thread_id = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1")
        .get(threadId) as any;
      if (!row) {
        this.#db.exec("COMMIT");
        return null;
      }
      this.#db.prepare("UPDATE queued_messages SET status = 'dispatching' WHERE id = ?").run(row.id);
      this.#db.exec("COMMIT");
      return mapQueuedMessageRow({ ...row, status: "dispatching" });
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public completeQueuedMessage(id: string): void {
    this.#db.prepare("DELETE FROM queued_messages WHERE id = ?").run(id);
  }

  public deleteQueuedMessage(threadId: string, id: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM queued_messages WHERE id = ? AND thread_id = ? AND status = 'queued'")
      .run(id, threadId) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  public createMessage(input: Omit<MessageRecord, "id" | "createdAt">): MessageRecord {
    const message: MessageRecord = {
      ...input,
      id: randomUUID(),
      createdAt: nowIso()
    };
    this.#db
      .prepare(
        "INSERT INTO messages (id, thread_id, turn_run_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        message.id,
        message.threadId,
        message.turnRunId,
        message.role,
        message.content,
        message.metadataJson,
        message.createdAt
      );
    return message;
  }

  public startTurn(input: Omit<TurnRunRecord, "id" | "startedAt" | "completedAt">): TurnRunRecord {
    const turn: TurnRunRecord = {
      ...input,
      id: randomUUID(),
      startedAt: nowIso(),
      completedAt: null
    };
    this.#db
      .prepare(
        `INSERT INTO turn_runs (
          id, thread_id, kind, status, provider_id, model_id, resolved_model_snapshot_json,
          prompt_tokens, completion_tokens, started_at, completed_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turn.id,
        turn.threadId,
        turn.kind,
        turn.status,
        turn.providerId,
        turn.modelId,
        turn.resolvedModelSnapshotJson,
        turn.promptTokens,
        turn.completionTokens,
        turn.startedAt,
        turn.completedAt,
        turn.errorMessage
      );
    return turn;
  }

  public finishTurn(turnRunId: string, patch: Partial<TurnRunRecord>): void {
    const current = this.#db.prepare("SELECT * FROM turn_runs WHERE id = ?").get(turnRunId) as any;
    if (!current) {
      return;
    }
    const next = {
      status: patch.status ?? current.status,
      promptTokens: patch.promptTokens ?? current.prompt_tokens,
      completionTokens: patch.completionTokens ?? current.completion_tokens,
      completedAt: patch.completedAt ?? current.completed_at,
      errorMessage: patch.errorMessage ?? current.error_message
    };
    this.#db
      .prepare(
        `UPDATE turn_runs
         SET status = ?, prompt_tokens = ?, completion_tokens = ?, completed_at = ?, error_message = ?
         WHERE id = ?`
      )
      .run(
        next.status,
        next.promptTokens,
        next.completionTokens,
        next.completedAt,
        next.errorMessage,
        turnRunId
      );
  }

  public recordToolCall(input: Omit<ToolCallRecord, "id" | "startedAt" | "completedAt">): ToolCallRecord {
    const record: ToolCallRecord = {
      ...input,
      id: randomUUID(),
      startedAt: nowIso(),
      completedAt: null
    };
    this.#db
      .prepare(
        `INSERT INTO tool_calls (
          id, thread_id, turn_run_id, tool_name, arguments_json, result_json, status, risk_level,
          approval_mode, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.threadId,
        record.turnRunId,
        record.toolName,
        record.argumentsJson,
        record.resultJson,
        record.status,
        record.riskLevel,
        record.approvalMode,
        record.startedAt,
        record.completedAt
      );
    return record;
  }

  public finishToolCall(id: string, patch: Partial<ToolCallRecord>): void {
    const current = this.#db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id) as any;
    if (!current) {
      return;
    }
    const next = {
      resultJson: patch.resultJson ?? current.result_json,
      status: patch.status ?? current.status,
      completedAt: patch.completedAt ?? current.completed_at
    };
    this.#db
      .prepare("UPDATE tool_calls SET result_json = ?, status = ?, completed_at = ? WHERE id = ?")
      .run(next.resultJson, next.status, next.completedAt, id);
  }

  public listToolCalls(threadId: string): ToolCallRecord[] {
    return this.#db
      .prepare("SELECT * FROM tool_calls WHERE thread_id = ? ORDER BY started_at ASC")
      .all(threadId)
      .map((row: any) => ({
        id: row.id,
        threadId: row.thread_id,
        turnRunId: row.turn_run_id,
        toolName: row.tool_name,
        argumentsJson: row.arguments_json,
        resultJson: row.result_json,
        status: row.status,
        riskLevel: row.risk_level,
        approvalMode: row.approval_mode,
        startedAt: row.started_at,
        completedAt: row.completed_at
      }));
  }

  public aggregateSkillUsageStats(): Array<{
    skillId: string;
    callCount: number;
    successCount: number;
    successRate: number;
    lastUsedAt: string | null;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT COALESCE(
                  NULLIF(TRIM(json_extract(result_json, '$.json.skill')), ''),
                  json_extract(arguments_json, '$.skill_id')
                ) AS skill_id,
                COUNT(*) AS call_count,
                SUM(CASE WHEN status = 'completed'
                  AND COALESCE(json_extract(result_json, '$.ok'), 1) != 0 THEN 1 ELSE 0 END) AS success_count,
                MAX(completed_at) AS last_used_at
         FROM tool_calls
         WHERE tool_name = 'skills.load'
           AND COALESCE(
             NULLIF(TRIM(json_extract(result_json, '$.json.skill')), ''),
             json_extract(arguments_json, '$.skill_id')
           ) IS NOT NULL
           AND TRIM(COALESCE(
             NULLIF(TRIM(json_extract(result_json, '$.json.skill')), ''),
             json_extract(arguments_json, '$.skill_id')
           )) != ''
         GROUP BY skill_id`
      )
      .all() as Array<{
      skill_id: string;
      call_count: number | bigint;
      success_count: number | bigint;
      last_used_at: string | null;
    }>;

    return rows.map((row) => {
      const callCount = Number(row.call_count) || 0;
      const successCount = Number(row.success_count) || 0;
      return {
        skillId: String(row.skill_id),
        callCount,
        successCount,
        successRate: callCount > 0 ? successCount / callCount : 0,
        lastUsedAt: row.last_used_at ?? null
      };
    });
  }

  public createApproval(
    input: Omit<ApprovalRequest, "id" | "createdAt" | "resolutionMode" | "resolvedAt">
  ): ApprovalRequest {
    const record: ApprovalRequest = {
      ...input,
      id: randomUUID(),
      resolutionMode: null,
      createdAt: nowIso(),
      resolvedAt: null
    };
    this.#db
      .prepare(
        `INSERT INTO approval_records (
          id, thread_id, turn_run_id, tool_call_id, project_id, title, description, scope, risk_level,
          approval_key, payload_json, status, resolution_mode, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.threadId,
        record.turnRunId,
        record.toolCallId,
        record.projectId,
        record.title,
        record.description,
        record.scope,
        record.riskLevel,
        record.approvalKey,
        record.payloadJson,
        record.status,
        record.resolutionMode,
        record.createdAt,
        record.resolvedAt
      );
    return record;
  }

  public resolveApproval(
    id: string,
    input: { approved: boolean; resolutionMode?: ApprovalResolutionMode | null }
  ): void {
    this.#db
      .prepare("UPDATE approval_records SET status = ?, resolution_mode = ?, resolved_at = ? WHERE id = ?")
      .run(
        input.approved ? "approved" : "denied",
        input.approved ? (input.resolutionMode ?? "once") : null,
        nowIso(),
        id
      );
  }

  public getApproval(id: string): ApprovalRequest | null {
    const row = this.#db.prepare("SELECT * FROM approval_records WHERE id = ?").get(id) as any;
    return row ? mapApprovalRow(row) : null;
  }

  public listApprovals(threadId: string): ApprovalRequest[] {
    return this.#db
      .prepare("SELECT * FROM approval_records WHERE thread_id = ? ORDER BY created_at DESC")
      .all(threadId)
      .map(mapApprovalRow);
  }

  public findRememberedApproval(
    projectId: string | null,
    approvalKey: string
  ): RememberedApprovalRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM remembered_approvals WHERE scope_key = ?")
      .get(buildApprovalScopeKey(projectId, approvalKey)) as any;
    return row ? mapRememberedApprovalRow(row) : null;
  }

  public upsertRememberedApproval(
    input: Omit<RememberedApprovalRecord, "id" | "createdAt" | "updatedAt">
  ): RememberedApprovalRecord {
    const existing = this.findRememberedApproval(input.projectId, input.approvalKey);
    const now = nowIso();
    const record: RememberedApprovalRecord = {
      id: existing?.id ?? randomUUID(),
      projectId: input.projectId,
      approvalKey: input.approvalKey,
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      payloadJson: input.payloadJson,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    this.#db
      .prepare(
        `INSERT INTO remembered_approvals (
          scope_key, id, project_id, approval_key, title, description, risk_level, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          id = excluded.id,
          project_id = excluded.project_id,
          approval_key = excluded.approval_key,
          title = excluded.title,
          description = excluded.description,
          risk_level = excluded.risk_level,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`
      )
      .run(
        buildApprovalScopeKey(record.projectId, record.approvalKey),
        record.id,
        record.projectId,
        record.approvalKey,
        record.title,
        record.description,
        record.riskLevel,
        record.payloadJson,
        record.createdAt,
        record.updatedAt
      );

    return record;
  }

  public createUserPrompt(input: Omit<UserInputPrompt, "id" | "createdAt" | "answers" | "answeredAt">): UserInputPrompt {
    const prompt: UserInputPrompt = {
      ...input,
      id: randomUUID(),
      answers: null,
      createdAt: nowIso(),
      answeredAt: null
    };
    this.#db
      .prepare(
        "INSERT INTO user_input_prompts (id, thread_id, turn_run_id, title, kind, allow_skip, questions_json, status, answers_json, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        prompt.id,
        prompt.threadId,
        prompt.turnRunId,
        prompt.title,
        prompt.kind,
        Number(prompt.allowSkip),
        JSON.stringify(prompt.questions),
        prompt.status,
        null,
        prompt.createdAt,
        null
      );
    return prompt;
  }

  public getUserPrompt(id: string): UserInputPrompt | null {
    const row = this.#db.prepare("SELECT * FROM user_input_prompts WHERE id = ?").get(id) as any;
    return row ? mapUserInputPromptRow(row) : null;
  }

  public resolveUserPrompt(id: string, answers: Record<string, string>): void {
    this.#db
      .prepare("UPDATE user_input_prompts SET status = 'answered', answers_json = ?, answered_at = ? WHERE id = ?")
      .run(JSON.stringify(answers), nowIso(), id);
  }

  public cancelPendingUserPrompts(threadId: string, turnRunId?: string): number {
    if (turnRunId) {
      const result = this.#db
        .prepare(
          "UPDATE user_input_prompts SET status = 'cancelled', answered_at = ? WHERE thread_id = ? AND turn_run_id = ? AND status = 'pending'"
        )
        .run(nowIso(), threadId, turnRunId);
      return Number(result.changes ?? 0);
    }
    const result = this.#db
      .prepare(
        "UPDATE user_input_prompts SET status = 'cancelled', answered_at = ? WHERE thread_id = ? AND status = 'pending'"
      )
      .run(nowIso(), threadId);
    return Number(result.changes ?? 0);
  }

  public listUserPrompts(threadId: string): UserInputPrompt[] {
    return this.#db
      .prepare("SELECT * FROM user_input_prompts WHERE thread_id = ? ORDER BY created_at DESC")
      .all(threadId)
      .map(mapUserInputPromptRow);
  }

  public addArtifact(input: Omit<ArtifactRecord, "id" | "createdAt">): ArtifactRecord {
    const artifact: ArtifactRecord = {
      ...input,
      id: randomUUID(),
      createdAt: nowIso()
    };
    this.#db
      .prepare(
        `INSERT INTO artifacts (
          id, thread_id, turn_run_id, message_id, tool_call_id, artifact_kind, display_name,
          absolute_path, relative_path, mime_type, size_bytes, sha256, source_kind,
          is_user_visible, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifact.id,
        artifact.threadId,
        artifact.turnRunId,
        artifact.messageId,
        artifact.toolCallId,
        artifact.artifactKind,
        artifact.displayName,
        artifact.absolutePath,
        artifact.relativePath,
        artifact.mimeType,
        artifact.sizeBytes,
        artifact.sha256,
        artifact.sourceKind,
        artifact.isUserVisible ? 1 : 0,
        artifact.status ?? "ready",
        artifact.createdAt
      );
    return artifact;
  }

  public listArtifacts(threadId: string): ArtifactRecord[] {
    return this.#db
      .prepare("SELECT * FROM artifacts WHERE thread_id = ? ORDER BY created_at DESC")
      .all(threadId)
      .map((row: any) => ({
        id: row.id,
        threadId: row.thread_id,
        turnRunId: row.turn_run_id,
        messageId: row.message_id,
        toolCallId: row.tool_call_id,
        artifactKind: row.artifact_kind,
        displayName: row.display_name,
        absolutePath: row.absolute_path,
        relativePath: row.relative_path,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        sourceKind: row.source_kind,
        isUserVisible: Boolean(row.is_user_visible),
        status: row.status,
        createdAt: row.created_at
      }));
  }

  public createKnowledgeBase(input: Omit<KnowledgeBaseRecord, "id" | "createdAt" | "updatedAt">): KnowledgeBaseRecord {
    const record: KnowledgeBaseRecord = {
      ...input,
      id: randomUUID(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.#db
      .prepare(
        "INSERT INTO knowledge_bases (id, scope, project_id, display_name, bundle_root, okf_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        record.id,
        record.scope,
        record.projectId,
        record.displayName,
        record.bundleRoot,
        record.okfVersion,
        record.status,
        record.createdAt,
        record.updatedAt
      );
    return record;
  }

  public updateKnowledgeBase(id: string, patch: Partial<KnowledgeBaseRecord>): void {
    const current = this.#db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as any;
    if (!current) {
      return;
    }
    const next = {
      displayName: patch.displayName ?? current.display_name,
      status: patch.status ?? current.status,
      updatedAt: nowIso()
    };
    this.#db
      .prepare(
        "UPDATE knowledge_bases SET display_name = ?, status = ?, updated_at = ? WHERE id = ?"
      )
      .run(next.displayName, next.status, next.updatedAt, id);
  }

  public listKnowledgeBases(): KnowledgeBaseRecord[] {
    return this.#db
      .prepare("SELECT * FROM knowledge_bases ORDER BY updated_at DESC")
      .all()
      .map((row: any) => ({
        id: row.id,
        scope: row.scope,
        projectId: row.project_id,
        displayName: row.display_name,
        bundleRoot: row.bundle_root,
        okfVersion: row.okf_version,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  public getKnowledgeBase(id: string): KnowledgeBaseRecord | null {
    const row = this.#db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as any;
    return row ? {
      id: row.id, scope: row.scope, projectId: row.project_id, displayName: row.display_name,
      bundleRoot: row.bundle_root, okfVersion: row.okf_version, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at
    } : null;
  }

  public listKnowledgeBaseSummaries(): KnowledgeBaseSummary[] {
    return this.#db.prepare(`
      SELECT kb.*, COUNT(DISTINCT kd.id) AS document_count, COUNT(kc.id) AS chunk_count,
        COALESCE(SUM(LENGTH(kc.content)), 0) AS indexed_bytes
      FROM knowledge_bases kb
      LEFT JOIN knowledge_documents kd ON kd.knowledge_base_id = kb.id
      LEFT JOIN knowledge_chunks kc ON kc.knowledge_base_id = kb.id
      GROUP BY kb.id
      ORDER BY kb.updated_at DESC
    `).all().map((row: any) => ({
      id: row.id, scope: row.scope, projectId: row.project_id, displayName: row.display_name,
      bundleRoot: row.bundle_root, okfVersion: row.okf_version, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      documentCount: Number(row.document_count), chunkCount: Number(row.chunk_count), indexedBytes: Number(row.indexed_bytes)
    }));
  }

  public createKnowledgeImportRun(knowledgeBaseId: string, sources: KnowledgeImportSource[]): string {
    const id = randomUUID();
    this.#db
      .prepare(
        "INSERT INTO knowledge_import_runs (id, knowledge_base_id, source_paths_json, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(id, knowledgeBaseId, JSON.stringify(sources), nowIso());
    return id;
  }

  public listLatestKnowledgeImportSources(knowledgeBaseId: string): KnowledgeImportSource[] {
    const row = this.#db.prepare(
      "SELECT source_paths_json FROM knowledge_import_runs WHERE knowledge_base_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(knowledgeBaseId) as { source_paths_json?: string } | undefined;
    if (!row?.source_paths_json) return [];
    try {
      const sources = JSON.parse(row.source_paths_json);
      if (!Array.isArray(sources)) return [];
      return sources.flatMap((source): KnowledgeImportSource[] => {
        if (typeof source === "string") return [{ kind: "file", path: source }];
        if (!source || typeof source !== "object") return [];
        const value = source as Partial<KnowledgeImportSource>;
        if ((value.kind === "file" || value.kind === "folder") && typeof value.path === "string") {
          return [{ kind: value.kind, path: value.path }];
        }
        if (value.kind === "url" && typeof value.url === "string") return [{ kind: "url", url: value.url }];
        if (value.kind === "browser" && typeof value.url === "string" && typeof value.threadId === "string" && typeof value.tabId === "string") {
          return [{ kind: "browser", url: value.url, threadId: value.threadId, tabId: value.tabId }];
        }
        return [];
      });
    } catch {
      return [];
    }
  }

  public insertKnowledgeConcept(concept: KnowledgeConcept): void {
    this.#db
      .prepare(
        `INSERT INTO knowledge_concepts (
          id, knowledge_base_id, source_document_id, type, title, description, tags_json, source_path, bundle_relative_path, body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        concept.id,
        concept.knowledgeBaseId,
        concept.sourceDocumentId,
        concept.type,
        concept.title,
        concept.description,
        JSON.stringify(concept.tags),
        concept.sourcePath,
        concept.bundleRelativePath,
        concept.body,
        concept.createdAt
      );
    this.#db
      .prepare("INSERT INTO knowledge_fts (concept_id, title, description, tags, body) VALUES (?, ?, ?, ?, ?)")
      .run(concept.id, concept.title, concept.description, concept.tags.join(" "), concept.body);
  }

  public replaceKnowledgeDocument(document: KnowledgeDocumentRecord, chunks: KnowledgeChunkRecord[]): void {
    const existing = this.#db.prepare("SELECT id FROM knowledge_documents WHERE knowledge_base_id = ? AND source_path = ?").get(document.knowledgeBaseId, document.sourcePath) as { id?: string } | undefined;
    if (existing?.id) {
      const rows = this.#db.prepare("SELECT id FROM knowledge_chunks WHERE document_id = ?").all(existing.id) as Array<{ id: string }>;
      for (const row of rows) this.#db.prepare("DELETE FROM knowledge_chunk_fts WHERE chunk_id = ?").run(row.id);
      this.#db.prepare("DELETE FROM knowledge_chunks WHERE document_id = ?").run(existing.id);
      this.#db.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(existing.id);
    }
    this.#db.prepare("INSERT INTO knowledge_documents (id, knowledge_base_id, source_path, source_hash, title, mime_hint, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(document.id, document.knowledgeBaseId, document.sourcePath, document.sourceHash, document.title, document.mimeHint, document.status, document.updatedAt);
    const insertChunk = this.#db.prepare("INSERT INTO knowledge_chunks (id, knowledge_base_id, document_id, chunk_index, title, content, source_path, locator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertFts = this.#db.prepare("INSERT INTO knowledge_chunk_fts (chunk_id, title, content, source_path, locator) VALUES (?, ?, ?, ?, ?)");
    for (const chunk of chunks) {
      insertChunk.run(chunk.id, chunk.knowledgeBaseId, chunk.documentId, chunk.chunkIndex, chunk.title, chunk.content, chunk.sourcePath, chunk.locator, chunk.createdAt);
      insertFts.run(chunk.id, chunk.title, chunk.content, chunk.sourcePath, chunk.locator);
    }
  }

  public listKnowledgeDocuments(knowledgeBaseId: string): KnowledgeDocumentRecord[] {
    return this.#db.prepare("SELECT * FROM knowledge_documents WHERE knowledge_base_id = ? ORDER BY source_path").all(knowledgeBaseId).map((row: any) => ({
      id: row.id, knowledgeBaseId: row.knowledge_base_id, sourcePath: row.source_path, sourceHash: row.source_hash, title: row.title, mimeHint: row.mime_hint, status: row.status, updatedAt: row.updated_at
    }));
  }

  public markKnowledgeDocumentMissing(documentId: string): void {
    const chunks = this.#db.prepare("SELECT id FROM knowledge_chunks WHERE document_id = ?").all(documentId) as Array<{ id: string }>;
    for (const chunk of chunks) this.#db.prepare("DELETE FROM knowledge_chunk_fts WHERE chunk_id = ?").run(chunk.id);
    this.#db.prepare("DELETE FROM knowledge_chunks WHERE document_id = ?").run(documentId);
    this.#db.prepare("UPDATE knowledge_documents SET status = 'missing', updated_at = ? WHERE id = ?").run(nowIso(), documentId);
  }

  public deleteKnowledgeBase(id: string): void {
    const chunks = this.#db.prepare("SELECT id FROM knowledge_chunks WHERE knowledge_base_id = ?").all(id) as Array<{ id: string }>;
    for (const chunk of chunks) this.#db.prepare("DELETE FROM knowledge_chunk_fts WHERE chunk_id = ?").run(chunk.id);
    this.#db.prepare("DELETE FROM knowledge_chunks WHERE knowledge_base_id = ?").run(id);
    this.#db.prepare("DELETE FROM knowledge_documents WHERE knowledge_base_id = ?").run(id);
    this.#db.prepare("DELETE FROM knowledge_fts WHERE concept_id IN (SELECT id FROM knowledge_concepts WHERE knowledge_base_id = ?)").run(id);
    this.#db.prepare("DELETE FROM knowledge_concepts WHERE knowledge_base_id = ?").run(id);
    this.#db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
  }

  public searchKnowledgeChunks(query: string, knowledgeBaseIds?: string[]): KnowledgeChunkRecord[] {
    const params: any[] = [query];
    let filter = "";
    if (knowledgeBaseIds?.length) { filter = ` AND kc.knowledge_base_id IN (${knowledgeBaseIds.map(() => "?").join(",")})`; params.push(...knowledgeBaseIds); }
    let rows: any[] = [];
    try {
      rows = this.#db.prepare(`SELECT kc.*, bm25(knowledge_chunk_fts) AS score FROM knowledge_chunk_fts f JOIN knowledge_chunks kc ON kc.id = f.chunk_id WHERE knowledge_chunk_fts MATCH ?${filter} ORDER BY score LIMIT 8`).all(...params) as any[];
    } catch {
      rows = [];
    }
    if (rows.length === 0 && query.trim()) {
      const fallbackFilter = knowledgeBaseIds?.length
        ? ` AND knowledge_base_id IN (${knowledgeBaseIds.map(() => "?").join(",")})`
        : "";
      const terms = extractKnowledgeSearchTerms(query);
      if (terms.length > 0) {
        const termClauses = terms
          .map(() => "(title LIKE ? OR content LIKE ? OR source_path LIKE ?)")
          .join(" OR ");
        const termParams = terms.flatMap((term) => {
          const pattern = `%${term}%`;
          return [pattern, pattern, pattern];
        });
        rows = this.#db.prepare(`SELECT *, 0 AS score FROM knowledge_chunks WHERE (${termClauses})${fallbackFilter} ORDER BY created_at DESC LIMIT 8`)
          .all(...termParams, ...(knowledgeBaseIds ?? [])) as any[];
      }
    }
    return rows.map((row: any) => ({
      id: row.id, knowledgeBaseId: row.knowledge_base_id, documentId: row.document_id, chunkIndex: row.chunk_index,
      title: row.title, content: row.content, sourcePath: row.source_path, locator: row.locator,
      createdAt: row.created_at, score: Number(row.score ?? 0)
    }));
  }

  public getKnowledgeChunk(id: string): KnowledgeChunkRecord | null {
    const row = this.#db.prepare("SELECT * FROM knowledge_chunks WHERE id = ?").get(id) as any;
    return row ? { id: row.id, knowledgeBaseId: row.knowledge_base_id, documentId: row.document_id, chunkIndex: row.chunk_index, title: row.title, content: row.content, sourcePath: row.source_path, locator: row.locator, createdAt: row.created_at } : null;
  }

  public searchKnowledge(query: string, knowledgeBaseIds?: string[]): any[] {
    const params: any[] = [query];
    let filter = "";
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
      filter = ` AND kc.knowledge_base_id IN (${knowledgeBaseIds.map(() => "?").join(", ")})`;
      params.push(...knowledgeBaseIds);
    }
    return this.#db
      .prepare(
        `
        SELECT kc.*
        FROM knowledge_fts fts
        JOIN knowledge_concepts kc ON kc.id = fts.concept_id
        WHERE knowledge_fts MATCH ?${filter}
        LIMIT 20
      `
      )
      .all(...params)
      .map(mapKnowledgeConceptRow);
  }

  public getKnowledgeConcept(conceptId: string): KnowledgeConcept | null {
    const row = this.#db.prepare("SELECT * FROM knowledge_concepts WHERE id = ?").get(conceptId);
    return row ? mapKnowledgeConceptRow(row) : null;
  }

  public replaceBrowserTabs(threadId: string, tabs: BrowserTabRecord[]): void {
    this.#db.prepare("DELETE FROM browser_tabs WHERE thread_id = ?").run(threadId);
    const statement = this.#db.prepare(
      "INSERT INTO browser_tabs (id, thread_id, title, url, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const tab of tabs) {
      statement.run(tab.id, tab.threadId, tab.title, tab.url, tab.isActive ? 1 : 0, tab.createdAt, tab.updatedAt);
    }
  }

  public listBrowserTabs(threadId: string): BrowserTabRecord[] {
    return this.#db
      .prepare("SELECT * FROM browser_tabs WHERE thread_id = ? ORDER BY updated_at DESC")
      .all(threadId)
      .map((row: any) => ({
        id: row.id,
        threadId: row.thread_id,
        title: row.title,
        url: row.url,
        isActive: Boolean(row.is_active),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
  }

  public addRuntimeEvent(event: RuntimeEvent): void {
    this.#db
      .prepare("INSERT INTO runtime_events (id, type, thread_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), event.type, event.threadId ?? null, JSON.stringify(event.payload), event.createdAt);
  }

  public getLatestContextCompaction(threadId: string): ContextCompactionRecord | null {
    const row = this.#db
      .prepare(
        "SELECT payload_json, created_at FROM runtime_events WHERE thread_id = ? AND type = 'agent.context_compacted' ORDER BY created_at DESC LIMIT 1"
      )
      .get(threadId) as { payload_json: string; created_at: string } | undefined;
    if (!row) return null;

    try {
      const payload = JSON.parse(row.payload_json) as Omit<ContextCompactionRecord, "createdAt">;
      if (!payload.turnRunId || !Number.isFinite(payload.afterTokens)) return null;
      return { ...payload, createdAt: row.created_at };
    } catch {
      return null;
    }
  }

  public upsertPlugin(plugin: PluginRecord, sourceHash?: string | null): PluginRecord {
    this.#db
      .prepare(
        `INSERT INTO plugins (id, name, version, manifest_path, install_path, enabled, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           manifest_path = excluded.manifest_path,
           install_path = excluded.install_path,
           enabled = excluded.enabled,
           source = excluded.source`
      )
      .run(
        plugin.id,
        plugin.name,
        plugin.version,
        plugin.manifestPath,
        plugin.installPath,
        plugin.enabled ? 1 : 0,
        plugin.source
      );

    this.#db
      .prepare(
        `INSERT OR REPLACE INTO plugin_versions (plugin_id, version, source_hash, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(plugin.id, plugin.version, sourceHash ?? null, nowIso());

    return plugin;
  }

  public listPlugins(): PluginRecord[] {
    return this.#db
      .prepare("SELECT * FROM plugins ORDER BY name ASC")
      .all()
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        manifestPath: row.manifest_path,
        installPath: row.install_path,
        enabled: Boolean(row.enabled),
        source: row.source
      }));
  }

  public setProjectPluginBinding(
    projectId: string,
    pluginId: string,
    enabled: boolean,
    settingsJson?: string | null
  ): ProjectPluginBinding {
    this.#db
      .prepare(
        `INSERT INTO project_plugin_bindings (project_id, plugin_id, enabled, settings_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, plugin_id) DO UPDATE SET
           enabled = excluded.enabled,
           settings_json = excluded.settings_json`
      )
      .run(projectId, pluginId, enabled ? 1 : 0, settingsJson ?? null);

    return {
      projectId,
      pluginId,
      enabled,
      settingsJson: settingsJson ?? null
    };
  }

  public listProjectPluginBindings(projectId: string): ProjectPluginBinding[] {
    return this.#db
      .prepare("SELECT * FROM project_plugin_bindings WHERE project_id = ? ORDER BY plugin_id ASC")
      .all(projectId)
      .map((row: any) => ({
        projectId: row.project_id,
        pluginId: row.plugin_id,
        enabled: Boolean(row.enabled),
        settingsJson: row.settings_json
      }));
  }

  public recordPluginHookRun(
    projectId: string,
    pluginId: string,
    hookName: string,
    status: "success" | "skipped" | "failed",
    message?: string
  ): void {
    this.#db
      .prepare(
        "INSERT INTO plugin_hook_runs (id, project_id, plugin_id, hook_name, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), projectId, pluginId, hookName, status, message ?? null, nowIso());
  }
}

async function seedSystemSkills(skillsSystemDir: string): Promise<void> {
  const seeds = [
    {
      dir: path.join(skillsSystemDir, "programming", "plan-and-patch"),
      force: false,
      skill: `---
name: plan-and-patch
description: Use this skill when you need to inspect a repository, make careful code edits, and verify the result.
metadata:
  short-description: Structured repo inspection and patch workflow
---
Read the repository first, explain the plan briefly, make minimal edits, and verify with tests when available.
`,
      meta: `interface:
  display_name: Plan and Patch
  short_description: Structured repository editing workflow
  default_prompt: Inspect first, patch second, verify third.
policy:
  allow_implicit_invocation: true
dependencies:
  tools:
    - type: builtin
      value: code.search
    - type: builtin
      value: apply_patch
`
    },
    {
      dir: path.join(skillsSystemDir, "office", "artifact-writer"),
      force: false,
      skill: `---
name: artifact-writer
description: Use this skill when the user asks for a deliverable file such as markdown, JSON, CSV, DOCX, PPTX, XLSX, or PDF.
---
Prefer writing user-visible outputs into the thread outputs directory and register them as artifacts.
`,
      meta: `interface:
  display_name: Artifact Writer
  short_description: Produce user-visible deliverables
  default_prompt: Save final deliverables to outputs, not tmp.
policy:
  allow_implicit_invocation: true
`
    },
    {
      dir: path.join(skillsSystemDir, "platform", "knowledge-importer"),
      force: false,
      skill: `---
name: knowledge-importer
description: Use this skill when the user wants to import local documents into the knowledge base and build an OKF bundle.
---
Import documents progressively, preserve source mapping, and rely on index.md before reading full concepts.
`,
      meta: `interface:
  display_name: Knowledge Importer
  short_description: Build local OKF bundles
policy:
  allow_implicit_invocation: true
`
    },
    {
      dir: path.join(skillsSystemDir, "generate_image"),
      force: true,
      skill: `---
name: generate_image
description: Use this skill whenever the user asks to generate, draw, create, or edit an image / 图片 / 插画 / 封面图.
domain: 多媒体
metadata:
  short-description: Call image.generate with the configured default image model
---
# Generate Image

When the user wants an image, do **not** invent a picture or claim you generated one in text.

## Required workflow
1. Call \`skills.load\` with \`skill_id: generate_image\` if you have not loaded it yet.
2. Call the built-in function \`image.generate\` with a concrete \`prompt\`.
3. The runtime will use the **default image model** from **设置 → 多模态** (not the chat reasoning model).
4. After the tool succeeds, briefly confirm the image was generated. The UI will show the image attachment.

## Prompt tips
- Include subject, composition, style, lighting, and constraints.
- Prefer a clear English or Chinese prompt; keep it specific.
- For edits, describe the change relative to the previous image in the prompt text.

## If the tool is unavailable
Tell the user to open **设置 → 多模态**, enable image generation, add an image model, and set a default. Do not fabricate image files.
`,
      meta: `interface:
  display_name: Generate Image
  short_description: Generate images via image.generate and the default multimodal image model
  default_prompt: Load generate_image, then call image.generate with a detailed prompt.
policy:
  allow_implicit_invocation: true
dependencies:
  tools:
    - type: builtin
      value: image.generate
`
    },
    {
      dir: path.join(skillsSystemDir, "generate_video"),
      force: true,
      skill: `---
name: generate_video
description: Use this skill whenever the user asks to generate, create, or produce a video / 视频 / 短片 / 文生视频.
domain: 多媒体
metadata:
  short-description: Call video.generate with the configured default video model
---
# Generate Video

When the user wants a video, do **not** invent a video file or claim you generated one in text.

## Required workflow
1. Call \`skills.load\` with \`skill_id: generate_video\` if you have not loaded it yet.
2. Call the built-in function \`video.generate\` with a concrete \`prompt\`.
3. The runtime will use the **default video model** from **设置 → 多模态** (not the chat reasoning model).
4. After the tool succeeds, briefly confirm the video was generated. The UI will show the file entry.

## Prompt tips
- Include subject, motion, camera, scene, style, and duration constraints.
- Prefer a clear English or Chinese prompt; keep it specific.

## If the tool is unavailable
Tell the user to open **设置 → 多模态**, enable video generation, add a video model, and set a default. Do not fabricate video files.
`,
      meta: `interface:
  display_name: Generate Video
  short_description: Generate videos via video.generate and the default multimodal video model
  default_prompt: Load generate_video, then call video.generate with a detailed prompt.
policy:
  allow_implicit_invocation: true
dependencies:
  tools:
    - type: builtin
      value: video.generate
`
    }
  ];

  for (const seed of seeds) {
    const skillPath = path.join(seed.dir, "SKILL.md");
    if (!seed.force && (await exists(skillPath))) {
      continue;
    }
    await fs.mkdir(path.join(seed.dir, "agents"), { recursive: true });
    await fs.writeFile(skillPath, seed.skill, "utf8");
    await fs.writeFile(path.join(seed.dir, "agents", "openai.yaml"), seed.meta, "utf8");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function mapThreadRow(row: any): ThreadRecord {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    workspaceKind: row.workspace_kind,
    cwd: row.cwd,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    modelId: row.model_id,
    providerId: row.provider_id,
    status: row.status,
    selectedSkillIds: JSON.parse(row.selected_skill_ids_json ?? "[]"),
    knowledgeBaseIds: JSON.parse(row.knowledge_base_ids_json ?? "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isPinned: Boolean(row.is_pinned),
    pinnedAt: row.pinned_at ?? null,
    gpaStateJson: row.gpa_state_json ?? null
  };
}

function mapMessageRow(row: any): MessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnRunId: row.turn_run_id,
    role: row.role,
    content: row.content,
    metadataJson: row.metadata_json,
    createdAt: row.created_at
  };
}

function mapApprovalRow(row: any): ApprovalRequest {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnRunId: row.turn_run_id,
    toolCallId: row.tool_call_id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    scope: row.scope,
    riskLevel: row.risk_level,
    approvalKey: row.approval_key ?? "",
    payloadJson: row.payload_json,
    status: row.status,
    resolutionMode: row.resolution_mode,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function mapKnowledgeConceptRow(row: any): KnowledgeConcept {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceDocumentId: row.source_document_id,
    type: row.type,
    title: row.title,
    description: row.description,
    tags: JSON.parse(row.tags_json),
    sourcePath: row.source_path,
    bundleRelativePath: row.bundle_relative_path,
    body: row.body,
    createdAt: row.created_at
  };
}

function mapRememberedApprovalRow(row: any): RememberedApprovalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    approvalKey: row.approval_key,
    title: row.title,
    description: row.description,
    riskLevel: row.risk_level,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapQueuedMessageRow(row: any): QueuedMessageRecord {
  let attachments: MessageAttachment[] = [];
  try {
    const parsed = JSON.parse(row.attachments_json ?? "[]");
    attachments = Array.isArray(parsed) ? parsed as MessageAttachment[] : [];
  } catch {
    attachments = [];
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    content: row.content,
    displayContent: row.display_content,
    attachments,
    status: row.status === "dispatching" ? "dispatching" : "queued",
    createdAt: row.created_at
  };
}

function mapUserInputPromptRow(row: any): UserInputPrompt {
  const rawQuestions = JSON.parse(row.questions_json ?? "[]") as Array<any>;
  return {
    id: row.id,
    threadId: row.thread_id,
    turnRunId: row.turn_run_id,
    title: row.title,
    kind: row.kind === "gpa_plan_clarification" ? "gpa_plan_clarification" : "generic",
    allowSkip: Boolean(row.allow_skip),
    questions: rawQuestions.map((question, questionIndex) => ({
      id: String(question?.id ?? `q${questionIndex + 1}`),
      label: String(question?.label ?? `问题 ${questionIndex + 1}`),
      prompt: String(question?.prompt ?? ""),
      options: Array.isArray(question?.options)
        ? question.options.map((option: unknown, optionIndex: number) => typeof option === "string"
          ? { id: `option_${optionIndex + 1}`, label: option }
          : {
              id: String((option as any)?.id ?? `option_${optionIndex + 1}`),
              label: String((option as any)?.label ?? "选项"),
              description: typeof (option as any)?.description === "string" ? (option as any).description : undefined,
              recommended: (option as any)?.recommended === true
            })
        : undefined,
      allowFreeText: question?.allowFreeText === true
    })),
    status: row.status === "cancelled" ? "cancelled" : row.status === "answered" ? "answered" : "pending",
    answers: row.answers_json ? JSON.parse(row.answers_json) : null,
    createdAt: row.created_at,
    answeredAt: row.answered_at ?? null
  };
}

export function fuzzyMatchScore(value: string, query: string): number {
  const source = value.toLocaleLowerCase().replace(/\s+/g, "");
  const needle = query.toLocaleLowerCase().replace(/\s+/g, "");
  if (!source || !needle) return 0;
  const exactIndex = source.indexOf(needle);
  if (exactIndex >= 0) return 300 - Math.min(exactIndex, 180) + Math.min(needle.length, 40);

  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const index = source.indexOf(character, cursor);
    if (index < 0) return 0;
    gaps += index - cursor;
    cursor = index + 1;
  }
  return Math.max(1, 120 - Math.min(gaps, 110));
}

function extractKnowledgeSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }

  for (const asciiTerm of normalized.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []) {
    if (asciiTerm.length >= 2) {
      terms.add(asciiTerm);
    }
  }
  for (const chineseRun of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (chineseRun.length >= 2) {
      terms.add(chineseRun);
      for (let index = 0; index <= chineseRun.length - 2; index += 1) {
        terms.add(chineseRun.slice(index, index + 2));
      }
    }
  }

  return [...terms].slice(0, 16);
}

function createSearchSnippet(content: string, query: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  const index = compact.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index - 42);
  const end = Math.min(compact.length, Math.max(index + query.length + 78, 160));
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashPath(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildApprovalScopeKey(projectId: string | null, approvalKey: string): string {
  return `${projectId ?? "__global__"}:${approvalKey}`;
}
