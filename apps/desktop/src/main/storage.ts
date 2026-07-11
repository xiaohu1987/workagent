import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import TOML from "@iarna/toml";
import type {
  AppConfig,
  ApprovalResolutionMode,
  ApprovalRequest,
  ArtifactRecord,
  BrowserTabRecord,
  KnowledgeBaseRecord,
  KnowledgeConcept,
  McpServerConfig,
  MessageRecord,
  ModelProfile,
  PluginRecord,
  ProjectPluginBinding,
  RememberedApprovalRecord,
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

export async function ensureHomeLayout(): Promise<HomeLayout> {
  const root = path.join(os.homedir(), ".codexh");
  const layout: HomeLayout = {
    root,
    configFile: path.join(root, "config.toml"),
    dbFile: path.join(root, "codexh.sqlite"),
    outputsDir: path.join(root, "outputs"),
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
    desktop: {
      theme: "system",
      approvals: "prompt",
      inAppBrowser: true
    },
    mcpServers: []
  };
}

export async function loadConfig(configFile: string): Promise<AppConfig> {
  const raw = await fs.readFile(configFile, "utf8");
  const parsed = TOML.parse(raw) as any;
  const providers = Object.entries(parsed.providers ?? {}).map(([id, value]) => ({
    id,
    ...(value as Record<string, unknown>)
  })) as ProviderDefinition[];
  const models = Object.entries(parsed.models ?? {}).map(([id, value]) => ({
    id,
    ...(value as Record<string, unknown>)
  })) as ModelProfile[];

  return {
    defaultModel: parsed.defaultModel ?? "mock-codexh",
    defaultProvider: parsed.defaultProvider ?? "mock",
    providers,
    models,
    routing: parsed.routing ?? {},
    desktop: {
      theme: parsed.desktop?.theme ?? "system",
      approvals: parsed.desktop?.approvals ?? "prompt",
      inAppBrowser: parsed.desktop?.inAppBrowser ?? true
    },
    mcpServers: ((parsed.mcpServers ?? []) as Array<Record<string, unknown>>).map((item) => ({
      id: String(item.id),
      name: String(item.name ?? item.id),
      command: typeof item.command === "string" ? item.command : undefined,
      args: Array.isArray(item.args) ? item.args.map(String) : undefined,
      env: item.env as Record<string, string> | undefined,
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      transport: typeof item.transport === "string" ? item.transport : undefined,
      source: "config",
      enabled: item.enabled !== false
    })) satisfies McpServerConfig[]
  };
}

export async function saveConfig(configFile: string, config: AppConfig): Promise<void> {
  const tomlObject = {
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
    routing: config.routing,
    desktop: config.desktop,
    providers: Object.fromEntries(config.providers.map((provider) => [provider.id, provider])),
    models: Object.fromEntries(config.models.map((model) => [model.id, model])),
    mcpServers: config.mcpServers.map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      transport: server.transport,
      enabled: server.enabled
    }))
  };

  await fs.writeFile(configFile, TOML.stringify(tomlObject as any), "utf8");
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
        updated_at TEXT NOT NULL
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
        questions_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
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
      .prepare("SELECT * FROM threads ORDER BY updated_at DESC")
      .all()
      .map(mapThreadRow);
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
      gpaStateJson: null
    };

    this.#db
      .prepare(`
        INSERT INTO threads (
          id, title, mode, workspace_kind, cwd, project_id, workspace_id,
          model_id, provider_id, status, selected_skill_ids_json,
          knowledge_base_ids_json, created_at, updated_at, gpa_state_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            knowledge_base_ids_json = ?, updated_at = ?, gpa_state_json = ?
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
      const thread = this.updateThread(threadId, { status: "idle", updatedAt: completedAt });
      this.#db.exec("COMMIT");
      return thread;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public recoverInterruptedThreads(): void {
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

  public createUserPrompt(input: Omit<UserInputPrompt, "id" | "createdAt">): UserInputPrompt {
    const prompt: UserInputPrompt = {
      ...input,
      id: randomUUID(),
      createdAt: nowIso()
    };
    this.#db
      .prepare(
        "INSERT INTO user_input_prompts (id, thread_id, turn_run_id, title, questions_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        prompt.id,
        prompt.threadId,
        prompt.turnRunId,
        prompt.title,
        JSON.stringify(prompt.questions),
        prompt.status,
        prompt.createdAt
      );
    return prompt;
  }

  public resolveUserPrompt(id: string): void {
    this.#db.prepare("UPDATE user_input_prompts SET status = 'answered' WHERE id = ?").run(id);
  }

  public listUserPrompts(threadId: string): UserInputPrompt[] {
    return this.#db
      .prepare("SELECT * FROM user_input_prompts WHERE thread_id = ? ORDER BY created_at DESC")
      .all(threadId)
      .map((row: any) => ({
        id: row.id,
        threadId: row.thread_id,
        turnRunId: row.turn_run_id,
        title: row.title,
        questions: JSON.parse(row.questions_json),
        status: row.status,
        createdAt: row.created_at
      }));
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

  public createKnowledgeImportRun(knowledgeBaseId: string, sourcePaths: string[]): string {
    const id = randomUUID();
    this.#db
      .prepare(
        "INSERT INTO knowledge_import_runs (id, knowledge_base_id, source_paths_json, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(id, knowledgeBaseId, JSON.stringify(sourcePaths), nowIso());
    return id;
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
    }
  ];

  for (const seed of seeds) {
    if (await exists(path.join(seed.dir, "SKILL.md"))) {
      continue;
    }
    await fs.mkdir(path.join(seed.dir, "agents"), { recursive: true });
    await fs.writeFile(path.join(seed.dir, "SKILL.md"), seed.skill, "utf8");
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

function nowIso(): string {
  return new Date().toISOString();
}

function hashPath(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function buildApprovalScopeKey(projectId: string | null, approvalKey: string): string {
  return `${projectId ?? "__global__"}:${approvalKey}`;
}
