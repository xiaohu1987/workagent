import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RollingStatusText } from "../apps/desktop/src/renderer/cards/runtime-cards";
import { AssistantDraftMessage, AssistantDraftReasoning } from "../apps/desktop/src/renderer/timeline/transcript";

const runtimeCards = readFileSync(new URL("../apps/desktop/src/renderer/cards/runtime-cards.tsx", import.meta.url), "utf8");

const styles = readFileSync(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");

describe("chat status roll and reasoning placement", () => {
  it("renders rolling status text for the current activity label", () => {
    const markup = renderToStaticMarkup(createElement(RollingStatusText, {
      text: "正在浏览器搜索 变形金刚大力神"
    }));
    expect(markup).toContain("runtime-activity-rolling");
    expect(markup).toContain("正在浏览器搜索 变形金刚大力神");
    expect(markup).not.toContain("is-rolling");
  });

  it("keeps the assistant draft reply above the thinking block", () => {
    const reply = renderToStaticMarkup(createElement(AssistantDraftMessage, {
      assistantLabel: "助手",
      content: "第一轮搜索已经找到几个候选。",
      draftId: "draft-1",
      phase: "generating",
      startedAt: "2026-09-10T01:00:00.000Z",
      completed: false
    }));
    const reasoning = renderToStaticMarkup(createElement(AssistantDraftReasoning, {
      draftId: "draft-1",
      reasoning: "先筛选适合小朋友的款式。"
    }));

    expect(reply).toContain("第一轮搜索已经找到几个候选。");
    expect(reply).not.toContain("思考过程");
    expect(reasoning).toContain("思考过程");
    expect(reasoning).toContain("先筛选适合小朋友的款式。");
  });

  it("defines the status roll animation", () => {
    expect(styles).toContain(".runtime-activity-rolling {");
    expect(styles).toContain("@keyframes runtime-status-roll-in {");
    expect(styles).toContain("@keyframes runtime-status-roll-out {");
    expect(styles).toContain("animation: runtime-status-roll-out 320ms ease forwards;");
    expect(styles).toContain("animation: runtime-status-roll-in 320ms ease forwards;");
  });

  it("does not cancel the roll cleanup when the displayed label updates", () => {
    expect(runtimeCards).toContain("currentRef.current = text");
    expect(runtimeCards).toMatch(/}, \[text\]\);/);
    expect(runtimeCards).not.toMatch(/}, \[text, current\]\);/);
  });
});
