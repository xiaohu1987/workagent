export const API_CARD_CONFIG_MAX_BYTES = 64 * 1024;
export const API_CARD_RESPONSE_PREVIEW_CHARS = 50_000;

const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const API_CARD_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;
const BARE_TEMPLATE_TOKEN_PATTERN = /(?<!["\\])\{\{\s*[A-Za-z_][A-Za-z0-9_-]*\s*\}\}(?!")/g;

export type ApiCardFieldType =
  | "text"
  | "textarea"
  | "number"
  | "password"
  | "select"
  | "radio"
  | "checkbox"
  | "switch"
  | "date"
  | "time"
  | "keyvalue"
  | "json";

const API_CARD_FIELD_TYPES = new Set<ApiCardFieldType>([
  "text",
  "textarea",
  "number",
  "password",
  "select",
  "radio",
  "checkbox",
  "switch",
  "date",
  "time",
  "keyvalue",
  "json"
]);

export interface ApiCardFieldOption {
  label: string;
  value: string;
}

export interface ApiCardField {
  name: string;
  label: string;
  type: ApiCardFieldType;
  required?: boolean;
  defaultValue?: unknown;
  placeholder?: string;
  help?: string;
  options?: ApiCardFieldOption[];
}

export interface ApiCardAuth {
  type: "bearer" | "apiKey" | "basic";
  in?: "header" | "query";
  name?: string;
  label?: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export interface ApiCardConfig {
  title: string;
  description?: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  auth?: ApiCardAuth;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  bodyTemplate?: string;
  fields: ApiCardField[];
}

export type ParsedApiCardConfig =
  | { ok: true; config: ApiCardConfig }
  | { ok: false; error: string };

export interface KeyValuePairValue {
  key: string;
  value: string;
}

export type ApiCardFieldValue = string | string[] | boolean | KeyValuePairValue[];
export type ApiCardValues = Record<string, ApiCardFieldValue | undefined>;

export interface ApiRequestSpec {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type BuildApiRequestResult =
  | { ok: true; request: ApiRequestSpec }
  | { ok: false; error?: string; fieldErrors: Record<string, string> };

function findForbiddenKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CONFIG_KEYS.has(key)) return key;
    const found = findForbiddenKey(nested);
    if (found) return found;
  }
  return null;
}

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) => typeof key === "string" && typeof item === "string"
  );
}

function normalizeField(candidate: unknown, index: number): ApiCardField | string {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return `第 ${index + 1} 个字段必须是对象。`;
  }
  const raw = candidate as Record<string, unknown>;
  if (typeof raw.name !== "string" || !FIELD_NAME_PATTERN.test(raw.name)) {
    return `第 ${index + 1} 个字段的 name 缺失或格式非法(需以字母/下划线开头,仅含字母数字与 _-)。`;
  }
  if (typeof raw.type !== "string" || !API_CARD_FIELD_TYPES.has(raw.type as ApiCardFieldType)) {
    return `字段 ${raw.name} 的 type 非法:${String(raw.type)}。`;
  }
  const type = raw.type as ApiCardFieldType;
  const field: ApiCardField = {
    name: raw.name,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label : raw.name,
    type
  };
  if (raw.required !== undefined) field.required = raw.required === true;
  if (raw.defaultValue !== undefined) field.defaultValue = raw.defaultValue;
  if (typeof raw.placeholder === "string") field.placeholder = raw.placeholder;
  if (typeof raw.help === "string") field.help = raw.help;
  if (type === "select" || type === "radio" || type === "checkbox") {
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      return `字段 ${raw.name}(${type})需要提供非空 options。`;
    }
    const options: ApiCardFieldOption[] = [];
    for (const option of raw.options) {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return `字段 ${raw.name} 的选项必须是 { label, value } 对象。`;
      }
      const rawOption = option as Record<string, unknown>;
      if (typeof rawOption.value !== "string" || typeof rawOption.label !== "string") {
        return `字段 ${raw.name} 的选项缺少 label 或 value。`;
      }
      options.push({ label: rawOption.label, value: rawOption.value });
    }
    field.options = options;
  }
  return field;
}

function normalizeAuth(candidate: unknown): ApiCardAuth | string | null {
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    return "auth 必须是对象。";
  }
  const raw = candidate as Record<string, unknown>;
  if (raw.type !== "bearer" && raw.type !== "apiKey" && raw.type !== "basic") {
    return `auth.type 非法:${String(raw.type)}(仅支持 bearer / apiKey / basic)。`;
  }
  const auth: ApiCardAuth = { type: raw.type };
  if (raw.in !== undefined) {
    if (raw.in !== "header" && raw.in !== "query") return "auth.in 仅支持 header 或 query。";
    auth.in = raw.in;
  }
  if (typeof raw.name === "string" && raw.name.trim()) auth.name = raw.name.trim();
  if (typeof raw.label === "string") auth.label = raw.label;
  if (typeof raw.placeholder === "string") auth.placeholder = raw.placeholder;
  if (typeof raw.help === "string") auth.help = raw.help;
  if (raw.required !== undefined) auth.required = raw.required === true;
  return auth;
}

function repairBareTemplateTokens(content: string): string {
  return content.replace(BARE_TEMPLATE_TOKEN_PATTERN, (token) => `"${token}"`);
}

export function parseApiCardConfig(content: string): ParsedApiCardConfig {
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > API_CARD_CONFIG_MAX_BYTES) {
    return { ok: false, error: "卡片配置超过 64 KB 限制。" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 模型常把 bodyTemplate 写成对象字面量并裸写 {{field}} 占位符,补引号修复后重试一次
    try {
      parsed = JSON.parse(repairBareTemplateTokens(content));
    } catch (error) {
      return { ok: false, error: `JSON 格式无效:${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "卡片配置必须是 JSON 对象。" };
  }

  const forbiddenKey = findForbiddenKey(parsed);
  if (forbiddenKey) return { ok: false, error: `卡片配置包含不允许的键:${forbiddenKey}。` };

  const raw = parsed as Record<string, unknown>;
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    return { ok: false, error: "卡片配置缺少 title。" };
  }
  if (typeof raw.method !== "string" || !API_CARD_METHODS.has(raw.method.toUpperCase())) {
    return { ok: false, error: `method 非法:${String(raw.method)}(仅支持 GET/POST/PUT/PATCH/DELETE)。` };
  }
  if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) {
    return { ok: false, error: "url 必须是以 http:// 或 https:// 开头的字符串。" };
  }
  if (!Array.isArray(raw.fields)) {
    return { ok: false, error: "卡片配置缺少 fields 数组。" };
  }

  const fields: ApiCardField[] = [];
  const seenNames = new Set<string>();
  for (let index = 0; index < raw.fields.length; index += 1) {
    const field = normalizeField(raw.fields[index], index);
    if (typeof field === "string") return { ok: false, error: field };
    if (seenNames.has(field.name)) return { ok: false, error: `字段 name 重复:${field.name}。` };
    seenNames.add(field.name);
    fields.push(field);
  }

  const auth = normalizeAuth(raw.auth);
  if (typeof auth === "string") return { ok: false, error: auth };

  if (raw.headers !== undefined && !isPlainStringRecord(raw.headers)) {
    return { ok: false, error: "headers 必须是字符串键值对对象。" };
  }
  if (raw.query !== undefined && !isPlainStringRecord(raw.query)) {
    return { ok: false, error: "query 必须是字符串键值对对象。" };
  }
  if (
    raw.bodyTemplate !== undefined &&
    typeof raw.bodyTemplate !== "string" &&
    (typeof raw.bodyTemplate !== "object" || raw.bodyTemplate === null)
  ) {
    return { ok: false, error: "bodyTemplate 必须是字符串或 JSON 对象。" };
  }

  const config: ApiCardConfig = {
    title: raw.title.trim(),
    method: raw.method.toUpperCase() as ApiCardConfig["method"],
    url: raw.url,
    fields
  };
  if (typeof raw.description === "string" && raw.description.trim()) config.description = raw.description;
  if (auth) config.auth = auth;
  if (raw.headers) config.headers = raw.headers as Record<string, string>;
  if (raw.query) config.query = raw.query as Record<string, string>;
  if (typeof raw.bodyTemplate === "string") {
    config.bodyTemplate = raw.bodyTemplate;
  } else if (raw.bodyTemplate && typeof raw.bodyTemplate === "object") {
    // 宽容处理:模型把 body 写成对象/数组时序列化为模板字符串,值中的 "{{field}}" 占位符照常参与替换
    config.bodyTemplate = JSON.stringify(raw.bodyTemplate);
  }
  return { ok: true, config };
}

export function createInitialValues(config: ApiCardConfig): ApiCardValues {
  const values: ApiCardValues = {};
  for (const field of config.fields) {
    const fallback = field.defaultValue;
    switch (field.type) {
      case "switch":
        values[field.name] = typeof fallback === "boolean" ? fallback : fallback === "true";
        break;
      case "checkbox":
        values[field.name] = Array.isArray(fallback) ? fallback.filter((item) => typeof item === "string") : [];
        break;
      case "keyvalue":
        values[field.name] = Array.isArray(fallback)
          ? fallback
              .filter((item) => item && typeof item === "object" && !Array.isArray(item))
              .map((item) => ({
                key: String((item as Record<string, unknown>).key ?? ""),
                value: String((item as Record<string, unknown>).value ?? "")
              }))
          : [];
        break;
      default:
        values[field.name] = typeof fallback === "string" ? fallback : fallback === undefined || fallback === null ? "" : String(fallback);
        break;
    }
  }
  return values;
}

function isEmptyValue(field: ApiCardField, value: ApiCardFieldValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "boolean") return false;
  if (Array.isArray(value)) {
    if (field.type === "keyvalue") {
      return (value as KeyValuePairValue[]).every((pair) => !pair.key.trim() && !pair.value.trim());
    }
    return value.length === 0;
  }
  return false;
}

function escapeJsonString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function keyValuePairsToObject(pairs: KeyValuePairValue[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    result[key] = pair.value;
  }
  return result;
}

function scalarString(field: ApiCardField, value: ApiCardFieldValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (field.type === "keyvalue") return JSON.stringify(keyValuePairsToObject(value as KeyValuePairValue[]));
    return (value as string[]).join(",");
  }
  return String(value);
}

function bodyFragment(field: ApiCardField, value: ApiCardFieldValue | undefined): string {
  switch (field.type) {
    case "number": {
      const text = scalarString(field, value).trim();
      return text === "" ? "null" : text;
    }
    case "switch":
      return value === true ? "true" : "false";
    case "checkbox": {
      const items = Array.isArray(value) ? (value as string[]) : [];
      return JSON.stringify(items);
    }
    case "keyvalue": {
      const pairs = Array.isArray(value) ? (value as KeyValuePairValue[]) : [];
      return JSON.stringify(keyValuePairsToObject(pairs));
    }
    case "json": {
      const text = scalarString(field, value).trim();
      return text === "" ? "null" : text;
    }
    default:
      return escapeJsonString(scalarString(field, value));
  }
}

export type TemplateMode = "url" | "raw" | "json";

export function substituteTemplate(
  template: string,
  fields: ApiCardField[],
  values: ApiCardValues,
  mode: TemplateMode
): string {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return template.replace(TEMPLATE_TOKEN_PATTERN, (token, name: string) => {
    const field = fieldByName.get(name);
    if (!field) return token;
    const value = values[name];
    switch (mode) {
      case "url":
        return encodeURIComponent(scalarString(field, value));
      case "json":
        return bodyFragment(field, value);
      default:
        return scalarString(field, value);
    }
  });
}

export function listTemplateFieldNames(template: string | undefined): string[] {
  if (!template) return [];
  const names = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    names.add(match[1]);
  }
  return [...names];
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildApiRequest(
  config: ApiCardConfig,
  values: ApiCardValues,
  authToken: string
): BuildApiRequestResult {
  const fieldErrors: Record<string, string> = {};
  for (const field of config.fields) {
    const value = values[field.name];
    if (field.required && isEmptyValue(field, value)) {
      fieldErrors[field.name] = `请填写${field.label}。`;
      continue;
    }
    if (field.type === "number" && !isEmptyValue(field, value)) {
      const text = scalarString(field, value).trim();
      if (text !== "" && Number.isNaN(Number(text))) {
        fieldErrors[field.name] = `${field.label}必须是数字。`;
      }
    }
    if (field.type === "json" && !isEmptyValue(field, value)) {
      try {
        JSON.parse(scalarString(field, value));
      } catch (error) {
        fieldErrors[field.name] = `${field.label}不是合法 JSON:${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  if (config.auth?.required && authToken.trim() === "") {
    fieldErrors.__auth = "请填写授权 Token。";
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const unknownTokens = [config.url, config.bodyTemplate, ...Object.values(config.headers ?? {}), ...Object.values(config.query ?? {})]
    .flatMap((template) => listTemplateFieldNames(template))
    .filter((name) => !config.fields.some((field) => field.name === name));
  if (unknownTokens.length > 0) {
    return { ok: false, error: `模板引用了未定义的字段:${[...new Set(unknownTokens)].join(", ")}。`, fieldErrors: {} };
  }

  const headers: Record<string, string> = {};
  for (const [key, template] of Object.entries(config.headers ?? {})) {
    headers[key] = substituteTemplate(template, config.fields, values, "raw");
  }

  const trimmedToken = authToken.trim();
  if (config.auth && trimmedToken) {
    switch (config.auth.type) {
      case "bearer":
        headers[config.auth.name?.trim() || "Authorization"] = `Bearer ${trimmedToken}`;
        break;
      case "basic":
        headers[config.auth.name?.trim() || "Authorization"] = `Basic ${encodeBase64(trimmedToken)}`;
        break;
      case "apiKey":
        if ((config.auth.in ?? "header") === "header") {
          headers[config.auth.name?.trim() || "X-API-Key"] = trimmedToken;
        }
        break;
    }
  }

  let url = substituteTemplate(config.url, config.fields, values, "url");
  const queryPairs: Array<[string, string]> = [];
  for (const [key, template] of Object.entries(config.query ?? {})) {
    queryPairs.push([key, substituteTemplate(template, config.fields, values, "url")]);
  }
  if (config.auth?.type === "apiKey" && (config.auth.in ?? "header") === "query" && trimmedToken) {
    queryPairs.push([config.auth.name?.trim() || "api_key", encodeURIComponent(trimmedToken)]);
  }
  if (queryPairs.length > 0) {
    const queryString = queryPairs
      .map(([key, value]) => `${encodeURIComponent(key)}=${value}`)
      .join("&");
    url = `${url}${url.includes("?") ? "&" : "?"}${queryString}`;
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return { ok: false, error: "替换后的 url 仅支持 http/https 协议。", fieldErrors: {} };
    }
  } catch {
    return { ok: false, error: "替换后的 url 无法解析,请检查路径参数取值。", fieldErrors: {} };
  }

  let body: string | undefined;
  if (config.bodyTemplate !== undefined && config.method !== "GET" && config.method !== "DELETE") {
    const substituted = substituteTemplate(config.bodyTemplate, config.fields, values, "json");
    try {
      body = JSON.stringify(JSON.parse(substituted));
    } catch (error) {
      return {
        ok: false,
        error: `bodyTemplate 替换后不是合法 JSON:${error instanceof Error ? error.message : String(error)}`,
        fieldErrors: {}
      };
    }
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }

  return { ok: true, request: { method: config.method, url, headers, body } };
}

export interface FormattedApiResponse {
  pretty: string;
  isJson: boolean;
  truncated: boolean;
}

export function formatApiResponseBody(bodyText: string): FormattedApiResponse {
  let pretty = bodyText;
  let isJson = false;
  const trimmed = bodyText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
      isJson = true;
    } catch {
      pretty = bodyText;
    }
  }
  let truncated = false;
  if (pretty.length > API_CARD_RESPONSE_PREVIEW_CHARS) {
    pretty = `${pretty.slice(0, API_CARD_RESPONSE_PREVIEW_CHARS)}\n…(内容过长已截断)`;
    truncated = true;
  }
  return { pretty, isJson, truncated };
}
