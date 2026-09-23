import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  editProjectRuleFile,
  readProjectRuleFile,
  writeProjectRuleFile,
  type ProjectRuleDocument
} from "../packages/agent-runtime/src/index";

function buildDocument(): ProjectRuleDocument {
  return {
    version: 1,
    updatedAt: "2026-09-23T00:00:00.000Z",
    entries: [
      {
        id: "R-STYLE-001",
        category: "style",
        title: "命名与代码风格",
        scope: "**/*",
        rules: ["沿用既有命名风格。"],
        source: "auto",
        updatedAt: "2026-09-23T00:00:00.000Z",
        stale: false
      }
    ]
  };
}

async function createTempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "codexh-rule-entry-"));
}

describe("project rule view and edit entry", () => {
  it("exposes the rule file through the runtime entry point", async () => {
    const root = await createTempProject();
    try {
      await writeProjectRuleFile(root, buildDocument());
      const viewed = await readProjectRuleFile(root);
      expect(viewed?.entries.map((entry) => entry.id)).toEqual(["R-STYLE-001"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("edits the rule file through the runtime entry point", async () => {
    const root = await createTempProject();
    try {
      await writeProjectRuleFile(root, buildDocument());
      const result = await editProjectRuleFile(root, {
        kind: "update",
        entryId: "R-STYLE-001",
        rules: ["组件文件使用 kebab-case。"]
      });

      expect(result.rejected).toBe(false);
      expect(result.written).toBe(true);
      const persisted = await readProjectRuleFile(root);
      const entry = persisted?.entries.find((item) => item.id === "R-STYLE-001");
      expect(entry?.source).toBe("user");
      expect(entry?.rules).toEqual(["组件文件使用 kebab-case。"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
