import type { Dispatch, SetStateAction } from "react";
import type { KnowledgeBaseSummary, KnowledgeDocumentRecord, KnowledgeImportSource, KnowledgeScope, RuntimeThreadSnapshot } from "@shared-types";
import { ComposerSelect } from "../../../workspace/composer-select";
import { IconClose, IconFile, IconFolder, IconGlobe, IconKnowledge, IconPlus, IconRefresh, IconSpinner, IconTrash } from "../../../icons";

type Props = {
  knowledgeSources: KnowledgeImportSource[];
  knowledgeName: string;
  setKnowledgeName: Dispatch<SetStateAction<string>>;
  knowledgeScope: KnowledgeScope;
  setKnowledgeScope: Dispatch<SetStateAction<KnowledgeScope>>;
  canImportProjectKnowledge: boolean;
  isKnowledgeUrlEditorOpen: boolean;
  setIsKnowledgeUrlEditorOpen: Dispatch<SetStateAction<boolean>>;
  knowledgeUrlInput: string;
  setKnowledgeUrlInput: Dispatch<SetStateAction<string>>;
  onAddUrls: () => boolean;
  onChooseSources: (kind: "files" | "folders") => Promise<unknown>;
  onRemoveSource: (key: string) => void;
  getSourceKey: (source: KnowledgeImportSource) => string;
  isKnowledgeImporting: boolean;
  onImport: () => Promise<unknown>;
  snapshot: RuntimeThreadSnapshot | null;
  knowledgeBases: KnowledgeBaseSummary[];
  knowledgeDocuments: Record<string, KnowledgeDocumentRecord[] | undefined>;
  knowledgeBusyId: string | null;
  onRefreshBases: () => Promise<unknown>;
  onToggleDocuments: (id: string) => Promise<unknown>;
  onRefreshBase: (id: string) => Promise<unknown>;
  onDeleteBase: (id: string) => Promise<unknown>;
  formatScope: (scope: KnowledgeScope) => string;
  formatStatus: (status: KnowledgeBaseSummary["status"]) => string;
  formatBytes: (bytes: number) => string;
  formatRelativeTime: (value: string) => string;
};

export function isDatabaseManagedKnowledgeBase(base: Pick<KnowledgeBaseSummary, "bundleRoot">): boolean {
  return base.bundleRoot.replace(/\\/g, "/").split("/").pop() === "quick-notes";
}

export function KnowledgePage({ knowledgeSources, knowledgeName, setKnowledgeName, knowledgeScope, setKnowledgeScope, canImportProjectKnowledge, isKnowledgeUrlEditorOpen, setIsKnowledgeUrlEditorOpen, knowledgeUrlInput, setKnowledgeUrlInput, onAddUrls: addKnowledgeUrls, onChooseSources: chooseKnowledgeSources, onRemoveSource: removeKnowledgeSource, getSourceKey: knowledgeSourceKey, isKnowledgeImporting, onImport: importKnowledge, snapshot, knowledgeBases, knowledgeDocuments, knowledgeBusyId, onRefreshBases: refreshKnowledgeBases, onToggleDocuments: toggleKnowledgeDocuments, onRefreshBase: refreshKnowledgeBase, onDeleteBase: deleteKnowledgeBase, formatScope: formatKnowledgeScope, formatStatus: formatKnowledgeStatus, formatBytes: formatKnowledgeBytes, formatRelativeTime }: Props) {
  return (
  <div className="settings-section knowledge-settings-section">
    <div className={`config-block knowledge-import-panel ${isKnowledgeImporting ? "is-importing" : ""}`}>
      <div className="section-copy section-copy-row knowledge-import-heading">
        <div>
          <strong>新建知识库</strong>
          <span>从本地文件、网页或当前浏览器页面创建可检索资料。</span>
        </div>
        <span className="knowledge-source-count">{knowledgeSources.length} 个来源</span>
      </div>
      <div className="knowledge-import-layout">
        <section className="knowledge-import-column knowledge-import-details" aria-label="知识库基本信息">
          <div className="knowledge-column-heading"><span>01</span><strong>基本信息</strong></div>
          <label className="settings-field">
            <span>名称</span>
            <input value={knowledgeName} onChange={(event) => setKnowledgeName(event.target.value)} placeholder="知识库名称" />
          </label>
          <label className="settings-field">
            <span>可见范围</span>
            <ComposerSelect
className="form-select knowledge-scope-select"
ariaLabel="可见范围"
value={knowledgeScope}
onChange={(scope) => setKnowledgeScope(scope as KnowledgeScope)}
options={[
  { value: "global", label: "全局知识库" },
  { value: "project", label: "项目知识库" },
  { value: "imported", label: "仅当前会话导入" }
]}
placeholder="选择可见范围"
            />
          </label>
          {knowledgeScope === "project" && !canImportProjectKnowledge ? <div className="knowledge-scope-warning">项目知识库需要先切换到项目聊天。</div> : null}
          <details className="knowledge-format-details">
            <summary>支持的文件格式</summary>
            <span>md、txt、json、html、csv、xlsx、xls、docx、pdf、pptx</span>
          </details>
        </section>
        <section className="knowledge-import-column knowledge-import-sources" aria-label="知识库来源">
          <div className="knowledge-column-heading"><span>02</span><strong>添加来源</strong></div>
          {isKnowledgeUrlEditorOpen ? (
            <div className="knowledge-url-editor">
<textarea autoFocus value={knowledgeUrlInput} onChange={(event) => setKnowledgeUrlInput(event.target.value)} placeholder="粘贴 URL，每行一个" rows={2} />
<div className="knowledge-url-editor-actions">
  <button className="button ghost" type="button" onClick={() => { setKnowledgeUrlInput(""); setIsKnowledgeUrlEditorOpen(false); }}>取消</button>
  <button className="button primary" type="button" onClick={() => { if (addKnowledgeUrls()) setIsKnowledgeUrlEditorOpen(false); }} disabled={!knowledgeUrlInput.trim()}>确定</button>
</div>
            </div>
          ) : null}
          <div className="knowledge-source-toolbar">
            <button className="button ghost" type="button" onClick={() => void chooseKnowledgeSources("files")}><IconFile />文件</button>
            <button className="button ghost" type="button" onClick={() => void chooseKnowledgeSources("folders")}><IconFolder />文件夹</button>
            <button className="button ghost" type="button" onClick={() => setIsKnowledgeUrlEditorOpen(true)}><IconPlus />添加 URL</button>
          </div>
          <div className="knowledge-source-list" aria-label="待导入来源">
            {knowledgeSources.length ? knowledgeSources.map((source) => (
              <div key={knowledgeSourceKey(source)} className={`knowledge-source-item ${source.kind}`}>
                <span className="knowledge-source-icon" aria-hidden>{source.kind === "folder" ? <IconFolder /> : source.kind === "file" ? <IconFile /> : <IconGlobe />}</span>
                <code title={source.kind === "file" || source.kind === "folder" ? source.path : source.url}>{source.kind === "file" || source.kind === "folder" ? source.path : source.url}</code>
                <button type="button" className="knowledge-source-remove" onClick={() => removeKnowledgeSource(knowledgeSourceKey(source))} title="移除来源" aria-label="移除来源"><IconClose /></button>
              </div>
            )) : <div className="knowledge-source-empty">尚未添加来源</div>}
          </div>
        </section>
      </div>
      <div className="knowledge-import-footer">
        <span>{knowledgeSources.length ? `将处理 ${knowledgeSources.length} 个来源` : "添加来源后即可导入"}</span>
        <button className="button primary" onClick={() => void importKnowledge()} disabled={isKnowledgeImporting || knowledgeSources.length === 0 || (knowledgeScope === "project" && !canImportProjectKnowledge)}>
          {isKnowledgeImporting ? <><IconSpinner />正在导入...</> : "导入并生成 Bundle"}
        </button>
      </div>
      {isKnowledgeImporting ? (
        <div className="knowledge-import-progress" role="status" aria-live="polite">
          <IconSpinner />
          <span>正在抓取网页内容并建立知识索引...</span>
        </div>
      ) : null}
    </div>

    <div className="config-block knowledge-binding-panel">
      <div className="section-copy section-copy-row">
        <div>
          <strong>当前任务可用</strong>
          <span>当前任务会自动检索这些知识库。</span>
        </div>
        <span className="knowledge-source-count">{snapshot?.knowledgeBases.length ?? 0}</span>
      </div>
      <div className="knowledge-binding-list">
        {snapshot?.knowledgeBases.length ? (
          snapshot.knowledgeBases.map((knowledgeBase) => (
            <article key={knowledgeBase.id} className="knowledge-binding-item">
              <span className="knowledge-binding-icon" aria-hidden><IconKnowledge /></span>
              <div>
                <strong>{knowledgeBase.displayName}</strong>
                <span>{formatKnowledgeScope(knowledgeBase.scope)}</span>
              </div>
            </article>
          ))
        ) : (
          <div className="knowledge-binding-empty">当前任务还没有可用知识库</div>
        )}
      </div>
    </div>
    <div className="config-block knowledge-management-panel">
      <div className="section-copy section-copy-row">
        <div>
          <strong>知识库管理</strong>
          <span>全局资料自动对所有聊天可见；项目资料仅对同一项目可见。</span>
        </div>
        <button className="button ghost compact-icon-button" onClick={() => void refreshKnowledgeBases()} title="刷新列表">
          <IconRefresh />
        </button>
      </div>
      <div className="knowledge-base-list">
        {knowledgeBases.length ? knowledgeBases.map((knowledgeBase) => {
          const documents = knowledgeDocuments[knowledgeBase.id];
          const isBusy = knowledgeBusyId === knowledgeBase.id;
          return (
            <article key={knowledgeBase.id} className="knowledge-base-row">
              <div className="knowledge-base-main">
                <div className="knowledge-base-title">
                  <strong>{knowledgeBase.displayName}</strong>
                  <span className={`knowledge-scope-pill ${knowledgeBase.scope}`}>{formatKnowledgeScope(knowledgeBase.scope)}</span>
                  <span className={`knowledge-status ${knowledgeBase.status}`}>{formatKnowledgeStatus(knowledgeBase.status)}</span>
                </div>
                {knowledgeBase.scopeTargetLabel ? (
                  <span className={`knowledge-base-target ${knowledgeBase.scope}`} title={knowledgeBase.scopeTargetLabel}>
                    {knowledgeBase.scopeTargetLabel}
                  </span>
                ) : null}
                <span className="knowledge-base-meta">
                  {knowledgeBase.documentCount} 个文档 · {knowledgeBase.chunkCount} 个片段 · {formatKnowledgeBytes(knowledgeBase.indexedBytes)} · 更新于 {formatRelativeTime(knowledgeBase.updatedAt)}
                </span>
              </div>
              <div className="knowledge-base-actions">
                <button className="button ghost" onClick={() => void toggleKnowledgeDocuments(knowledgeBase.id)}>
                  {documents ? "收起文档" : "查看文档"}
                </button>
                {isDatabaseManagedKnowledgeBase(knowledgeBase) ? null : (
                  <button className="button ghost" onClick={() => void refreshKnowledgeBase(knowledgeBase.id)} disabled={isBusy}>
                    {isBusy ? "处理中" : "刷新"}
                  </button>
                )}
                <button className="button ghost danger-icon-button" onClick={() => void deleteKnowledgeBase(knowledgeBase.id)} disabled={isBusy} title="删除知识库">
                  <IconTrash />
                </button>
              </div>
              {documents ? (
                <div className="knowledge-document-list">
                  {documents.map((document) => (
                    <div key={document.id} className={`knowledge-document-row ${document.status}`}>
                      <IconFile />
                      <span title={document.sourcePath}>{document.title}</span>
                      <small>{document.status === "missing" ? "源文件已删除" : document.status}</small>
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          );
        }) : <div className="detail-empty">尚未导入本地知识库。</div>}
      </div>
    </div>
  </div>
  );
}
