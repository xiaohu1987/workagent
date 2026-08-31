import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Dispatch, SetStateAction } from "react";
import type { AppConfig, BrowserRecordingFamily } from "@shared-types";
import type { BrowserRecordingsController } from "../../../hooks/use-browser-recordings";
import { IconCheck, IconClose, IconCode, IconCopy, IconEye, IconFolder, IconPlay, IconRecord, IconRename, IconSpinner, IconTrash, IconSkills } from "../../../icons";
import { ConfirmationSheet } from "../../../workspace/confirmation-sheet";

export function RecordingPage({
  controller,
  configDraft,
  setConfigDraft,
  onSaveConfig
}: {
  controller: BrowserRecordingsController;
  configDraft: AppConfig | null;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  onSaveConfig: (options?: { showSuccessNotice?: boolean }) => Promise<void>;
}) {
  const [browser, setBrowser] = useState<BrowserRecordingFamily>("chrome");
  const [name, setName] = useState("");
  const [startUrlsText, setStartUrlsText] = useState("");
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [detailView, setDetailView] = useState<"document" | "script">("document");

  useEffect(() => {
    const selectedAvailable = controller.browsers.some((item) => item.family === "chrome" && item.available);
    if (!selectedAvailable) {
      setBrowser("chrome");
    }
  }, [browser, controller.browsers]);

  useEffect(() => {
    if (detailId && !controller.recordings.some((item) => item.id === detailId)) setDetailId(null);
  }, [detailId, controller.recordings]);

  const active = controller.session.mode === "recording" || controller.session.mode === "replaying" || controller.session.mode === "paused";
  const chromeBrowser = controller.browsers.find((item) => item.family === "chrome");
  const canStart = Boolean(controller.threadId) && chromeBrowser?.available === true && !active && !controller.busy;
  const startDisabledReason = !controller.threadId ? "请先选择一个聊天" : chromeBrowser?.available !== true ? "未检测到 Google Chrome，请配置 Chrome 可执行文件路径" : active ? "当前已有录制或回放正在运行" : controller.busy ? "正在处理上一个操作" : undefined;
  const chromePath = configDraft?.desktop.chromeExecutablePath ?? "";

  async function chooseChromePath(): Promise<void> {
    const selectedPath = await window.codexh.chooseChromeExecutablePath();
    if (selectedPath) {
      setConfigDraft((current) => current ? { ...current, desktop: { ...current.desktop, chromeExecutablePath: selectedPath } } : current);
    }
  }

  function clearChromePath(): void {
    setConfigDraft((current) => current ? { ...current, desktop: { ...current.desktop, chromeExecutablePath: undefined } } : current);
  }

  async function saveChromePath(): Promise<void> {
    await onSaveConfig();
    await controller.refresh();
  }
  const selected = controller.recordings.find((item) => item.id === detailId) ?? null;
  const deleting = controller.busy && deleteTarget !== null;

  async function submitStart(): Promise<void> {
    const startUrls = startUrlsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const started = await controller.start({ browser, name: name.trim() || undefined, startUrls });
    if (started) {
      setStartDialogOpen(false);
      setName("");
      setStartUrlsText("");
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    const removed = await controller.remove(target.id);
    if (removed) {
      setDeleteTarget(null);
      setDetailId(null);
    }
  }

  return (
    <div className="settings-section recording-settings-section">
      <section className="config-block recording-launcher recording-page-toolbar">
        <div className="section-copy"><strong>浏览器操作录制</strong><span>{!controller.threadId ? "请先选择一个聊天，再开始录制或回放。" : chromeBrowser?.available !== true ? "未检测到 Google Chrome，请在下方配置 Chrome 可执行文件路径。" : "使用独立的 Chrome 配置录制网页操作，并将进度写入当前聊天。"}</span></div>
        <div className="recording-toolbar-actions">
          <button type="button" className="button primary recording-start-button" disabled={!canStart} title={startDisabledReason} onClick={() => setStartDialogOpen(true)}>{controller.busy ? <IconSpinner /> : <IconRecord />}开始录制</button>
        </div>
      </section>
      <section className="config-block recording-chrome-path" aria-label="Chrome 路径配置">
        <div className="section-copy"><strong>Chrome 可执行文件路径</strong><span>自动检测不到 Chrome 时，可手动指定本机的 <code>chrome.exe</code>。保存后立即用于录制和回放。</span></div>
        <div className="recording-chrome-path-controls">
          <input className="text-input" value={chromePath} onChange={(event) => setConfigDraft((current) => current ? { ...current, desktop: { ...current.desktop, chromeExecutablePath: event.target.value } } : current)} placeholder="例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" aria-label="Chrome 可执行文件路径" />
          <button type="button" className="button ghost" onClick={() => void chooseChromePath()} title="浏览 Chrome 可执行文件" aria-label="浏览 Chrome 可执行文件"><IconFolder /></button>
          <button type="button" className="button ghost" onClick={clearChromePath} disabled={!chromePath} title="清除手动路径" aria-label="清除手动路径"><IconClose /></button>
          <button type="button" className="button primary" onClick={() => void saveChromePath()} title="保存 Chrome 路径" aria-label="保存 Chrome 路径"><IconCheck />保存</button>
        </div>
        {chromePath && chromeBrowser?.available !== true ? <small className="recording-path-warning">当前路径无效或不是 chrome.exe，请重新选择。</small> : null}
      </section>
      {controller.error ? <div className="recording-inline-error" role="alert">{controller.error}</div> : null}
      <section className="recording-list-panel recording-list-panel-full" aria-label="录制列表">
        <header><strong>录制列表</strong><span>{controller.recordings.length}</span></header>
        <div className="recording-list">
          {controller.loading ? <div className="recording-empty"><IconSpinner />正在加载</div> : controller.recordings.length === 0 ? <div className="recording-empty">暂无录制脚本</div> : controller.recordings.map((item) => (
            <div className="recording-list-item-row" key={item.id}>
              <span className="recording-list-icon"><IconCode /></span>
              <span className="recording-list-copy"><strong>{item.name}</strong><small>{item.browser === "edge" ? "Edge" : "Chrome"} · {item.stepCount} 步 · {formatStatus(item.status)}</small></span>
              <div className="recording-detail-actions recording-list-item-actions">
                <button type="button" title="播放" aria-label="播放" disabled={!controller.threadId || active || controller.busy || item.status === "invalid"} onClick={() => void controller.play(item.id)}><IconPlay /></button>
                <button type="button" title="重命名" aria-label="重命名" disabled={active || controller.busy} onClick={() => { controller.setSelectedId(item.id); setDetailId(item.id); setRenameOpen(true); setRenameValue(item.name); }}><IconRename /></button>
                <button type="button" title="复制脚本" aria-label="复制脚本" disabled={controller.busy || item.status === "invalid"} onClick={() => void controller.copyScript(item.id)}><IconCopy /></button>
                <button type="button" title="打开所在目录" aria-label="打开所在目录" disabled={controller.busy} onClick={() => void controller.openDirectory(item.id)}><IconFolder /></button>
                <button type="button" className="danger" title="删除" aria-label="删除" disabled={active || controller.busy} onClick={() => setDeleteTarget({ id: item.id, name: item.name })}><IconTrash /></button>
              </div>
              <button type="button" className="recording-view-button" onClick={() => { controller.setSelectedId(item.id); setDetailId(item.id); setRenameOpen(false); }} title="查看详情" aria-label="查看详情"><IconEye /></button>
            </div>
          ))}
        </div>
      </section>

      {startDialogOpen ? createPortal(
        <div className="project-sheet-overlay motion-overlay">
          <section className="project-sheet recording-start-dialog" role="dialog" aria-modal="true" aria-labelledby="recording-start-title">
            <header className="project-sheet-header"><div className="project-sheet-copy"><strong id="recording-start-title">开始录制</strong><span>选择浏览器并设置要同时打开的起始网址。</span></div><button className="project-sheet-close" type="button" onClick={() => setStartDialogOpen(false)} title="关闭" aria-label="关闭"><IconClose /></button></header>
            <div className="recording-start-dialog-form">
              <div className="recording-browser-segments" role="group" aria-label="录制浏览器">{controller.browsers.filter((item) => item.family === "chrome").map((item) => <button key={item.family} type="button" className="active" disabled={!item.available || active} onClick={() => setBrowser("chrome")} title={item.available ? item.executablePath ?? item.label : `${item.label} 未安装`}>{item.label}<small>{item.available ? "可用" : "未检测到"}</small></button>)}</div>
              <label className="settings-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="自动按时间命名" /></label>
              <label className="settings-field"><span>起始网址</span><textarea value={startUrlsText} onChange={(event) => setStartUrlsText(event.target.value)} placeholder="每行一个网址，可同时打开多个页面" rows={4} /></label>
              <div className="recording-security-warning" role="note">输入内容、密码和上传文件路径会以明文保存在录制目录的 <code>recording.config.json</code>。</div>
            </div>
            <div className="project-sheet-actions"><button className="button ghost" type="button" onClick={() => setStartDialogOpen(false)}>取消</button><button className="button primary" type="button" disabled={!canStart} onClick={() => void submitStart()}>{controller.busy ? <IconSpinner /> : <IconRecord />}开始录制</button></div>
          </section>
        </div>, document.body
      ) : null}

      {selected ? createPortal(
        <div className="project-sheet-overlay motion-overlay">
          <section className="project-sheet recording-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="recording-detail-title">
            <header className="project-sheet-header recording-detail-dialog-header"><div className="project-sheet-copy">{renameOpen ? <input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenameOpen(false); if (event.key === "Enter" && renameValue.trim()) void controller.rename(selected.id, renameValue).then((renamed) => { if (renamed) setRenameOpen(false); }); }} /> : <strong id="recording-detail-title">{selected.name}</strong>}<span>{(selected.startUrls?.length ? selected.startUrls : selected.startUrl ? [selected.startUrl] : []).join(" · ") || "未设置起始网址"}</span></div><div className="recording-detail-actions recording-detail-header-actions"><button type="button" title="播放" aria-label="播放" disabled={!controller.threadId || active || controller.busy || selected.status === "invalid"} onClick={() => void controller.play(selected.id)}><IconPlay /></button><button type="button" title="LLM 完善" aria-label="LLM 完善" disabled={!controller.threadId || active || controller.busy || selected.status === "invalid"} onClick={() => void controller.enhance(selected.id)}><IconSkills /></button><button type="button" title="重命名" aria-label="重命名" disabled={active} onClick={() => { setRenameOpen(true); setRenameValue(selected.name); }}><IconRename /></button><button type="button" title="复制操作文档" aria-label="复制操作文档" disabled={!controller.document} onClick={() => void controller.copyDocument(selected.id)}><IconCopy /></button><button type="button" title="复制脚本" aria-label="复制脚本" disabled={!controller.script} onClick={() => void controller.copyScript()}><IconCode /></button><button type="button" title="打开所在目录" aria-label="打开所在目录" onClick={() => void controller.openDirectory(selected.id)}><IconFolder /></button><button type="button" className="danger" title="删除" aria-label="删除" disabled={active} onClick={() => setDeleteTarget({ id: selected.id, name: selected.name })}><IconTrash /></button></div><button className="project-sheet-close" type="button" onClick={() => setDetailId(null)} title="关闭" aria-label="关闭"><IconClose /></button></header>
            <div className="recording-summary-row"><span><strong>{selected.stepCount}</strong>步骤</span><span><strong>{selected.browser === "edge" ? "Edge" : "Chrome"}</strong>浏览器</span><span><strong>{formatRunStatus(selected.lastRunStatus)}</strong>最近运行</span><span><strong>{selected.enhancedPlanStatus === "candidate" ? "待确认" : selected.enhancedPlanStatus === "approved" ? "LLM 已增强" : "规则计划"}</strong>计划</span><span><strong>{formatDate(selected.updatedAt)}</strong>更新时间</span></div>
            <div className="recording-detail-content">{selected.lastError ? <div className="recording-inline-error">{selected.lastError}</div> : null}{selected.enhancedPlanStatus === "candidate" ? <div className="recording-llm-candidate" role="status"><IconSkills /><span>LLM 已生成修复候选，请确认后从失败步骤继续。</span><div className="recording-detail-actions"><button type="button" title="采用修复候选" aria-label="采用修复候选" onClick={() => void controller.applyLlmCandidate(selected.id)}><IconPlay /></button><button type="button" title="放弃修复候选" aria-label="放弃修复候选" onClick={() => void controller.discardLlmCandidate(selected.id)}><IconTrash /></button></div></div> : null}<div className="recording-document-tabs" role="tablist"><button type="button" role="tab" aria-selected={detailView === "document"} className={detailView === "document" ? "active" : ""} onClick={() => setDetailView("document")}>操作说明</button><button type="button" role="tab" aria-selected={detailView === "script"} className={detailView === "script" ? "active" : ""} onClick={() => setDetailView("script")}>Playwright 脚本</button></div><div className="recording-script-preview"><div className="recording-script-title"><IconCode /><span>{detailView === "document" ? "recording.md" : "recording.ts"}</span></div><pre><code>{detailView === "document" ? (controller.document || "操作文档尚未生成。") : (controller.script || "脚本尚未生成。")}</code></pre></div></div>
          </section>
        </div>, document.body
      ) : null}

      {deleteTarget ? createPortal(<ConfirmationSheet titleId="recording-delete-confirm-title" title="删除录制？" description={<>将删除“{deleteTarget.name}”的录制文件，并移入系统回收站。对应的浏览器配置、Cookie 和登录状态不会受到影响。</>} confirmLabel={deleting ? "正在删除..." : "删除录制"} busy={deleting} onClose={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} />, document.body) : null}
    </div>
  );
}

function formatStatus(status: string): string { if (status === "ready") return "就绪"; if (status === "recording") return "录制中"; if (status === "interrupted") return "已中断"; return "不可用"; }
function formatRunStatus(status: string | null): string { if (status === "passed") return "通过"; if (status === "failed") return "失败"; if (status === "cancelled") return "已终止"; return "未运行"; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
