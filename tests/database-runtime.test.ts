import { describe, expect, it } from "vitest";
import { DatabaseRuntime, stripSqlComments, validateReadOnlySql } from "@database-runtime";
import { ToolRuntime, type ToolRuntimeContext } from "@tool-runtime";
import { defaultConfig } from "../apps/desktop/src/main/storage";

describe("database configuration", () => {
  it("starts with no configured database connections", () => {
    expect(defaultConfig().databaseConnections).toEqual([]);
  });
});

describe("read-only SQL validation", () => {
  it("allows one SELECT, CTE SELECT, and EXPLAIN SELECT", () => {
    expect(validateReadOnlySql("SELECT * FROM users WHERE id = $1")).toBeNull();
    expect(validateReadOnlySql("WITH active AS (SELECT id FROM users) SELECT * FROM active")).toBeNull();
    expect(validateReadOnlySql("EXPLAIN SELECT * FROM users")).toBeNull();
  });

  it("ignores ordinary comments but rejects writes, exports, and multiple statements", () => {
    expect(stripSqlComments("SELECT 1 -- harmless\n")).toContain("SELECT 1");
    expect(validateReadOnlySql("/* note */ SELECT 1")).toBeNull();
    expect(validateReadOnlySql("WITH changed AS (INSERT INTO users VALUES (1) RETURNING id) SELECT * FROM changed")).toContain("forbidden");
    expect(validateReadOnlySql("SELECT * INTO archive FROM users")).toContain("forbidden");
    expect(validateReadOnlySql("SELECT 1; DELETE FROM users")).toContain("one SQL statement");
    expect(validateReadOnlySql("UPDATE users SET admin = true")).toContain("read-only");
  });

  it("does not treat SQL inside quoted values as an operation", () => {
    expect(validateReadOnlySql("SELECT 'DROP TABLE users' AS example")).toBeNull();
    expect(validateReadOnlySql("SELECT $$; DROP TABLE users$$ AS example")).toBeNull();
    expect(validateReadOnlySql("SELECT [DROP TABLE users] FROM audit_log")).toBeNull();
  });

  it("fails closed for executable comments, locks, and side-effect functions", () => {
    expect(validateReadOnlySql("SELECT 1 /*!50000 DROP TABLE users */")).toContain("Executable");
    expect(validateReadOnlySql("SELECT * FROM users FOR UPDATE")).toContain("forbidden");
    expect(validateReadOnlySql("SELECT * FROM users FOR SHARE")).toContain("locking");
    expect(validateReadOnlySql("SELECT pg_terminate_backend(pid) FROM sessions")).toContain("side-effect");
    expect(validateReadOnlySql("SELECT pg_sleep(5)")).toContain("side-effect");
    expect(validateReadOnlySql("SELECT load_file('/etc/passwd')")).toContain("side-effect");
    expect(validateReadOnlySql("SELECT 1\u0000")).toContain("control character");
    expect(validateReadOnlySql("SELECT 1 /* unfinished")).toContain("unterminated");
  });
});

describe("database query runtime", () => {
  it("rejects dangerous SQL before resolving credentials or opening a connection", async () => {
    const getCredential = async () => {
      throw new Error("Credential lookup should not occur for blocked SQL.");
    };
    const runtime = new DatabaseRuntime(getCredential);
    await expect(runtime.query({
      id: "reporting", name: "Reporting", engine: "postgresql", host: "db.example.com", port: 5432,
      database: "reporting", username: "readonly", tlsMode: "verify", credentialRef: "database:reporting", enabled: true,
      permissions: ["query"], maxRows: 200
    }, "DROP TABLE users")).rejects.toThrow("read-only");
  });

  it("requires the selected permission before looking up credentials", async () => {
    const runtime = new DatabaseRuntime(async () => {
      throw new Error("Credential lookup should not occur for a denied operation.");
    });
    await expect(runtime.execute({
      id: "reporting", name: "Reporting", engine: "postgresql", host: "db.example.com", port: 5432,
      database: "reporting", username: "readonly", tlsMode: "verify", credentialRef: "database:reporting", enabled: true,
      permissions: ["query"], maxRows: 200
    }, "DELETE FROM users")).rejects.toThrow("does not permit delete");
  });
});

describe("federated database tool", () => {
  it("joins bounded source rows and aggregates by the requested key", async () => {
    const queryDatabase = async (sourceId: string) => sourceId === "orders"
      ? { rows: [{ customer_id: 1, amount: 20 }, { customer_id: 1, amount: 30 }], rowCount: 2, durationMs: 1 }
      : { rows: [{ id: 1, name: "Ada" }], rowCount: 1, durationMs: 1 };
    const result = await new ToolRuntime().execute({
      id: "federated", name: "database.federated_query", arguments: {
        sources: [{ alias: "orders", sourceId: "orders", sql: "SELECT * FROM orders" }, { alias: "customers", sourceId: "customers", sql: "SELECT * FROM customers" }],
        joins: [{ leftAlias: "orders", leftColumn: "customer_id", rightAlias: "customers", rightColumn: "id", kind: "inner" }],
        groupBy: ["customers.name"], aggregates: [{ op: "sum", field: "orders.amount", as: "revenue" }]
      }
    }, { cwd: process.cwd(), queryDatabase } as unknown as ToolRuntimeContext);
    expect(result.ok).toBe(true);
    expect(result.json?.rows).toEqual([{ "customers.name": "Ada", revenue: 50 }]);
  });
});
