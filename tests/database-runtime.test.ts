import { describe, expect, it } from "vitest";
import { stripSqlComments, validateReadOnlySql } from "@database-runtime";
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

  it("ignores comments but rejects writes, exports, and multiple statements", () => {
    expect(stripSqlComments("SELECT 1 -- harmless\n")).toContain("SELECT 1");
    expect(validateReadOnlySql("/* note */ SELECT 1")).toBeNull();
    expect(validateReadOnlySql("WITH changed AS (INSERT INTO users VALUES (1) RETURNING id) SELECT * FROM changed")).toContain("forbidden");
    expect(validateReadOnlySql("SELECT * INTO archive FROM users")).toContain("forbidden");
    expect(validateReadOnlySql("SELECT 1; DELETE FROM users")).toContain("one SQL statement");
    expect(validateReadOnlySql("UPDATE users SET admin = true")).toContain("read-only");
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
