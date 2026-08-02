import type { Dispatch, SetStateAction } from "react";
import type { AppConfig, DatabaseConnectionConfig, DatabasePermission } from "@shared-types";
import { ComposerSelect } from "../../../workspace/composer-select";
import { IconMcp } from "../../../icons";

type Props = { configDraft: AppConfig | null; savedCredentialIds: Set<string>; testingId: string | null; savingCredentialId: string | null; changingEnabledId: string | null; editingId: string | null; databaseCatalogs: Record<string,string[]>; passwordDrafts: Record<string,string>; permissions: Array<{value:DatabasePermission;label:string}>; setPasswordDrafts: Dispatch<SetStateAction<Record<string,string>>>; setEditingId:(id:string|null)=>void; onAdd:()=>void; onSetEnabled:(c:DatabaseConnectionConfig,e:boolean)=>Promise<void>; onUpdate:(id:string,p:Partial<DatabaseConnectionConfig>)=>void; onTest:(c:DatabaseConnectionConfig)=>Promise<void>; onSave:(c:DatabaseConnectionConfig)=>Promise<void>; onRemove:(id:string)=>void; };
export function DatabasePage({configDraft,savedCredentialIds,testingId,savingCredentialId,changingEnabledId,editingId,databaseCatalogs,passwordDrafts,permissions,setPasswordDrafts,setEditingId,onAdd,onSetEnabled,onUpdate,onTest,onSave,onRemove}:Props){return (
                <div className="settings-section database-settings-section">
                  <div className="config-block database-config-block">
                    <div className="section-copy-with-action">
                      <div><strong>数据库连接</strong><span>按连接权限执行查询或数据变更。密码由系统加密保存，不会写入配置文件。</span></div>
                      <button className="button primary" type="button" onClick={onAdd} disabled={!configDraft}>添加数据库</button>
                    </div>
                    <div className="mcp-server-list database-connection-list">
                      {(configDraft?.databaseConnections ?? []).map((connection) => {
                        const hasSavedCredential = savedCredentialIds.has(connection.id);
                        const isTesting = testingId === connection.id;
                        const isSavingPassword = savingCredentialId === connection.id;
                        const isChangingEnabled = changingEnabledId === connection.id;
                        const isEditing = editingId === connection.id;
                        const engineLabel = connection.engine === "postgresql" ? "PostgreSQL" : connection.engine === "mysql" ? "MySQL" : "SQL Server";
                        const target = `${connection.username || "user"}@${connection.host || "host"}:${connection.port}/${connection.database || "database"}`;
                        const databaseOptions = [...new Set([connection.database, ...(databaseCatalogs[connection.id] ?? [])])].filter(Boolean).map((database) => ({ value: database, label: database }));
                        return (
                        <article key={connection.id} className={`mcp-server-row database-connection-row ${isEditing ? "is-editing" : ""} ${connection.enabled ? "is-enabled" : "is-disabled"}`}>
                          <div className="mcp-server-row-top">
                            <div className="mcp-server-row-main">
                              <div className="mcp-server-row-title">
                                <span className="mcp-server-row-icon" aria-hidden><IconMcp /></span>
                                <strong>{connection.name || connection.id}</strong>
                                <span className="mcp-transport-pill">{engineLabel}</span>
                                <span className={`mcp-status-pill ${connection.enabled ? "ready" : "disabled"}`}>{connection.enabled ? "启用" : "停用"}</span>
                              </div>
                              {!isEditing ? <span className="mcp-server-row-target" title={target}>{target}</span> : null}
                            </div>
                            <div className="mcp-server-row-side">
                              <label className={`mcp-enable-switch ${connection.enabled ? "is-on" : ""}`}>
                                <input type="checkbox" checked={connection.enabled} disabled={isChangingEnabled} onChange={(event) => void onSetEnabled(connection, event.target.checked)} />
                                <span className="mcp-enable-track" aria-hidden="true"><span className="mcp-enable-thumb" /></span>
                                <span className="mcp-enable-label">{connection.enabled ? "启用" : "停用"}</span>
                              </label>
                            </div>
                          </div>
                          {isEditing ? <div className="mcp-editor-grid database-connection-grid">
                            <label className="settings-field"><span>名称</span><input value={connection.name} onChange={(event) => onUpdate(connection.id, { name: event.target.value })} /></label>
                            <label className="settings-field"><span>ID</span><input value={connection.id} disabled /></label>
                            <label className="settings-field"><span>类型</span><ComposerSelect className="mcp-select" ariaLabel="数据库类型" value={connection.engine} onChange={(value) => { const engine = value as DatabaseConnectionConfig["engine"]; onUpdate(connection.id, { engine, port: engine === "postgresql" ? 5432 : engine === "mysql" ? 3306 : 1433 }); }} options={[{ value: "postgresql", label: "PostgreSQL" }, { value: "mysql", label: "MySQL" }, { value: "sqlserver", label: "SQL Server" }]} placeholder="选择数据库类型" /></label>
                            <label className="settings-field"><span>主机</span><input value={connection.host} onChange={(event) => onUpdate(connection.id, { host: event.target.value })} /></label>
                            <label className="settings-field"><span>端口</span><input type="number" value={connection.port} onChange={(event) => onUpdate(connection.id, { port: Number(event.target.value) })} /></label>
                            <label className="settings-field"><span>数据库</span>{databaseOptions.length > 0 ? <ComposerSelect className="mcp-select database-catalog-select" ariaLabel="数据库" value={connection.database} onChange={(database) => onUpdate(connection.id, { database })} options={databaseOptions} placeholder="测试连接后选择数据库" /> : <input value={connection.database} onChange={(event) => onUpdate(connection.id, { database: event.target.value })} />}</label>
                            <label className="settings-field"><span>用户名</span><input value={connection.username} onChange={(event) => onUpdate(connection.id, { username: event.target.value })} /></label>
                            <label className="settings-field"><span>TLS</span><ComposerSelect className="mcp-select" ariaLabel="TLS 设置" value={connection.tlsMode} onChange={(value) => onUpdate(connection.id, { tlsMode: value as DatabaseConnectionConfig["tlsMode"] })} options={[{ value: "require", label: "加密" }, { value: "verify", label: "验证证书" }, { value: "disable", label: "关闭" }]} placeholder="选择 TLS 设置" /></label>
                            <fieldset className="database-permission-field">
                              <legend>权限</legend>
                              <div className="database-permission-options">
                                {permissions.map((permission) => (
                                  <label key={permission.value} className="database-permission-option">
                                    <input
                                      type="checkbox"
                                      checked={connection.permissions.includes(permission.value)}
                                      onChange={(event) => onUpdate(connection.id, {
                                        permissions: event.target.checked
                                          ? [...new Set([...connection.permissions, permission.value])]
                                          : connection.permissions.filter((value) => value !== permission.value)
                                      })}
                                    />
                                    <span>{permission.label}</span>
                                  </label>
                                ))}
                              </div>
                            </fieldset>
                            <label className="settings-field database-row-limit-field">
                              <span>查询最大数量</span>
                              <input
                                type="number"
                                min={1}
                                max={1000}
                                value={connection.maxRows}
                                disabled={!connection.permissions.includes("query")}
                                onChange={(event) => onUpdate(connection.id, {
                                  maxRows: Math.min(1000, Math.max(1, Number(event.target.value) || 1))
                                })}
                              />
                              <small>每次查询最多 1000 条，运行时会再次限制。</small>
                            </label>
                            <label className="settings-field database-password-field"><span>密码</span><div className="database-password-control"><input type="password" value={passwordDrafts[connection.id] ?? ""} placeholder={hasSavedCredential ? "已安全保存，输入可更新" : "输入数据库密码"} onChange={(event) => setPasswordDrafts((current) => ({ ...current, [connection.id]: event.target.value }))} />{hasSavedCredential ? <span className="database-credential-status">已保存</span> : null}</div><small>留空测试时会使用已加密保存的密码。</small></label>
                          </div> : null}
                          <div className="mcp-server-row-actions">
                            <button className="button secondary" type="button" onClick={() => setEditingId(isEditing ? null : connection.id)}>{isEditing ? "收起" : "编辑"}</button>
                            <button className="button secondary" type="button" disabled={isTesting || isSavingPassword} onClick={() => void onTest(connection)}>{isTesting ? "测试中..." : "测试连接"}</button>
                            <button className="button secondary" type="button" disabled={isSavingPassword || isTesting} onClick={() => void onSave(connection)}>{isSavingPassword ? "保存中..." : "保存"}</button>
                            <button className="button ghost" type="button" onClick={() => onRemove(connection.id)}>删除</button>
                            {isEditing ? <span className="mcp-test-summary">{hasSavedCredential ? "密码已由系统加密保存。" : "输入并保存密码后可随时测试连接。"}</span> : null}
                          </div>
                        </article>
                        );
                      })}
                      {(configDraft?.databaseConnections ?? []).length === 0 ? <div className="detail-empty">尚未配置数据库连接。</div> : null}
                    </div>
                  </div>
                </div>
                );}
