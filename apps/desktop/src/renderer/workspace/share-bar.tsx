import type { ReactNode } from "react";
import type { ShareChannel, ShareTarget, ShareTargetStatus, ShareTaskStats } from "@shared-types";
import { IconCheck, IconClose, IconCopy, IconDownload, IconImage, IconSpinner } from "../icons";
import { formatShareStats } from "../lib/share-turns";

export type ShareBarFeedback = { tone: "success" | "warning"; message: string } | null;

type Props = {
  stats: ShareTaskStats;
  /** Ticked messages, and how many the transcript offers in total. */
  selectedCount: number;
  allSelected: boolean;
  targets: ShareTargetStatus[];
  targetsLoading: boolean;
  busyChannel: ShareChannel | null;
  generating: boolean;
  feedback: ShareBarFeedback;
  onToggleAll: () => void;
  onChannel: (channel: ShareChannel) => void;
  onExit: () => void;
};

/**
 * Bottom bar that replaces the composer while the share selection is active.
 *
 * Mirrors the WorkBuddy interaction: tick messages directly in the transcript,
 * then pick a channel from the bar. There is no dialog — the transcript stays
 * readable and the selection is what you see. The payload is a rendered
 * conversation image, so formatting survives the trip into WeChat or DingTalk.
 */
export function ShareBar({
  stats,
  selectedCount,
  allSelected,
  targets,
  targetsLoading,
  busyChannel,
  generating,
  feedback,
  onToggleAll,
  onChannel,
  onExit
}: Props) {
  const busy = generating || busyChannel !== null;
  const hasContent = selectedCount > 0;

  // Available clients first: the channels you can actually complete stay on the
  // left, so the row does not reshuffle when a client is missing.
  const detected = [...targets].sort((left, right) => Number(right.available) - Number(left.available));

  return (
    <div className="share-bar" role="toolbar" aria-label="分享对话">
      <div className="share-bar-meta">
        <span className="share-bar-summary">
          已选 {selectedCount} 条 · {formatShareStats(stats)}
        </span>
        {targetsLoading ? <span className="share-bar-status">正在检测本机客户端…</span> : null}
        {generating ? (
          <span className="share-bar-status is-busy">
            <IconSpinner />
            正在生成分享长图…
          </span>
        ) : null}
        {feedback ? (
          <span className={`share-bar-status is-${feedback.tone}`} role="status">{feedback.message}</span>
        ) : null}
      </div>

      <div className="share-bar-main">
        <button
          type="button"
          className={`share-bar-select-all ${allSelected ? "is-on" : ""}`}
          aria-pressed={allSelected}
          title={allSelected ? "取消全选" : "全选"}
          onClick={onToggleAll}
        >
          <span className="share-bar-check" aria-hidden="true">{allSelected ? <IconCheck /> : null}</span>
          <span>{allSelected ? "取消全选" : "全选"}</span>
        </button>

        <div className="share-bar-channels" aria-label="分享渠道">
          {detected.map((target) => (
            <ShareBarChannel
              key={target.target}
              label={`分享到${target.label}`}
              hint={target.available ? "复制图片并唤起" : "未检测到客户端，仍可复制"}
              muted={!target.available}
              busy={busyChannel === target.target}
              disabled={!hasContent || busy}
              icon={<ShareTargetIcon target={target.target} />}
              onClick={() => onChannel(target.target)}
            />
          ))}
          <ShareBarChannel
            label="复制图片"
            hint="只写入剪贴板"
            busy={busyChannel === "copyImage"}
            disabled={!hasContent || busy}
            icon={<IconImage />}
            onClick={() => onChannel("copyImage")}
          />
          <ShareBarChannel
            label="保存图片"
            hint="另存为 PNG"
            busy={busyChannel === "saveImage"}
            disabled={!hasContent || busy}
            icon={<IconDownload />}
            onClick={() => onChannel("saveImage")}
          />
          <ShareBarChannel
            label="复制 Markdown"
            hint="保留标记的纯文本"
            busy={busyChannel === "copyMarkdown"}
            disabled={!hasContent || busy}
            icon={<IconCopy />}
            onClick={() => onChannel("copyMarkdown")}
          />
        </div>

        <button type="button" className="share-bar-exit" title="退出分享" aria-label="退出分享" onClick={onExit}>
          <IconClose />
        </button>
      </div>
    </div>
  );
}

function ShareBarChannel({
  label,
  hint,
  icon,
  busy,
  disabled,
  muted = false,
  onClick
}: {
  label: string;
  hint: string;
  icon: ReactNode;
  busy: boolean;
  disabled: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`share-bar-channel ${muted ? "is-muted" : ""} ${busy ? "is-busy" : ""}`}
      title={`${label} · ${busy ? "处理中…" : hint}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="share-bar-channel-icon" aria-hidden="true">{busy ? <IconSpinner /> : icon}</span>
      <span className="share-bar-channel-label">{label}</span>
    </button>
  );
}

function ShareTargetIcon({ target }: { target: ShareTarget }) {
  if (target === "wechat") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M9.1 3.2C5 3.2 1.7 6 1.7 9.4c0 2 1.1 3.7 2.9 4.8l-.7 2.2 2.5-1.3c.8.2 1.6.3 2.4.3h.6a5.6 5.6 0 0 1-.2-1.4c0-3.3 3.1-6 7-6h.5c-.5-2.8-3.5-4.8-7.6-4.8Zm-2.6 3.7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5.2 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
        />
        <path
          fill="currentColor"
          d="M22.3 14c0-2.8-2.8-5-6.3-5s-6.3 2.2-6.3 5 2.8 5 6.3 5c.7 0 1.4-.1 2-.3l2.1 1.1-.6-1.8c1.7-.9 2.8-2.4 2.8-4Zm-8.4-1.5a.9.9 0 1 1 0 1.7.9.9 0 0 1 0-1.7Zm4.3 0a.9.9 0 1 1 0 1.7.9.9 0 0 1 0-1.7Z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 1.6 2.9 5.7v5.6c0 5.6 3.7 9.9 9.1 11.1 5.4-1.2 9.1-5.5 9.1-11.1V5.7L12 1.6Zm3.9 8.9-4.6 4.6a1 1 0 0 1-1.4 0l-2.1-2.1 1.4-1.4 1.4 1.4 3.9-3.9 1.4 1.4Z"
      />
    </svg>
  );
}
