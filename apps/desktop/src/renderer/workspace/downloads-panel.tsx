import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DownloadServiceSnapshot, DownloadTask } from "@shared-types";
import { IconClose, IconDownload, IconFolder } from "../icons";

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

export function DownloadsPanel({ motionPhase, snapshot, setSnapshot, onClose }: Props) {
  const [urlInput, setUrlInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirBusy, setDirBusy] = useState(false);
  const [error, setError] = useState("");
  const activeTasks = snapshot.tasks;
  const history = snapshot.history;
  const defaultDir = snapshot.defaultDir || "";

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

  async function resetDefaultDir() {
    if (dirBusy) return;
    setDirBusy(true);
    setError("");
    try {
      const next = await window.codexh.setDefaultDownloadDir("");
      setSnapshot((current) => ({ ...current, defaultDir: next }));
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setDirBusy(false);
    }
  }

  return (
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

        <div className="downloads-dir-card">
          <span className="downloads-dir-icon" aria-hidden="true"><IconFolder /></span>
          <div className="downloads-dir-info">
            <span className="downloads-dir-label">默认下载目录</span>
            <span className="downloads-dir-path" title={defaultDir || undefined}>{defaultDir || "系统下载目录（未自定义）"}</span>
          </div>
          <div className="downloads-dir-actions">
            <button type="button" className="downloads-action-button" disabled={dirBusy} onClick={() => void pickDefaultDir()}>更换目录</button>
            {defaultDir ? <button type="button" className="downloads-action-button" disabled={dirBusy} onClick={() => void resetDefaultDir()}>恢复默认</button> : null}
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
                    {task.error ? <span className="downloads-item-error" title={task.error}>{task.error}</span> : null}
                  </div>
                </div>
                <div className="downloads-item-actions">
                  {task.status === "downloading" ? <button type="button" className="downloads-action-button" title="暂停" onClick={() => { void window.codexh.pauseDownload(task.id); }}>暂停</button> : null}
                  {task.status === "paused" ? <button type="button" className="downloads-action-button is-accent" title="继续" onClick={() => { void window.codexh.resumeDownload(task.id); }}>继续</button> : null}
                  <button type="button" className="downloads-action-button is-danger" title="取消并删除临时文件" onClick={() => { void window.codexh.cancelDownload(task.id); }}>取消</button>
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
                  <button type="button" className="downloads-action-button is-danger" title="删除记录" onClick={() => { void window.codexh.removeDownloadHistory(task.id); }}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
