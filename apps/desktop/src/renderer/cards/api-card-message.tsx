import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  buildApiRequest,
  createInitialValues,
  formatApiResponseBody,
  parseApiCardConfig,
  resolveApiCardDownloadFileName,
  type ApiCardConfig,
  type ApiCardField,
  type ApiCardValues,
  type FormattedApiResponse,
  type KeyValuePairValue
} from "./api-card";
import {
  CheckboxGroup,
  DateInput,
  JsonEditor,
  KeyValueEditor,
  NumberInput,
  PasswordInput,
  RadioGroup,
  SelectInput,
  Switch,
  TextArea,
  TextInput,
  TimeInput
} from "../form-controls";
import {
  addApiCardFavorite,
  removeApiCardFavoriteByConfig,
  useIsApiCardFavorited
} from "../api-card-favorites";
import "./api-card-message.css";

type ApiCardResult = {
  status: number;
  statusText: string;
  durationMs: number;
  truncated: boolean;
  headers: Record<string, string>;
  rawBody: string;
  formatted: FormattedApiResponse;
  download?: {
    fileName: string;
    filePath: string;
    mimeType: string;
    sizeBytes: number;
  };
};

export const ApiCardThreadContext = createContext<string | null>(null);

function methodBadgeClass(method: ApiCardConfig["method"]): string {
  return `api-card-method is-${method.toLowerCase()}`;
}

function statusBadgeClass(status: number): string {
  if (status >= 200 && status < 300) return "api-card-status is-success";
  if (status >= 400 && status < 500) return "api-card-status is-client-error";
  if (status >= 500) return "api-card-status is-server-error";
  return "api-card-status";
}

function authHelpText(config: ApiCardConfig): string {
  const auth = config.auth;
  if (!auth) return "";
  if (auth.help) return auth.help;
  switch (auth.type) {
    case "bearer":
      return "将以 Authorization: Bearer <token> 形式注入请求头。";
    case "basic":
      return "将以 Authorization: Basic base64(token) 形式注入请求头,token 请按 用户名:密码 格式填写。";
    case "apiKey":
      return (auth.in ?? "header") === "query"
        ? `将以 query 参数 ${auth.name?.trim() || "api_key"} 注入。`
        : `将以请求头 ${auth.name?.trim() || "X-API-Key"} 注入。`;
  }
}

function ApiCardFieldControl(props: {
  field: ApiCardField;
  values: ApiCardValues;
  error: string | null;
  disabled: boolean;
  onValueChange: (name: string, value: ApiCardValues[string]) => void;
}) {
  const { field, values, error, disabled, onValueChange } = props;
  const common = {
    label: field.label,
    required: field.required,
    error,
    help: field.help,
    disabled
  };
  switch (field.type) {
    case "textarea":
      return (
        <TextArea
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          placeholder={field.placeholder}
          rows={4}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    case "number":
      return (
        <NumberInput
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          placeholder={field.placeholder}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    case "password":
      return (
        <PasswordInput
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          placeholder={field.placeholder}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    case "select":
      return (
        <SelectInput
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          options={field.options ?? []}
          placeholder={field.placeholder ?? "请选择"}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    case "radio":
      return (
        <RadioGroup
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          options={field.options ?? []}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    case "checkbox":
      return (
        <CheckboxGroup
          {...common}
          values={Array.isArray(values[field.name]) ? (values[field.name] as string[]) : []}
          options={field.options ?? []}
          onChange={(next) => onValueChange(field.name, next)}
        />
      );
    case "switch":
      return (
        <Switch
          {...common}
          checked={values[field.name] === true}
          onChange={(checked) => onValueChange(field.name, checked)}
        />
      );
    case "date":
      return (
        <DateInput
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    case "time":
      return (
        <TimeInput
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    case "keyvalue":
      return (
        <KeyValueEditor
          {...common}
          pairs={Array.isArray(values[field.name]) ? (values[field.name] as KeyValuePairValue[]) : []}
          onChange={(pairs) => onValueChange(field.name, pairs)}
        />
      );
    case "json":
      return (
        <JsonEditor
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          placeholder={field.placeholder ?? '{ "key": "value" }'}
          rows={6}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
    default:
      return (
        <TextInput
          {...common}
          value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
          placeholder={field.placeholder}
          onChange={(value) => onValueChange(field.name, value)}
        />
      );
  }
}

export function ApiCardMessage({
  configText,
  initialCollapsed = false,
  onCollapsedChange
}: {
  configText: string;
  initialCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const threadId = useContext(ApiCardThreadContext);
  const parsed = useMemo(() => parseApiCardConfig(configText), [configText]);
  const config = parsed.ok ? parsed.config : null;

  const [values, setValues] = useState<ApiCardValues>(() => (config ? createInitialValues(config) : {}));
  const [authToken, setAuthToken] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiCardResult | null>(null);
  const [url, setUrl] = useState(config?.url ?? "");
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const favorited = useIsApiCardFavorited(config);

  useEffect(() => {
    if (!config) return;
    setValues(createInitialValues(config));
    setUrl(config.url);
    setAuthToken("");
    setFieldErrors({});
    setGlobalError(null);
    setResult(null);
  }, [config]);

  useEffect(() => {
    setCollapsed(initialCollapsed);
  }, [initialCollapsed]);

  if (!config) {
    return (
      <div className="api-card-error" role="alert">
        <div className="api-card-error-header">
          <strong>API 卡片配置无效</strong>
          <span>{parsed.ok ? "未知错误。" : parsed.error}</span>
        </div>
        <details>
          <summary>查看原始配置</summary>
          <pre>{configText}</pre>
        </details>
      </div>
    );
  }

  const handleValueChange = (name: string, value: ApiCardValues[string]) => {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const handleReset = () => {
    if (loading) return;
    setValues(createInitialValues(config));
    setUrl(config.url);
    setFieldErrors({});
    setGlobalError(null);
    setResult(null);
  };

  const handleSubmit = async () => {
    if (loading) return;
    setGlobalError(null);
    if (!threadId) {
      setGlobalError("无法确定当前任务，不能保存接口返回文件。");
      return;
    }
    const built = buildApiRequest({ ...config, url }, values, authToken);
    if (!built.ok) {
      setFieldErrors(built.fieldErrors);
      setGlobalError(built.error ?? null);
      return;
    }
    setFieldErrors({});
    setLoading(true);
    try {
      const response = await window.codexh.requestHttp({
        threadId,
        ...built.request,
        downloadFileName: resolveApiCardDownloadFileName(config, values)
      });
      if (!response.ok) {
        setResult(null);
        setGlobalError(response.error);
        return;
      }
      setResult({
        status: response.status,
        statusText: response.statusText,
        durationMs: response.durationMs,
        truncated: response.truncated,
        headers: response.headers,
        rawBody: response.bodyText,
        formatted: formatApiResponseBody(response.bodyText),
        download: response.download
      });
    } catch (error) {
      setResult(null);
      setGlobalError(`调用失败:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`api-card${collapsed ? " is-collapsed" : ""}`}>
      <div className="api-card-header">
        <span className="api-card-title" title={config.title}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3z" />
          </svg>
          {config.title}
        </span>
        <span className={methodBadgeClass(config.method)}>{config.method}</span>
        <button
          type="button"
          className={`api-card-favorite${favorited ? " is-active" : ""}`}
          title={favorited ? "取消收藏" : "收藏此卡片,下次从输入框 + 菜单快速唤出"}
          aria-label={favorited ? "取消收藏" : "收藏卡片"}
          aria-pressed={favorited}
          onClick={() => {
            if (favorited) {
              removeApiCardFavoriteByConfig(config);
            } else {
              addApiCardFavorite(config);
            }
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
          </svg>
        </button>
        <button
          type="button"
          className="api-card-collapse"
          aria-label={collapsed ? "展开卡片" : "折叠卡片"}
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed((current) => {
              const next = !current;
              onCollapsedChange?.(next);
              return next;
            });
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      {collapsed ? null : (
        <div className="api-card-body">
          {config.description ? <p className="api-card-description">{config.description}</p> : null}
          <div className="api-card-url-control">
            <TextInput
              label="请求地址"
              value={url}
              placeholder="https://api.example.com/path"
              disabled={loading}
              onChange={(value) => {
                setUrl(value);
                setGlobalError(null);
              }}
            />
          </div>
          {config.auth ? (
            <div className="api-card-auth">
              <div className="api-card-auth-title">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="5" y="10" width="14" height="10" rx="2" />
                  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                </svg>
                <span>授权</span>
              </div>
              <PasswordInput
                label={config.auth.label ?? "授权 Token"}
                required={config.auth.required}
                error={fieldErrors.__auth ?? null}
                help={authHelpText(config)}
                value={authToken}
                placeholder={config.auth.placeholder ?? "输入 token,仅保留在本次会话中"}
                disabled={loading}
                onChange={(value) => {
                  setAuthToken(value);
                  setFieldErrors((current) => {
                    if (!current.__auth) return current;
                    const next = { ...current };
                    delete next.__auth;
                    return next;
                  });
                }}
              />
            </div>
          ) : null}
          <div className="api-card-fields">
            {config.fields.map((field) => (
              <ApiCardFieldControl
                key={field.name}
                field={field}
                values={values}
                error={fieldErrors[field.name] ?? null}
                disabled={loading}
                onValueChange={handleValueChange}
              />
            ))}
          </div>
          <div className="api-card-actions">
            <button type="button" className="api-card-button is-ghost" disabled={loading} onClick={handleReset}>
              重置
            </button>
            <button
              type="button"
              className="api-card-button is-primary"
              disabled={loading}
              onClick={() => {
                void handleSubmit();
              }}
            >
              {loading ? <span className="api-card-spinner" aria-hidden="true" /> : null}
              {loading ? "请求中…" : "确定"}
            </button>
          </div>
          {globalError ? (
            <div className="api-card-call-error" role="alert">
              {globalError}
            </div>
          ) : null}
          {result ? (
            <div className="api-card-result">
              <div className="api-card-result-meta">
                <span className={statusBadgeClass(result.status)}>
                  {result.status}
                  {result.statusText ? ` ${result.statusText}` : ""}
                </span>
                <span className="api-card-result-duration">{result.durationMs} ms</span>
                {result.truncated ? <span className="api-card-result-truncated">响应过大已截断</span> : null}
              </div>
              {result.download ? (
                <pre className="api-card-result-body is-plain">{result.download.filePath}</pre>
              ) : result.formatted.pretty ? (
                <pre className={`api-card-result-body${result.formatted.isJson ? "" : " is-plain"}`}>
                  {result.formatted.pretty}
                </pre>
              ) : (
                <div className="api-card-result-empty">(响应体为空)</div>
              )}
              {!result.download ? (
                <details className="api-card-result-details">
                  <summary>查看原始内容</summary>
                  <pre>{result.rawBody || "(空)"}</pre>
                </details>
              ) : null}
              {!result.download ? (
                <details className="api-card-result-details">
                  <summary>响应头</summary>
                  <pre>{JSON.stringify(result.headers, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
