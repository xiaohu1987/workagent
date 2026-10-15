import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DownloadFileInfo, DownloadServiceSnapshot, DownloadTask } from "@shared-types";
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
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  // 小数最多保留两位：≥100 取整、≥10 一位、其余两位。
  const text = value >= 100 ? String(Math.round(value)) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${text} ${unit}`;
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
  // 任务详情展开（点击任务行）：BT 多附件显示逐文件进度，HTTP 显示分段进度。
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // BT 多附件勾选弹窗：needsFileSelection 的任务自动弹一次，手动关过就不再自动弹。
  const [fileSelectTaskId, setFileSelectTaskId] = useState<string | null>(null);
  const [fileChecked, setFileChecked] = useState<Set<number>>(() => new Set());
  // 勾选弹窗列表排序：null=种子原始顺序；点表头按名字/大小切换升/降序。
  const [fileSort, setFileSort] = useState<{ key: "name" | "size" | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const [fileSelectBusy, setFileSelectBusy] = useState(false);
  const dismissedFileSelectionRef = useRef<Set<string>>(new Set());

  const fileSelectTask = fileSelectTaskId ? activeTasks.find((task) => task.id === fileSelectTaskId) ?? null : null;

  function openFileSelection(task: DownloadTask) {
    setExpandedTaskId(task.id);
    setFileChecked(new Set((task.files ?? []).map((file) => file.index)));
    setFileSort({ key: null, dir: "asc" });
    setFileSelectTaskId(task.id);
  }

  function toggleFileSort(key: "name" | "size") {
    setFileSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  }

  function toggleFileChecked(index: number, checked: boolean) {
    setFileChecked((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function toggleAllFiles(checked: boolean) {
    const files = fileSelectTask?.files ?? [];
    setFileChecked(checked ? new Set(files.map((file) => file.index)) : new Set());
  }

  useEffect(() => {
    if (fileSelectTaskId) return;
    const pending = activeTasks.find((task) => task.needsFileSelection && !dismissedFileSelectionRef.current.has(task.id));
    if (pending) openFileSelection(pending);
  }, [activeTasks, fileSelectTaskId]);

  async function confirmFileSelection() {
    if (!fileSelectTask || fileSelectBusy) return;
    setFileSelectBusy(true);
    setError("");
    try {
      await window.codexh.selectDownloadFiles(fileSelectTask.id, [...fileChecked]);
      setFileSelectTaskId(null);
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setFileSelectBusy(false);
    }
  }

  // 子任务级控制：BT 多附件任务里对单个文件暂停/继续/移除。
  // 任务快照由主进程推送更新，这里只发起动作并展示错误。
  async function controlFile(taskId: string, index: number, action: "pause" | "resume" | "remove") {
    setError("");
    try {
      await window.codexh.controlDownloadFile(taskId, index, action);
    } catch (caught) {
      setError(cleanIpcError(caught));
    }
  }

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
              <div
                key={task.id}
                className={`downloads-item is-${task.status} ${expandedTaskId === task.id ? "is-expanded" : ""}`}
              >
                <div
                  className={`downloads-item-main ${task.kind === "p2p" && (task.files?.length ?? 0) > 0 || task.kind === "http" && task.segments.length > 0 ? "is-clickable" : ""}`}
                  title={task.kind === "p2p" && (task.files?.length ?? 0) > 0 || task.kind === "http" && task.segments.length > 0 ? "点击展开/收起任务详情" : undefined}
                  onClick={() => setExpandedTaskId((current) => (current === task.id ? null : task.id))}
                >
                  <div className="downloads-item-title" title={task.filePath || task.url}>
                    <span className="downloads-item-name">{task.fileName}</span>
                    <span className={`downloads-item-status is-${task.status}`}>{task.needsFileSelection ? "待选择文件" : STATUS_LABELS[task.status]}</span>
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
                  {task.status === "downloading" ? <button type="button" className="downloads-action-button" title="暂停" onClick={(event) => { event.stopPropagation(); void window.codexh.pauseDownload(task.id); }}>暂停</button> : null}
                  {task.status === "paused" ? <button type="button" className="downloads-action-button is-accent" title="继续" onClick={(event) => { event.stopPropagation(); void window.codexh.resumeDownload(task.id); }}>继续</button> : null}
                  <button
                    type="button"
                    className="downloads-action-button is-danger"
                    title="取消任务"
                    onClick={(event) => {
                      event.stopPropagation();
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
                {expandedTaskId === task.id ? (
                  <div className="downloads-task-detail" onClick={(event) => event.stopPropagation()}>
                    {task.kind === "p2p" && (task.files?.length ?? 0) > 0 ? (
                      <div className="downloads-file-list" aria-label="下载文件明细">
                        {(task.files ?? []).filter((file) => {
                          // 没选中的文件不展示：已移除的直接隐藏；勾选弹窗里
                          // 落选的也隐藏（单独暂停过的文件仍要显示，可继续）。
                          if ((task.removedFiles ?? []).includes(file.index)) return false;
                          const selected = task.selectedFiles;
                          if (task.fileSelectionDone && selected && !selected.includes(file.index) && !(task.pausedFiles ?? []).includes(file.index)) return false;
                          return true;
                        }).map((file) => {
                          const fileDone = file.length > 0 && file.downloaded >= file.length;
                          const filePaused = (task.pausedFiles ?? []).includes(file.index);
                          return (
                            <div key={file.index} className="downloads-file-row">
                              <span className="downloads-file-name" title={file.path || file.name}>{file.name}</span>
                              <span className="downloads-progress downloads-file-progress" aria-hidden><span className="downloads-progress-fill" style={{ width: `${Math.min(100, Math.max(0, file.progress)) * 100}%` }} /></span>
                              <span className="downloads-file-size">{formatBytes(file.downloaded)} / {formatBytes(file.length)}</span>
                              {fileDone ? null : (
                                <span className="downloads-file-actions">
                                  {filePaused ? (
                                    <button type="button" className="downloads-action-button is-accent" title="继续下载该文件" onClick={() => void controlFile(task.id, file.index, "resume")}>继续</button>
                                  ) : (
                                    <button type="button" className="downloads-action-button" title="仅暂停该文件" onClick={() => void controlFile(task.id, file.index, "pause")}>暂停</button>
                                  )}
                                  <button type="button" className="downloads-action-button is-danger" title="不再下载该文件" onClick={() => void controlFile(task.id, file.index, "remove")}>移除</button>
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : task.kind === "http" && task.segments.length > 0 ? (
                      <div className="downloads-file-list" aria-label="下载分段明细">
                        {task.segments.map((segment, index) => {
                          const size = segment.end < 0 ? 0 : segment.end - segment.start + 1;
                          const done = segment.end >= 0 && segment.downloaded >= size;
                          return (
                            <div key={index} className="downloads-file-row">
                              <span className="downloads-file-name">分段 {index + 1}</span>
                              <span className="downloads-progress downloads-file-progress" aria-hidden><span className="downloads-progress-fill" style={{ width: size > 0 ? `${Math.min(100, (segment.downloaded / size) * 100)}%` : "100%" }} /></span>
                              <span className="downloads-file-size">{done ? "完成" : `${formatBytes(segment.downloaded)}${size > 0 ? ` / ${formatBytes(size)}` : ""}`}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {task.kind === "p2p" && (task.files?.length ?? 0) > 1 && !task.fileSelectionDone ? (
                      <button
                        type="button"
                        className="downloads-action-button"
                        onClick={() => openFileSelection(task)}
                      >选择要下载的文件</button>
                    ) : null}
                  </div>
                ) : null}
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
    {fileSelectTask ? (
      <div className="project-sheet-overlay motion-overlay" data-motion={motionPhase}>
        <div className="project-sheet confirm-sheet delete-confirm-sheet clear-chat-confirm-sheet downloads-file-select-sheet" role="dialog" aria-modal="true" aria-label="选择要下载的文件">
          <div className="confirm-sheet-body delete-confirm-body clear-chat-confirm-body downloads-confirm-body downloads-file-select-body">
            <div className="downloads-file-select-head">
              <strong>选择要下载的文件</strong>
              <p>识别到 {fileSelectTask.files?.length ?? 0} 个附件，只会下载勾选的文件。</p>
            </div>
            <div className="downloads-file-select-columns">
              <button
                type="button"
                className={`downloads-file-select-sort ${fileSort.key === "name" ? "is-active" : ""}`}
                title="按文件名排序"
                onClick={() => toggleFileSort("name")}
              >文件名{fileSort.key === "name" ? <span className="downloads-file-sort-arrow">{fileSort.dir === "asc" ? "↑" : "↓"}</span> : null}</button>
              <button
                type="button"
                className={`downloads-file-select-sort downloads-file-select-sort-size ${fileSort.key === "size" ? "is-active" : ""}`}
                title="按文件大小排序"
                onClick={() => toggleFileSort("size")}
              >大小{fileSort.key === "size" ? <span className="downloads-file-sort-arrow">{fileSort.dir === "asc" ? "↑" : "↓"}</span> : null}</button>
            </div>
            <div className="downloads-file-select-list" aria-label="附件列表">
              {((): DownloadFileInfo[] => {
                const files = fileSelectTask.files ?? [];
                if (fileSort.key === null) return files;
                const sorted = [...files].sort((a, b) =>
                  fileSort.key === "size"
                    ? a.length - b.length
                    : a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true })
                );
                return fileSort.dir === "desc" ? sorted.reverse() : sorted;
              })().map((file) => (
                <label key={file.index} className="downloads-confirm-file">
                  <input
                    type="checkbox"
                    checked={fileChecked.has(file.index)}
                    onChange={(event) => toggleFileChecked(file.index, event.target.checked)}
                  />
                  <span className="downloads-file-select-name" title={file.path || file.name}>{file.name}</span>
                  <span className="downloads-file-select-size">{formatBytes(file.length)}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="project-sheet-actions downloads-file-select-actions">
            <label className="downloads-confirm-file downloads-file-select-all">
              <input
                type="checkbox"
                checked={fileChecked.size > 0 && fileChecked.size === (fileSelectTask.files?.length ?? 0)}
                ref={(element) => {
                  if (element) {
                    element.indeterminate = fileChecked.size > 0 && fileChecked.size < (fileSelectTask.files?.length ?? 0);
                  }
                }}
                onChange={(event) => toggleAllFiles(event.target.checked)}
              />
              <span>{fileChecked.size === (fileSelectTask.files?.length ?? 0) ? "取消全选" : "全选"}</span>
              <span className="downloads-file-select-count">已选 {fileChecked.size} / {fileSelectTask.files?.length ?? 0}</span>
            </label>
            <div className="downloads-file-select-buttons">
              <button
                className="button ghost"
                type="button"
                disabled={fileSelectBusy}
                onClick={() => {
                  dismissedFileSelectionRef.current.add(fileSelectTask.id);
                  setFileSelectTaskId(null);
                }}
              >暂不下载</button>
              <button
                className="button primary"
                type="button"
                disabled={fileChecked.size === 0 || fileSelectBusy}
                onClick={() => void confirmFileSelection()}
              >{fileSelectBusy ? "提交中…" : `下载勾选的 ${fileChecked.size} 个文件`}</button>
            </div>
          </div>
        </div>
      </div>
    ) : null}
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
        // downloads-confirm-body 把勾选行的样式作用域收敛到这里，避免被确认条
        // 里其它网格/对齐规则拆散「勾选框 + 文案」的同一行布局。
        bodyClassName="delete-confirm-body clear-chat-confirm-body downloads-confirm-body"
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
