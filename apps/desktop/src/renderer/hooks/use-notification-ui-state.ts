import { useRef, useState } from "react";
import { createEmptyTokenUsage, type TokenUsage } from "@shared-types";
import {
  EMPTY_NOTIFICATION_CENTER_STATE,
  reduceNotificationCenter,
  type NotificationCenterAction,
  type NotificationCenterState
} from "../core/notification-center";

export function useNotificationUiState() {
  const [notificationCenterState, setNotificationCenterState] = useState<NotificationCenterState>(EMPTY_NOTIFICATION_CENTER_STATE);
  const notificationCenterStateRef = useRef<NotificationCenterState>(EMPTY_NOTIFICATION_CENTER_STATE);
  const [isNotificationCenterOpen, setIsNotificationCenterOpen] = useState(false);
  const [isTokenUsagePanelOpen, setIsTokenUsagePanelOpen] = useState(false);
  const [threadTokenUsage, setThreadTokenUsage] = useState<{
    turn: TokenUsage;
    thread: TokenUsage;
    turnRunId: string | null;
  }>({ turn: createEmptyTokenUsage(), thread: createEmptyTokenUsage(), turnRunId: null });
  const [highlightedNotificationTarget, setHighlightedNotificationTarget] = useState<string | null>(null);
  const [notificationNow, setNotificationNow] = useState(() => Date.now());
  const notificationCenterRef = useRef<HTMLDivElement | null>(null);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const tokenUsagePanelRef = useRef<HTMLDivElement | null>(null);
  const tokenUsageButtonRef = useRef<HTMLButtonElement | null>(null);

  function dispatchNotificationCenter(action: NotificationCenterAction) {
    setNotificationCenterState((current) => {
      const next = reduceNotificationCenter(current, action);
      notificationCenterStateRef.current = next;
      return next;
    });
  }

  return {
    notificationCenterState,
    notificationCenterStateRef,
    isNotificationCenterOpen,
    setIsNotificationCenterOpen,
    isTokenUsagePanelOpen,
    setIsTokenUsagePanelOpen,
    threadTokenUsage,
    setThreadTokenUsage,
    highlightedNotificationTarget,
    setHighlightedNotificationTarget,
    notificationNow,
    setNotificationNow,
    notificationCenterRef,
    notificationButtonRef,
    tokenUsagePanelRef,
    tokenUsageButtonRef,
    dispatchNotificationCenter
  };
}
