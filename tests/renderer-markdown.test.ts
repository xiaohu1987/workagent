import { describe, expect, it } from "vitest";
import {
  buildProjectFileTree,
  buildProjectFolderManifest,
  buildFileSnapshotDiff,
  buildFileSnapshotDiffPreview,
  getFileSnapshotDiffCounts,
  getFileSnapshotDiffMarker,
  getGitProjectFileChangeKinds,
  getProjectRelativeGitFiles,
  getProjectFileChangeKinds,
  mergeProjectFileEntries,
  resolveProjectFilePath
} from "../apps/desktop/src/renderer/lib/project-files";
import {
  buildContextUsage,
  buildPlanTimelineItems,
  collectFileChangesByTurn,
  getActivePlanTimelineItem,
  getGpaPlanMessageId,
  getLatestTurnRunId,
  formatComposerAttachments,
  retainPersistentComposerContexts
} from "../apps/desktop/src/renderer/lib/conversation-utils";
import { getFileChangeLineCounts, getVisibleFileChanges, resolveFileSnapshotFromToolDetails } from "../apps/desktop/src/renderer/timeline/conversation-rail";
import {
  extractMessageMediaReferences,
  isGeneratedUserSkill,
  isRuntimeActivityBoundaryMessage,
  segmentRuntimeActivityAfterMessage
} from "../apps/desktop/src/renderer/App";
import {
  clearMarkdownRenderCache,
  getMarkdownRenderCacheStats,
  highlightMarkdownCode,
  normalizeMarkdownImageSource,
  parseMarkdownBlocks,
  renderMarkdownDocument
} from "../apps/desktop/src/renderer/markdown";
import { ECHARTS_CONFIG_MAX_BYTES, parseEChartsConfig } from "../apps/desktop/src/renderer/charts/echarts-message-chart";

describe("parseMarkdownBlocks", () => {
  it("keeps rendered markdown cache within its byte budget", () => {
    clearMarkdownRenderCache();
    renderMarkdownDocument("x".repeat(300_000), "large", "message-markdown");
    expect(getMarkdownRenderCacheStats()).toEqual({ entries: 0, bytes: 0 });

    for (let index = 0; index < 200; index += 1) {
      renderMarkdownDocument(`message-${index}\n${"x".repeat(100_000)}`, `message-${index}`, "message-markdown");
    }
    expect(getMarkdownRenderCacheStats().bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("recognizes user skills generated from chat drafts", () => {
    expect(isGeneratedUserSkill({
      pluginId: undefined,
      scope: "user",
      skillPath: "C:\\Users\\test\\.codexh\\skills\\drafts\\monthly-report\\SKILL.md"
    })).toBe(true);
    expect(isGeneratedUserSkill({
      pluginId: undefined,
      scope: "user",
      skillPath: "C:\\Users\\test\\.codexh\\skills\\imported\\monthly-report\\SKILL.md"
    })).toBe(false);
    expect(isGeneratedUserSkill({
      pluginId: "superpowers",
      scope: "user",
      skillPath: "C:\\Users\\test\\.codexh\\skills\\drafts\\monthly-report\\SKILL.md"
    })).toBe(false);
  });

  it("clears every composer chip after a send, including skill, MCP, and database", () => {
    expect(retainPersistentComposerContexts([
      { kind: "file", label: "report.xlsx" },
      { kind: "image", label: "chart.png" },
      { kind: "code", label: "query.ts" },
      { kind: "skill", label: "数据分析" },
      { kind: "mcp", label: "项目服务" },
      { kind: "database", label: "分析库" }
    ])).toEqual([]);
  });

  it("parses only a closed echarts fence as a chart block", () => {
    const content = '{"title":{"text":"Sales"},"series":[{"type":"bar","data":[1,2]}]}';

    expect(parseMarkdownBlocks(`\`\`\`echarts\n${content}\n\`\`\``)).toEqual([{ kind: "echarts", content }]);
    expect(parseMarkdownBlocks(`\`\`\`echarts\n${content}`)).toEqual([{ kind: "code", language: "echarts", content }]);
    expect(parseMarkdownBlocks(`\`\`\`json\n${content}\n\`\`\``)).toEqual([{ kind: "code", language: "json", content }]);
  });

  it("parses only a closed mermaid fence as a diagram block", () => {
    const content = "flowchart LR\n  A[开始] --> B[完成]";

    expect(parseMarkdownBlocks(`\`\`\`mermaid\n${content}\n\`\`\``)).toEqual([{ kind: "mermaid", content }]);
    expect(parseMarkdownBlocks(`\`\`\`mermaid\n${content}`)).toEqual([{ kind: "code", language: "mermaid", content }]);
  });

  it("merges repeatedly restarted numbered items with their descriptions", () => {
    expect(parseMarkdownBlocks([
      "1. **First repository**",
      "",
      "Its description.",
      "",
      "1. **Second repository**",
      "",
      "Its description."
    ].join("\n"))).toEqual([{
      kind: "structured-ordered-list",
      items: [
        { title: "**First repository**", paragraphs: ["Its description."] },
        { title: "**Second repository**", paragraphs: ["Its description."] }
      ]
    }]);
  });

  it("renders Markdown horizontal rules as dedicated blocks", () => {
    expect(parseMarkdownBlocks("Before\n\n---\n\nAfter")).toEqual([
      { kind: "paragraph", text: "Before" },
      { kind: "horizontal-rule" },
      { kind: "paragraph", text: "After" }
    ]);
  });

  it("keeps GFM task-list syntax as list items for the rich task-list renderer", () => {
    expect(parseMarkdownBlocks("- [x] Completed\n- [ ] Pending")).toEqual([{
      kind: "unordered-list",
      items: ["[x] Completed", "[ ] Pending"]
    }]);
  });

  it("highlights fenced C# code and escapes source HTML", () => {
    const highlighted = highlightMarkdownCode('string title = "<script>";', "csharp");

    expect(highlighted).toContain("hljs-");
    expect(highlighted).toContain("&lt;script&gt;");
  });

  it("keeps unlabeled code escaped without running automatic language detection", () => {
    expect(highlightMarkdownCode('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
  });

  it("does not interpret an HTTP image URL as a Windows local path", () => {
    const url = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png";

    expect(extractMessageMediaReferences(url)).toEqual([{ source: url, kind: "url" }]);
  });

  it("converts Wikimedia file pages into image URLs", () => {
    const filePage = "https://commons.wikimedia.org/wiki/File:B-2_Spirit.jpg";
    const imageUrl = "https://commons.wikimedia.org/wiki/Special:FilePath/B-2_Spirit.jpg";

    expect(normalizeMarkdownImageSource(filePage)).toBe(imageUrl);
    expect(extractMessageMediaReferences(filePage)).toEqual([{ source: imageUrl, kind: "url" }]);
    expect(normalizeMarkdownImageSource("https://upload.wikimedia.org/wikipedia/commons/a/a0/B-2_Spirit.jpg")).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/a/a0/B-2_Spirit.jpg"
    );
  });

  it("leaves direct Wikimedia image URLs unchanged", () => {
    expect(normalizeMarkdownImageSource("https://commons.wikimedia.org/wiki/Special:FilePath/B-2_Spirit.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/B-2_Spirit.jpg"
    );
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

  it("does not retain the last completed task as bottom progress", () => {
    const items = buildPlanTimelineItems({
      stage: "act",
      fullAccess: false,
      knowledgeEnabled: false,
      planTasks: [{ id: "T1", title: "Completed", done: true }],
      awaitingConfirmation: null,
      updatedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(getActivePlanTimelineItem(items)).toBeNull();
  });

  it("keeps the confirmed GPA plan response framed during ACT", () => {
    const messages = [
      { id: "goal", role: "assistant" },
      { id: "user", role: "user" },
      { id: "plan", role: "assistant", content: "### T1: Build the feature" },
      { id: "act", role: "assistant", content: "Implementing T1 now." }
    ] as Parameters<typeof getGpaPlanMessageId>[0];
    const state = {
      stage: "plan" as const,
      fullAccess: false,
      knowledgeEnabled: false,
      planTasks: [{ id: "T1", title: "Build the feature", done: false }],
      awaitingConfirmation: "plan" as const,
      updatedAt: "2026-07-15T00:00:00.000Z"
    };

    expect(getGpaPlanMessageId(messages, state)).toBe("plan");
    expect(getGpaPlanMessageId(messages, { ...state, stage: "act", awaitingConfirmation: null })).toBe("plan");
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

  it("merges lazily loaded directory entries without duplicating existing paths", () => {
    expect(mergeProjectFileEntries(
      [{ path: "src", kind: "directory" }, { path: "README.md", kind: "file", size: 10 }],
      [{ path: "src\\app.ts", kind: "file", size: 20 }, { path: "README.md", kind: "file", size: 12 }]
    )).toEqual([
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file", size: 12 },
      { path: "src/app.ts", kind: "file", size: 20 }
    ]);
  });

  it("keeps a real directory when Git also reports the same path", () => {
    expect(mergeProjectFileEntries(
      [{ path: "ISS.IPSA.Project.Web", kind: "directory" }],
      [{ path: "ISS.IPSA.Project.Web", kind: "file" }]
    )).toEqual([{ path: "ISS.IPSA.Project.Web", kind: "directory" }]);
  });

  it("scopes parent-repository Git files to the selected project folder", () => {
    const gitFile = (path: string, originalPath?: string) => ({ path, originalPath }) as any;
    const files = getProjectRelativeGitFiles({
      available: true,
      root: "E:\\开发代码",
      files: [
        gitFile("Project/ISS.IPSA.Project.Web/src/App.vue"),
        gitFile("Project/softstone-webpmp/src/main.ts", "Project/softstone-webpmp/src/old.ts"),
        gitFile("python-code/foo.py"),
        gitFile("../Dockerfile"),
        gitFile("Project/../Dockerfile")
      ]
    } as any, "E:\\开发代码\\Project");

    expect(files.map((file) => file.path)).toEqual([
      "ISS.IPSA.Project.Web/src/App.vue",
      "softstone-webpmp/src/main.ts"
    ]);
    expect(files[1]?.originalPath).toBe("softstone-webpmp/src/old.ts");
  });

  it("retains safe Git paths when the Git and project roots match", () => {
    const inside = { path: "src/App.tsx" } as any;
    expect(getProjectRelativeGitFiles({
      available: true,
      root: "E:/开发代码/Project/",
      files: [inside, { path: "../Dockerfile" }]
    } as any, "e:\\开发代码\\project")).toEqual([inside]);
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

  it("prefers runtime token and provider byte measurements over fixed UI estimates", () => {
    const usage = buildContextUsage({
      contextWindow: 128_000,
      messages: [],
      toolCalls: [],
      gpaStage: "act",
      selectedSkillCount: 0,
      mcpServerCount: 0,
      pendingInput: "",
      measurement: {
        turnRunId: "turn-1",
        modelId: "deepseek-v4-flash-0731",
        providerId: "provider-10",
        contextWindow: 500_000,
        maxInputTokens: 375_000,
        estimatedInputTokens: 128_000,
        outputReserveTokens: 32_768,
        requestBytes: 117_352,
        maxRequestBytes: 122_880,
        maxTools: 50,
        toolCount: 47,
        segments: [
          { id: "system", tokens: 12_000 },
          { id: "tools", tokens: 8_000 },
          { id: "conversation", tokens: 100_000 },
          { id: "capsules", tokens: 8_000 },
          { id: "output_reserve", tokens: 32_768 }
        ],
        createdAt: "2026-08-04T09:00:00.000Z"
      }
    });

    expect(usage.contextWindow).toBe(500_000);
    expect(usage.maxInputTokens).toBe(375_000);
    expect(usage.usedTokens).toBe(160_768);
    expect(usage.requestBytes).toBe(117_352);
    expect(usage.maxRequestBytes).toBe(122_880);
    expect(usage.toolCount).toBe(47);
    expect(usage.measurement?.providerId).toBe("provider-10");
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

  it("keeps unchanged lines between separate snapshot edits as context", () => {
    const diff = buildFileSnapshotDiff(
      "first\nold-one\nmiddle\nold-two\nlast",
      "first\nnew-one\nmiddle\nnew-two\nlast"
    );

    expect(diff).toEqual([
      { kind: "context", content: "first" },
      { kind: "removed", content: "old-one" },
      { kind: "added", content: "new-one" },
      { kind: "context", content: "middle" },
      { kind: "removed", content: "old-two" },
      { kind: "added", content: "new-two" },
      { kind: "context", content: "last" }
    ]);
    expect(diff.filter((line) => line.kind === "added")).toHaveLength(2);
    expect(diff.filter((line) => line.kind === "removed")).toHaveLength(2);
  });

  it("counts separated snapshot insertions and deletions without counting their context", () => {
    const counts = getFileSnapshotDiffCounts(
      "first\nremove-me\nmiddle\nlast",
      "first\ninsert-me\nmiddle\nlast\nappend-me"
    );

    expect(counts).toEqual({ additions: 2, deletions: 1 });
  });

  it("preserves repeated context when a large snapshot uses the bounded diff path", () => {
    const repeatedContext = Array.from({ length: 1_001 }, () => "repeated context");
    const before = ["old-first", ...repeatedContext, "old-last"].join("\n");
    const after = ["new-first", ...repeatedContext, "new-last"].join("\n");
    const diff = buildFileSnapshotDiff(before, after);

    expect(diff.filter((line) => line.kind === "context")).toHaveLength(1_001);
    expect(diff.filter((line) => line.kind === "added")).toHaveLength(2);
    expect(diff.filter((line) => line.kind === "removed")).toHaveLength(2);
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

  it("keeps complete snapshot totals when the displayed preview is truncated", () => {
    const before = [
      ...Array.from({ length: 24 }, (_, index) => `before-${index}`),
      "old-one",
      ...Array.from({ length: 24 }, (_, index) => `middle-${index}`),
      "old-two",
      ...Array.from({ length: 24 }, (_, index) => `later-${index}`),
      "old-three",
      ...Array.from({ length: 24 }, (_, index) => `after-${index}`)
    ].join("\n");
    const after = before
      .replace("old-one", "new-one")
      .replace("old-two", "new-two")
      .replace("old-three", "new-three");
    const preview = buildFileSnapshotDiffPreview(before, after, 20);
    const full = buildFileSnapshotDiff(before, after);

    expect(full.filter((line) => line.kind === "added")).toHaveLength(3);
    expect(full.filter((line) => line.kind === "removed")).toHaveLength(3);
    expect(preview.filter((line) => line.kind === "added").length).toBeLessThan(3);
    expect(preview.filter((line) => line.kind === "removed").length).toBeLessThan(3);
  });

  it("counts the current task's net snapshot changes", () => {
    expect(getFileChangeLineCounts({
      path: "src/App.tsx",
      action: "modified",
      additions: 20,
      deletions: 10,
      snapshot: {
        path: "src/App.tsx",
        before: "first\nold",
        after: "first\nnew\nlast",
        beforeTruncated: false,
        afterTruncated: false
      }
    })).toEqual({ additions: 2, deletions: 1 });
  });

  it("excludes modified files with no final content diff from the task summary", () => {
    const visible = getVisibleFileChanges([
      {
        path: "src/no-op.ts",
        action: "modified",
        additions: 3,
        deletions: 3,
        snapshot: {
          path: "src/no-op.ts",
          before: "same",
          after: "same",
          beforeTruncated: false,
          afterTruncated: false
        }
      },
      { path: "src/zero.ts", action: "modified", additions: 0, deletions: 0 },
      { path: "src/changed.ts", action: "modified", additions: 1, deletions: 1 },
      { path: "empty.ts", action: "created", additions: 0, deletions: 0 }
    ]);

    expect(visible.map(({ file }) => file.path)).toEqual(["src/changed.ts", "empty.ts"]);
  });

  it("selects only the latest one-shot task, including an internal GPA continuation", () => {
    const patchCall = (
      turnRunId: string,
      path: string,
      before: string,
      after: string,
      status: "completed" | "failed" = "completed",
      startedAt = "2026-08-17T10:00:00.000Z"
    ) => ({
      id: `${turnRunId}-${path}`,
      threadId: "thread-1",
      turnRunId,
      toolName: "apply_patch",
      status,
      argumentsJson: JSON.stringify({ patch: `*** Begin Patch\n*** Update File: ${path}\n-old\n+new\n*** End Patch` }),
      resultJson: JSON.stringify({
        ok: status === "completed",
        json: {
          changes: [{ path, action: "update", additions: 1, deletions: 1 }],
          snapshots: [{ path, before, after, beforeTruncated: false, afterTruncated: false }]
        }
      }),
      riskLevel: "medium",
      approvalMode: "prompt",
      startedAt,
      completedAt: startedAt
    }) as any;

    const toolCalls = [
      patchCall("turn-1", "src/old.ts", "old", "first", "completed", "2026-08-17T10:00:01.000Z"),
      patchCall("turn-gpa-resume", "src/current.ts", "before", "after", "completed", "2026-08-17T10:01:01.000Z")
    ];
    const messages = [
      { turnRunId: "turn-1", content: "visible request", createdAt: "2026-08-17T10:00:00.000Z" },
      { turnRunId: "turn-gpa-resume", content: "[internal:gpa-resume]", createdAt: "2026-08-17T10:01:00.000Z" }
    ] as any;
    const latestTurnRunId = getLatestTurnRunId(messages, toolCalls);
    const changes = collectFileChangesByTurn(toolCalls, "D:\\project").get(latestTurnRunId ?? "") ?? [];

    expect(latestTurnRunId).toBe("turn-gpa-resume");
    expect(changes.map((file) => file.path)).toEqual(["src/current.ts"]);
  });

  it("does not report read-only AST comparisons as file changes", () => {
    const astDiffCall = {
      id: "ast-diff-1",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "code.ast_diff",
      status: "completed",
      argumentsJson: JSON.stringify({ path: "src/App.vue" }),
      resultJson: JSON.stringify({
        ok: true,
        json: {
          path: "src/App.vue",
          language: null,
          entities: [],
          summary: "Unsupported language for AST diff: src/App.vue"
        }
      }),
      riskLevel: "low",
      approvalMode: "prompt",
      startedAt: "2026-08-17T10:00:00.000Z",
      completedAt: "2026-08-17T10:00:01.000Z"
    } as any;

    expect(collectFileChangesByTurn([astDiffCall], "D:\\project").get("turn-1")).toBeUndefined();
  });

  it("merges repeated edits within one turn and excludes failed writes", () => {
    const patchCall = (path: string, before: string, after: string, status: "completed" | "failed" = "completed") => ({
      id: `${path}-${before}`,
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "apply_patch",
      status,
      argumentsJson: JSON.stringify({ patch: `*** Begin Patch\n*** Update File: ${path}\n-old\n+new\n*** End Patch` }),
      resultJson: JSON.stringify({
        ok: status === "completed",
        json: {
          changes: [{ path, action: "update", additions: 1, deletions: 1 }],
          snapshots: [{ path, before, after, beforeTruncated: false, afterTruncated: false }]
        }
      }),
      riskLevel: "medium",
      approvalMode: "prompt",
      startedAt: "2026-08-17T10:00:00.000Z",
      completedAt: "2026-08-17T10:00:01.000Z"
    }) as any;

    const changes = collectFileChangesByTurn([
      patchCall("src/App.tsx", "old", "first"),
      patchCall("src/App.tsx", "first", "latest"),
      patchCall("src/failed.ts", "before", "after", "failed")
    ], "D:\\project").get("turn-1") ?? [];

    expect(changes.map((file) => file.path)).toEqual(["src/App.tsx"]);
    expect(changes[0]?.snapshot).toMatchObject({ before: "old", after: "latest" });
  });

  it("recovers a compacted file snapshot from full tool-call details", () => {
    const file = {
      path: "src/Generated.cs",
      action: "created" as const,
      additions: 120,
      deletions: 0,
      sourceThreadId: "thread-1",
      sourceToolCallIds: ["write-1"]
    };
    const snapshot = resolveFileSnapshotFromToolDetails(file, [{
      toolCallId: "write-1",
      available: true,
      resultSize: 12_000,
      resultJson: JSON.stringify({
        ok: true,
        json: {
          snapshots: [{
            path: "src/Generated.cs",
            before: "",
            after: "namespace Generated;",
            beforeTruncated: false,
            afterTruncated: false
          }]
        }
      })
    }]);

    expect(snapshot).toEqual({
      path: "src/Generated.cs",
      before: "",
      after: "namespace Generated;",
      beforeTruncated: false,
      afterTruncated: false
    });
  });

  it("keeps source tool ids when compact results omit snapshots", () => {
    const changes = collectFileChangesByTurn([{
      id: "write-large-file",
      threadId: "thread-1",
      turnRunId: "turn-1",
      toolName: "apply_patch",
      status: "completed",
      argumentsJson: JSON.stringify({
        patch: "*** Begin Patch\n*** Add File: src/Generated.cs\n+namespace Generated;\n*** End Patch"
      }),
      resultJson: null,
      riskLevel: "medium",
      approvalMode: "prompt",
      startedAt: "2026-08-17T10:00:00.000Z",
      completedAt: "2026-08-17T10:00:01.000Z"
    } as any], "D:\\project").get("turn-1") ?? [];

    expect(changes[0]).toMatchObject({
      path: "src/Generated.cs",
      sourceThreadId: "thread-1",
      sourceToolCallIds: ["write-large-file"]
    });
  });

  it("shows runtime activity only after the latest visible message", () => {
    const activity = {
      threadId: "thread-1",
      startedAt: "2026-08-17T10:00:00.000Z",
      entries: [
        { id: "old-status", kind: "status", label: "旧状态", createdAt: "2026-08-17T10:00:01.000Z" },
        {
          id: "new-tool",
          kind: "tool",
          toolCall: { id: "tool-1", startedAt: "2026-08-17T10:01:01.000Z" }
        },
        { id: "new-status", kind: "status", label: "新状态", createdAt: "2026-08-17T10:01:02.000Z" }
      ]
    } as any;

    const segmented = segmentRuntimeActivityAfterMessage(activity, "2026-08-17T10:01:00.000Z");

    expect(segmented.startedAt).toBe("2026-08-17T10:01:00.000Z");
    expect(segmented.entries.map((entry) => entry.id)).toEqual(["new-tool", "new-status"]);
    expect(segmentRuntimeActivityAfterMessage(segmented, "2026-08-17T10:00:30.000Z")).toBe(segmented);
  });

  it("uses only visible user and assistant messages as runtime activity boundaries", () => {
    const message = (role: "user" | "assistant", content: string, metadataJson: string | null = null) => ({
      role,
      content,
      metadataJson
    }) as any;

    expect(isRuntimeActivityBoundaryMessage(message("assistant", "继续检查文件"))).toBe(true);
    expect(isRuntimeActivityBoundaryMessage(message("user", "补充一个要求"))).toBe(true);
    expect(isRuntimeActivityBoundaryMessage(message("user", "[internal:gpa-resume] continue"))).toBe(false);
    expect(isRuntimeActivityBoundaryMessage(message("assistant", "工具批次", JSON.stringify({ displayKind: "tool_batch" })))).toBe(false);
    expect(isRuntimeActivityBoundaryMessage(message("assistant", "[Executed tools: exec_command]"))).toBe(false);
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

  it("keeps repository changes visible when the Git workspace tab is hidden", () => {
    const changes = getGitProjectFileChangeKinds([
      { path: "new.ts", untracked: true, indexStatus: "?", worktreeStatus: "?" },
      { path: "staged.ts", untracked: false, indexStatus: "A", worktreeStatus: " " },
      { path: "src/removed.ts", untracked: false, indexStatus: " ", worktreeStatus: "D" },
      { path: "src/app.ts", untracked: false, indexStatus: " ", worktreeStatus: "M" }
    ] as any);

    expect(changes.get("new.ts")).toBe("added");
    expect(changes.get("staged.ts")).toBe("added");
    expect(changes.get("src/removed.ts")).toBe("deleted");
    expect(changes.get("src/app.ts")).toBe("modified");
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

describe("parseEChartsConfig", () => {
  it("accepts a strict JSON option and reserves canvas space for the legend", () => {
    const result = parseEChartsConfig('{"title":{"text":"月度销售额"},"legend":{},"xAxis":{"data":["1月"]},"series":[{"type":"bar","data":[120]}]}');

    expect(result).toMatchObject({ ok: true, title: "月度销售额", option: { aria: { enabled: true }, legend: { top: 12 }, grid: { top: 58, containLabel: true } } });
    if (result.ok) expect(result.option.title).toBeUndefined();
  });

  it("rejects invalid roots, dangerous keys, remote images, and oversized input", () => {
    expect(parseEChartsConfig("[]")).toMatchObject({ ok: false });
    expect(parseEChartsConfig('{"__proto__":{"polluted":true}}')).toMatchObject({ ok: false });
    expect(parseEChartsConfig('{"series":[{"symbol":"image://https://example.com/a.png"}]}')).toMatchObject({ ok: false });
    expect(parseEChartsConfig(" ".repeat(ECHARTS_CONFIG_MAX_BYTES + 1))).toMatchObject({ ok: false });
  });
});
