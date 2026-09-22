/**
 * TypeSafe System One（Jev）请求/响应管线。
 *
 * 这里只做三件事：校验入参、按官方接口组装请求体、把上游响应或错误原样交给调用方。
 * 不改字段名、不翻译答案、不决定重试 —— 阈值、路由和补偿策略属于调用方的业务代码。
 *
 * 接口契约来自 https://docs.typesafe.ai/api ：
 *   POST https://api.typesafe.ai/v1/systemone
 *   { state, model, questions } -> { model, answers, usage }
 */

import { readFileSync } from "node:fs";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const QUESTION_TYPES = ["noul", "choice", "score"];
export const API_KEY_ENV_VARS = ["TYPESAFE_API_KEY", "JEV_API_KEY"];
export const API_KEY_FILE_ENV_VAR = "TYPESAFE_API_KEY_FILE";
export const BASE_URL_ENV_VAR = "TYPESAFE_BASE_URL";
export const TIMEOUT_ENV_VAR = "TYPESAFE_TIMEOUT_MS";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function snippet(value, limit = 400) {
  const collapsed = String(value ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

export function resolveBaseUrl(env = process.env) {
  return (text(env[BASE_URL_ENV_VAR]) || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function resolveTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(text(env[TIMEOUT_ENV_VAR]), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * 解析 API Key。顺序：TYPESAFE_API_KEY -> JEV_API_KEY -> TYPESAFE_API_KEY_FILE 指向的文件内容。
 * 找不到时返回 null（由调用方给出可操作的配置提示），读取文件失败则直接抛错。
 */
export function resolveApiKey(env = process.env, readKeyFile = (path) => readFileSync(path, "utf8")) {
  for (const name of API_KEY_ENV_VARS) {
    const value = text(env[name]);
    if (value) return value;
  }
  const keyFile = text(env[API_KEY_FILE_ENV_VAR]);
  if (!keyFile) return null;
  try {
    return text(readKeyFile(keyFile)) || null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 ${API_KEY_FILE_ENV_VAR} 指向的密钥文件 ${keyFile}：${reason}`);
  }
}

function validateQuestion(id, question) {
  if (!question || typeof question !== "object" || Array.isArray(question)) {
    throw new Error(`问题 ${id} 必须是对象，例如 { "type": "noul", "instructions": "..." }。`);
  }
  if (!QUESTION_TYPES.includes(question.type)) {
    throw new Error(`问题 ${id} 的 type 必须是 ${QUESTION_TYPES.join(" / ")} 之一，当前为 ${JSON.stringify(question.type)}。`);
  }
  if (question.instructions === undefined || question.instructions === null) {
    throw new Error(`问题 ${id} 缺少 instructions：Jev 需要一个明确、单一维度的判断问题。`);
  }
  if (question.type === "choice" && (!question.criteria || typeof question.criteria !== "object" || Array.isArray(question.criteria))) {
    throw new Error(`choice 问题 ${id} 需要 criteria，即「选项 -> 描述」的映射。`);
  }
  if (question.type === "score" && !Array.isArray(question.criteria)) {
    throw new Error(`score 问题 ${id} 需要 criteria，即有序档位数组（至少两级，最多十级）。`);
  }
}

export function buildRequestBody(input = {}) {
  const { state, model, questions } = input ?? {};
  if (state === undefined || state === null || (typeof state === "string" && state.trim() === "")) {
    throw new Error("state 必填：把待判定的文本或结构化上下文放进 state，Jev 只依据它做判断。");
  }
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw new Error("questions 必填：形如 { 问题 id: { type, instructions, criteria? } } 的映射。");
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error("questions 至少需要一个条目。");
  for (const id of ids) validateQuestion(id, questions[id]);
  return { state, model: text(model) || DEFAULT_MODEL, questions };
}

export function describeHttpError(status, bodyText) {
  const detail = snippet(bodyText);
  const suffix = detail ? `：${detail}` : "";
  if (status === 401 || status === 403) {
    return `TypeSafe 拒绝了凭证（HTTP ${status}）${suffix}。请确认 MCP 配置里的 TYPESAFE_API_KEY 是有效密钥。`;
  }
  if (status === 429) {
    return `TypeSafe 返回限流（HTTP 429）${suffix}。降低调用频率后重试。`;
  }
  if (status === 400 || status === 422) {
    return `TypeSafe 判定请求不合法（HTTP ${status}）${suffix}。检查各问题的 type 与 criteria 是否符合接口要求。`;
  }
  if (status >= 500) {
    return `TypeSafe 服务端错误（HTTP ${status}）${suffix}。稍后重试。`;
  }
  return `TypeSafe 请求失败（HTTP ${status}）${suffix}`;
}

/**
 * 调用一次 Jev。返回上游响应对象本身，字段与官方文档一致（model / answers / usage）。
 * 失败时抛出带可操作提示的 Error，由 MCP 层转成 isError 结果。
 */
export async function evaluate(input = {}, options = {}) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch
  } = options;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境没有可用的 fetch，需要 Node 18 及以上版本。");
  }
  const body = buildRequestBody(input);
  const url = `${String(baseUrl).replace(/\/+$/, "")}/v1/systemone`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const name = error && typeof error === "object" ? error.name : "";
    const reason = name === "TimeoutError" || name === "AbortError"
      ? `调用 Jev 超时（${timeoutMs}ms）`
      : `无法连接 ${url}`;
    throw new Error(`${reason}：${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(describeHttpError(response.status, raw));
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Jev 返回的内容不是合法 JSON（HTTP ${response.status}）：${snippet(raw)}`);
  }
}
