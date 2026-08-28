import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectEditSheet } from "../apps/desktop/src/renderer/workspace/project-edit-sheet";

describe("project edit sheet", () => {
  it("treats collaboration roots as project-level folders", () => {
    const markup = renderToStaticMarkup(createElement(ProjectEditSheet, {
      cwd: "D:\\workagent",
      workspaceRoots: ["D:\\workagent", "D:\\shared-ui"],
      isPickingFolder: false,
      isSaving: false,
      isRemoving: false,
      onClose: vi.fn(),
      onChooseFolder: vi.fn(),
      onRemoveRoot: vi.fn(),
      onSave: vi.fn(),
      onRemoveProject: vi.fn()
    }));

    expect(markup).toContain("编辑项目");
    expect(markup).toContain("项目内的聊天会共享这些文件夹");
    expect(markup).toContain("主要");
    expect(markup).toContain("添加文件夹");
    expect(markup).toContain('aria-label="移除 D:\\shared-ui"');
    expect(markup).not.toContain('aria-label="移除 D:\\workagent"');
  });
});
