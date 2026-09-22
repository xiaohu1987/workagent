import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// jev-mcp 是本仓库 tools/ 下的原生 ESM 模块，不属于 TS 项目范围，
// 因此用动态导入拿到实现，再在类型层面按需断言。
const api = (await import(new URL("../tools/jev-mcp/jev-api.mjs", import.meta.url).href)) as any;
const SERVER_PATH = fileURLToPath(new URL("../tools/jev-mcp/server.mjs", import.meta.url));

const TOOL = "jev_evaluate";

interface CapturedRequest {
  url?: string;
  authorization?: string;
  body: any;
}

/** 起一个本地假 TypeSafe 端点，记录收到的请求并返回固定响应。 */
async function startFakeTypeSafe(respond: () => { status: number; body: string }) {
  const requests: CapturedRequest[] = [];
  const httpServer = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined
      });
      const { status, body } = respond();
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

function connectServer(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env,
    stderr: "pipe"
  });
  const client = new Client({ name: "codexh-jev-test", version: "0.1.0" }, { capabilities: {} });
  return { client, transport, ready: client.connect(transport) };
}

describe("jev-api 入参校验与错误映射", () => {
  it("组装请求体时补默认模型，并逐项校验问题", () => {
    const questions = { urgent: { type: "noul", instructions: "是否表达了紧迫性" } };
    expect(api.buildRequestBody({ state: "payouts failing", questions })).toEqual({
      state: "payouts failing",
      model: "jev-latest",
      questions
    });

    expect(() => api.buildRequestBody({ questions })).toThrow(/state 必填/);
    expect(() => api.buildRequestBody({ state: "x", questions: {} })).toThrow(/至少需要一个条目/);
    expect(() => api.buildRequestBody({ state: "x", questions: { a: { type: "ranking", instructions: "?" } } })).toThrow(/type 必须是/);
    expect(() => api.buildRequestBody({ state: "x", questions: { a: { type: "noul" } } })).toThrow(/instructions/);
    expect(() => api.buildRequestBody({ state: "x", questions: { a: { type: "choice", instructions: "?" } } })).toThrow(/criteria/);
    expect(() => api.buildRequestBody({ state: "x", questions: { a: { type: "score", instructions: "?", criteria: "low-high" } } })).toThrow(/有序档位数组/);
  });

  it("按环境变量或密钥文件解析密钥", () => {
    expect(api.resolveApiKey({ TYPESAFE_API_KEY: " ts_1 " })).toBe("ts_1");
    expect(api.resolveApiKey({ JEV_API_KEY: "ts_2" })).toBe("ts_2");
    expect(api.resolveApiKey({})).toBeNull();
    expect(api.resolveApiKey({ TYPESAFE_API_KEY_FILE: "C:/keys/jev" }, () => "ts_3\n")).toBe("ts_3");
    expect(() =>
      api.resolveApiKey({ TYPESAFE_API_KEY_FILE: "C:/keys/missing" }, () => {
        throw new Error("ENOENT");
      })
    ).toThrow(/无法读取/);
  });

  it("调用接口时组装请求，并把 401、429 映射成可操作提示", async () => {
    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: {} })
    });
    const questions = { urgent: { type: "noul", instructions: "?" } };
    await expect(
      api.evaluate({ state: { text: "help" }, questions }, { apiKey: "k", baseUrl: "https://api.example.test/", fetchImpl: okFetch })
    ).resolves.toEqual({ model: "jev-1.13.0", answers: {}, usage: {} });

    const [url, init] = okFetch.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body)).toEqual({ state: { text: "help" }, model: "jev-latest", questions });

    const unauthorized = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "invalid key" });
    await expect(api.evaluate({ state: "x", questions }, { apiKey: "bad", fetchImpl: unauthorized })).rejects.toThrow(/TYPESAFE_API_KEY/);

    const limited = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "slow down" });
    await expect(api.evaluate({ state: "x", questions }, { apiKey: "k", fetchImpl: limited })).rejects.toThrow(/限流/);
  });
});

describe("jev-mcp stdio 服务", () => {
  it("原样转发 state/questions，并原样返回 answers", async () => {
    const canned = {
      model: "jev-1.13.0",
      answers: { is_urgent: { type: "noul", noul: 0.95 } },
      usage: { input_tokens: 12, output_tokens: 3 }
    };
    const fake = await startFakeTypeSafe(() => ({ status: 200, body: JSON.stringify(canned) }));
    const { client, ready } = connectServer({ TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: fake.url });
    await ready;
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([TOOL]);

      const questions = { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } };
      const state = "Payouts have been failing for 3 days";
      const result = (await client.callTool({ name: TOOL, arguments: { state, questions } })) as any;

      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toEqual(canned);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0].url).toBe("/v1/systemone");
      expect(fake.requests[0].authorization).toBe("Bearer test-key");
      expect(fake.requests[0].body).toEqual({ state, model: "jev-latest", questions });
    } finally {
      await client.close();
      await fake.close();
    }
  }, 30_000);

  it("缺少密钥时给出配置指引而不是让连接失败", async () => {
    const { client, ready } = connectServer({ TYPESAFE_API_KEY: "" });
    await ready;
    try {
      const result = (await client.callTool({
        name: TOOL,
        arguments: { state: "x", questions: { a: { type: "noul", instructions: "?" } } }
      })) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("TYPESAFE_API_KEY");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("上游报错时把状态码与原因回传给调用方", async () => {
    const fake = await startFakeTypeSafe(() => ({ status: 401, body: JSON.stringify({ error: "invalid_api_key" }) }));
    const { client, ready } = connectServer({ TYPESAFE_API_KEY: "wrong", TYPESAFE_BASE_URL: fake.url });
    await ready;
    try {
      const result = (await client.callTool({
        name: TOOL,
        arguments: { state: "x", questions: { a: { type: "noul", instructions: "?" } } }
      })) as any;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("HTTP 401");
      expect(result.content[0].text).toContain("TYPESAFE_API_KEY");
    } finally {
      await client.close();
      await fake.close();
    }
  }, 30_000);
});
