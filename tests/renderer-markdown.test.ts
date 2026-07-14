import { describe, expect, it } from "vitest";
import {
  buildProjectFileTree,
  buildProjectFolderManifest,
  buildFileSnapshotDiff,
  buildFileSnapshotDiffPreview,
  getFileSnapshotDiffMarker,
  getProjectFileChangeKinds,
  buildContextUsage,
  buildPlanTimelineItems,
  extractMessageMediaReferences,
  formatComposerAttachments,
  highlightMarkdownCode,
  parseMarkdownBlocks,
  resolveProjectFilePath
} from "../apps/desktop/src/renderer/App";

describe("parseMarkdownBlocks", () => {
  it("highlights fenced C# code and escapes source HTML", () => {
    const highlighted = highlightMarkdownCode('string title = "<script>";', "csharp");

    expect(highlighted).toContain("hljs-");
    expect(highlighted).toContain("&lt;script&gt;");
  });

  it("does not interpret an HTTP image URL as a Windows local path", () => {
    const url = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png";

    expect(extractMessageMediaReferences(url)).toEqual([{ source: url, kind: "url" }]);
  });

  it("marks the first incomplete plan task as in progress", () => {
    const items = buildPlanTimelineItems({
      stage: "act",
      fullAccess: false,
      knowledgeEnabled: false,
      planTasks: [
        { id: "one", title: "Completed", done: true },
        { id: "two", title: "Current", done: false },
        { id: "three", title: "Pending", done: false }
      ],
      awaitingConfirmation: null,
      updatedAt: "2026-07-13T00:00:00.000Z"
    });

    expect(items.map((item) => item.status)).toEqual(["completed", "in_progress", "pending"]);
  });

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

  it("uses the actual compacted token count instead of the full raw history", () => {
    const usage = buildContextUsage({
      contextWindow: 128_000,
      messages: [{ content: "x".repeat(500_000), createdAt: "2026-07-13T12:00:00.000Z" } as any],
      toolCalls: [],
      gpaStage: "act",
      selectedSkillCount: 0,
      mcpServerCount: 0,
      pendingInput: "",
      compaction: {
        turnRunId: "turn-1",
        contextWindow: 128_000,
        threshold: 0.9,
        target: 0.6,
        beforeTokens: 349_625,
        afterTokens: 38_287,
        messagesBefore: 21,
        messagesAfter: 9,
        createdAt: "2026-07-13T12:22:56.900Z"
      }
    });

    expect(usage.usedTokens).toBe(38_287);
    expect(usage.percentage).toBe(30);
    expect(usage.compaction?.threshold).toBe(0.9);
    expect(usage.compaction?.beforeTokens).toBe(349_625);
    expect(usage.segments.map((segment) => segment.label)).toContain("压缩后的对话与工具结果");
  });

  it("uses one normalized path for Windows file-tree entries", () => {
    const tree = buildProjectFileTree([
      { path: "src\\tools\\e2e_battle.py", kind: "file" }
    ]);

    expect(tree[0]?.path).toBe("src");
    expect(tree[0]?.children[0]?.path).toBe("src/tools");
    expect(tree[0]?.children[0]?.children[0]?.path).toBe("src/tools/e2e_battle.py");
  });

  it("renders snapshot changes with removed and added lines", () => {
    expect(buildFileSnapshotDiff("first\nold\nlast", "first\nnew\nlast")).toEqual([
      { kind: "context", content: "first" },
      { kind: "removed", content: "old" },
      { kind: "added", content: "new" },
      { kind: "context", content: "last" }
    ]);
  });

  it("includes a bounded directory tree and inspection requirement for attached folders", () => {
    const folder = buildProjectFileTree([
      { path: "src", kind: "directory" },
      { path: "src/app.ts", kind: "file" },
      { path: "src/lib", kind: "directory" },
      { path: "src/lib/tool.ts", kind: "file" }
    ])[0]!;
    const manifest = buildProjectFolderManifest(folder);
    const context = formatComposerAttachments([{
      id: "folder",
      kind: "folder",
      path: "D:\\project\\src",
      label: "src",
      entries: manifest.entries,
      entriesTruncated: manifest.truncated
    }]);

    expect(context).toContain("src/app.ts");
    expect(context).toContain("src/lib/tool.ts");
    expect(context).toContain("Use fs.read_directory");
  });

  it("uses visible Git-style markers for snapshot additions and removals", () => {
    expect(getFileSnapshotDiffMarker("removed")).toBe("-");
    expect(getFileSnapshotDiffMarker("added")).toBe("+");
    expect(getFileSnapshotDiffMarker("context")).toBe(" ");
  });

  it("keeps hover diff previews focused around changed lines", () => {
    const before = [...Array.from({ length: 30 }, (_, index) => `before-${index}`), "old", ...Array.from({ length: 30 }, (_, index) => `after-${index}`)].join("\n");
    const after = before.replace("old", "new");
    const preview = buildFileSnapshotDiffPreview(before, after);

    expect(preview.some((line) => line.omitted && line.content.includes("隐藏"))).toBe(true);
    expect(preview.some((line) => line.kind === "removed" && line.content === "old")).toBe(true);
    expect(preview.some((line) => line.kind === "added" && line.content === "new")).toBe(true);
    expect(preview.length).toBeLessThan(20);
  });

  it("uses Git-like file states from task snapshots", () => {
    const changes = getProjectFileChangeKinds([
      {
        status: "completed",
        resultJson: JSON.stringify({
          json: {
            snapshots: [
              { path: "new.ts", before: "", after: "export {};" },
              { path: "src/app.ts", before: "old", after: "new" },
              { path: "old.ts", before: "old", after: "" }
            ]
          }
        })
      } as any
    ]);

    expect(changes.get("new.ts")).toBe("added");
    expect(changes.get("src/app.ts")).toBe("modified");
    expect(changes.get("old.ts")).toBe("deleted");
  });

  it("keeps the compacted baseline after a later turn is added", () => {
    const usage = buildContextUsage({
      contextWindow: 128_000,
      messages: [
        { content: "old history".repeat(100_000), createdAt: "2026-07-13T12:00:00.000Z", turnRunId: "turn-1" } as any,
        { content: "new request", createdAt: "2026-07-13T12:30:00.000Z", turnRunId: "turn-2" } as any
      ],
      toolCalls: [],
      gpaStage: "act",
      selectedSkillCount: 0,
      mcpServerCount: 0,
      pendingInput: "",
      compaction: {
        turnRunId: "turn-1",
        contextWindow: 128_000,
        threshold: 0.9,
        target: 0.6,
        beforeTokens: 349_625,
        afterTokens: 38_287,
        messagesBefore: 21,
        messagesAfter: 9,
        createdAt: "2026-07-13T12:22:56.900Z"
      }
    });

    expect(usage.usedTokens).toBeLessThan(40_000);
  });

  it("does not count persisted tool results twice", () => {
    const usage = buildContextUsage({
      contextWindow: 10_000,
      messages: [{ content: "tool output".repeat(1_000) } as any],
      toolCalls: [{ argumentsJson: "{}", resultJson: "tool output".repeat(1_000) } as any],
      gpaStage: "off",
      selectedSkillCount: 0,
      mcpServerCount: 0,
      pendingInput: ""
    });

    expect(usage.segments.find((segment) => segment.id === "conversation")?.tokens).toBeLessThan(4_000);
  });
});
