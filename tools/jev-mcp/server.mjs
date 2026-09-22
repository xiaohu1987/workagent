#!/usr/bin/env node
/**
 * jev-mcp —— 把 TypeSafe System One（Jev）决策接口包成一个 stdio MCP 服务。
 *
 * 设计原则：薄转接。入参 state / model / questions 原样转发给 TypeSafe，
 * 上游响应原样作为工具结果返回。这里不做分类、不改写答案、不代替调用方做阈值判断。
 *
 * 启动：node tools/jev-mcp/server.mjs（由 CodeXH 作为 stdio MCP 子进程拉起）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  DEFAULT_MODEL,
  QUESTION_TYPES,
  evaluate,
  resolveApiKey,
  resolveBaseUrl,
  resolveTimeoutMs
} from "./jev-api.mjs";

const SERVER_NAME = "jev-mcp";
const SERVER_VERSION = "1.0.0";
const TOOL_NAME = "jev_evaluate";

const MISSING_KEY_MESSAGE = [
  "未配置 TypeSafe API Key，无法调用 Jev。",
  "请在 CodeXH 的「设置 -> MCP」中打开 jev 服务，在「环境变量（KEY=VALUE）」中填写：",
  "    TYPESAFE_API_KEY=ts_xxx",
  "保存后重连该服务即可。密钥可在 https://console.typesafe.ai/keys 生成。",
  `也可以填写 ${"TYPESAFE_API_KEY_FILE=<本地密钥文件路径>"} 让本服务从文件读取。`
].join("\n");

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: "Jev 类型化决策",
  description: [
    "向 TypeSafe 的 System One 模型 Jev 提交一组类型化问题，得到代码可直接使用的结构化答案。",
    "Jev 不生成文本、不写代码、不做多轮对话：它只依据 state 对每个问题给出数值化判断。",
    "可用问题类型：noul（是否成立，返回 0~1 概率）、choice（从给定选项里选一个，附每个选项的概率与 confidence）、score（按有序档位评分，附概率与 confidence）。",
    "适合用于分类、路由、打分、风险判断与结果校验；阈值、分支和后续动作由调用方代码决定。",
    "建议每次只问单一维度的问题，把多个维度拆成多个问题后在自己的代码里加权组合。"
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      state: {
        description: "待判定的内容。可以是文本字符串，也可以是结构化对象或数组（例如对话记录、工单、当前应用状态）。Jev 只依据 state 做判断，上下文越具体结论越稳定。"
      },
      model: {
        type: "string",
        description: `模型别名，默认 ${DEFAULT_MODEL}，也可以指定具体版本号。`
      },
      questions: {
        type: "object",
        description: "问题映射，键名会原样出现在返回的 answers 里。每个问题的形状为 { type, instructions, criteria? }。",
        additionalProperties: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: QUESTION_TYPES,
              description: "noul 为是非判断；choice 为从选项中选择；score 为按有序档位打分。"
            },
            instructions: {
              description: "要判断的问题本身。可以是字符串，也可以是包含待引用数据的对象/数组，并在问题文本里用反引号引用字段名。"
            },
            criteria: {
              description: "choice 必填：选项 -> 描述 的映射；score 必填：有序档位描述数组（2~10 级）；noul 可选：用 { true, false } 说明两端含义。"
            }
          },
          required: ["type", "instructions"],
          additionalProperties: true
        }
      }
    },
    required: ["state", "questions"],
    additionalProperties: false
  }
};

function textResult(text, isError = false) {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL_DEFINITION] }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const params = request?.params ?? {};
  const name = params.name;
  const args = params.arguments ?? {};
  if (name !== TOOL_NAME) {
    return textResult(`未知工具 ${name}，本服务只提供 ${TOOL_NAME}。`, true);
  }

  let apiKey;
  try {
    apiKey = resolveApiKey(process.env);
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
  if (!apiKey) return textResult(MISSING_KEY_MESSAGE, true);

  try {
    const response = await evaluate(
      { state: args.state, model: args.model, questions: args.questions },
      {
        apiKey,
        baseUrl: resolveBaseUrl(process.env),
        timeoutMs: resolveTimeoutMs(process.env)
      }
    );
    return textResult(JSON.stringify(response, null, 2));
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
});

await server.connect(new StdioServerTransport());
