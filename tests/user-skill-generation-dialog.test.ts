import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UserSkillGenerationDialog } from "../apps/desktop/src/renderer/settings/user-skill-generation-dialog";

describe("user skill generation dialog", () => {
  it("allows closing while generation continues in the background", () => {
    const markup = renderToStaticMarkup(createElement(UserSkillGenerationDialog, {
      dialog: { thread: { title: "示例对话" } as any, name: "示例技能" },
      generating: true,
      onClose: vi.fn(),
      onNameChange: vi.fn(),
      onGenerate: vi.fn()
    }));

    expect(markup).toContain('aria-label="关闭并在后台继续"');
    expect(markup).toContain("关闭并后台运行");
    expect(markup).not.toContain('class="project-sheet-close" type="button" disabled');
  });
});
