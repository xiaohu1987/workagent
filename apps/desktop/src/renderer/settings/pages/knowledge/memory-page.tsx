import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppConfig, ErrorSolutionRecord, SelfImprovementMemoryRecord, SelfImprovementMemoryStats } from "@shared-types";
import { ComposerSelect, type ComposerSelectOption } from "../../../workspace/composer-select";
import { MemoryPagination } from "../../../workspace/memory-pagination";
import type { MemoryScopeFilter } from "../../../hooks/use-self-improvement-memories";
import { IconChevronDown, IconKnowledge, IconRefresh, IconTrash } from "../../../icons";

type Props = {
  configDraft: AppConfig | null;
  setConfigDraft: Dispatch<SetStateAction<AppConfig | null>>;
  selfImprovementMemories: SelfImprovementMemoryRecord[];
  visibleSelfImprovementMemories: SelfImprovementMemoryRecord[];
  selfImprovementMemoryStats: SelfImprovementMemoryStats;
  memoryScopeFilter: MemoryScopeFilter;
  setMemoryScopeFilter: Dispatch<SetStateAction<MemoryScopeFilter>>;
  selfImprovementMemoryListRef: MutableRefObject<HTMLDivElement | null>;
  safeSelfImprovementMemoryPage: number;
  selfImprovementMemoryPageCount: number;
  setSelfImprovementMemoryPage: Dispatch<SetStateAction<number>>;
  isRefreshingSelfImprovementMemories: boolean;
  isClearingSelfImprovement: boolean;
  onRefreshMemories: () => Promise<unknown>;
  onOpenClearMemories: () => void;
  onSaveConfig: () => Promise<unknown>;
  onDeleteMemory: (id: string) => Promise<unknown>;
  errorSolutionModelFilter: string;
  setErrorSolutionModelFilter: Dispatch<SetStateAction<string>>;
  setErrorSolutionPage: Dispatch<SetStateAction<number>>;
  onRefreshErrorSolutions: (modelId?: string) => Promise<unknown>;
  errorSolutionModelOptions: ComposerSelectOption[];
  errorSolutions: ErrorSolutionRecord[];
  visibleErrorSolutions: ErrorSolutionRecord[];
  errorSolutionListRef: MutableRefObject<HTMLDivElement | null>;
  safeErrorSolutionPage: number;
  errorSolutionPageCount: number;
  isClearingErrorSolutions: boolean;
  errorSolutionBusyId: string | null;
  expandedErrorSolutionIds: Set<string>;
  resolveModelLabel: (modelId: string) => string;
  getRecallStatus: (outcome: ErrorSolutionRecord["lastRecallOutcome"]) => string | null;
  formatRelativeTime: (value: string) => string;
  onToggleExpanded: (id: string) => void;
  onDeleteErrorSolution: (id: string) => Promise<unknown>;
  onOpenClearErrorSolutions: () => void;
};

export function MemoryPage({ configDraft, setConfigDraft, selfImprovementMemories, visibleSelfImprovementMemories, selfImprovementMemoryStats, memoryScopeFilter, setMemoryScopeFilter, selfImprovementMemoryListRef, safeSelfImprovementMemoryPage, selfImprovementMemoryPageCount, setSelfImprovementMemoryPage, isRefreshingSelfImprovementMemories, isClearingSelfImprovement, onRefreshMemories: refreshSelfImprovementNow, onOpenClearMemories, onSaveConfig: saveConfigDraft, onDeleteMemory: deleteSelfImprovementMemory, errorSolutionModelFilter, setErrorSolutionModelFilter, setErrorSolutionPage, onRefreshErrorSolutions: refreshErrorSolutions, errorSolutionModelOptions, errorSolutions, visibleErrorSolutions, errorSolutionListRef, safeErrorSolutionPage, errorSolutionPageCount, isClearingErrorSolutions, errorSolutionBusyId, expandedErrorSolutionIds, resolveModelLabel: resolveErrorSolutionModelLabel, getRecallStatus: getErrorSolutionRecallStatus, formatRelativeTime, onToggleExpanded: toggleErrorSolutionExpanded, onDeleteErrorSolution: deleteErrorSolution, onOpenClearErrorSolutions }: Props) {
  const memoryScopeTabs: Array<{ id: MemoryScopeFilter; label: string; count: number; hint: string }> = [
    { id: "all", label: "全部", count: selfImprovementMemoryStats.total, hint: "项目记忆与全局记忆合并显示" },
    { id: "project", label: "项目记忆", count: selfImprovementMemoryStats.project, hint: "只在所属项目中使用" },
    { id: "global", label: "全局记忆", count: selfImprovementMemoryStats.global, hint: "所有项目共享的通用事实" }
  ];
  return (
  <div className="settings-section memory-settings-section">
    <div className="config-block memory-management-panel">
      <div className="section-copy">
        <strong>记忆</strong>
        <span>任务完成后自动提炼脱敏经验，并按作用域分开管理：项目记忆只在对应项目中使用，全局记忆在所有项目共享。</span>
      </div>
      {configDraft ? (
        <div className="memory-toolbar">
          <div className="memory-toolbar-main">
            <div className="memory-option-row" role="group" aria-label="记忆开关">
              <label className="memory-option"><input type="checkbox" checked={configDraft.selfImprovement.generateMemories} onChange={(event) => setConfigDraft((current) => current ? { ...current, selfImprovement: { ...current.selfImprovement, generateMemories: event.target.checked } } : current)} /><span>生成经验</span></label>
              <label className="memory-option" title="主任务完成后自动调用模型提炼记忆"><input type="checkbox" checked={configDraft.selfImprovement.autoDistillOnComplete} onChange={(event) => setConfigDraft((current) => current ? { ...current, selfImprovement: { ...current.selfImprovement, autoDistillOnComplete: event.target.checked } } : current)} /><span>完成自动提炼</span></label>
              <label className="memory-option"><input type="checkbox" checked={configDraft.selfImprovement.useMemories} onChange={(event) => setConfigDraft((current) => current ? { ...current, selfImprovement: { ...current.selfImprovement, useMemories: event.target.checked } } : current)} /><span>任务中使用</span></label>
              <label className="memory-option" title="允许模型通过专用工具检索与写入记忆"><input type="checkbox" checked={configDraft.selfImprovement.dedicatedTools} onChange={(event) => setConfigDraft((current) => current ? { ...current, selfImprovement: { ...current.selfImprovement, dedicatedTools: event.target.checked } } : current)} /><span>专用工具</span></label>
            </div>
            <span className="memory-toolbar-sep" aria-hidden="true" />
            <div className="memory-param-row">
              <label className="memory-param" title="超过该天数的记忆会被自动清理"><span>保留天数</span><input className="memory-param-input" type="number" min="7" max="3650" value={configDraft.selfImprovement.retentionDays} onChange={(event) => setConfigDraft((current) => current ? { ...current, selfImprovement: { ...current.selfImprovement, retentionDays: Number(event.target.value) || 180 } } : current)} /></label>
              <label className="memory-param" title="记忆总量上限，超出后优先清理低频记录"><span>最大记录</span><input className="memory-param-input" type="number" min="20" max="5000" value={configDraft.selfImprovement.maxMemories} onChange={(event) => setConfigDraft((current) => current ? { ...current, selfImprovement: { ...current.selfImprovement, maxMemories: Number(event.target.value) || 500 } } : current)} /></label>
            </div>
          </div>
          <div className="memory-toolbar-actions">
            <div className="memory-scope-tabs" role="tablist" aria-label="记忆作用域">
              {memoryScopeTabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`memory-scope-tab${memoryScopeFilter === tab.id ? " is-active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={memoryScopeFilter === tab.id}
                  title={tab.hint}
                  onClick={() => {
                    setMemoryScopeFilter(tab.id);
                    setSelfImprovementMemoryPage(0);
                  }}
                >
                  {tab.label}
                  <span className="memory-scope-tab-count">{tab.count}</span>
                </button>
              ))}
            </div>
            <span className="memory-toolbar-sep" aria-hidden="true" />
            <button className="button ghost" type="button" onClick={() => void refreshSelfImprovementNow()} disabled={isRefreshingSelfImprovementMemories}><IconRefresh /><span>{isRefreshingSelfImprovementMemories ? "提炼中" : "立即提炼"}</span></button>
            <button className="button ghost" type="button" onClick={onOpenClearMemories} disabled={selfImprovementMemories.length === 0 || isClearingSelfImprovement}><IconTrash /><span>清空记忆</span></button>
            <button className="button ghost" type="button" onClick={() => void saveConfigDraft()}><span>保存设置</span></button>
          </div>
        </div>
      ) : null}
      <div ref={selfImprovementMemoryListRef} className="memory-solution-list memory-paged-list" aria-label="自我完善经验列表">
        {visibleSelfImprovementMemories.map((memory) => (
          <article key={memory.id} className="memory-solution-card">
            <div className="memory-solution-card-head"><div className="memory-solution-card-copy"><div className="memory-solution-card-title"><strong>{memory.title}</strong><span className="memory-meta-chip soft">{memory.scope === "project" ? "项目" : "全局"}</span><span className="memory-meta-chip soft">{memory.source === "manual" ? "手动" : "自动提炼"}</span>{memory.usageCount > 0 ? <span className="memory-meta-chip soft">引用 {memory.usageCount} 次</span> : null}</div><p className="memory-solution-summary">{memory.content}</p></div><button className="button ghost danger-icon-button" type="button" title="删除经验" onClick={() => void deleteSelfImprovementMemory(memory.id)}><IconTrash /></button></div>
          </article>
        ))}
        {!visibleSelfImprovementMemories.length ? <div className="memory-empty-state"><div className="memory-empty-icon" aria-hidden><IconKnowledge /></div><strong>{selfImprovementMemories.length ? "当前范围暂无记忆" : "暂无记忆记录"}</strong><p>{selfImprovementMemories.length ? "切换到其他作用域，或调整上方筛选。" : "主任务完成约 20 秒后会自动提炼为记忆。"}</p></div> : null}
      </div>
      <MemoryPagination
        label="记忆列表"
        page={safeSelfImprovementMemoryPage}
        pageCount={selfImprovementMemoryPageCount}
        totalCount={visibleSelfImprovementMemories.length}
        onPageChange={(page) => {
          setSelfImprovementMemoryPage(page);
          window.requestAnimationFrame(() => selfImprovementMemoryListRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
        }}
      />
    </div>
    <div className="config-block memory-management-panel">
      <div className="section-copy">
        <strong>错误恢复经验</strong>
        <span>按模型隔离存储；不同模型的失败模式不会互相干扰。</span>
      </div>

      <div className="memory-toolbar">
        <div className="memory-toolbar-main">
          <label className="memory-filter-field">
            <span>模型</span>
            <ComposerSelect
              className="form-select memory-model-filter"
              ariaLabel="按模型筛选记忆"
              value={errorSolutionModelFilter}
              onChange={(value) => {
                setErrorSolutionModelFilter(value);
                setErrorSolutionPage(0);
                void refreshErrorSolutions(value);
              }}
              options={errorSolutionModelOptions}
              placeholder="选择模型"
            />
          </label>
        </div>
        <div className="memory-toolbar-actions">
          <span className="memory-count-pill">{errorSolutions.length} 条记录</span>
          <span className="memory-toolbar-sep" aria-hidden="true" />
          <button
            className="button ghost"
            type="button"
            onClick={() => void refreshErrorSolutions()}
            title="刷新列表"
          >
            <IconRefresh />
            <span>刷新</span>
          </button>
          <button
            className="button ghost"
            type="button"
            disabled={errorSolutions.length === 0 || isClearingErrorSolutions}
            onClick={onOpenClearErrorSolutions}
          >
            <IconTrash />
            <span>{errorSolutionModelFilter === "all" ? "清空全部" : "清空当前模型"}</span>
          </button>
        </div>
      </div>

      <div ref={errorSolutionListRef} className="memory-solution-list memory-paged-list" aria-label="错误恢复经验列表">
        {visibleErrorSolutions.length ? visibleErrorSolutions.map((solution) => {
          const isBusy = errorSolutionBusyId === solution.id;
          const isExpanded = expandedErrorSolutionIds.has(solution.id);
          const modelLabel = resolveErrorSolutionModelLabel(solution.modelId);
          const recallCount = solution.recallCount ?? 0;
          const recallStatus = getErrorSolutionRecallStatus(solution.lastRecallOutcome);
          return (
            <article key={solution.id} className={`memory-solution-card${isExpanded ? " is-expanded" : ""}`}>
              <div className="memory-solution-card-head">
                <div className="memory-solution-card-copy">
                  <div className="memory-solution-card-title">
                    <strong title={solution.toolName}>{solution.toolName}</strong>
                    <span className="memory-meta-chip">{modelLabel}</span>
                    <span className="memory-meta-chip soft">成功 {solution.successCount} 次</span>
                  </div>
                  <p className="memory-solution-summary" title={solution.solutionSummary}>
                    {solution.solutionSummary}
                  </p>
                  <div className="memory-solution-card-meta">
                    <span title={solution.taskKeyPattern}>{solution.taskKeyPattern}</span>
                    <span>{solution.projectId ? "项目范围" : "全局范围"}</span>
                    <span>引用 {recallCount} 次</span>
                    <span>{solution.lastRecalledAt ? `最近命中 ${formatRelativeTime(solution.lastRecalledAt)}` : "尚未命中"}</span>
                    {recallStatus ? <span className={`memory-recall-status is-${solution.lastRecallOutcome}`}>{recallStatus}</span> : null}
                    <span>最近使用 {formatRelativeTime(solution.lastUsedAt)}</span>
                  </div>
                </div>
                <div className="memory-solution-card-actions">
                  <button
                    className={`button ghost memory-solution-toggle${isExpanded ? " is-expanded" : ""}`}
                    type="button"
                    onClick={() => toggleErrorSolutionExpanded(solution.id)}
                    aria-expanded={isExpanded}
                    aria-controls={`error-solution-details-${solution.id}`}
                  >
                    <IconChevronDown />
                    <span>{isExpanded ? "收起" : "详情"}</span>
                  </button>
                  <button
                    className="button ghost danger-icon-button"
                    type="button"
                    onClick={() => void deleteErrorSolution(solution.id)}
                    disabled={isBusy || isClearingErrorSolutions}
                    title="删除错误恢复经验"
                    aria-label="删除错误恢复经验"
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
              {isExpanded ? (
                <div id={`error-solution-details-${solution.id}`} className="memory-solution-details">
                  <div className="memory-solution-detail-block">
                    <span>所属模型</span>
                    <p>{modelLabel}（{solution.modelId || "未知"}）</p>
                  </div>
                  <div className="memory-solution-detail-block">
                    <span>引用情况</span>
                    <p>累计引用 {recallCount} 次；{solution.lastRecalledAt
                      ? `最近命中于 ${formatRelativeTime(solution.lastRecalledAt)}${recallStatus ? `，结果：${recallStatus}` : ""}`
                      : "尚未在后续任务中命中"}</p>
                  </div>
                  <div className="memory-solution-detail-block">
                    <span>失败摘要</span>
                    <p>{solution.errorSummary || "无"}</p>
                  </div>
                  <div className="memory-solution-detail-block">
                    <span>最优解</span>
                    <p>{solution.solutionSummary || "无"}</p>
                  </div>
                  <div className="memory-solution-detail-meta">
                    <span>签名：{solution.errorSignature}</span>
                    <span>创建于 {formatRelativeTime(solution.createdAt)}</span>
                  </div>
                  <button
                    className="memory-solution-collapse"
                    type="button"
                    onClick={() => toggleErrorSolutionExpanded(solution.id)}
                  >
                    <IconChevronDown />
                    <span>收起详情</span>
                  </button>
                </div>
              ) : null}
            </article>
          );
        }) : (
          <div className="memory-empty-state">
            <div className="memory-empty-icon" aria-hidden>
              <IconKnowledge />
            </div>
            <strong>暂无记忆记录</strong>
            <p>
              {errorSolutionModelFilter === "all"
                ? "Agent 在失败并成功恢复后，会按模型自动写入最优解。"
                : "当前模型还没有记忆。可切换到「全部模型」查看其他记录。"}
            </p>
          </div>
        )}
      </div>
      <MemoryPagination
        label="错误恢复经验列表"
        page={safeErrorSolutionPage}
        pageCount={errorSolutionPageCount}
        totalCount={errorSolutions.length}
        onPageChange={(page) => {
          setErrorSolutionPage(page);
          window.requestAnimationFrame(() => errorSolutionListRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
        }}
      />
    </div>
  </div>
  );
}
