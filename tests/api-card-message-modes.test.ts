import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiCardMessage } from "../apps/desktop/src/renderer/cards/api-card-message";

function renderCard(config: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(ApiCardMessage, { configText: JSON.stringify(config) }));
}

describe("api-card 入参模式切换", () => {
  const withFields = {
    title: "查询用户",
    method: "GET",
    url: "https://api.example.com/users/{{userId}}",
    fields: [{ name: "userId", label: "用户 ID", type: "text", required: true }]
  };

  it("默认停在控件模式,同时给出两种模式入口", () => {
    const markup = renderCard(withFields);
    expect(markup).toContain("入参");
    expect(markup).toContain("控件模式");
    expect(markup).toContain("JSON 模式");
    expect(markup).toContain('class="api-card-mode-option is-active"');
  });

  it("控件模式仍然是默认渲染的入参表单", () => {
    const markup = renderCard(withFields);
    expect(markup).toContain("用户 ID");
    expect(markup).toContain("api-card-fields");
    expect(markup).not.toContain("入参 JSON");
  });

  it("没有声明字段时不渲染模式切换", () => {
    const markup = renderCard({
      title: "Ping",
      method: "GET",
      url: "https://api.example.com/ping",
      fields: []
    });
    expect(markup).not.toContain("控件模式");
    expect(markup).not.toContain("JSON 模式");
  });

  it("配置非法时只渲染错误块", () => {
    const markup = renderToStaticMarkup(createElement(ApiCardMessage, { configText: "{ not json" }));
    expect(markup).toContain("API 卡片配置无效");
    expect(markup).not.toContain("控件模式");
  });
});
