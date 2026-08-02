type UpdateState = {
  phase: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "error";
  currentVersion: string;
  remoteVersion?: string;
  changelog?: string;
  progress?: number;
  receivedBytes?: number;
  totalBytes?: number;
  downloadedInstaller?: string;
  error?: string;
  isPackaged: boolean;
};

type SettingsUpdatePageProps = {
  updateState: UpdateState | null;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
  formatPhase: (phase: UpdateState["phase"]) => string;
  formatDownloadSize: (receivedBytes?: number, totalBytes?: number) => string;
};

export function SettingsUpdatePage({ updateState, onCheck, onDownload, onInstall, formatPhase, formatDownloadSize }: SettingsUpdatePageProps) {
  const busy = updateState?.phase === "checking" || updateState?.phase === "downloading" || updateState?.phase === "installing";
  return <div className="settings-section"><div className="config-block update-settings-panel">
    <div className="section-copy section-copy-with-action"><div><strong>CodeXH 更新</strong><span>启动时会静默检查；安装更新会保留本地聊天、项目、知识库和日志。</span></div><button className="button ghost" onClick={onCheck} disabled={busy}>{updateState?.phase === "checking" ? "检查中" : "检查更新"}</button></div>
    <div className="update-version-row"><span>当前版本</span><strong>{updateState?.currentVersion ?? "读取中"}</strong>{updateState?.remoteVersion ? <><span>最新版本</span><strong>{updateState.remoteVersion}</strong></> : null}{updateState ? <span className={`update-phase ${updateState.phase}`}>{formatPhase(updateState.phase)}</span> : null}</div>
    {updateState?.changelog ? <pre className="update-changelog">{updateState.changelog}</pre> : null}
    {updateState?.phase === "downloading" ? <div className="update-progress-group"><div className="update-progress" aria-label={`下载进度 ${updateState.progress ?? 0}%`}><span style={{ width: `${updateState.progress ?? 0}%` }} /></div><div className="update-progress-meta"><span>{formatDownloadSize(updateState.receivedBytes, updateState.totalBytes)}</span><strong>{updateState.progress === undefined ? "正在接收" : `${updateState.progress}%`}</strong></div></div> : null}
    {updateState?.error ? <div className="update-error">{updateState.error}</div> : null}
    {updateState?.phase === "downloaded" && updateState.downloadedInstaller ? <div className="update-download-path">安装包已保存至：<code>{updateState.downloadedInstaller}</code></div> : null}
    {updateState?.phase === "available" ? <div className="action-row"><button className="button warm" onClick={onDownload} disabled={!updateState.isPackaged}>{updateState.isPackaged ? "下载更新" : "开发模式不可下载"}</button></div> : null}
    {updateState?.phase === "downloaded" ? <div className="action-row"><button className="button warm" onClick={onInstall}>立即安装并重启</button></div> : null}
  </div></div>;
}
