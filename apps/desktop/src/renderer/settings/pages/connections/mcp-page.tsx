import type { Dispatch, SetStateAction } from "react";
import type { AppConfig, McpServerConfig } from "@shared-types";
import { ComposerSelect } from "../../../workspace/composer-select";
import { IconMcp } from "../../../icons";

type RuntimeMcpServer = { id: string; name: string; source?: string; command?: string; url?: string; authStatus?: string; status: { state: string; error?: string } };
type McpTestResult = { tools: Array<{ name: string; description?: string }>; resources: unknown[]; resourceTemplates: unknown[]; prompts: unknown[] };
type Props = {
  configDraft: AppConfig | null;
  mcpRuntimeServers: RuntimeMcpServer[];
  editingMcpServerId: string | null;
  setEditingMcpServerId: Dispatch<SetStateAction<string | null>>;
  mcpTestResults: Record<string, McpTestResult | undefined>;
  testingMcpServerId: string | null;
  mcpAuthBusyId: string | null;
  onAdd: () => void;
  onUpdate: (id: string, update: Partial<McpServerConfig>) => void;
  onTest: (server: McpServerConfig) => Promise<unknown>;
  onRefreshTools: (id: string) => Promise<unknown>;
  onLogin: (id: string) => Promise<unknown>;
  onLogout: (id: string) => Promise<unknown>;
  onRemove: (id: string) => void;
  onSave: () => Promise<unknown>;
  parseEnvironment: (value: string) => Record<string, string> | undefined;
};

export function McpPage({ configDraft, mcpRuntimeServers, editingMcpServerId, setEditingMcpServerId, mcpTestResults, testingMcpServerId, mcpAuthBusyId, onAdd: addMcpServer, onUpdate: updateMcpServerDraft, onTest: testMcpServer, onRefreshTools: refreshMcpToolDirectory, onLogin: loginMcpServer, onLogout: logoutMcpServer, onRemove: removeMcpServer, onSave: saveConfigDraft, parseEnvironment: parseMcpEnvironment }: Props) {
  return (
  <div className="settings-section mcp-settings-section">
    <div className="config-block mcp-service-config">
      <div className="section-copy-with-action">
        <div>
          <strong>MCP 服务</strong>
          <span>按需编辑、测试和管理已载入的服务。</span>
        </div>
        <button className="button primary" type="button" onClick={addMcpServer} disabled={!configDraft}>添加服务</button>
      </div>
      <div className="mcp-server-list">
        {configDraft?.mcpServers.length ? configDraft.mcpServers.map((server) => {
          const runtime = mcpRuntimeServers.find((item) => item.id === server.id);
          const isEditing = editingMcpServerId === server.id;
          const testResult = mcpTestResults[server.id];
          const isStdio = (server.transport ?? "stdio") === "stdio";
          const transport = server.transport ?? "stdio";
          const transportLabel = transport === "streamable_http" ? "HTTP" : transport === "sse" ? "SSE" : "stdio";
          const statusState = (runtime?.status.state ?? (server.enabled ? "idle" : "disabled")).toLowerCase();
          return (
            <article key={server.id} className={`mcp-server-row ${isEditing ? "is-editing" : ""} ${server.enabled ? "is-enabled" : "is-disabled"}`}>
              <div className="mcp-server-row-top">
                <div className="mcp-server-row-main">
                  <div className="mcp-server-row-title">
                    <span className="mcp-server-row-icon" aria-hidden><IconMcp /></span>
                    <strong>{server.name || server.id}</strong>
                   <span className={`mcp-transport-pill ${transport}`}>{transportLabel}</span>
                    <span className={`mcp-status-pill ${statusState}`}>{statusState}</span>
                    {server.auth?.mode === "oauth" ? <span className="mcp-transport-pill">{runtime?.authStatus === "signed_in" ? "OAuth 已登录" : "OAuth 未登录"}</span> : null}
                  </div>
                  {!isEditing ? (
                    <span className="mcp-server-row-target" title={server.command ?? server.url ?? server.id}>
                      {server.command ?? server.url ?? server.id}
                    </span>
                  ) : null}
                </div>
                <div className="mcp-server-row-side">
                  <label className={`mcp-enable-switch ${server.enabled ? "is-on" : ""}`}>
                    <input type="checkbox" checked={server.enabled} onChange={(event) => updateMcpServerDraft(server.id, { enabled: event.target.checked })} />
                    <span className="mcp-enable-track" aria-hidden="true"><span className="mcp-enable-thumb" /></span>
                    <span className="mcp-enable-label">{server.enabled ? "启用" : "停用"}</span>
                  </label>
                </div>
              </div>
              {runtime?.status.error ? <p className="mcp-error">{runtime.status.error}</p> : null}
              {isEditing ? (
                <div className="mcp-editor-grid">
                  <label className="settings-field"><span>名称</span><input value={server.name} onChange={(event) => updateMcpServerDraft(server.id, { name: event.target.value })} /></label>
                  <label className="settings-field"><span>ID</span><input value={server.id} onChange={(event) => updateMcpServerDraft(server.id, { id: event.target.value.trim() })} /></label>
                  <label className="settings-field full"><span>描述</span><input value={server.description ?? ""} onChange={(event) => updateMcpServerDraft(server.id, { description: event.target.value || undefined })} /></label>
                  <label className="settings-field"><span>传输方式</span><ComposerSelect className="mcp-select" ariaLabel="传输方式" value={server.transport ?? "stdio"} onChange={(transport) => updateMcpServerDraft(server.id, { transport, command: transport === "stdio" ? server.command : undefined, url: transport === "stdio" ? undefined : server.url })} options={[{ value: "stdio", label: "stdio" }, { value: "sse", label: "SSE" }, { value: "streamable_http", label: "HTTP" }]} placeholder="选择传输方式" /></label>
                  {isStdio ? <>
                    <label className="settings-field full"><span>命令</span><input value={server.command ?? ""} placeholder="npx" onChange={(event) => updateMcpServerDraft(server.id, { command: event.target.value })} /></label>
                    <label className="settings-field"><span>参数（每行一个）</span><textarea value={(server.args ?? []).join("\n")} onChange={(event) => updateMcpServerDraft(server.id, { args: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label>
                    <label className="settings-field"><span>环境变量（KEY=VALUE）</span><textarea value={Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n")} onChange={(event) => updateMcpServerDraft(server.id, { env: parseMcpEnvironment(event.target.value) })} /></label>
                  </> : <>
                    <label className="settings-field full"><span>服务 URL</span><input value={server.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => updateMcpServerDraft(server.id, { url: event.target.value })} /></label>
                    <label className="settings-field"><span>认证方式</span><ComposerSelect className="mcp-select" ariaLabel="认证方式" value={server.auth?.mode ?? "none"} onChange={(mode) => updateMcpServerDraft(server.id, { auth: { mode: mode as "none" | "bearer_env" | "oauth" } })} options={[{ value: "none", label: "无认证" }, { value: "bearer_env", label: "Bearer 环境变量" }, { value: "oauth", label: "OAuth" }]} placeholder="选择认证方式" /></label>
                    <label className="settings-field"><span>默认工具审批</span><ComposerSelect className="mcp-select" ariaLabel="默认工具审批" value={server.defaultToolsApprovalMode ?? "prompt"} onChange={(defaultToolsApprovalMode) => updateMcpServerDraft(server.id, { defaultToolsApprovalMode: defaultToolsApprovalMode as "auto" | "prompt" | "writes" | "approve" })} options={[{ value: "prompt", label: "每次确认" }, { value: "auto", label: "自动执行" }, { value: "writes", label: "写入时确认" }, { value: "approve", label: "高风险确认" }]} placeholder="选择审批方式" /></label>
                    {server.auth?.mode === "bearer_env" ? <label className="settings-field full"><span>Bearer Token 环境变量</span><input value={server.auth.bearerTokenEnvVar ?? ""} placeholder="MCP_TOKEN" onChange={(event) => updateMcpServerDraft(server.id, { auth: { ...server.auth!, bearerTokenEnvVar: event.target.value } })} /></label> : null}
                    {server.auth?.mode === "oauth" ? <>
                      <label className="settings-field"><span>OAuth Client ID</span><input value={server.auth.oauthClientId ?? ""} onChange={(event) => updateMcpServerDraft(server.id, { auth: { ...server.auth!, oauthClientId: event.target.value } })} /></label>
                      <label className="settings-field"><span>Scopes（空格分隔）</span><input value={(server.auth.oauthScopes ?? []).join(" ")} onChange={(event) => updateMcpServerDraft(server.id, { auth: { ...server.auth!, oauthScopes: event.target.value.split(/\s+/).filter(Boolean) } })} /></label>
                      <label className="settings-field full"><span>Resource Metadata URL（可选）</span><input value={server.auth.oauthResource ?? ""} onChange={(event) => updateMcpServerDraft(server.id, { auth: { ...server.auth!, oauthResource: event.target.value || undefined } })} /></label>
                    </> : null}
                  </>}
                </div>
              ) : null}
              <div className="mcp-server-row-actions">
                 <button className="button secondary" type="button" onClick={() => setEditingMcpServerId(isEditing ? null : server.id)}>{isEditing ? "收起" : "编辑"}</button>
                 <button className="button secondary" type="button" disabled={testingMcpServerId === server.id} onClick={() => void testMcpServer(server)}>{testingMcpServerId === server.id ? "测试中" : "测试连接"}</button>
                 <button className="button secondary" type="button" onClick={() => void refreshMcpToolDirectory(server.id)}>刷新工具</button>
                 {server.auth?.mode === "oauth" ? <button className="button secondary" type="button" disabled={mcpAuthBusyId === server.id} onClick={() => void (runtime?.authStatus === "signed_in" ? logoutMcpServer(server.id) : loginMcpServer(server.id))}>{mcpAuthBusyId === server.id ? "处理中" : runtime?.authStatus === "signed_in" ? "退出 OAuth" : "登录 OAuth"}</button> : null}
                 <button className="button ghost" type="button" onClick={() => removeMcpServer(server.id)}>删除</button>
                 {testResult ? <span className="mcp-test-summary">工具 {testResult.tools.length} · 资源 {testResult.resources.length} · 模板 {testResult.resourceTemplates.length} · 提示词 {testResult.prompts.length}</span> : null}
               </div>
               {testResult ? (
                 <details className="mcp-test-details">
                   <summary>
                     <span>查看发现的能力</span>
                     <span>{testResult.tools.length} 个工具</span>
                   </summary>
                   <div className="mcp-tool-list">
                     {testResult.tools.map((tool) => {
                       const policy = server.tools?.[tool.name];
                       return (
                         <div className="mcp-tool-row" key={tool.name}>
                           <label className="mcp-tool-enabled" title={policy?.enabled === false ? "启用工具" : "停用工具"}>
                             <input
                               type="checkbox"
                               checked={policy?.enabled !== false}
                               onChange={(event) => updateMcpServerDraft(server.id, {
                                 tools: { ...(server.tools ?? {}), [tool.name]: { ...policy, enabled: event.target.checked } }
                               })}
                             />
                             <span className="mcp-tool-name">{tool.name}</span>
                           </label>
                           <span className="mcp-tool-description" title={tool.description}>{tool.description || "无描述"}</span>
                           <ComposerSelect
                             className="mcp-tool-approval-select"
                             ariaLabel={`${tool.name} 的审批策略`}
                             value={policy?.approvalMode ?? server.defaultToolsApprovalMode ?? "prompt"}
                             onChange={(approvalMode) => updateMcpServerDraft(server.id, {
                               tools: {
                                 ...(server.tools ?? {}),
                                 [tool.name]: { ...policy, approvalMode: approvalMode as "auto" | "prompt" | "writes" | "approve" }
                               }
                             })}
                             options={[
                               { value: "auto", label: "自动" },
                               { value: "prompt", label: "每次确认" },
                               { value: "writes", label: "写入确认" },
                               { value: "approve", label: "高风险确认" }
                             ]}
                             placeholder="选择审批策略"
                           />
                         </div>
                       );
                     })}
                   </div>
                   {(testResult.resources.length || testResult.resourceTemplates.length || testResult.prompts.length) ? (
                     <div className="mcp-discovery-meta">
                       {testResult.resources.length ? <span>资源 {testResult.resources.length}</span> : null}
                       {testResult.resourceTemplates.length ? <span>模板 {testResult.resourceTemplates.length}</span> : null}
                       {testResult.prompts.length ? <span>提示词 {testResult.prompts.length}</span> : null}
                     </div>
                   ) : null}
                 </details>
               ) : null}
            </article>
          );
        }) : <div className="detail-empty">尚未配置 MCP 服务。</div>}
      </div>
    </div>
    <div className="config-block mcp-plugin-config">
      <div className="section-copy"><strong>插件提供的 MCP 服务</strong><span>由插件清单管理，只能通过项目插件启用状态控制。</span></div>
      <div className="mcp-server-list">
        {mcpRuntimeServers.filter((server) => server.source === "plugin").length ? mcpRuntimeServers.filter((server) => server.source === "plugin").map((server) => (
          <article key={server.id} className="mcp-server-row is-plugin">
            <div className="mcp-server-row-top">
              <div className="mcp-server-row-main">
                <div className="mcp-server-row-title">
                  <span className="mcp-server-row-icon" aria-hidden><IconMcp /></span>
                  <strong>{server.name}</strong>
                  <span className="mcp-transport-pill plugin">plugin</span>
                  <span className={`mcp-status-pill ${String(server.status.state).toLowerCase()}`}>{server.status.state}</span>
                </div>
                <span className="mcp-server-row-target">{server.command ?? server.url ?? server.id}</span>
              </div>
            </div>
            {server.status.error ? <p className="mcp-error">{server.status.error}</p> : null}
          </article>
        )) : <div className="detail-empty">没有插件提供的 MCP 服务。</div>}
      </div>
    </div>
    <div className="settings-save-row"><span className="subtle-inline">保存后立即重建已变更的 MCP 连接。</span><button className="button warm" onClick={() => void saveConfigDraft()} disabled={!configDraft}>保存</button></div>
  </div>
  );
}
