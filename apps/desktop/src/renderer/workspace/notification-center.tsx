import type { RefObject } from "react";
import { IconBell, IconNotificationStatus } from "../icons";
import {
  isFinishedNotification,
  sortNotificationItems,
  type NotificationCenterItem
} from "../core/notification-center";
import { formatNotificationElapsed, getNotificationStatusLabel } from "../core/app-formatters";

type Props = {
  items: NotificationCenterItem[];
  now: number;
  isOpen: boolean;
  visible: boolean;
  motionPhase: string;
  highlightedTarget: string | null;
  buttonRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onOpenItem: (item: NotificationCenterItem) => Promise<void>;
  onClearFinished: () => void;
  onMarkAllRead: () => void;
};

export function NotificationCenter({
  items,
  now,
  isOpen,
  visible,
  motionPhase,
  highlightedTarget,
  buttonRef,
  panelRef,
  onToggle,
  onOpenItem,
  onClearFinished,
  onMarkAllRead
}: Props) {
  const sortedItems = sortNotificationItems(items);
  const attentionItems = sortedItems.filter((item) => item.status === "attention");
  const runningItems = sortedItems.filter((item) => item.status === "running");
  const finishedItems = sortedItems.filter(isFinishedNotification);
  const unreadFinishedCount = finishedItems.filter((item) => item.unread).length;
  const badgeCount = attentionItems.length + unreadFinishedCount;

  function renderGroup(label: string, groupItems: NotificationCenterItem[]) {
    if (!groupItems.length) return null;
    return (
      <section className="notification-center-group" aria-label={label}>
        <div className="notification-center-group-title">{label}<span>{groupItems.length}</span></div>
        <div className="notification-center-list">
          {groupItems.map((item) => {
            const statusLabel = getNotificationStatusLabel(item.status);
            const elapsed = formatNotificationElapsed(item.startedAt, item.status === "running" || item.status === "attention" ? now : Date.parse(item.updatedAt));
            const highlighted = highlightedTarget === `${item.source}:${item.targetId}`;
            return (
              <button key={item.id} type="button" className={`notification-center-item is-${item.status} ${item.unread ? "is-unread" : ""} ${highlighted ? "is-highlighted" : ""}`} onClick={() => void onOpenItem(item)}>
                <span className="notification-item-status" aria-hidden><IconNotificationStatus status={item.status} /></span>
                <span className="notification-item-copy">
                  <span className="notification-item-heading"><strong>{item.title}</strong><small>{statusLabel} · {elapsed}</small></span>
                  <span className="notification-item-detail">{item.detail}</span>
                  {item.status === "running" || item.status === "attention" ? (
                    item.progress ? (
                      <span className="notification-item-progress-wrap">
                        <span className="notification-item-progress is-determinate" role="progressbar" aria-label={`${item.title} 进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress.percent}><i style={{ width: `${item.progress.percent}%` }} /></span>
                        <small>{item.progress.current}/{item.progress.total} · {item.progress.percent}%</small>
                      </span>
                    ) : <span className="notification-item-progress is-indeterminate" aria-label={`${item.title} 正在运行`}><i /></span>
                  ) : null}
                </span>
                {item.unread && isFinishedNotification(item) ? <span className="notification-item-unread" aria-label="未读" /> : null}
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div className="notification-center-control">
      <button
        ref={buttonRef}
        type="button"
        className={`workspace-control-button notification-center-toggle ${isOpen ? "active" : ""} ${runningItems.length ? "is-running" : ""} ${attentionItems.length ? "has-attention" : ""}`}
        title={`消息与进度${runningItems.length ? ` · ${runningItems.length} 个运行中` : ""}${badgeCount ? ` · ${badgeCount} 条提醒` : ""}`}
        aria-label={`消息与进度${badgeCount ? `，${badgeCount} 条提醒` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="notification-bell-glyph" aria-hidden><IconBell /></span>
        {runningItems.length ? <span className="notification-running-dot" aria-hidden /> : null}
        {badgeCount ? <span className="notification-count-badge">{badgeCount > 9 ? "9+" : badgeCount}</span> : null}
      </button>
      {visible ? (
        <div ref={panelRef} className={`notification-center-panel motion-${motionPhase}`} role="dialog" aria-modal="false" aria-label="消息与进度">
          <header className="notification-center-header">
            <div><strong>消息与进度</strong><span>{runningItems.length} 个运行中</span></div>
            <div className="notification-center-header-actions">
              <button type="button" disabled={!finishedItems.length} onClick={onClearFinished}>清除已结束</button>
              <button type="button" disabled={!unreadFinishedCount} onClick={onMarkAllRead}>全部已读</button>
            </div>
          </header>
          <div className="notification-center-body">
            {!sortedItems.length ? <div className="notification-center-empty"><IconBell /><span>暂无后台任务或消息</span></div> : <>{renderGroup("待处理", attentionItems)}{renderGroup("运行中", runningItems)}{renderGroup("最近消息", finishedItems)}</>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
