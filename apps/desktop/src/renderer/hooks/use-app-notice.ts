import { useEffect, useState } from "react";
import type { AppNotice, AppNoticeTone } from "../core/app-types";

export function useAppNotice() {
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [isNoticeHovered, setIsNoticeHovered] = useState(false);
  const [exitingNoticeId, setExitingNoticeId] = useState<number | null>(null);

  function showNotice(title: string, options?: { message?: string; tone?: AppNoticeTone }) {
    setExitingNoticeId(null);
    setNotice({ id: Date.now(), title, message: options?.message, tone: options?.tone ?? "warning" });
  }

  function dismissNotice(noticeId: number) {
    setIsNoticeHovered(false);
    setExitingNoticeId((current) => current ?? noticeId);
  }

  useEffect(() => {
    if (!notice || isNoticeHovered) return;
    const timer = window.setTimeout(() => dismissNotice(notice.id), notice.tone === "success" ? 3200 : 4200);
    return () => window.clearTimeout(timer);
  }, [isNoticeHovered, notice]);

  useEffect(() => {
    if (!notice || exitingNoticeId !== notice.id) return;
    const timer = window.setTimeout(() => {
      setNotice((current) => current?.id === notice.id ? null : current);
      setExitingNoticeId((current) => current === notice.id ? null : current);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [exitingNoticeId, notice]);

  return { notice, isNoticeHovered, setIsNoticeHovered, exitingNoticeId, showNotice, dismissNotice };
}
