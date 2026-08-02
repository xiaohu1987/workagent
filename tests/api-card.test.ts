import { describe, expect, it } from "vitest";
import {
  API_CARD_CONFIG_MAX_BYTES,
  API_CARD_RESPONSE_PREVIEW_CHARS,
  buildApiRequest,
  createInitialValues,
  formatApiResponseBody,
  parseApiCardConfig,
  substituteTemplate,
  type ApiCardConfig
} from "../apps/desktop/src/renderer/cards/api-card";
import { parseMarkdownBlocks } from "../apps/desktop/src/renderer/markdown";

const baseConfig: ApiCardConfig = {
  title: "查询用户",
  method: "GET",
  url: "https://api.example.com/users/{{userId}}",
  headers: { "X-Trace": "{{traceId}}" },
  query: { q: "{{keyword}}", page: "1" },
  fields: [
    { name: "userId", label: "用户 ID", type: "text", required: true },
    { name: "keyword", label: "关键词", type: "text" },
    { name: "traceId", label: "追踪 ID", type: "text" }
  ]
};

describe("parseApiCardConfig", () => {
  it("parses a minimal valid config", () => {
    const result = parseApiCardConfig(JSON.stringify({
      title: "Ping",
      method: "get",
      url: "https://api.example.com/ping",
      fields: []
    }));
    expect(result).toEqual({
      ok: true,
      config: {
        title: "Ping",
        method: "GET",
        url: "https://api.example.com/ping",
        fields: []
      }
    });
  });

  it("parses a full config with auth, headers, query and bodyTemplate", () => {
    const result = parseApiCardConfig(JSON.stringify({
      title: "创建订单",
      description: "根据接口文档生成",
      method: "POST",
      url: "https://api.example.com/orders",
      auth: { type: "bearer", required: true },
      headers: { "X-Env": "prod" },
      query: { source: "chat" },
      bodyTemplate: "{ \"sku\": \"{{sku}}\", \"count\": {{count}} }",
      fields: [
        { name: "sku", label: "商品", type: "text", required: true },
        { name: "count", label: "数量", type: "number", defaultValue: 1 }
      ]
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.method).toBe("POST");
    expect(result.config.auth).toEqual({ type: "bearer", required: true });
    expect(result.config.fields[1]).toMatchObject({ name: "count", type: "number", defaultValue: 1 });
  });

  it("rejects invalid JSON and non-object configs", () => {
    expect(parseApiCardConfig("{ not json")).toMatchObject({ ok: false });
    expect(parseApiCardConfig("[1,2]")).toMatchObject({ ok: false, error: expect.stringContaining("JSON 对象") });
  });

  it("rejects configs exceeding the size limit", () => {
    const oversized = JSON.stringify({
      title: "Big",
      method: "GET",
      url: "https://api.example.com",
      fields: [{ name: "payload", label: "载荷", type: "text", defaultValue: "x".repeat(API_CARD_CONFIG_MAX_BYTES) }]
    });
    const result = parseApiCardConfig(oversized);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("64 KB") });
  });

  it("rejects configs containing forbidden keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const result = parseApiCardConfig(JSON.stringify({
        title: "Evil",
        method: "GET",
        url: "https://api.example.com",
        fields: [],
        headers: { "X-Nested": "safe" },
        query: {},
        [key]: { polluted: true }
      }));
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(key) });
    }
  });

  it("rejects missing or invalid required sections", () => {
    const cases: Array<[unknown, string]> = [
      [{ method: "GET", url: "https://a.com", fields: [] }, "title"],
      [{ title: "t", url: "https://a.com", fields: [] }, "method"],
      [{ title: "t", method: "TELEPORT", url: "https://a.com", fields: [] }, "method"],
      [{ title: "t", method: "GET", url: "ftp://a.com", fields: [] }, "url"],
      [{ title: "t", method: "GET", url: "https://a.com" }, "fields"]
    ];
    for (const [config, fragment] of cases) {
      expect(parseApiCardConfig(JSON.stringify(config))).toMatchObject({
        ok: false,
        error: expect.stringContaining(fragment)
      });
    }
  });

  it("rejects invalid field definitions", () => {
    const make = (fields: unknown[]) => JSON.stringify({
      title: "t",
      method: "GET",
      url: "https://a.com",
      fields
    });
    expect(parseApiCardConfig(make([{ name: "1bad", type: "text" }]))).toMatchObject({ ok: false, error: expect.stringContaining("name") });
    expect(parseApiCardConfig(make([{ name: "ok", type: "unknown" }]))).toMatchObject({ ok: false, error: expect.stringContaining("type") });
    expect(parseApiCardConfig(make([{ name: "s", type: "select" }]))).toMatchObject({ ok: false, error: expect.stringContaining("options") });
    expect(parseApiCardConfig(make([
      { name: "dup", type: "text" },
      { name: "dup", type: "text" }
    ]))).toMatchObject({ ok: false, error: expect.stringContaining("重复") });
  });

  it("rejects invalid auth declarations", () => {
    const make = (auth: unknown) => JSON.stringify({
      title: "t",
      method: "GET",
      url: "https://a.com",
      fields: [],
      auth
    });
    expect(parseApiCardConfig(make({ type: "oauth" }))).toMatchObject({ ok: false, error: expect.stringContaining("auth.type") });
    expect(parseApiCardConfig(make({ type: "apiKey", in: "cookie" }))).toMatchObject({ ok: false, error: expect.stringContaining("auth.in") });
  });

  it("repairs bare {{placeholder}} tokens inside an object bodyTemplate", () => {
    // 模型常见错误:bodyTemplate 写成对象字面量并裸写占位符,不是合法 JSON
    const content = `{
      "title": "查询",
      "method": "POST",
      "url": "https://api.example.com/search",
      "bodyTemplate": {
        "type": {{type}},
        "name": "{{name}}"
      },
      "fields": [
        { "name": "type", "label": "类型", "type": "select", "options": [{ "label": "A", "value": "1" }] },
        { "name": "name", "label": "名称", "type": "text" }
      ]
    }`;
    const parsed = parseApiCardConfig(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.bodyTemplate).toBe(JSON.stringify({ type: "{{type}}", name: "{{name}}" }));
    const built = buildApiRequest(parsed.config, { type: "1", name: "报表" }, "");
    expect(built).toMatchObject({ ok: true });
    if (built.ok) expect(JSON.parse(built.request.body ?? "")).toEqual({ type: "1", name: "报表" });
  });

  it("accepts bodyTemplate given as a plain object with quoted placeholders", () => {
    const parsed = parseApiCardConfig(JSON.stringify({
      title: "t",
      method: "POST",
      url: "https://api.example.com/x",
      bodyTemplate: { keyword: "{{kw}}", page: 1 },
      fields: [{ name: "kw", label: "kw", type: "text" }]
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const built = buildApiRequest(parsed.config, { kw: "a\"b" }, "");
    expect(built).toMatchObject({ ok: true });
    if (built.ok) expect(JSON.parse(built.request.body ?? "")).toEqual({ keyword: "a\"b", page: 1 });
  });

  it("keeps already-quoted placeholders untouched when repairing", () => {
    const parsed = parseApiCardConfig(
      `{ "title": "t", "method": "POST", "url": "https://api.example.com/x", "bodyTemplate": "{ \\"name\\": \\"{{name}}\\" }", "fields": [{ "name": "name", "label": "n", "type": "text" }] }`
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.bodyTemplate).toBe('{ "name": "{{name}}" }');
  });
});

describe("createInitialValues", () => {
  it("creates defaults per field type", () => {
    const values = createInitialValues({
      title: "t",
      method: "GET",
      url: "https://a.com",
      fields: [
        { name: "text", label: "t", type: "text", defaultValue: "hello" },
        { name: "num", label: "n", type: "number" },
        { name: "flag", label: "f", type: "switch", defaultValue: true },
        { name: "tags", label: "t", type: "checkbox", options: [{ label: "A", value: "a" }] },
        { name: "kv", label: "k", type: "keyvalue" }
      ]
    });
    expect(values).toEqual({
      text: "hello",
      num: "",
      flag: true,
      tags: [],
      kv: []
    });
  });
});

describe("buildApiRequest", () => {
  it("substitutes path params with URL encoding", () => {
    const result = buildApiRequest(baseConfig, { userId: "a/b c", keyword: "x", traceId: "t" }, "");
    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({
        method: "GET",
        url: expect.stringContaining("https://api.example.com/users/a%2Fb%20c")
      })
    });
  });

  it("substitutes query and header templates", () => {
    const result = buildApiRequest(baseConfig, { userId: "u1", keyword: "你好 &", traceId: "trace-9" }, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.url).toContain("q=%E4%BD%A0%E5%A5%BD%20%26");
    expect(result.request.url).toContain("page=1");
    expect(result.request.headers["X-Trace"]).toBe("trace-9");
  });

  it("builds a JSON body with type-aware fragments", () => {
    const config: ApiCardConfig = {
      title: "创建",
      method: "POST",
      url: "https://api.example.com/items",
      bodyTemplate: [
        "{",
        "  \"name\": \"{{name}}\",",
        "  \"count\": {{count}},",
        "  \"enabled\": {{enabled}},",
        "  \"tags\": {{tags}},",
        "  \"extra\": {{extra}},",
        "  \"attrs\": {{attrs}}",
        "}"
      ].join("\n"),
      fields: [
        { name: "name", label: "名称", type: "text", required: true },
        { name: "count", label: "数量", type: "number" },
        { name: "enabled", label: "启用", type: "switch" },
        { name: "tags", label: "标签", type: "checkbox", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] },
        { name: "extra", label: "扩展", type: "json" },
        { name: "attrs", label: "属性", type: "keyvalue" }
      ]
    };
    const result = buildApiRequest(config, {
      name: "带有\"引号\"和\n换行",
      count: "3",
      enabled: true,
      tags: ["a", "b"],
      extra: "{ \"nested\": true }",
      attrs: [{ key: "color", value: "red" }, { key: "", value: "ignored" }]
    }, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(result.request.body ?? "")).toEqual({
      name: "带有\"引号\"和\n换行",
      count: 3,
      enabled: true,
      tags: ["a", "b"],
      extra: { nested: true },
      attrs: { color: "red" }
    });
  });

  it("does not override an explicit Content-Type header", () => {
    const config: ApiCardConfig = {
      title: "t",
      method: "POST",
      url: "https://api.example.com",
      headers: { "content-type": "application/vnd.api+json" },
      bodyTemplate: "{ \"a\": {{n}} }",
      fields: [{ name: "n", label: "n", type: "number" }]
    };
    const result = buildApiRequest(config, { n: "1" }, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers["content-type"]).toBe("application/vnd.api+json");
  });

  it("skips the body for GET requests", () => {
    const config: ApiCardConfig = {
      title: "t",
      method: "GET",
      url: "https://api.example.com",
      bodyTemplate: "{ \"a\": 1 }",
      fields: []
    };
    const result = buildApiRequest(config, {}, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toBeUndefined();
  });

  it("validates required fields before building", () => {
    const result = buildApiRequest(baseConfig, { userId: "  ", keyword: "", traceId: "" }, "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors.userId).toContain("用户 ID");
  });

  it("validates number and json field values", () => {
    const config: ApiCardConfig = {
      title: "t",
      method: "POST",
      url: "https://api.example.com",
      bodyTemplate: "{ \"n\": {{num}}, \"j\": {{doc}} }",
      fields: [
        { name: "num", label: "数量", type: "number" },
        { name: "doc", label: "文档", type: "json" }
      ]
    };
    const badNumber = buildApiRequest(config, { num: "abc", doc: "{}" }, "");
    expect(badNumber).toMatchObject({ ok: false, fieldErrors: { num: expect.stringContaining("数字") } });
    const badJson = buildApiRequest(config, { num: "1", doc: "{ not json" }, "");
    expect(badJson).toMatchObject({ ok: false, fieldErrors: { doc: expect.stringContaining("JSON") } });
  });

  it("rejects templates referencing unknown fields", () => {
    const config: ApiCardConfig = {
      title: "t",
      method: "GET",
      url: "https://api.example.com/{{ghost}}",
      fields: []
    };
    const result = buildApiRequest(config, {}, "");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("ghost") });
  });

  it("rejects when the substituted url is unparseable", () => {
    const config: ApiCardConfig = {
      title: "t",
      method: "GET",
      url: "https://api.example.com/{{path}}",
      fields: [{ name: "path", label: "p", type: "text", required: true }]
    };
    const result = buildApiRequest(config, { path: "%zz" }, "");
    // %zz 被 encodeURIComponent 处理后仍可解析,这里改用含空格协议注入尝试
    expect(result.ok).toBe(true);
    const badConfig: ApiCardConfig = { ...config, url: "https://exa mple.com/{{path}}" };
    expect(buildApiRequest(badConfig, { path: "x" }, "")).toMatchObject({ ok: false });
  });

  it("injects bearer auth into the Authorization header", () => {
    const config: ApiCardConfig = {
      ...baseConfig,
      auth: { type: "bearer", required: true }
    };
    const missing = buildApiRequest(config, { userId: "u", keyword: "", traceId: "" }, " ");
    expect(missing).toMatchObject({ ok: false, fieldErrors: { __auth: expect.stringContaining("Token") } });
    const result = buildApiRequest(config, { userId: "u", keyword: "", traceId: "" }, "tok-123");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers.Authorization).toBe("Bearer tok-123");
  });

  it("injects apiKey auth into header or query", () => {
    const headerConfig: ApiCardConfig = {
      ...baseConfig,
      auth: { type: "apiKey", in: "header", name: "X-Custom-Key" }
    };
    const headerResult = buildApiRequest(headerConfig, { userId: "u", keyword: "", traceId: "" }, "k");
    expect(headerResult.ok).toBe(true);
    if (!headerResult.ok) return;
    expect(headerResult.request.headers["X-Custom-Key"]).toBe("k");

    const queryConfig: ApiCardConfig = {
      ...baseConfig,
      auth: { type: "apiKey", in: "query", name: "key" }
    };
    const queryResult = buildApiRequest(queryConfig, { userId: "u", keyword: "", traceId: "" }, "k%2");
    expect(queryResult.ok).toBe(true);
    if (!queryResult.ok) return;
    expect(queryResult.request.url).toContain("key=k%252");
  });

  it("injects basic auth as base64", () => {
    const config: ApiCardConfig = {
      ...baseConfig,
      auth: { type: "basic" }
    };
    const result = buildApiRequest(config, { userId: "u", keyword: "", traceId: "" }, "alice:secret");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers.Authorization).toBe("Basic YWxpY2U6c2VjcmV0");
  });
});

describe("substituteTemplate", () => {
  const fields: ApiCardConfig["fields"] = [
    { name: "raw", label: "r", type: "text" },
    { name: "list", label: "l", type: "checkbox", options: [{ label: "A", value: "a" }] }
  ];

  it("leaves unknown tokens untouched", () => {
    expect(substituteTemplate("{{unknown}}", fields, {}, "raw")).toBe("{{unknown}}");
  });

  it("encodes values in url mode", () => {
    expect(substituteTemplate("v={{raw}}", fields, { raw: "a b" }, "url")).toBe("v=a%20b");
  });

  it("joins checkbox values in raw mode", () => {
    expect(substituteTemplate("{{list}}", fields, { list: ["a", "b"] }, "raw")).toBe("a,b");
  });
});

describe("formatApiResponseBody", () => {
  it("pretty prints json bodies", () => {
    const result = formatApiResponseBody("{\"a\":1,\"b\":[2]}");
    expect(result.isJson).toBe(true);
    expect(result.pretty).toBe(JSON.stringify({ a: 1, b: [2] }, null, 2));
    expect(result.truncated).toBe(false);
  });

  it("keeps plain text bodies untouched", () => {
    const result = formatApiResponseBody("plain text body");
    expect(result).toEqual({ pretty: "plain text body", isJson: false, truncated: false });
  });

  it("truncates oversized bodies", () => {
    const result = formatApiResponseBody(`{\"data\":\"${"x".repeat(API_CARD_RESPONSE_PREVIEW_CHARS)}\"}`);
    expect(result.truncated).toBe(true);
    expect(result.pretty.length).toBeLessThan(API_CARD_RESPONSE_PREVIEW_CHARS + 100);
  });
});

describe("parseMarkdownBlocks api-card", () => {
  const cardJson = JSON.stringify({
    title: "t",
    method: "GET",
    url: "https://api.example.com",
    fields: []
  });

  it("parses a closed api-card fence as an api-card block", () => {
    expect(parseMarkdownBlocks(`\`\`\`api-card\n${cardJson}\n\`\`\``)).toEqual([
      { kind: "api-card", content: cardJson }
    ]);
  });

  it("keeps an unclosed api-card fence as a code block", () => {
    expect(parseMarkdownBlocks(`\`\`\`api-card\n${cardJson}`)).toEqual([
      { kind: "code", language: "api-card", content: cardJson }
    ]);
  });
});
