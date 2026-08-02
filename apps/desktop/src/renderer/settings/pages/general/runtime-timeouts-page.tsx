import type { AppConfig } from "@shared-types";
import { IconTrash } from "../../../icons";

type RuntimeLogStats = { bytes: number; fileCount: number };
type RuntimeTimeoutsPageProps = {
  configDraft: AppConfig | null; runtimeLogStats: RuntimeLogStats | null; isRuntimeLogStatsLoading: boolean; isClearingLogs: boolean;
  onResetTimeouts: () => void; onUpdateTimeout: (key: keyof AppConfig["timeouts"], value: string) => void; onSave: () => Promise<void>; onRequestClearLogs: () => void; formatStorageBytes: (bytes: number) => string;
};

export function RuntimeTimeoutsPage({ configDraft, runtimeLogStats, isRuntimeLogStatsLoading, isClearingLogs, onResetTimeouts, onUpdateTimeout, onSave, onRequestClearLogs, formatStorageBytes }: RuntimeTimeoutsPageProps) {
  return (
      <div className="settings-section">
        {configDraft ? (
          <>
            <div className="config-block">
              <div className="section-copy section-copy-with-action">
                <div>
                  <strong>模型与媒体超时</strong>
                  <span>单位为秒。保存后立即写入运行时；已经发出的单次请求沿用原超时，下一次重试读取新配置。</span>
                </div>
                <button className="button ghost" type="button" onClick={onResetTimeouts}>恢复默认</button>
              </div>
              <div className="provider-detail-grid timeout-settings-grid">
                <label className="settings-field"><span>模型决策超时</span><input type="number" step="1" value={configDraft.timeouts.modelDecisionMs / 1_000} onChange={(event) => onUpdateTimeout("modelDecisionMs", event.target.value)} /></label>
                <label className="settings-field"><span>恢复请求超时</span><input type="number" step="1" value={configDraft.timeouts.recoveryModelDecisionMs / 1_000} onChange={(event) => onUpdateTimeout("recoveryModelDecisionMs", event.target.value)} /></label>
                <label className="settings-field"><span>超时恢复窗口</span><input type="number" step="1" value={configDraft.timeouts.modelTimeoutRetries} onChange={(event) => onUpdateTimeout("modelTimeoutRetries", event.target.value)} /></label>
                <label className="settings-field"><span>非终端工具超时</span><input type="number" step="1" value={configDraft.timeouts.toolExecutionMs / 1_000} onChange={(event) => onUpdateTimeout("toolExecutionMs", event.target.value)} /></label>
                <label className="settings-field"><span>多模态意图分类超时</span><input type="number" step="1" value={configDraft.timeouts.multimodalIntentClassifyMs / 1_000} onChange={(event) => onUpdateTimeout("multimodalIntentClassifyMs", event.target.value)} /></label>
                <label className="settings-field"><span>模型连接测试超时</span><input type="number" step="1" value={configDraft.timeouts.modelTestMs / 1_000} onChange={(event) => onUpdateTimeout("modelTestMs", event.target.value)} /></label>
                <label className="settings-field"><span>视频生成总超时</span><input type="number" step="1" value={configDraft.timeouts.videoGenerationMs / 1_000} onChange={(event) => onUpdateTimeout("videoGenerationMs", event.target.value)} /></label>
                <label className="settings-field"><span>视频状态轮询间隔</span><input type="number" step="1" value={configDraft.timeouts.videoPollIntervalMs / 1_000} onChange={(event) => onUpdateTimeout("videoPollIntervalMs", event.target.value)} /></label>
              </div>
              <span className="timeout-settings-note">“超时恢复窗口”控制连续超时多少次后压缩上下文并延长下一次等待；模型、429 和临时网络错误会持续自动恢复，直到你手动停止。</span>
            </div>
            <div className="settings-save-row">
              <span className="subtle-inline">图片生成与视频下载没有固定超时，只会在任务被取消时中断。</span>
              <button className="button warm" onClick={() => void onSave()}>保存</button>
            </div>
            <div className="config-block log-cleanup-settings">
              <div className="section-copy section-copy-with-action">
                <div>
                  <strong>日志与存储</strong>
                  <span>清理应用运行日志，并安全回收 SQLite WAL 事务日志；聊天、项目和知识库数据不会被删除。</span>
                </div>
                <button
                  className="button ghost log-cleanup-button"
                  type="button"
                  disabled={isRuntimeLogStatsLoading || isClearingLogs || runtimeLogStats?.bytes === 0}
                  onClick={() => onRequestClearLogs()}
                >
                  <IconTrash />
                  <span>{isClearingLogs ? "清理中" : "清理日志"}</span>
                </button>
              </div>
              <div className="log-cleanup-status" aria-live="polite">
                <span>当前占用</span>
                <strong>{isRuntimeLogStatsLoading && !runtimeLogStats ? "统计中..." : formatStorageBytes(runtimeLogStats?.bytes ?? 0)}</strong>
                {runtimeLogStats ? <em>{runtimeLogStats.fileCount} 个日志文件</em> : null}
              </div>
            </div>
          </>
        ) : <div className="config-block"><div className="detail-empty">正在加载超时配置...</div></div>}
      </div>
                );
}
