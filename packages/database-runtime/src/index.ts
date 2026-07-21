import type { DatabaseConnectionConfig, DatabasePermission } from "@shared-types";

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

const FORBIDDEN_SQL_KEYWORDS = new Set([
  "ABORT", "ALTER", "ANALYZE", "ATTACH", "BACKUP", "BEGIN", "BULK", "CALL", "CHECKPOINT", "CLUSTER",
  "COMMIT", "COPY", "CREATE", "DEALLOCATE", "DECLARE", "DELETE", "DENY", "DETACH", "DISCARD", "DO", "DROP",
  "EXEC", "EXECUTE", "FLUSH", "GRANT", "HANDLER", "INSERT", "INSTALL", "INTO", "KILL", "LOAD", "LOCK", "MERGE",
  "OPTIMIZE", "PURGE", "REASSIGN", "RECONFIGURE", "REFRESH", "REINDEX", "RENAME", "REPAIR", "RESET", "RESTORE",
  "REVOKE", "ROLLBACK", "SAVEPOINT", "SET", "SHUTDOWN", "START", "STOP", "TRUNCATE", "UNINSTALL", "UNLOAD",
  "UPDATE", "UPDLOCK", "UPSERT", "USE", "VACUUM", "WAITFOR", "WRITE", "XA", "XLOCK", "TABLOCKX"
]);
const FORBIDDEN_SQL_FUNCTIONS = new Set([
  "BENCHMARK", "DBLINK_EXEC", "DBMS_LOCK", "DBMS_PIPE", "DBMS_SCHEDULER", "DBMS_SYSTEM", "DBMS_UTILITY", "GET_LOCK",
  "LOAD_FILE", "LO_EXPORT", "LO_IMPORT", "PG_ADVISORY_LOCK", "PG_ADVISORY_XACT_LOCK", "PG_CANCEL_BACKEND",
  "PG_LOGICAL_EMIT_MESSAGE", "PG_READ_BINARY_FILE", "PG_READ_FILE", "PG_RELOAD_CONF", "PG_ROTATE_LOGFILE", "PG_SLEEP",
  "PG_SLEEP_FOR", "PG_SLEEP_UNTIL", "PG_TERMINATE_BACKEND", "PG_WRITE_FILE", "SET_CONFIG", "SLEEP", "SYS_EVAL",
  "SYS_EXEC", "XP_CMDSHELL", "XP_DIRTREE", "XP_FILEEXIST"
]);
const FORBIDDEN_SQL_TOKEN_SEQUENCES = [
  ["FOR", "UPDATE"], ["FOR", "SHARE"], ["FOR", "NO", "KEY", "UPDATE"], ["FOR", "KEY", "SHARE"]
] as const;
const FORBIDDEN_MUTATION_SQL_KEYWORDS = new Set(
  [...FORBIDDEN_SQL_KEYWORDS].filter((keyword) => !["INSERT", "INTO", "UPDATE", "DELETE", "SET"].includes(keyword))
);

type SqlTokens = { tokens: string[]; executableComment: boolean; error?: string };

/**
 * Fail-closed lexical guard. It is defense in depth: database accounts must still
 * be granted read-only permissions, because a SQL lexer is not an authorization boundary.
 */
export function validateReadOnlySql(sql: string): string | null {
  const statement = parseSingleSqlStatement(sql);
  if (typeof statement === "string") return statement;

  if (!new Set(["SELECT", "WITH", "EXPLAIN"]).has(statement[0]!)) return "Only read-only SELECT statements are allowed.";
  if (statement.some((token) => FORBIDDEN_SQL_KEYWORDS.has(token))) return "The SQL contains a forbidden write, schema, transaction, or export operation.";
  if (statement.some((token) => FORBIDDEN_SQL_FUNCTIONS.has(token))) return "The SQL contains a forbidden side-effect function.";
  if (FORBIDDEN_SQL_TOKEN_SEQUENCES.some((sequence) => containsTokenSequence(statement, sequence))) return "The SQL contains a forbidden locking operation.";
  if ((statement[0] === "WITH" || statement[0] === "EXPLAIN") && !statement.includes("SELECT")) return "Only read-only SELECT statements are allowed.";
  return null;
}

export function validateDatabaseSql(sql: string, allowedPermission: DatabasePermission): string | null {
  const statement = parseSingleSqlStatement(sql);
  if (typeof statement === "string") return statement;
  const operation = databaseOperationFromStatement(statement);
  if (!operation) return "Only SELECT, INSERT, UPDATE, or DELETE statements are allowed.";
  if (operation !== allowedPermission) return `This connection does not permit ${operation} statements.`;
  if (operation === "query") return validateReadOnlySql(sql);
  if (statement.some((token) => FORBIDDEN_MUTATION_SQL_KEYWORDS.has(token))) {
    return "The SQL contains a forbidden schema, transaction, or administrative operation.";
  }
  if (statement.some((token) => FORBIDDEN_SQL_FUNCTIONS.has(token))) {
    return "The SQL contains a forbidden side-effect function.";
  }
  return null;
}

export function getDatabaseSqlOperation(sql: string): DatabasePermission | null {
  const statement = parseSingleSqlStatement(sql);
  return typeof statement === "string" ? null : databaseOperationFromStatement(statement);
}

function parseSingleSqlStatement(sql: string): string[] | string {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(sql)) return "SQL contains a forbidden control character.";
  const parsed = tokenizeSql(sql);
  if (parsed.error) return parsed.error;
  if (parsed.executableComment) return "Executable SQL comments are not allowed.";
  const tokens = parsed.tokens;
  if (tokens.length === 0) return "SQL is required.";
  const semicolons = tokens.reduce<number[]>((positions, token, index) => token === ";" ? [...positions, index] : positions, []);
  if (semicolons.some((index) => index !== tokens.length - 1) || semicolons.length > 1) return "Only one SQL statement is allowed.";
  const statement = semicolons.length === 1 ? tokens.slice(0, -1) : tokens;
  return statement.length > 0 ? statement : "SQL is required.";
}

function databaseOperationFromStatement(statement: string[]): DatabasePermission | null {
  if (["SELECT", "WITH", "EXPLAIN"].includes(statement[0]!)) return "query";
  if (statement[0] === "INSERT") return "insert";
  if (statement[0] === "UPDATE") return "update";
  if (statement[0] === "DELETE") return "delete";
  return null;
}

function containsTokenSequence(tokens: string[], sequence: readonly string[]): boolean {
  return sequence.length <= tokens.length && tokens.some((_, index) => sequence.every((token, offset) => tokens[index + offset] === token));
}

export function stripSqlComments(sql: string): string {
  let result = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      result += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = skipBlockComment(sql, index);
      if (end === -1) return `${result} `;
      index = end;
      result += " ";
      continue;
    }
    const quotedEnd = skipQuotedValue(sql, index);
    if (quotedEnd !== null) {
      result += sql.slice(index, quotedEnd);
      index = quotedEnd;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function tokenizeSql(sql: string): SqlTokens {
  const tokens: string[] = [];
  let executableComment = false;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      if (sql[index + 2] === "!" || sql[index + 2] === "+") executableComment = true;
      const end = skipBlockComment(sql, index);
      if (end === -1) return { tokens, executableComment, error: "SQL contains an unterminated block comment." };
      index = end;
      continue;
    }
    const quotedEnd = skipQuotedValue(sql, index);
    if (quotedEnd !== null) {
      if (quotedEnd === -1) return { tokens, executableComment, error: "SQL contains an unterminated quoted value." };
      index = quotedEnd;
      continue;
    }
    if (char === ";") { tokens.push(char); index += 1; continue; }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$#]/.test(sql[index]!)) index += 1;
      tokens.push(sql.slice(start, index).toUpperCase());
      continue;
    }
    index += 1;
  }
  return { tokens, executableComment };
}

function skipBlockComment(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length) {
    if (sql[index] === "/" && sql[index + 1] === "*") { depth += 1; index += 2; continue; }
    if (sql[index] === "*" && sql[index + 1] === "/") { depth -= 1; index += 2; if (depth === 0) return index; continue; }
    index += 1;
  }
  return -1;
}

function skipQuotedValue(sql: string, start: number): number | null {
  const char = sql[start]!;
  if (char === "'" || char === '"' || char === "`") return skipDelimitedValue(sql, start, char, char === "'");
  if (char === "[") return skipDelimitedValue(sql, start, "]", false);
  if (char !== "$") return null;
  const match = sql.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  if (!match) return null;
  const delimiter = match[0]!;
  const end = sql.indexOf(delimiter, start + delimiter.length);
  return end === -1 ? -1 : end + delimiter.length;
}

function skipDelimitedValue(sql: string, start: number, delimiter: string, backslashEscapes: boolean): number {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (backslashEscapes && sql[index] === "\\") { index += 1; continue; }
    if (sql[index] !== delimiter) continue;
    if (sql[index + 1] === delimiter) { index += 1; continue; }
    return index + 1;
  }
  return -1;
}

export class DatabaseRuntime {
  public constructor(private readonly getCredential: CredentialProvider) {}

  public async query(connection: DatabaseConnectionConfig, sql: string, parameters: unknown[] = [], maxRows = DATABASE_MAX_ROWS): Promise<DatabaseQueryResult> {
    if (!connection.permissions.includes("query")) throw new Error(`Database ${connection.id} does not permit queries.`);
    const validation = validateReadOnlySql(sql);
    if (validation) throw new Error(validation);
    const password = await this.getCredential(connection);
    if (!password) throw new Error(`No credentials are stored for database ${connection.id}.`);
    const started = Date.now();
    const rows = await runQuery(connection, password, sql, parameters, limitRows(connection, maxRows));
    return { rows: rows.map(normalizeRow), rowCount: rows.length, durationMs: Date.now() - started };
  }

  public async execute(connection: DatabaseConnectionConfig, sql: string, parameters: unknown[] = [], expectedOperation?: Exclude<DatabasePermission, "query">): Promise<DatabaseQueryResult> {
    const operation = getDatabaseSqlOperation(sql);
    if (!operation || operation === "query") throw new Error("Only INSERT, UPDATE, or DELETE statements can be executed as a mutation.");
    if (expectedOperation && operation !== expectedOperation) throw new Error(`Expected a ${expectedOperation} statement but received ${operation}.`);
    if (!connection.permissions.includes(operation)) throw new Error(`Database ${connection.id} does not permit ${operation} statements.`);
    const validation = validateDatabaseSql(sql, operation);
    if (validation) throw new Error(validation);
    const password = await this.getCredential(connection);
    if (!password) throw new Error(`No credentials are stored for database ${connection.id}.`);
    const started = Date.now();
    const rows = await runQuery(connection, password, sql, parameters, 0, DATABASE_QUERY_TIMEOUT_MS, false);
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
    if (!connection.permissions.includes("query")) throw new Error(`Database ${connection.id} does not permit schema queries.`);
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

function limitRows(connection: DatabaseConnectionConfig, requestedMaxRows: number): number {
  const configuredMaxRows = Number.isFinite(connection.maxRows) ? connection.maxRows : DATABASE_MODEL_MAX_ROWS;
  return Math.min(
    DATABASE_MAX_ROWS,
    Math.max(1, Math.round(configuredMaxRows)),
    Math.max(1, Math.round(requestedMaxRows))
  );
}

async function runQuery(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs = DATABASE_QUERY_TIMEOUT_MS, enforceRowLimit = true): Promise<DatabaseRows> {
  if (connection.engine === "postgresql") return runPostgres(connection, password, sql, parameters, limit, timeoutMs, enforceRowLimit);
  if (connection.engine === "mysql") return runMysql(connection, password, sql, parameters, limit, timeoutMs, "parameterized", enforceRowLimit);
  return runSqlServer(connection, password, sql, parameters, limit, timeoutMs, enforceRowLimit);
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
function wrapSql(sql: string, engine: DatabaseConnectionConfig["engine"], limit: number, enforceRowLimit = true): string {
  const clean = sql.replace(/;\s*$/, "");
  if (!enforceRowLimit) return clean;
  return engine === "sqlserver" ? `SELECT TOP (${limit}) * FROM (${clean}) AS codexh_query` : `SELECT * FROM (${clean}) AS codexh_query LIMIT ${limit}`;
}

async function runPostgres(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs: number, enforceRowLimit: boolean): Promise<DatabaseRows> {
  const { Client }: any = await loadDriver("pg");
  const client = new Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: tls(connection), connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  await client.connect(); try { return (await client.query({ text: wrapSql(sql, connection.engine, limit, enforceRowLimit), values: parameters })).rows; } finally { await client.end(); }
}

async function runMysql(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs: number, protocol: "parameterized" | "text" = "parameterized", enforceRowLimit = true): Promise<DatabaseRows> {
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
    const statement = wrapSql(sql, connection.engine, limit, enforceRowLimit);
    const operation = protocol === "text" ? client.query(statement) : client.query(statement, parameters);
    const stage: DatabaseOperationStage = protocol === "text" ? "query_text" : "query_parameterized";
    const [rows] = await withDatabaseTimeout<[unknown, unknown]>(operation as Promise<[unknown, unknown]>, timeoutMs, stage);
    queryCompleted = true;
    return Array.isArray(rows) ? rows as DatabaseRows : [rows as Record<string, unknown>];
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

async function runSqlServer(connection: DatabaseConnectionConfig, password: string, sql: string, parameters: unknown[], limit: number, timeoutMs: number, enforceRowLimit: boolean): Promise<DatabaseRows> {
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
        wrapSql(replaceQuestionMarks(sql), connection.engine, limit, enforceRowLimit),
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
