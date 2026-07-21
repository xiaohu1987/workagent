import type { DatabaseConnectionConfig } from "@shared-types";

export const DATABASE_QUERY_TIMEOUT_MS = 30_000;
export const DATABASE_CONNECTION_TEST_TIMEOUT_MS = 15_000;
export const DATABASE_MAX_ROWS = 1_000;
export const DATABASE_MODEL_MAX_ROWS = 200;
export const DATABASE_MODEL_MAX_CHARS = 50_000;
export const DATABASE_FEDERATED_INPUT_MAX_ROWS = 5_000;
export const DATABASE_FEDERATED_OUTPUT_MAX_ROWS = 1_000;

export type DatabaseRows = Array<Record<string, unknown>>;
export type CredentialProvider = (connection: DatabaseConnectionConfig) => Promise<string | undefined>;
export type DatabaseOperationStage = "driver_load" | "connect" | "query" | "query_text" | "query_parameterized";

export type DatabaseDriverError = Error & {
  code?: string | number;
  errno?: number;
  sqlState?: string;
  databaseStage?: DatabaseOperationStage;
};

export interface DatabaseQueryResult { rows: DatabaseRows; rowCount: number; durationMs: number; }
export interface DatabaseSchemaResult { schemas: Array<{ name: string; tables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable: boolean }> }> }>; }

/** Conservative lexical guard. Database accounts must also be restricted to read-only. */
export function validateReadOnlySql(sql: string): string | null {
  const cleaned = stripSqlComments(sql).trim();
  if (!cleaned) return "SQL is required.";
  if (hasMultipleStatements(cleaned)) return "Only one SQL statement is allowed.";
  const upper = cleaned.replace(/\s+/g, " ").toUpperCase();
  if (!/^(SELECT\b|WITH\b|EXPLAIN\s+(?:ANALYZE\s+)?SELECT\b)/.test(upper)) return "Only read-only SELECT statements are allowed.";
  if (/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC(?:UTE)?|COPY|LOAD|UNLOAD|INTO\s+(?:OUTFILE|DUMPFILE|TABLE))\b/.test(upper) || /\bSELECT\b[\s\S]*\bINTO\b/.test(upper)) return "The SQL contains a forbidden write or export operation.";
  return null;
}

export function stripSqlComments(sql: string): string {
  let result = ""; let quote = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!; const next = sql[index + 1];
    if (quote) { result += char; if (char === quote && next === quote) { result += sql[++index]!; } else if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; result += char; continue; }
    if (char === "-" && next === "-") { while (index < sql.length && sql[index] !== "\n") index += 1; result += " "; continue; }
    if (char === "/" && next === "*") { index += 2; while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1; index += 1; result += " "; continue; }
    result += char;
  }
  return result;
}

function hasMultipleStatements(sql: string): boolean {
  let quote = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === ";" && sql.slice(index + 1).trim()) return true;
  }
  return false;
}

export class DatabaseRuntime {
  public constructor(private readonly getCredential: CredentialProvider) {}

  public async query(connection: DatabaseConnectionConfig, sql: string, parameters: unknown[] = [], maxRows = DATABASE_MAX_ROWS): Promise<DatabaseQueryResult> {
    const validation = validateReadOnlySql(sql);
    if (validation) throw new Error(validation);
    const password = await this.getCredential(connection);
    if (!password) throw new Error(`No credentials are stored for database ${connection.id}.`);
    const started = Date.now();
    const rows = await runQuery(connection, password, sql, parameters, Math.min(Math.max(1, maxRows), DATABASE_MAX_ROWS));
    return { rows: rows.map(normalizeRow), rowCount: rows.length, durationMs: Date.now() - started };
  }

  public async test(connection: DatabaseConnectionConfig, password?: string): Promise<{ version: string; schemas: string[]; databases: string[] }> {
    const credential = password || await this.getCredential(connection);
    if (!credential) throw new Error(`No password is available for database ${connection.id}.`);
    if (connection.engine === "mysql") {
      const version = await runMysql(connection, credential, versionSql(connection.engine), [], 1, DATABASE_CONNECTION_TEST_TIMEOUT_MS, "text");
      await runMysql(connection, credential, "SELECT ? AS parameter_test", ["ok"], 1, DATABASE_CONNECTION_TEST_TIMEOUT_MS, "parameterized");
      const databases = await listDatabases(connection, credential);
      return { version: String(Object.values(version[0] ?? {})[0] ?? "connected"), schemas: [], databases };
    }
    const version = await runQuery(connection, credential, versionSql(connection.engine), [], 1, DATABASE_CONNECTION_TEST_TIMEOUT_MS);
    const databases = await listDatabases(connection, credential);
    return { version: String(Object.values(version[0] ?? {})[0] ?? "connected"), schemas: [], databases };
  }

  public async describeSchema(connection: DatabaseConnectionConfig, schema?: string): Promise<DatabaseSchemaResult> {
    const password = await this.getCredential(connection);
    if (!password) throw new Error(`No credentials are stored for database ${connection.id}.`);
    const query = columnsSql(connection.engine, schema);
    const rows = await runQuery(connection, password, query.sql, query.parameters, DATABASE_MAX_ROWS);
    const schemas = new Map<string, Map<string, Array<{ name: string; type: string; nullable: boolean }>>>();
    for (const row of rows) {
      const schemaName = String(row.schema_name ?? ""); const tableName = String(row.table_name ?? "");
      if (!schemaName || !tableName) continue;
      const tables = schemas.get(schemaName) ?? new Map(); schemas.set(schemaName, tables);
      const columns = tables.get(tableName) ?? []; tables.set(tableName, columns);
      columns.push({ name: String(row.column_name), type: String(row.data_type), nullable: String(row.is_nullable).toUpperCase() === "YES" });
    }
    return { schemas: [...schemas].map(([name, tables]) => ({ name, tables: [...tables].map(([table, columns]) => ({ name: table, columns })) })) };
  }
}

async function runQuery(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs = DATABASE_QUERY_TIMEOUT_MS): Promise<DatabaseRows> {
  if (connection.engine === "postgresql") return runPostgres(connection, password, sql, parameters, limit, timeoutMs);
  if (connection.engine === "mysql") return runMysql(connection, password, sql, parameters, limit, timeoutMs);
  return runSqlServer(connection, password, sql, parameters, limit, timeoutMs);
}

async function listDatabases(connection: DatabaseConnectionConfig, password: string): Promise<string[]> {
  try {
    const rows = await runQuery(connection, password, databaseCatalogSql(connection.engine), [], 200, DATABASE_CONNECTION_TEST_TIMEOUT_MS);
    return [...new Set(rows.map((row) => String(row.database_name ?? "")).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

// Keep optional native drivers external to the Electron bundle.
const loadDriver = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

function tls(connection: DatabaseConnectionConfig): false | { rejectUnauthorized: boolean } { return connection.tlsMode === "disable" ? false : { rejectUnauthorized: connection.tlsMode === "verify" }; }
function wrapSql(sql: string, engine: DatabaseConnectionConfig["engine"], limit: number): string { const clean = sql.replace(/;\s*$/, ""); return engine === "sqlserver" ? `SELECT TOP (${limit}) * FROM (${clean}) AS codexh_query` : `SELECT * FROM (${clean}) AS codexh_query LIMIT ${limit}`; }

async function runPostgres(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs: number): Promise<DatabaseRows> {
  const { Client }: any = await loadDriver("pg");
  const client = new Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: tls(connection), connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  await client.connect(); try { return (await client.query({ text: wrapSql(sql, connection.engine, limit), values: parameters })).rows; } finally { await client.end(); }
}

async function runMysql(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs: number, protocol: "parameterized" | "text" = "parameterized"): Promise<DatabaseRows> {
  let mysql: any;
  try {
    mysql = await loadDriver("mysql2/promise");
  } catch (error) {
    throw annotateDatabaseError(error, "driver_load");
  }

  let client: any;
  let queryCompleted = false;
  let connectionTimedOut = false;
  const connectionPromise = mysql.createConnection({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password,
    ssl: tls(connection) || undefined,
    connectTimeout: timeoutMs
  }).then((openedClient: any) => {
    if (connectionTimedOut) void openedClient.end().catch(() => undefined);
    return openedClient;
  });

  try {
    client = await withDatabaseTimeout(connectionPromise, timeoutMs, "connect", () => { connectionTimedOut = true; });
    const statement = wrapSql(sql, connection.engine, limit);
    const operation = protocol === "text" ? client.query(statement) : client.query(statement, parameters);
    const stage: DatabaseOperationStage = protocol === "text" ? "query_text" : "query_parameterized";
    const [rows] = await withDatabaseTimeout(operation, timeoutMs, stage);
    queryCompleted = true;
    return rows as DatabaseRows;
  } finally {
    if (client) {
      if (queryCompleted) await client.end().catch(() => undefined);
      else {
        try { client.destroy(); } catch { await client.end().catch(() => undefined); }
      }
    }
  }
}

function withDatabaseTimeout<T>(operation: Promise<T>, timeoutMs: number, stage: DatabaseOperationStage, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      const error = new Error(`Database ${stage} timed out after ${timeoutMs / 1000} seconds.`) as DatabaseDriverError;
      error.code = "DATABASE_TIMEOUT";
      error.databaseStage = stage;
      reject(error);
    }, timeoutMs);

    void operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(annotateDatabaseError(error, stage)); }
    );
  });
}

function annotateDatabaseError(error: unknown, stage: DatabaseOperationStage): DatabaseDriverError {
  const typed = (error instanceof Error ? error : new Error(String(error))) as DatabaseDriverError;
  typed.databaseStage ??= stage;
  return typed;
}

async function runSqlServer(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs: number): Promise<DatabaseRows> {
  let tedious: any;
  try {
    tedious = await loadDriver("tedious");
  } catch (error) {
    throw annotateDatabaseError(error, "driver_load");
  }
  return new Promise((resolve, reject) => {
    const client = new tedious.Connection({ server: connection.host, authentication: { type: "default", options: { userName: connection.username, password } }, options: { port: connection.port, database: connection.database, encrypt: connection.tlsMode !== "disable", trustServerCertificate: connection.tlsMode !== "verify", connectTimeout: timeoutMs, requestTimeout: timeoutMs } });
    const rows: DatabaseRows = [];
    let settled = false;
    let stage: DatabaseOperationStage = "connect";
    const timer = setTimeout(() => {
      const error = new Error(`Database ${stage} timed out after ${timeoutMs / 1000} seconds.`) as DatabaseDriverError;
      error.code = "DATABASE_TIMEOUT";
      error.databaseStage = stage;
      finish(error);
    }, timeoutMs + 1_000);
    const finish = (error?: Error, result: DatabaseRows = rows) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch { /* The client may not have opened its socket yet. */ }
      if (error) reject(error); else resolve(result);
    };
    client.on("connect", (error: Error | undefined) => {
      if (error) { finish(annotateDatabaseError(error, "connect")); return; }
      stage = "query";
      const request = new tedious.Request(
        wrapSql(replaceQuestionMarks(sql), connection.engine, limit),
        (requestError: Error | undefined) => finish(requestError ? annotateDatabaseError(requestError, "query") : undefined)
      );
      request.on("row", (columns: Array<{ metadata: { colName: string }; value: unknown }>) => rows.push(Object.fromEntries(columns.map((column) => [column.metadata.colName, column.value]))));
      parameters.forEach((value, index) => request.addParameter(`p${index}`, tedious.TYPES.NVarChar, value === null ? null : String(value)));
      client.execSql(request);
    });
    client.on("error", (error: Error) => finish(annotateDatabaseError(error, stage)));
    try {
      client.connect();
    } catch (error) {
      finish(annotateDatabaseError(error, "connect"));
    }
  });
}

function replaceQuestionMarks(sql: string): string { let index = 0; return sql.replace(/\?/g, () => `@p${index++}`); }
function versionSql(engine: DatabaseConnectionConfig["engine"]): string { return engine === "postgresql" ? "SELECT version() AS version" : engine === "mysql" ? "SELECT VERSION() AS version" : "SELECT @@VERSION AS version"; }
function databaseCatalogSql(engine: DatabaseConnectionConfig["engine"]): string {
  if (engine === "postgresql") return "SELECT datname AS database_name FROM pg_database WHERE datistemplate = false";
  if (engine === "mysql") return "SELECT schema_name AS database_name FROM information_schema.schemata";
  return "SELECT name AS database_name FROM sys.databases WHERE state = 0";
}
function columnsSql(engine: DatabaseConnectionConfig["engine"], schema?: string): { sql: string; parameters: unknown[] } { const sql = engine === "sqlserver" ? "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable FROM INFORMATION_SCHEMA.COLUMNS" : "SELECT table_schema AS schema_name, table_name, column_name, data_type, is_nullable FROM information_schema.columns"; return schema ? { sql: `${sql} WHERE ${engine === "sqlserver" ? "TABLE_SCHEMA = ?" : "table_schema = ?"}`, parameters: [schema] } : { sql, parameters: [] }; }

export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])); }
function normalizeValue(value: unknown): unknown { if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value; if (typeof value === "bigint") return value.toString(); if (value instanceof Date) return value.toISOString(); if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`; return String(value); }
