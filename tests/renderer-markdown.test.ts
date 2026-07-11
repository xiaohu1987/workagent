import { describe, expect, it } from "vitest";
import {
  buildProjectFileTree,
  buildContextUsage,
  formatComposerAttachments,
  parseMarkdownBlocks,
  resolveProjectFilePath
} from "../apps/desktop/src/renderer/App";

describe("parseMarkdownBlocks", () => {
  it("parses a pipe-delimited task breakdown into a table", () => {
    const blocks = parseMarkdownBlocks([
      "| ID | 名称 | 动作 | 交付物 |",
      "| --- | --- | --- | --- |",
      "| T1 | 初始化项目 | 创建 HTML 骨架 | `index.html` |",
      "| T2 | 实现逻辑 | 编写数据模型 | `js/game.js` |"
    ].join("\n"));

    expect(blocks).toEqual([
      {
        kind: "table",
        headers: ["ID", "名称", "动作", "交付物"],
        rows: [
          ["T1", "初始化项目", "创建 HTML 骨架", "`index.html`"],
          ["T2", "实现逻辑", "编写数据模型", "`js/game.js`"]
        ]
      }
    ]);
  });

  it("keeps nested files under their parent directory", () => {
    const tree = buildProjectFileTree([
      { path: "apps", kind: "directory" },
      { path: "apps/desktop", kind: "directory" },
      { path: "apps/desktop/main.ts", kind: "file" },
      { path: "package.json", kind: "file" }
    ]);

    expect(tree).toMatchObject([
      {
        path: "apps",
        kind: "directory",
        children: [
          {
            path: "apps/desktop",
            kind: "directory",
            children: [{ path: "apps/desktop/main.ts", kind: "file" }]
          }
        ]
      },
      { path: "package.json", kind: "file" }
    ]);
  });

  it("resolves file-tree paths against the selected project folder", () => {
    expect(resolveProjectFilePath("D:\\project", "src/app.ts")).toBe("D:\\project\\src\\app.ts");
    expect(resolveProjectFilePath("/workspace/project/", "src/app.ts")).toBe("/workspace/project/src/app.ts");
  });

  it("serializes attached files, folders, and code into task context", () => {
    expect(
      formatComposerAttachments([
        { id: "file", kind: "file", path: "D:\\project\\src\\app.ts", label: "app.ts" },
        { id: "folder", kind: "folder", path: "D:\\project\\src", label: "src" },
        {
          id: "code",
          kind: "code",
          path: "src/app.ts",
          content: "const value = 1;",
          label: "待编辑代码段",
          intent: "edit"
        },
        {
          id: "skill",
          kind: "skill",
          skillId: "skill-1",
          label: "前端技能",
          description: "用于 React 界面任务"
        },
        {
          id: "mcp",
          kind: "mcp",
          serverId: "mcp-1",
          label: "项目服务",
          description: "stdio server"
        },
        {
          id: "image",
          kind: "image",
          path: "D:\\project\\reference.png",
          label: "reference.png"
        }
      ])
    ).toContain("Edit the following selected code from src/app.ts");
    expect(
      formatComposerAttachments([
        { id: "skill", kind: "skill", skillId: "skill-1", label: "前端技能", description: "React" },
        { id: "mcp", kind: "mcp", serverId: "mcp-1", label: "项目服务", description: "stdio" },
        { id: "image", kind: "image", path: "D:\\reference.png", label: "reference.png" }
      ])
    ).toContain("Selected MCP server");
  });

  it("reports a bounded Chinese context-usage breakdown", () => {
    const usage = buildContextUsage({
      contextWindow: 10_000,
      messages: [{ content: "请实现一个功能" } as any],
      toolCalls: [{ argumentsJson: "{}", resultJson: "完成" } as any],
      gpaStage: "act",
      selectedSkillCount: 1,
      mcpServerCount: 1,
      pendingInput: "继续完善"
    });

    expect(usage.percentage).toBeGreaterThan(0);
    expect(usage.percentage).toBeLessThanOrEqual(100);
    expect(usage.segments.map((segment) => segment.label)).toContain("对话与工具结果");
  });
});
