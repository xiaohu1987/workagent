import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(
  new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url),
  "utf8"
);
const stylesSource = readFileSync(
  new URL("../apps/desktop/src/renderer/styles.css", import.meta.url),
  "utf8"
);

describe("新建任务页标题区", () => {
  it("仅在新建任务页、输入框上方渲染标题与副标题", () => {
    const hero = rendererSource.match(
      /isNewTaskComposerOpen\s*\?\s*\(\s*<div className="new-task-hero"[\s\S]*?<\/div>\s*\)\s*:\s*null\s*\}/
    );
    expect(hero).not.toBeNull();
    expect(hero?.[0]).toContain(
      '<span className="new-task-hero-brand">Code<span className="new-task-hero-red">XH</span></span>来帮你完成一个<span className="new-task-hero-blue">新任务</span>'
    );
    expect(hero?.[0]).toContain("描述你的目标，直接在下方输入框开始。");
    expect(hero?.[0]).not.toContain("NEW TASK");

    const heroIndex = rendererSource.indexOf('className="new-task-hero"');
    const composerIndex = rendererSource.indexOf('<div className="chat-composer">');
    expect(heroIndex).toBeGreaterThan(-1);
    expect(composerIndex).toBeGreaterThan(heroIndex);
  });

  it("标题区样式只作用于新建任务页，常规聊天不受影响", () => {
    expect(stylesSource).toContain(".chat-canvas.is-new-task .new-task-hero {");
    expect(stylesSource).toContain(".chat-canvas.is-new-task .new-task-hero h1 .new-task-hero-brand {");
    expect(stylesSource).toContain(".chat-canvas.is-new-task .new-task-hero h1 .new-task-hero-red {");
    expect(stylesSource).toContain(".chat-canvas.is-new-task .new-task-hero h1 .new-task-hero-blue {");
    expect(stylesSource).not.toContain(".new-task-hero-eyebrow");
    expect(stylesSource).not.toMatch(/^\.new-task-hero/m);
  });

  it("品牌词 CodeXH 字重高于标题基准字重", () => {
    const brandRule = stylesSource.match(
      /\.chat-canvas\.is-new-task \.new-task-hero h1 \.new-task-hero-brand \{[^}]*\}/
    );
    expect(brandRule).not.toBeNull();
    expect(brandRule?.[0]).toContain("font-weight: 800");
  });
});
