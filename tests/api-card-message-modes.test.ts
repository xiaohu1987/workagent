import { createElement } from "react";
import { readFileSync } from "node:fs";
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

  it("重置与发送按钮挪到请求地址行内,按钮文案为发送", () => {
    const markup = renderCard(withFields);
    expect(markup).toContain("请求地址");
    expect(markup).toContain("重置");
    expect(markup).toContain(">发送<");
    expect(markup).not.toContain(">确定<");

    // 按钮区作为请求地址行的兄弟节点渲染,不再单独占一整行。
    const urlRow = markup.match(/class="api-card-url-control"[\s\S]*?<\/div><\/div>/);
    expect(urlRow?.[0]).toContain("api-card-actions");
  });

  it("按钮右贴边:样式把请求地址行改成横向布局并让按钮区不参与伸缩", () => {
    const css = readFileSync(
      new URL("../apps/desktop/src/renderer/cards/api-card-message.css", import.meta.url),
      "utf8"
    );
    expect(css).toContain(".api-card-url-control {");
    expect(css).toContain("align-items: flex-end");
    expect(css).toContain(".api-card-url-control > .fc-field {");
    expect(css).toContain(".api-card-url-control .api-card-actions {");
    expect(css).toContain("flex: 0 0 auto;");
  });
});
