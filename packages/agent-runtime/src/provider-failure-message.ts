import {
  ProviderRequestLimitError,
  ProviderStreamIncompleteError,
  readProviderRequestDiagnostics,
  stripProviderRequestDiagnostics,
  type ProviderRequestDiagnostics
} from "@provider-adapters";

/**
 * Localized, user-facing explanations for provider (upstream model service)
 * failures.
 *
 * The runtime previously fell back to
 * `任务暂时停止：运行时遇到了无法自动恢复的异常。原因：<raw provider error>` for
 * every provider fault that no retry branch claimed — which for a gateway
 * rejection meant a 300-character wall of English, a role sequence dump, an
 * empty `param=` and a log path. Users cannot act on that. This module turns
 * the recognizable provider faults into a short conclusion plus a concrete
 * action, and demotes the machine-readable detail to one labelled line.
 */
export type ProviderFailureKind =
  | "quota"
  | "auth"
  | "model_unavailable"
  | "context_length"
  | "request_too_large"
  | "content_filter"
  | "rate_limit"
  | "service_unavailable"
  | "network";

const QUOTA_PATTERN =
  /insufficient[_ ]?user[_ ]?quota|insufficient[_ ]?quota|insufficient[_ ]?balance|insufficient credit|credits? insufficient|exceeded your current quota|quota exceeded|out of credits|no credit|billing hard limit|balance=\d+\s+required=\d+|余额不足|额度不足|配额不足/i;
const AUTH_PATTERN =
  /invalid[_ ]api[_ ]key|incorrect api key|invalid[_ ]token|api key not valid|unauthorized|unauthenticated|authentication fails?|permission denied|no permission to|not authorized|forbidden/i;
const MODEL_UNAVAILABLE_PATTERN =
  /model[_ ]not[_ ]found|no such model|unknown model|unsupported model|model .{0,48}(?:does not exist|not exist|not supported|not available|not enabled)|模型不存在|模型不可用|未开通.{0,8}模型/i;
const CONTEXT_LENGTH_PATTERN =
  /context[_ ]length[_ ]exceeded|maximum context length|context window|too many tokens|reduce the length|prompt is too long|input is too long|exceed(?:s|ed) the (?:maximum )?(?:context|token|input) limit/i;
const REQUEST_TOO_LARGE_PATTERN =
  /payload too large|request entity too large|request (?:body )?too large|content length exceeded|exceeds the maximum allowed size|request size limit/i;
const CONTENT_FILTER_PATTERN =
  /content[_ ]?filter|content policy|safety (?:system|policy|filter)|flagged|blocked by .{0,24}(?:safety|moderation)|内容安全|风控/i;
const RATE_LIMIT_PATTERN = /rate[_ ]?limit|too many requests|请求过于频繁/i;
const SERVICE_UNAVAILABLE_PATTERN =
  /service[_ ]?unavailable|overloaded|temporarily unavailable|bad gateway|gateway time-?out|upstream (?:error|unavailable|failed)/i;
const NETWORK_PATTERN =
  /socket hang up|fetch failed|connection (?:error|refused|reset|timed? ?out)|network error|stream (?:disconnected?|terminated)|econnreset|econnrefused|etimedout|epipe|enotfound|eai_again/i;

const REQUEST_ID_PATTERN = /request id:\s*([^\s)]+)/i;
const QUOTA_SHORTFALL_PATTERN = /balance=(\d+)[\s,;]+required=(\d+)/i;

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function errorField(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  if (record.error && typeof record.error === "object") {
    const nested = (record.error as Record<string, unknown>)[key];
    if (nested !== undefined) return nested;
  }
  if (record.cause && typeof record.cause === "object") {
    return errorField(record.cause, key);
  }
  return undefined;
}

function readHttpStatus(error: unknown): number | undefined {
  const direct = Number(errorField(error, "status"));
  if (Number.isFinite(direct) && direct >= 100 && direct < 600) return direct;
  // The OpenAI SDK prefixes `APIError` messages with the numeric status.
  const match = /^\s*(\d{3})\b/.exec(errorMessageOf(error));
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return parsed >= 100 && parsed < 600 ? parsed : undefined;
}

function matches(text: string, pattern: RegExp): boolean {
  return text.length > 0 && pattern.test(text);
}

/**
 * Classifies a provider failure into the bucket that decides which localized
 * explanation the user sees. Returns null when the error is not a provider
 * fault (the caller keeps its existing message).
 */
export function classifyProviderFailure(error: unknown): ProviderFailureKind | null {
  if (error instanceof ProviderRequestLimitError) return "request_too_large";
  if (error instanceof ProviderStreamIncompleteError) {
    return error.reason === "content_filter" ? "content_filter" : null;
  }

  const text = stripProviderRequestDiagnostics(errorMessageOf(error));
  const status = readHttpStatus(error);

  // Quota first: a drained account is the single most common gateway rejection
  // and the only fix is on the provider side, so it must never be reported as
  // a generic runtime fault.
  if (status === 402 || matches(text, QUOTA_PATTERN)) return "quota";
  if (status === 401 || status === 403 || matches(text, AUTH_PATTERN)) return "auth";
  if (status === 429 || matches(text, RATE_LIMIT_PATTERN)) return "rate_limit";
  if (status === 413 || matches(text, REQUEST_TOO_LARGE_PATTERN)) return "request_too_large";
  if (status === 404 && /\bmodel\b/i.test(text)) return "model_unavailable";
  if (matches(text, MODEL_UNAVAILABLE_PATTERN)) return "model_unavailable";
  if (matches(text, CONTEXT_LENGTH_PATTERN)) return "context_length";
  if (matches(text, CONTENT_FILTER_PATTERN)) return "content_filter";
  if (status === 500 || status === 502 || status === 503 || status === 504) return "service_unavailable";
  if (matches(text, SERVICE_UNAVAILABLE_PATTERN)) return "service_unavailable";
  if (matches(text, NETWORK_PATTERN)) return "network";
  return null;
}

/**
 * The provider as a user should see it: the configured name, falling back to
 * the raw id only when the provider was never renamed. `provider-16` means
 * nothing to the person reading the error, so the id is a last resort.
 */
function providerLabel(details: ProviderRequestDiagnostics | null): string {
  return details?.providerName || details?.providerId || "";
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One trimmed sentence from the upstream response, so the user still sees what
 * the provider actually said without the request-shape tail.
 */
function summarizeUpstreamReason(error: unknown, maxLength = 160): string {
  const raw = stripProviderRequestDiagnostics(errorMessageOf(error)).replace(/\s+/g, " ").trim();
  const withoutStatus = raw.replace(/^\d{3}\s+/, "").replace(/\(request id:[^)]*\)/gi, "").trim();
  if (!withoutStatus) return "";
  return withoutStatus.length > maxLength
    ? `${withoutStatus.slice(0, maxLength - 1).trimEnd()}…`
    : withoutStatus;
}

function buildTechnicalDetailLines(error: unknown, details: ProviderRequestDiagnostics | null): string[] {
  const parts: string[] = [];
  const status = readHttpStatus(error);
  if (status !== undefined) parts.push(`HTTP ${status}`);
  if (details?.upstreamCode) parts.push(details.upstreamCode);
  if (details?.modelId) parts.push(`模型 ${details.modelId}`);
  // Name first, id kept in parentheses: the reader recognizes the name, support
  // still needs the stable id to correlate logs.
  const provider = providerLabel(details);
  if (provider) {
    parts.push(
      details?.providerName && details.providerName !== details.providerId && details.providerId
        ? `供应商 ${provider}（${details.providerId}）`
        : `供应商 ${provider}`
    );
  }
  const size = formatBytes(details?.requestBytes);
  if (size) {
    const shape = [
      details?.messageCount !== undefined ? `${details.messageCount} 条消息` : "",
      details?.toolCount !== undefined ? `${details.toolCount} 个工具` : ""
    ].filter(Boolean).join(" / ");
    parts.push(shape ? `${size} / ${shape}` : size);
  }
  const requestId = REQUEST_ID_PATTERN.exec(errorMessageOf(error))?.[1];
  if (requestId) parts.push(`request id ${requestId}`);

  const lines: string[] = [];
  if (parts.length > 0) lines.push(`技术细节：${parts.join(" · ")}`);
  if (details?.dumpPath) lines.push(`完整请求已保存：${details.dumpPath}`);
  return lines;
}

/**
 * Labelled, machine-readable context for a failure: provider status, upstream
 * error code, model/provider identity, request shape and the dumped payload
 * path. Empty when the error carries none of it, so callers can append the
 * lines unconditionally.
 */
export function buildProviderFailureDetailLines(error: unknown): string[] {
  return buildTechnicalDetailLines(error, readProviderRequestDiagnostics(error));
}

/**
 * Sanitizes a failure reason for display: drops the `[provider-request ...]`
 * tail, collapses whitespace and caps the length, so an unclassified error
 * cannot dump a wall of raw provider text into the chat.
 */
export function summarizeFailureDetail(error: unknown, maxLength = 300): string {
  const raw = stripProviderRequestDiagnostics(errorMessageOf(error)).replace(/\s+/g, " ").trim();
  if (!raw) return "未提供更多信息。";
  return raw.length > maxLength ? `${raw.slice(0, maxLength - 1).trimEnd()}…` : raw;
}

const RETAINED_NOTE = "已完成的工具结果和项目文件都会保留。";

function buildBody(error: unknown, kind: ProviderFailureKind): string[] {
  const details = readProviderRequestDiagnostics(error);
  const text = errorMessageOf(error);
  const upstream = summarizeUpstreamReason(error);

  switch (kind) {
    case "quota": {
      const shortfall = QUOTA_SHORTFALL_PATTERN.exec(text);
      const provider = providerLabel(details);
      const account = provider ? `供应商「${provider}」的账户` : "该供应商的账户";
      const reason = shortfall
        ? `原因：${account}剩余额度 ${shortfall[1]}，本次请求需要 ${shortfall[2]}。额度不足属于供应商侧的硬性拒绝，重试同一个请求不会成功。`
        : `原因：${account}额度不足${upstream ? `（上游返回：${upstream}）` : ""}。这类拒绝来自供应商侧，重试同一个请求不会成功。`;
      const advice = provider
        ? `建议：先给「${provider}」的账户充值，或在「设置 → 模型」里改用其它还有额度的供应商或模型。换好模型后直接发送「继续」即可接着跑，${RETAINED_NOTE}`
        : `建议：先给该供应商账户充值，或在「设置 → 模型」里改用其它还有额度的供应商或模型。换好模型后直接发送「继续」即可接着跑，${RETAINED_NOTE}`;
      return [
        "任务暂时停止：模型供应商账户额度不足，本次请求被拒绝。",
        "",
        reason,
        "",
        advice
      ];
    }
    case "auth": {
      return [
        "任务暂时停止：模型供应商拒绝了本次请求，API Key 无效或没有访问权限。",
        "",
        `原因：${upstream || "供应商返回鉴权失败。"}`,
        "",
        `建议：打开「设置 → 模型」检查该供应商的 API Key、服务地址和账号权限，确认后重试。${RETAINED_NOTE}`
      ];
    }
    case "model_unavailable": {
      return [
        "任务暂时停止：供应商找不到当前模型，或当前账号没有该模型的使用权限。",
        "",
        `原因：${upstream || "供应商返回模型不存在或不可用。"}`,
        "",
        `建议：在「设置 → 模型」里改用该供应商已开通的模型，模型名要与供应商文档完全一致。${RETAINED_NOTE}`
      ];
    }
    case "context_length": {
      return [
        "任务暂时停止：本次请求超过了模型可处理的上下文长度，供应商拒绝处理。",
        "",
        `原因：${upstream || "提示词与历史对话的总长度超出模型上限。"}`,
        "",
        `建议：新建一个会话继续，或把任务拆成更小的步骤；系统已尝试自动压缩历史但可能仍然超限。${RETAINED_NOTE}`
      ];
    }
    case "request_too_large": {
      const limit = error instanceof ProviderRequestLimitError
        ? `当前请求 ${formatBytes(error.requestBytes)}，配置上限 ${formatBytes(error.maxRequestBytes)}`
        : "";
      return [
        "任务暂时停止：本次请求体积超过了供应商允许的上限。",
        "",
        `原因：${limit || upstream || "请求体过大，压缩历史后仍然放不进去。"}`,
        "",
        `建议：拆小任务或减少一次性要处理的文件数量；也可以在该供应商设置里调大「单次请求字节上限」，或限制「工具数量上限」让系统提前精简请求。${RETAINED_NOTE}`
      ];
    }
    case "content_filter": {
      return [
        "任务暂时停止：请求或模型回复被供应商的内容安全策略拦截。",
        "",
        `原因：${upstream || "供应商判定内容触发了安全策略。"}`,
        "",
        `建议：调整措辞或拆分内容后重试；如果确认是正常业务内容，请更换供应商。${RETAINED_NOTE}`
      ];
    }
    case "rate_limit": {
      return [
        "任务暂时停止：模型供应商限流，本次请求被拒绝。",
        "",
        `原因：${upstream || "短时间内请求过多。"}`,
        "",
        `建议：稍等片刻再试，或切换到配额更充足的供应商 / 模型。${RETAINED_NOTE}`
      ];
    }
    case "service_unavailable": {
      return [
        "任务暂时停止：模型供应商服务暂时不可用。",
        "",
        `原因：${upstream || "上游服务返回了服务端错误。"}`,
        "",
        `建议：稍后重试，或切换到其它供应商 / 模型。${RETAINED_NOTE}`
      ];
    }
    case "network": {
      return [
        "任务暂时停止：连接模型供应商失败，网络不可达或连接被中断。",
        "",
        `原因：${upstream || "请求未能送达供应商。"}`,
        "",
        `建议：检查本机网络、代理设置和服务地址是否可用，确认后重试。${RETAINED_NOTE}`
      ];
    }
  }
}

/**
 * Builds the localized, user-facing explanation for a provider failure, or
 * null when the error is not a recognizable provider fault.
 */
export function buildProviderFailureMessage(error: unknown): string | null {
  const kind = classifyProviderFailure(error);
  if (!kind) return null;
  const details = readProviderRequestDiagnostics(error);
  const detailLines = buildTechnicalDetailLines(error, details);
  const body = buildBody(error, kind);
  return (detailLines.length > 0 ? [...body, "", ...detailLines] : body).join("\n");
}
