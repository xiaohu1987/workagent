import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyProjectRuleEdit,
  editProjectRuleFile
} from "../packages/agent-runtime/src/project-rule-edit";
import {
  readProjectRuleFile,
  writeProjectRuleFile,
  type ProjectRuleDocument,
  type ProjectRuleEntry
} from "../packages/agent-runtime/src/project-rule-file";

function ruleEntry(overrides: Partial<ProjectRuleEntry>): ProjectRuleEntry {
  return {
    id: "R-STYLE-001",
    category: "style",
    title: "命名与代码风格",
    scope: "**/*",
    rules: ["沿用既有命名风格。"],
    source: "auto",
    updatedAt: "2026-09-23T00:00:00.000Z",
    stale: false,
    ...overrides
  };
}

function buildDocument(entries: ProjectRuleEntry[]): ProjectRuleDocument {
  return { version: 1, updatedAt: "2026-09-23T00:00:00.000Z", entries };
}

async function createTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "codexh-rule-edit-"));
}

describe("project rule natural-language edit", () => {
  it("creates a user-sourced entry when the target does not exist", () => {
    const document = buildDocument([ruleEntry({})]);
    const result = applyProjectRuleEdit(
      document,
      {
        kind: "add",
        category: "verify",
        title: "改动后的验证命令",
        rules: ["改动后执行 pnpm test。"]
      },
      "2026-09-23T01:00:00.000Z"
    );

    expect(result.rejected).toBe(false);
    expect(result.changed).toHaveLength(1);
    const created = result.document.entries.find((entry) => entry.category === "verify");
    expect(created?.source).toBe("user");
    expect(created?.rules).toEqual(["改动后执行 pnpm test。"]);
    expect(created?.id).toMatch(/^R-VERIFY-\d{3}$/);
  });

  it("rewrites an existing entry and marks it as user-sourced", () => {
    const document = buildDocument([ruleEntry({})]);
    const result = applyProjectRuleEdit(
      document,
      {
        kind: "update",
        entryId: "R-STYLE-001",
        rules: ["组件文件使用 kebab-case。"]
      },
      "2026-09-23T02:00:00.000Z"
    );

    expect(result.rejected).toBe(false);
    expect(result.changed).toEqual(["R-STYLE-001"]);
    const entry = result.document.entries.find((item) => item.id === "R-STYLE-001");
    expect(entry?.source).toBe("user");
    expect(entry?.rules).toEqual(["组件文件使用 kebab-case。"]);
    expect(entry?.stale).toBe(false);
    expect(entry?.updatedAt).toBe("2026-09-23T02:00:00.000Z");
  });

  it("keeps the entry id stable when the category is unchanged", () => {
    const document = buildDocument([ruleEntry({})]);
    const result = applyProjectRuleEdit(
      document,
      {
        kind: "update",
        entryId: "R-STYLE-001",
        rules: ["不要引入新的格式化工具。"]
      },
      "2026-09-23T03:00:00.000Z"
    );

    expect(result.document.entries.map((item) => item.id)).toEqual(["R-STYLE-001"]);
    const entry = result.document.entries[0];
    expect(entry?.rules).toEqual(["不要引入新的格式化工具。"]);
  });

  it("rejects an edit that targets an unknown entry id", () => {
    const document = buildDocument([ruleEntry({})]);
    const result = applyProjectRuleEdit(
      document,
      {
        kind: "update",
        entryId: "R-STYLE-999",
        rules: ["不存在。"]
      },
      "2026-09-23T04:00:00.000Z"
    );

    expect(result.rejected).toBe(true);
    expect(result.document).toBe(document);
    expect(result.summary).toContain("R-STYLE-999");
  });

  it("persists the edit so the next read returns the new content", async () => {
    const root = await createTempProject();
    try {
      await writeProjectRuleFile(root, buildDocument([ruleEntry({})]));
      const result = await editProjectRuleFile(root, {
        kind: "update",
        entryId: "R-STYLE-001",
        rules: ["导入顺序按字母排序。"]
      });

      expect(result.rejected).toBe(false);
      expect(result.written).toBe(true);
      const persisted = await readProjectRuleFile(root);
      const entry = persisted?.entries.find((item) => item.id === "R-STYLE-001");
      expect(entry?.source).toBe("user");
      expect(entry?.rules).toEqual(["导入顺序按字母排序。"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not write the file when the edit is rejected", async () => {
    const root = await createTempProject();
    try {
      await writeProjectRuleFile(root, buildDocument([ruleEntry({})]));
      const before = await fs.readFile(
        path.join(root, ".codexh", "rule.md"),
        "utf8"
      );
      const result = await editProjectRuleFile(root, {
        kind: "update",
        entryId: "R-STYLE-999",
        rules: ["不存在。"]
      });

      expect(result.rejected).toBe(true);
      expect(result.written).toBe(false);
      expect(
        await fs.readFile(path.join(root, ".codexh", "rule.md"), "utf8")
      ).toBe(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
