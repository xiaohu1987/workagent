import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { IconClose, IconFile, IconPlus, IconSpinner } from "../icons";
import { renderMarkdownDocument } from "../markdown";
import { getFilePreviewLanguage, highlightFilePreview } from "./file-preview-utils";
import { WorkspaceEmptyState } from "./panels";
import {
  countDocumentLines,
  getDocumentIndentSize,
  getDocumentSelectionPosition,
  indentDocumentSelection,
  insertDocumentIndent,
  isDocumentDirty,
  type DocumentIndentResult
} from "./document-editing";
import {
  DOCUMENT_CHOOSE_EXTENSIONS,
  getDocumentViewKindLabel,
  getDocumentViewModeLabel,
  getDocumentViewModes,
  isSupportedDocumentPath,
  type DocumentViewKind,
  type DocumentViewMode
} from "./document-viewer-utils";
import { useDocumentTabs, type DocumentTab } from "../hooks/use-document-tabs";

type DocumentViewerPanelProps = {
  motionPhase: string;
  onClose: () => void;
  /** 把「请求收起」的能力交给上层，让 Esc 与侧栏再次点击也走未保存确认。 */
  onRegisterCloseRequest?: (handler: (() => void) | null) => void;
};

/** 超过这个体积就不再逐键做语法高亮，避免大文件编辑时输入延迟。 */
const DOCUMENT_HIGHLIGHT_LIMIT = 200_000;

/** 关闭确认与保存上限的说明文案只在这里维护一份。 */
const DOCUMENT_TRUNCATED_NOTE = "文件内容过长，仅显示前 512 KB。";

/** 空态里列出的代表格式，让「支持什么」一眼可见，而不是一段说明文字。 */
const DOCUMENT_EMPTY_BADGES = ["Markdown", "HTML", "C#", "SQL", "JSON", "纯文本"];

/**
 * 查看文档：与随手记、接口卡片同构，常驻聊天区显示与操作。
 * 支持一次打开多个文件形成页签，Markdown/HTML 可在预览与源码之间切换，
 * 代码与文本按后缀名高亮并允许直接编辑后保存。
 */
export function DocumentViewerPanel({ motionPhase, onClose, onRegisterCloseRequest }: DocumentViewerPanelProps) {
  const documents = useDocumentTabs(onClose);
  const { tabs, activeTab, activeTabId, pendingAction, picking, dirtyCount, requestClosePanel } = documents;
  const [dropActive, setDropActive] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const dropDepthRef = useRef(0);

  useEffect(() => {
    if (!onRegisterCloseRequest) {
      return;
    }
    onRegisterCloseRequest(requestClosePanel);
    return () => onRegisterCloseRequest(null);
  }, [onRegisterCloseRequest, requestClosePanel]);

  /** 只接管文件拖拽：拖文字或链接时保持原生行为，不弹落点提示。 */
  function isFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dropDepthRef.current += 1;
    setDropActive(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!isFileDrag(event)) {
      return;
    }
    // 在子元素之间移动也会触发 leave，用进出计数避免提示闪烁。
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (dropDepthRef.current === 0) {
      setDropActive(false);
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>) {
    if (!isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dropDepthRef.current = 0;
    setDropActive(false);
    const dropped = Array.from(event.dataTransfer.files);
    // 拖进来的文件在渲染层拿不到本地路径，统一交给预加载脚本解析成绝对路径。
    const paths = dropped
      .map((file) => window.codexh.resolveDroppedFilePath(file))
      .filter((path) => path.length > 0);
    const supported = paths.filter(isSupportedDocumentPath);
    const ignored = dropped.length - supported.length;
    setDropNotice(
      ignored > 0
        ? supported.length > 0
          ? `已打开 ${supported.length} 个文档，忽略 ${ignored} 个不支持的文件。`
          : `忽略 ${ignored} 个不支持的文件，这里只打开 Markdown、HTML、代码与文本。`
        : null
    );
    if (supported.length > 0) {
      void documents.openDroppedPaths(supported);
    }
  }

  return (
    <section
      className={`document-viewer-sheet document-viewer-inline${dropActive ? " is-drop-target" : ""}`}
      aria-label="查看文档"
      data-motion={motionPhase}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="project-sheet-header document-viewer-header">
        <div className="document-viewer-header-leading">
          <button
            className="document-viewer-open-button"
            type="button"
            title="新建空白页"
            aria-label="新建空白页"
            onClick={documents.newBlankDocument}
          >
            <IconPlus />
          </button>
          <button
            className="document-viewer-open-button"
            type="button"
            disabled={picking}
            title={`打开文件（${DOCUMENT_CHOOSE_EXTENSIONS.length} 种可识别后缀）`}
            aria-label="打开文件"
            onClick={() => void documents.openDocuments()}
          >
            {picking ? <IconSpinner /> : <IconFile />}
          </button>
        </div>
        <div className="document-viewer-header-actions">
          {activeTab ? (
            <span className="document-viewer-kind-chip">{getDocumentViewKindLabel(activeTab.kind)}</span>
          ) : null}
          {activeTab ? (
            <DocumentViewerModeSwitch
              kinds={activeTab.kind}
              mode={activeTab.mode}
              onSelect={(mode) => documents.setTabMode(activeTab.id, mode)}
            />
          ) : null}
          <button
            className="project-sheet-close"
            type="button"
            title="收起查看文档"
            aria-label="收起查看文档"
            onClick={requestClosePanel}
          >
            <IconClose />
          </button>
        </div>
      </header>
      {dropNotice ? (
        <div className="document-viewer-drop-notice" role="status">
          {dropNotice}
        </div>
      ) : null}
      {tabs.length > 0 ? (
        <DocumentTabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={documents.selectTab}
          onCloseTab={documents.requestCloseTab}
        />
      ) : null}
      <div className="document-viewer-inline-body">
        <DocumentViewerContent
          tab={activeTab}
          picking={picking}
          onOpen={() => void documents.openDocuments()}
          onChange={documents.updateContent}
          onSave={documents.saveTab}
          onSaveAs={documents.saveTabAs}
        />
      </div>
      {dropActive ? (
        <div className="document-viewer-drop-hint" aria-hidden="true">
          <span className="document-viewer-drop-hint-icon"><IconFile /></span>
          <span className="document-viewer-drop-hint-title">松开即可打开文档</span>
          <span className="document-viewer-drop-hint-copy">支持一次拖入多个文件，不支持的格式会跳过</span>
        </div>
      ) : null}
      {pendingAction ? (
        <DocumentViewerConfirmation
          message={
            pendingAction.type === "closePanel"
              ? `${dirtyCount} 个页签有未保存的修改，收起前要保存吗？`
              : `「${tabs.find((tab) => tab.id === pendingAction.tabId)?.title ?? "文档"}」有未保存的修改，关闭前要保存吗？`
          }
          onDecision={documents.resolvePendingAction}
          onCancel={documents.cancelPendingAction}
        />
      ) : null}
    </section>
  );
}

type DocumentViewerModeSwitchProps = {
  kinds: DocumentViewKind;
  mode: DocumentViewMode;
  onSelect: (mode: DocumentViewMode) => void;
};

/** 预览 / 源码切换；只有 Markdown 与 HTML 有两种形态，其它类型不显示。 */
function DocumentViewerModeSwitch({ kinds, mode, onSelect }: DocumentViewerModeSwitchProps) {
  const modes = useMemo(() => getDocumentViewModes(kinds), [kinds]);
  if (modes.length < 2) {
    return null;
  }
  return (
    <div className="document-viewer-mode-switch" role="group" aria-label="展示方式">
      {modes.map((item) => (
        <button
          key={item}
          type="button"
          className={`document-viewer-mode-button ${mode === item ? "is-active" : ""}`}
          onClick={() => onSelect(item)}
        >
          {getDocumentViewModeLabel(item)}
        </button>
      ))}
    </div>
  );
}

type DocumentTabStripProps = {
  tabs: DocumentTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
};

/** 页签栏：每个页签显示文件名、未保存圆点与关闭按钮，改动落在哪个文件一眼可见。 */
function DocumentTabStrip({ tabs, activeTabId, onSelect, onCloseTab }: DocumentTabStripProps) {
  return (
    <div className="document-tab-strip" role="tablist" aria-label="打开的文档">
      {tabs.map((tab) => {
        const dirty = !tab.binary && isDocumentDirty(tab.content, tab.savedContent);
        return (
          <div key={tab.id} className={`document-tab ${tab.id === activeTabId ? "is-active" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              className="document-tab-label"
              title={tab.path || "尚未保存到磁盘"}
              onClick={() => onSelect(tab.id)}
            >
              <span className="document-tab-name">{tab.title}</span>
              {dirty ? <span className="document-tab-dirty" aria-label="未保存">●</span> : null}
            </button>
            <button
              type="button"
              className="document-tab-close"
              title={`关闭 ${tab.title}`}
              aria-label={`关闭 ${tab.title}`}
              onClick={() => onCloseTab(tab.id)}
            >
              <IconClose />
            </button>
          </div>
        );
      })}
    </div>
  );
}

type DocumentViewerContentProps = {
  tab: DocumentTab | null;
  picking: boolean;
  onOpen: () => void;
  onChange: (tabId: string, content: string) => void;
  onSave: (tabId: string) => Promise<boolean>;
  onSaveAs: (tabId: string) => Promise<boolean>;
};

function DocumentViewerContent({ tab, picking, onOpen, onChange, onSave, onSaveAs }: DocumentViewerContentProps) {
  if (!tab) {
    return <DocumentViewerEmptyState picking={picking} onOpen={onOpen} />;
  }
  if (tab.error) {
    return <div className="project-preview-note project-preview-note-error">打开失败：{tab.error}</div>;
  }
  if (tab.loading) {
    return <WorkspaceEmptyState icon={<IconSpinner />} title="读取中" message="正在读取文件..." />;
  }
  if (tab.binary) {
    return <div className="project-preview-note">二进制文件无法直接预览或编辑。</div>;
  }
  if (tab.kind === "markdown" && tab.mode === "rendered") {
    return (
      <div className="document-viewer-content">
        <div className="document-viewer-markdown">
          {renderMarkdownDocument(tab.content, `document-viewer-${tab.path}`, "message-markdown")}
        </div>
        {tab.truncated ? <div className="project-preview-note">{DOCUMENT_TRUNCATED_NOTE}</div> : null}
      </div>
    );
  }
  if (tab.kind === "html" && tab.mode === "rendered") {
    return (
      <div className="document-viewer-content">
        <iframe className="document-viewer-html-frame" title={tab.path} sandbox="" srcDoc={tab.content} />
        {tab.truncated ? <div className="project-preview-note">{DOCUMENT_TRUNCATED_NOTE}</div> : null}
      </div>
    );
  }
  return (
    <DocumentEditor
      tab={tab}
      onChange={(content) => onChange(tab.id, content)}
      onSave={() => onSave(tab.id)}
      onSaveAs={() => onSaveAs(tab.id)}
    />
  );
}

type DocumentEditorProps = {
  tab: DocumentTab;
  onChange: (content: string) => void;
  onSave: () => Promise<boolean>;
  onSaveAs: () => Promise<boolean>;
};

/** 空态：把「支持哪些格式」与打开入口收进同一张卡片，比一行素文字更容易上手。 */
function DocumentViewerEmptyState({ picking, onOpen }: { picking: boolean; onOpen: () => void }) {
  return (
    <div className="document-viewer-empty">
      <div className="document-viewer-empty-card">
        <span className="document-viewer-empty-icon" aria-hidden="true"><IconFile /></span>
        <h3 className="document-viewer-empty-title">还没有打开文档</h3>
        <p className="document-viewer-empty-copy">
          打开的文件按后缀名自动处理：Markdown 与 HTML 可随时切换预览与源码，代码与文本按语法高亮，编辑后可直接保存。
        </p>
        <p className="document-viewer-empty-copy">
          也可以把文件从系统里直接拖进来，一次拖多个会各开一个页签。
        </p>
        <div className="document-viewer-empty-badges" aria-label="支持的格式">
          {DOCUMENT_EMPTY_BADGES.map((badge) => (
            <span key={badge} className="document-viewer-empty-badge">{badge}</span>
          ))}
        </div>
        <button className="document-viewer-empty-open" type="button" disabled={picking} onClick={onOpen}>
          <IconPlus />
          <span>{picking ? "选择中..." : "打开文件"}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * 源码编辑器：行号 + 语法高亮的展示层与真实 textarea 叠在一起，
 * 编辑始终落在 textarea 上，高亮层只做背景，滚动与行号保持同步。
 */
function DocumentEditor({ tab, onChange, onSave, onSaveAs }: DocumentEditorProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const language = useMemo(() => getFilePreviewLanguage(tab.path), [tab.path]);
  const highlightEnabled = tab.content.length <= DOCUMENT_HIGHLIGHT_LIMIT;
  const highlightedHtml = useMemo(
    () => (highlightEnabled ? highlightFilePreview(tab.content, language.id).join("\n") : ""),
    [highlightEnabled, tab.content, language.id]
  );
  const lineNumbers = useMemo(
    () => Array.from({ length: countDocumentLines(tab.content) }, (_, index) => index + 1).join("\n"),
    [tab.content]
  );

  function syncScroll() {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = input.scrollTop;
    }
    if (highlightRef.current) {
      highlightRef.current.scrollTop = input.scrollTop;
      highlightRef.current.scrollLeft = input.scrollLeft;
    }
  }

  function updateCaret() {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    setCaret(getDocumentSelectionPosition(input.value, input.selectionStart ?? 0));
  }

  function applyIndentResult(result: DocumentIndentResult) {
    onChange(result.content);
    // 受控组件要等 React 回写 value 之后再恢复选区。
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) {
        return;
      }
      input.selectionStart = result.selectionStart;
      input.selectionEnd = result.selectionEnd;
      updateCaret();
    });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget;
    if (event.key === "Tab") {
      event.preventDefault();
      const indentSize = getDocumentIndentSize(tab.kind);
      applyIndentResult(
        event.shiftKey
          ? indentDocumentSelection(input.value, input.selectionStart, input.selectionEnd, indentSize, true)
          : insertDocumentIndent(input.value, input.selectionStart, input.selectionEnd, indentSize)
      );
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void (event.shiftKey ? onSaveAs() : onSave());
    }
  }

  return (
    <div className="document-editor">
      <div className="document-editor-toolbar">
        <span className="document-editor-language">{language.label}</span>
        <span className="document-editor-path" title={tab.path}>{tab.path}</span>
        <div className="document-editor-actions">
          <button
            type="button"
            className="document-editor-action"
            disabled={tab.truncated}
            title={tab.truncated ? "文件超过预览上限，已禁止保存以免截断" : "保存（Ctrl+S）"}
            onClick={() => void onSave()}
          >
            保存
          </button>
          <button
            type="button"
            className="document-editor-action"
            title="另存为（Ctrl+Shift+S）"
            onClick={() => void onSaveAs()}
          >
            另存为
          </button>
        </div>
      </div>
      <div className="document-editor-surface">
        <pre className="document-editor-gutter" ref={gutterRef} aria-hidden="true">{lineNumbers}</pre>
        <div className="document-editor-scroll">
          {highlightEnabled ? (
            <pre
              className="document-editor-highlight"
              ref={highlightRef}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : null}
          <textarea
            className="document-editor-input"
            ref={inputRef}
            value={tab.content}
            aria-label={`${tab.title} 源码`}
            wrap="off"
            spellCheck={false}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onScroll={syncScroll}
            onSelect={updateCaret}
            onClick={updateCaret}
            onKeyUp={updateCaret}
          />
        </div>
      </div>
      <div className="document-editor-status" role="status">
        <span>第 {caret.line} 行，第 {caret.column} 列</span>
        <span>{countDocumentLines(tab.content)} 行</span>
        <span>{language.label}</span>
        <span>{tab.lineEnding === "crlf" ? "CRLF" : "LF"}</span>
        <span>UTF-8</span>
        {tab.truncated ? <span className="document-editor-warning">仅显示前 512 KB，已禁止保存</span> : null}
      </div>
    </div>
  );
}

type DocumentViewerConfirmationProps = {
  message: string;
  onDecision: (decision: "save" | "discard") => Promise<void>;
  onCancel: () => void;
};

/** 关闭确认条：与仓库其它确认条一致地贴在面板底部，不抢焦点也不做遮罩。 */
function DocumentViewerConfirmation({ message, onDecision, onCancel }: DocumentViewerConfirmationProps) {
  return (
    <div className="document-viewer-confirm" role="alertdialog" aria-label="未保存的修改">
      <span className="document-viewer-confirm-message">{message}</span>
      <div className="document-viewer-confirm-actions">
        <button type="button" className="document-viewer-confirm-save" onClick={() => void onDecision("save")}>
          保存
        </button>
        <button type="button" className="document-viewer-confirm-discard" onClick={() => void onDecision("discard")}>
          不保存
        </button>
        <button type="button" className="document-viewer-confirm-cancel" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
