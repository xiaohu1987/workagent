import type { McpServerConfig } from "@shared-types";
import { IconClose } from "../icons";

type McpCreateMode = "form" | "json";

type McpCreateSheetProps = {
  motionPhase?: string;
  draft: McpServerConfig;
  mode: McpCreateMode;
  jsonDraft: string;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  onModeChange: (mode: McpCreateMode) => void;
  onDraftChange: (draft: McpServerConfig) => void;
  onJsonDraftChange: (value: string) => void;
  onClearError: () => void;
};

const TRANSPORT_OPTIONS: Array<[NonNullable<McpServerConfig["transport"]>, string, string]> = [
  ["stdio", "stdio", "本地进程"],
  ["sse", "SSE", "事件流"],
  ["streamable_http", "HTTP", "流式 HTTP"]
];

function parseEnvironment(value: string): Record<string, string> {
  return value.split("\n").reduce<Record<string, string>>((environment, line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) return environment;
    const key = line.slice(0, separator).trim();
    const entry = line.slice(separator + 1).trim();
    if (key) environment[key] = entry;
    return environment;
  }, {});
}

export function McpCreateSheet({
  motionPhase,
  draft,
  mode,
  jsonDraft,
  error,
  onClose,
  onConfirm,
  onModeChange,
  onDraftChange,
  onJsonDraftChange,
  onClearError
}: McpCreateSheetProps) {
  const updateDraft = (patch: Partial<McpServerConfig>) => onDraftChange({ ...draft, ...patch });

  return (
    <div className="project-sheet-overlay mcp-create-overlay motion-overlay" data-motion={motionPhase}>
      <div className="project-sheet mcp-create-sheet" role="dialog" aria-modal="true" aria-labelledby="mcp-create-title">
        <div className="project-sheet-header">
          <div className="project-sheet-copy">
            <strong id="mcp-create-title">新增 MCP 服务</strong>
            <span>选择填写方式，加入后在管理页统一保存。</span>
          </div>
          <button className="project-sheet-close" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <div className="mcp-create-mode" role="tablist" aria-label="MCP 配置方式">
          <button type="button" role="tab" aria-selected={mode === "form"} className={mode === "form" ? "active" : ""} onClick={() => onModeChange("form")}>控件填写</button>
          <button type="button" role="tab" aria-selected={mode === "json"} className={mode === "json" ? "active" : ""} onClick={() => onModeChange("json")}>JSON 配置</button>
        </div>

        <div className="mcp-create-body">
          {mode === "form" ? (
            <div className="mcp-editor-grid mcp-create-form">
              <label className="settings-field"><span>名称</span><input autoFocus value={draft.name} placeholder="例如：网页检索" onChange={(event) => { updateDraft({ name: event.target.value }); onClearError(); }} /></label>
              <label className="settings-field"><span>ID</span><input value={draft.id} onChange={(event) => { updateDraft({ id: event.target.value }); onClearError(); }} /></label>
              <label className="settings-field full"><span>描述</span><input value={draft.description ?? ""} placeholder="可选" onChange={(event) => updateDraft({ description: event.target.value || undefined })} /></label>
              <div className="settings-field mcp-transport-field">
                <span>传输方式</span>
                <div className="mcp-transport-options" role="radiogroup" aria-label="传输方式">
                  {TRANSPORT_OPTIONS.map(([transport, label, hint]) => {
                    const selected = (draft.transport ?? "stdio") === transport;
                    return <button key={transport} type="button" role="radio" aria-checked={selected} className={selected ? "is-selected" : ""} onClick={() => { updateDraft({ transport, command: transport === "stdio" ? draft.command : undefined, url: transport === "stdio" ? undefined : draft.url }); onClearError(); }}><strong>{label}</strong><small>{hint}</small></button>;
                  })}
                </div>
              </div>
              <div className="settings-field mcp-create-enabled">
                <span>状态</span>
                <label className={`mcp-enable-switch ${draft.enabled !== false ? "is-on" : ""}`}>
                  <input type="checkbox" checked={draft.enabled !== false} onChange={(event) => updateDraft({ enabled: event.target.checked })} />
                  <span className="mcp-enable-track" aria-hidden="true"><span className="mcp-enable-thumb" /></span>
                  <span className="mcp-enable-label">{draft.enabled !== false ? "已启用" : "已停用"}</span>
                </label>
              </div>
              {(draft.transport ?? "stdio") === "stdio" ? <>
                <label className="settings-field full"><span>命令</span><input value={draft.command ?? ""} placeholder="npx" onChange={(event) => { updateDraft({ command: event.target.value }); onClearError(); }} /></label>
                <label className="settings-field"><span>参数（每行一个）</span><textarea value={(draft.args ?? []).join("\n")} onChange={(event) => updateDraft({ args: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label>
                <label className="settings-field"><span>环境变量（KEY=VALUE）</span><textarea value={Object.entries(draft.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n")} onChange={(event) => updateDraft({ env: parseEnvironment(event.target.value) })} /></label>
              </> : <label className="settings-field full"><span>服务 URL</span><input value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => { updateDraft({ url: event.target.value }); onClearError(); }} /></label>}
              {error ? <p className="mcp-error full">{error}</p> : null}
            </div>
          ) : (
            <div className="mcp-create-json">
              <textarea className="mcp-json-input" autoFocus value={jsonDraft} spellCheck={false} onChange={(event) => { onJsonDraftChange(event.target.value); onClearError(); }} />
              {error ? <p className="mcp-error">{error}</p> : null}
            </div>
          )}
        </div>

        <div className="project-sheet-actions">
          <button className="button ghost" type="button" onClick={onClose}>取消</button>
          <button className="button warm" type="button" onClick={onConfirm} disabled={mode === "json" && !jsonDraft.trim()}>添加到列表</button>
        </div>
      </div>
    </div>
  );
}
