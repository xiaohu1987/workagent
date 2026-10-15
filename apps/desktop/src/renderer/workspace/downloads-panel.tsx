import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DownloadServiceSnapshot, DownloadTask } from "@shared-types";
import { IconClose, IconDownload, IconFolder } from "../icons";
import { ConfirmationSheet } from "./confirmation-sheet";

type Props = {
  motionPhase: string;
  snapshot: DownloadServiceSnapshot;
  setSnapshot: Dispatch<SetStateAction<DownloadServiceSnapshot>>;
  onClose: () => void;
};

const STATUS_LABELS: Record<DownloadTask["status"], string> = {
  probing: "解析中",
  downloading: "下载中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消"
};

/**
 * 主进程抛出的错误在渲染层会带 "Error invoking remote method ..." 前缀，
 * 只保留最后一段可读信息。
 */
function cleanIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const marker = raw.lastIndexOf("Error: ");
  return (marker >= 0 ? raw.slice(marker + 7) : raw).trim();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

// 模块级缓存：面板卸载再重挂后，进度条与日志立即恢复到切换前的状态
// （组件 state 会随卸载丢失，模块变量不会）。
let p2pProgressCache = { percent: -1, log: "" };

export function DownloadsPanel({ motionPhase, snapshot, setSnapshot, onClose }: Props) {
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirBusy, setDirBusy] = useState(false);
  const [error, setError] = useState("");
  const [installingP2p, setInstallingP2p] = useState(false);
  const [installLog, setInstallLog] = useState(p2pProgressCache.log);
  const [installPercent, setInstallPercent] = useState(p2pProgressCache.percent); // -1 = 尚未解析到进度，走流动动画
  const activeTasks = snapshot.tasks;
  const history = snapshot.history;
  const defaultDir = snapshot.defaultDir || "";
  // 安装态以主进程快照为准（面板关闭再打开也能恢复），本地 state 只是点击后的即时反馈。
  const p2pInstalling = installingP2p || snapshot.p2pInstalling === true;
  // 删除任务/记录的页内确认：取消任务与删除历史记录都要先问是否连文件一起删。
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    fileName: string;
    filePath: string;
    mode: "cancel" | "history";
    offerFileDelete: boolean;
  } | null>(null);
  const [deleteFileToo, setDeleteFileToo] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 安装期间订阅主进程的包管理器输出：最后一行作日志提示，
  // pnpm 的 "Progress: resolved N, reused N, downloaded N" 解析为真实百分比。
  useEffect(() => {
    if (!p2pInstalling) return;
    return window.codexh.onP2pInstallProgress((line) => {
      const match = line.match(/Progress:\s*resolved\s*(\d+),.*?reused\s*(\d+),.*?downloaded\s*(\d+)/);
      if (match) {
        const resolved = Number(match[1]);
        const done = Number(match[2]) + Number(match[3]);
        if (resolved > 0) p2pProgressCache.percent = Math.min(100, Math.round((done / resolved) * 100));
      }
      p2pProgressCache.log = line;
      setInstallLog(line);
      setInstallPercent(p2pProgressCache.percent);
    });
  }, [p2pInstalling]);

  async function installP2p() {
    if (p2pInstalling) return;
    p2pProgressCache = { percent: -1, log: "" };
    setInstallingP2p(true);
    setInstallLog("");
    setInstallPercent(-1);
    setError("");
    try {
      // 成功路径：主进程装完会自动重启应用，这里的 await 不会正常返回。
      await window.codexh.installP2pDependency();
    } catch (caught) {
      setError(cleanIpcError(caught));
      setInstallingP2p(false);
    }
  }

  async function submitUrl() {
    const url = urlInput.trim();
    if (!url || busy) return;
    setBusy(true);
    setError("");
    try {
      await window.codexh.addDownload({ url });
      setUrlInput("");
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function pickDefaultDir() {
    if (dirBusy) return;
    setDirBusy(true);
    setError("");
    try {
      const dir = await window.codexh.chooseDownloadDir(defaultDir || undefined);
      if (dir) {
        const next = await window.codexh.setDefaultDownloadDir(dir);
        setSnapshot((current) => ({ ...current, defaultDir: next }));
      }
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setDirBusy(false);
    }
  }

  function openDefaultDir() {
    void window.codexh.openPath(defaultDir).then((message) => {
      if (message) setError(message);
    });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    const target = pendingDelete;
    try {
      if (target.mode === "history") {
        await window.codexh.removeDownloadHistory(target.id);
        if (deleteFileToo && target.filePath) {
          const message = await window.codexh.deleteDownloadFile(target.filePath);
          if (message) setError(message);
        }
      } else {
        await window.codexh.cancelDownload(target.id);
        if (deleteFileToo && target.filePath) {
          const message = await window.codexh.deleteDownloadFile(target.filePath);
          if (message) setError(message);
        }
      }
      setPendingDelete(null);
    } catch (caught) {
      setError(cleanIpcError(caught));
      setPendingDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
    <section className="quick-notes-sheet quick-notes-inline downloads-inline" aria-label="下载" data-motion={motionPhase}>
      <header className="project-sheet-header">
        <div className="quick-notes-header-title">
          <span className="quick-notes-header-icon downloads-header-icon" aria-hidden="true"><IconDownload /></span>
          <strong>下载</strong>
          <span className="quick-notes-header-scope">{snapshot.p2pAvailable ? "分段 · 断点续传 · P2P" : "分段下载 · 断点续传"}</span>
        </div>
        <button className="project-sheet-close" type="button" title="收起下载" aria-label="收起下载" onClick={onClose}><IconClose /></button>
      </header>

      <div className="downloads-inline-body">
        <div className="downloads-composer">
          <input
            className="downloads-url-input"
            value={urlInput}
            placeholder="粘贴 http(s) 下载链接、磁力链接（magnet:）或 .torrent 地址，回车开始下载"
            spellCheck={false}
            onChange={(event) => setUrlInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submitUrl(); }}
          />
          <button type="button" className="button primary downloads-add-button" disabled={busy || !urlInput.trim()} onClick={() => void submitUrl()}>{busy ? "添加中..." : "下载"}</button>
        </div>
        {error ? <div className="downloads-error" role="alert">{error}</div> : null}

        {!snapshot.p2pAvailable ? (
          <div className="downloads-p2p-bar">
            <div className="downloads-p2p-row">
              <div className="downloads-p2p-info">
                <span className="downloads-p2p-label">P2P（BT/磁力）组件未安装</span>
                <span className="downloads-p2p-desc">
                  {p2pInstalling
                    ? installPercent >= 0
                      ? `正在下载安装 webtorrent（${installPercent}%），完成后将自动重启应用，请保持网络畅通…`
                      : "正在下载安装 webtorrent，完成后将自动重启应用，请保持网络畅通…"
                    : "安装后可下载磁力链接与 .torrent 种子（组件来自 npm 的 webtorrent）。"}
                </span>
                {p2pInstalling && installLog ? <span className="downloads-p2p-log" title={installLog}>{installLog}</span> : null}
              </div>
              <button type="button" className="downloads-action-button is-accent" disabled={p2pInstalling} onClick={() => void installP2p()}>
                {p2pInstalling ? "安装中…" : "下载安装"}
              </button>
            </div>
            {p2pInstalling ? (
              <div className="downloads-progress downloads-p2p-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={installPercent >= 0 ? installPercent : undefined}>
                <span
                  className="downloads-progress-fill"
                  style={installPercent >= 0 ? { width: `${Math.min(100, installPercent)}%` } : undefined}
                  data-indeterminate={installPercent < 0 ? "true" : undefined}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="downloads-dir-card">
          <span className="downloads-dir-icon" aria-hidden="true"><IconFolder /></span>
          <div className="downloads-dir-info">
            <span className="downloads-dir-label">默认下载目录</span>
            <span className="downloads-dir-path" title={defaultDir || undefined}>{defaultDir || "系统下载目录（未自定义）"}</span>
          </div>
          <div className="downloads-dir-actions">
            <button type="button" className="downloads-action-button" disabled={dirBusy} onClick={() => void pickDefaultDir()}>更换目录</button>
            {defaultDir ? <button type="button" className="downloads-action-button" title="在资源管理器中打开该目录" onClick={openDefaultDir}>打开目录</button> : null}
          </div>
        </div>

        <div className="downloads-section-head">
          <span className="downloads-section-title">下载中</span>
          <span className="downloads-section-count">{activeTasks.length}</span>
        </div>
        {activeTasks.length === 0 ? (
          <div className="downloads-empty">暂无进行中的任务。粘贴上方链接开始下载，支持大文件、多分段并行与断点续传。</div>
        ) : (
          <div className="downloads-list">
            {activeTasks.map((task) => (
              <div key={task.id} className={`downloads-item is-${task.status}`}>
                <div className="downloads-item-main">
                  <div className="downloads-item-title" title={task.filePath || task.url}>
                    <span className="downloads-item-name">{task.fileName}</span>
                    <span className={`downloads-item-status is-${task.status}`}>{STATUS_LABELS[task.status]}</span>
                  </div>
                  <div className="downloads-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((task.progress >= 0 ? task.progress : 0) * 100)}>
                    <span className="downloads-progress-fill" style={{ width: task.progress >= 0 ? `${Math.min(100, task.progress * 100)}%` : "100%" }} data-indeterminate={task.progress < 0 ? "true" : undefined} />
                  </div>
                  <div className="downloads-item-meta">
                    <span>{formatBytes(task.receivedBytes)}{task.totalBytes > 0 ? ` / ${formatBytes(task.totalBytes)}` : ""}</span>
                    <span>{formatSpeed(task.speedBps)}</span>
                    {task.kind === "http" && task.resumable && task.segments.length > 1 ? <span>{task.segments.filter((segment) => segment.end < 0 || segment.downloaded >= segment.end - segment.start + 1).length}/{task.segments.length} 段完成</span> : null}
                    {task.kind === "p2p" ? <span>{task.peers ?? 0} 个节点</span> : null}
                    {task.kind === "p2p" && task.status === "probing" ? <span>DHT {task.dhtNodes ?? 0} 节点</span> : null}
                    {task.error ? <span className="downloads-item-error" title={task.error}>{task.error}</span> : null}
                  </div>
                </div>
                <div className="downloads-item-actions">
                  {task.status === "downloading" ? <button type="button" className="downloads-action-button" title="暂停" onClick={() => { void window.codexh.pauseDownload(task.id); }}>暂停</button> : null}
                  {task.status === "paused" ? <button type="button" className="downloads-action-button is-accent" title="继续" onClick={() => { void window.codexh.resumeDownload(task.id); }}>继续</button> : null}
                  <button
                    type="button"
                    className="downloads-action-button is-danger"
                    title="取消任务"
                    onClick={() => {
                      setDeleteFileToo(false);
                      setPendingDelete({
                        id: task.id,
                        fileName: task.fileName,
                        filePath: task.kind === "http" ? task.filePath : "",
                        mode: "cancel",
                        // P2P 的部分数据由引擎销毁（destroyStore），无「文件」可选。
                        offerFileDelete: task.kind === "http"
                      });
                    }}
                  >取消</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="downloads-section-head downloads-history-head">
          <span className="downloads-section-title">历史下载</span>
          <span className="downloads-section-side">
            <span className="downloads-section-count">{history.length}</span>
            {history.length > 0 ? <button type="button" className="downloads-action-button" onClick={() => { void window.codexh.clearDownloadHistory(); }}>清空历史</button> : null}
          </span>
        </div>
        {history.length === 0 ? (
          <div className="downloads-empty">还没有历史记录。</div>
        ) : (
          <div className="downloads-list">
            {history.map((task) => (
              <div key={task.id} className={`downloads-item is-history is-${task.status}`}>
                <div className="downloads-item-main">
                  <div className="downloads-item-title" title={task.error || task.filePath || task.url}>
                    <span className="downloads-item-name">{task.fileName}</span>
                    <span className={`downloads-item-status is-${task.status}`}>{STATUS_LABELS[task.status]}</span>
                  </div>
                  <div className="downloads-item-meta">
                    <span>{formatBytes(task.totalBytes > 0 ? task.totalBytes : task.receivedBytes)}</span>
                    <span>{formatTime(task.completedAt)}</span>
                    {task.error ? <span className="downloads-item-error" title={task.error}>{task.error}</span> : null}
                  </div>
                </div>
                <div className="downloads-item-actions">
                  {task.status === "completed" ? <button type="button" className="downloads-action-button" title="打开所在文件夹" onClick={() => { void window.codexh.revealDownload(task.filePath); }}>打开目录</button> : null}
                  <button type="button" className="downloads-action-button is-accent" title="重新下载" onClick={() => { void window.codexh.addDownload({ url: task.url }).catch((caught) => setError(cleanIpcError(caught))); }}>重新下载</button>
                  <button
                    type="button"
                    className="downloads-action-button is-danger"
                    title="删除记录"
                    onClick={() => {
                      setDeleteFileToo(false);
                      setPendingDelete({
                        id: task.id,
                        fileName: task.fileName,
                        filePath: task.filePath,
                        mode: "history",
                        offerFileDelete: Boolean(task.filePath)
                      });
                    }}
                  >删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
    {pendingDelete ? (
      <ConfirmationSheet
        motionPhase={motionPhase}
        titleId="downloads-delete-confirm-title"
        title={pendingDelete.mode === "history" ? "删除下载记录" : "取消下载任务"}
        description={pendingDelete.mode === "history"
          ? `将删除「${pendingDelete.fileName}」的下载记录，默认保留磁盘上的文件。`
          : `将取消「${pendingDelete.fileName}」并清理未完成的分段进度。`}
        confirmLabel={pendingDelete.mode === "history" ? "确认删除" : "确认取消"}
        confirmVariant="danger"
        busy={deleteBusy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      >
        {pendingDelete.offerFileDelete && pendingDelete.filePath ? (
          <label className="downloads-confirm-file">
            <input
              type="checkbox"
              checked={deleteFileToo}
              onChange={(event) => setDeleteFileToo(event.target.checked)}
            />
            <span>同时删除已下载的文件（移入回收站）</span>
          </label>
        ) : null}
      </ConfirmationSheet>
    ) : null}
    </>
  );
}
