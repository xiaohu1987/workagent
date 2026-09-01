import type { ReactNode, RefObject } from "react";
import type { TokenUsage } from "@shared-types";
import type { NotificationCenterItem } from "../core/notification-center";
import { IconFolder, IconTerminal } from "../icons";
import { NotificationCenter } from "./notification-center";
import { TokenUsagePopover } from "./token-usage-popover";

type Props = {
  tokenUsage: TokenUsage;
  tokenUsageOpen: boolean;
  tokenUsageMotionPhase?: string;
  selectedThreadId: string | null;
  tokenUsageButtonRef: RefObject<HTMLButtonElement | null>;
  tokenUsagePanelRef: RefObject<HTMLDivElement | null>;
  onToggleTokenUsage: () => void;
  notifications: NotificationCenterItem[];
  notificationNow: number;
  notificationOpen: boolean;
  notificationVisible: boolean;
  notificationMotionPhase: string;
  highlightedNotificationTarget: string | null;
  notificationButtonRef: RefObject<HTMLButtonElement | null>;
  notificationPanelRef: RefObject<HTMLDivElement | null>;
  onToggleNotifications: () => void;
  onOpenNotification: (item: NotificationCenterItem) => Promise<void>;
  onClearFinishedNotifications: () => void;
  onMarkNotificationsRead: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  rightWorkspaceOpen: boolean;
  onOpenRightWorkspace: () => void;
  subagentControl?: ReactNode;
};

export function WorkspaceControls({ tokenUsage, tokenUsageOpen, tokenUsageMotionPhase, selectedThreadId, tokenUsageButtonRef, tokenUsagePanelRef, onToggleTokenUsage, notifications, notificationNow, notificationOpen, notificationVisible, notificationMotionPhase, highlightedNotificationTarget, notificationButtonRef, notificationPanelRef, onToggleNotifications, onOpenNotification, onClearFinishedNotifications, onMarkNotificationsRead, terminalOpen, onToggleTerminal, rightWorkspaceOpen, onOpenRightWorkspace, subagentControl }: Props) {
  return (
    <div className="workspace-controls">
      <TokenUsagePopover usage={tokenUsage} active={tokenUsageOpen} selectedThreadId={selectedThreadId} motionPhase={tokenUsageMotionPhase} buttonRef={tokenUsageButtonRef} panelRef={tokenUsagePanelRef} onToggle={onToggleTokenUsage} />
      {subagentControl}
      <NotificationCenter items={notifications} now={notificationNow} isOpen={notificationOpen} visible={notificationVisible} motionPhase={notificationMotionPhase} highlightedTarget={highlightedNotificationTarget} buttonRef={notificationButtonRef} panelRef={notificationPanelRef} onToggle={onToggleNotifications} onOpenItem={onOpenNotification} onClearFinished={onClearFinishedNotifications} onMarkAllRead={onMarkNotificationsRead} />
      <button type="button" className={`workspace-control-button terminal-toggle ${terminalOpen ? "active" : ""}`} title={terminalOpen ? "收起终端" : "打开终端"} aria-label={terminalOpen ? "收起终端" : "打开终端"} onClick={onToggleTerminal}><IconTerminal /></button>
      {!rightWorkspaceOpen ? <button type="button" className="workspace-control-button" title="显示右侧文件工作区" aria-label="显示右侧文件工作区" onClick={onOpenRightWorkspace}><IconFolder /></button> : null}
    </div>
  );
}
