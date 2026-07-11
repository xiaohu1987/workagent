import { describe, expect, it } from "vitest";
import { buildProjectFileTree, parseMarkdownBlocks } from "../apps/desktop/src/renderer/App";

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
});
