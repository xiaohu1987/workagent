import type { ReactNode } from "react";
import type { NotificationCenterItem } from "./core/notification-center";

export function SvgIcon({
  children,
  size = 18,
  className
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconSidebar() {
  return (
    <SvgIcon>
      <rect x="3.5" y="4" width="17" height="16" rx="4" />
      <path d="M9 4v16" />
    </SvgIcon>
  );
}

export function IconBolt() {
  return (
    <SvgIcon>
      <path d="M13 2 3.8 13.6h6.4L9 22l9.4-11.6h-6.6L13 2z" />
    </SvgIcon>
  );
}

export function IconChevronLeft() {
  return (
    <SvgIcon>
      <path d="m14.5 6.5-5 5 5 5" />
    </SvgIcon>
  );
}

export function IconChevronRight() {
  return (
    <SvgIcon>
      <path d="m9.5 6.5 5 5-5 5" />
    </SvgIcon>
  );
}

export function IconChevronDown() {
  return (
    <SvgIcon>
      <path d="m6.5 9.5 5.5 5 5.5-5" />
    </SvgIcon>
  );
}

export function IconTerminal() {
  return (
    <SvgIcon>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="m7.5 9 3 3-3 3" />
      <path d="M13.5 15h3" />
    </SvgIcon>
  );
}

export function IconBell() {
  return (
    <SvgIcon>
      <path d="M18 9.5a6 6 0 0 0-12 0c0 7-2.5 7-2.5 8.5h17C20.5 16.5 18 16.5 18 9.5z" />
      <path d="M9.5 20a2.8 2.8 0 0 0 5 0" />
    </SvgIcon>
  );
}

export function IconNotificationStatus({ status }: { status: NotificationCenterItem["status"] }) {
  if (status === "completed") return <IconCheck />;
  if (status === "failed") return <IconClose />;
  if (status === "cancelled") return <IconStop />;
  if (status === "attention") return <IconHelpCircle />;
  return <IconBell />;
}

export function IconGlobe() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4" />
      <path d="M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5C9.8 18.2 8.7 15.4 8.7 12S9.8 5.8 12 3.5z" />
    </SvgIcon>
  );
}

export function IconSearch() {
  return (
    <SvgIcon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </SvgIcon>
  );
}

export function IconNotebook() {
  return (
    <SvgIcon>
      <path d="M7 4.5h9.5a2 2 0 0 1 2 2v12a1.5 1.5 0 0 1-1.5 1.5H7z" />
      <path d="M7 4.5v15" />
      <path d="M4.5 7h2.5M4.5 11h2.5M4.5 15h2.5" />
      <path d="M10.5 9h5M10.5 13h5" />
    </SvgIcon>
  );
}

export function IconCompose() {
  return (
    <SvgIcon>
      <path d="M12 20h8" />
      <path d="m16.5 3.5 4 4-11 11-5 1 1-5z" />
    </SvgIcon>
  );
}

export function IconGuide() {
  return (
    <SvgIcon>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="M6 7v10a2 2 0 0 0 2 2h8" />
      <path d="M8 5h8" />
    </SvgIcon>
  );
}

export function IconCopy() {
  return (
    <SvgIcon>
      <rect x="8" y="8" width="10" height="11" rx="1.5" />
      <path d="M6 16.5H5.5A1.5 1.5 0 0 1 4 15V5.5A1.5 1.5 0 0 1 5.5 4H14a1.5 1.5 0 0 1 1.5 1.5V6" />
    </SvgIcon>
  );
}

export function IconCheck() {
  return (
    <SvgIcon>
      <path d="m6 12.5 3.8 3.8L18 8.2" />
    </SvgIcon>
  );
}

export function IconChecklist() {
  return (
    <SvgIcon>
      <path d="m3.5 6 1.5 1.5L7.5 4.5" />
      <path d="M10.5 6h10" />
      <circle cx="5" cy="12" r="1.3" />
      <path d="M10.5 12h10" />
      <path d="m3.5 17 1.5 1.5 2.5-3" />
      <path d="M10.5 18h10" />
    </SvgIcon>
  );
}

export function IconPin() {
  return (
    <SvgIcon>
      <path d="m9 4 6 6" />
      <path d="m7 9 8 8" />
      <path d="M14.5 4.5 19 9l-3 1.5-3.5 3.5L11 17l-4-4 3-1.5 3.5-3.5z" />
      <path d="m7 17-3 3" />
    </SvgIcon>
  );
}

export function IconRename() {
  return (
    <SvgIcon>
      <path d="M4 20h4L18.5 9.5a1.5 1.5 0 0 0 0-2.12L16.62 5.5a1.5 1.5 0 0 0-2.12 0L4 16v4z" />
      <path d="m13.5 6.5 4 4" />
    </SvgIcon>
  );
}

export function IconCode() {
  return (
    <SvgIcon>
      <path d="m9.25 7-4 5 4 5" />
      <path d="m14.75 7 4 5-4 5" />
      <path d="m13.25 5.5-2.5 13" />
    </SvgIcon>
  );
}

export function IconImage() {
  return (
    <SvgIcon>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m5.5 17 4.5-4 3 2.5 2.5-2 3 3.5" />
    </SvgIcon>
  );
}

export function IconUpload() {
  return (
    <SvgIcon size={16}>
      <path d="M12 16V4" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M5 14.5v4h14v-4" />
    </SvgIcon>
  );
}

export function IconDownload() {
  return (
    <SvgIcon size={16}>
      <path d="M12 4v12" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </SvgIcon>
  );
}

export function IconVideo() {
  return (
    <SvgIcon>
      <rect x="3.5" y="6" width="12" height="12" rx="2" />
      <path d="m15.5 10 5-2.5v9L15.5 14z" />
    </SvgIcon>
  );
}

export function IconSkills() {
  return (
    <SvgIcon>
      <path d="M12 3.5 14 8l4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2z" />
      <path d="m18 15 .8 1.7L20.5 18l-1.7.8L18 20.5l-.8-1.7-1.7-.8 1.7-.8z" />
    </SvgIcon>
  );
}

export function IconMcp() {
  return (
    <SvgIcon>
      <circle cx="7" cy="8" r="2.5" />
      <circle cx="17" cy="7" r="2.5" />
      <circle cx="13" cy="17" r="2.5" />
      <path d="m9.2 8.2 5.5-.8M8.6 10l3.1 4.8m4.2-5.3-1.8 5" />
    </SvgIcon>
  );
}

export function IconFolder() {
  return (
    <SvgIcon>
      <path d="M3.5 8.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </SvgIcon>
  );
}

export function IconFolders() {
  return (
    <SvgIcon>
      <path d="M7 6.5a2 2 0 0 1 2-2h3l1.8 2h5.2a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" />
      <path d="M4 9.5a2 2 0 0 0-2 2V17a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1" />
    </SvgIcon>
  );
}

export function IconFile() {
  return (
    <SvgIcon>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13.5 3.5v4h4" />
    </SvgIcon>
  );
}

export function IconEye() {
  return (
    <SvgIcon>
      <path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5z" />
      <circle cx="12" cy="12" r="2.5" />
    </SvgIcon>
  );
}

export function IconFileChanges() {
  return (
    <SvgIcon size={18}>
      <rect x="5" y="4.5" width="12" height="14" rx="2.5" />
      <path d="M8.5 2.5h8a2 2 0 0 1 2 2v10" />
      <path d="M8 11.5h6" />
      <path d="M11 8.5v6" />
    </SvgIcon>
  );
}

export function IconPlus() {
  return (
    <SvgIcon>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </SvgIcon>
  );
}

export function IconTrash() {
  return (
    <SvgIcon size={16}>
      <path d="M7.5 7.25h9" />
      <path d="M10 5.5h4" />
      <path d="M9.25 8.5v7.25c0 .69.56 1.25 1.25 1.25h3c.69 0 1.25-.56 1.25-1.25V8.5" />
      <path d="M11 10.25v4.5" />
      <path d="M13 10.25v4.5" />
    </SvgIcon>
  );
}

export function IconEraser() {
  return (
    <SvgIcon size={16}>
      <path d="m5.25 12.5 6.9-6.9a1.5 1.5 0 0 1 2.1 0l2.15 2.15a1.5 1.5 0 0 1 0 2.1L9.75 16.5H7.1l-1.85-1.85a1.5 1.5 0 0 1 0-2.15Z" />
      <path d="m10.25 7.5 4.25 4.25" />
      <path d="M9.75 16.5h7.5" />
    </SvgIcon>
  );
}

export function IconRefresh() {
  return (
    <SvgIcon size={16}>
      <path d="M19 8.5V4.5l-1.7 1.7A7.1 7.1 0 0 0 5.6 8.1" />
      <path d="M5 15.5v4l1.7-1.7a7.1 7.1 0 0 0 11.7-1.9" />
    </SvgIcon>
  );
}

export function IconUndo() {
  return (
    <SvgIcon size={16}>
      <path d="M9 7 5 11l4 4" />
      <path d="M5.5 11H14a4.5 4.5 0 0 1 0 9H11" />
    </SvgIcon>
  );
}

export function IconComment() {
  return (
    <SvgIcon size={16}>
      <path d="M5 5.5h14v10H10l-4 3v-3H5z" />
      <path d="M8 9h8" />
      <path d="M8 12h5" />
    </SvgIcon>
  );
}

export function IconSun() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.75v2.1M12 19.15v2.1M21.25 12h-2.1M4.85 12h-2.1M18.54 5.46l-1.49 1.49M6.95 17.05l-1.49 1.49M18.54 18.54l-1.49-1.49M6.95 6.95 5.46 5.46" />
    </SvgIcon>
  );
}

export function IconMoon() {
  return (
    <SvgIcon>
      <path d="M20 14.65A8.25 8.25 0 0 1 9.35 4 8.25 8.25 0 1 0 20 14.65z" />
    </SvgIcon>
  );
}

export function IconChatBubbles() {
  return (
    <SvgIcon>
      <path d="M6.8 5.2h7.7a3.3 3.3 0 0 1 3.3 3.3v3.2a3.3 3.3 0 0 1-3.3 3.3H11l-3.5 2.7v-2.7H6.8a3.3 3.3 0 0 1-3.3-3.3V8.5a3.3 3.3 0 0 1 3.3-3.3z" />
      <path d="M17.8 9.2h.4a2.3 2.3 0 0 1 2.3 2.3v2.4a2.3 2.3 0 0 1-2.3 2.3h-1.7v2.1L14 16.2" />
      <circle cx="8.1" cy="10.1" r=".55" fill="currentColor" stroke="none" />
      <circle cx="10.7" cy="10.1" r=".55" fill="currentColor" stroke="none" />
      <circle cx="13.3" cy="10.1" r=".55" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

export function IconSpinner() {
  return (
    <SvgIcon size={16} className="icon-spinner">
      <circle cx="12" cy="12" r="6.75" opacity="0.22" />
      <path d="M18.75 12a6.75 6.75 0 0 0-6.75-6.75" />
    </SvgIcon>
  );
}

export function IconClose() {
  return (
    <SvgIcon>
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </SvgIcon>
  );
}

export function IconGear() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 0 1-4 0v-.1a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.1a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 0 1 4 0v.1a1 1 0 0 0 .6.9h.1a1 1 0 0 0 1.1-.2l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6H20a2 2 0 0 1 0 4h-.1a1 1 0 0 0-.9.6z" />
    </SvgIcon>
  );
}

export function IconChart() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19H20M8 16V11M12 16V7M16 16V9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

export function IconHelpCircle() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.75 9.25a2.45 2.45 0 0 1 4.6 1.2c0 1.6-1.85 2.1-1.85 3.35" />
      <path d="M12 17h.01" />
    </SvgIcon>
  );
}

export function IconSinglePanel() {
  return (
    <SvgIcon>
      <rect x="4" y="5" width="16" height="14" rx="3" />
    </SvgIcon>
  );
}

export function IconSplitPanel() {
  return (
    <SvgIcon>
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <path d="M12 5v14" />
    </SvgIcon>
  );
}

export function IconCodexMark() {
  return (
    <SvgIcon size={38} className="codex-mark-icon">
      <path d="M12 4.5c2.4 0 4 1.6 4.6 3.4 2 .1 3.9 1.7 3.9 4.1 0 1.8-1.1 3.2-2.7 3.9-.5 2.3-2.2 4.1-4.8 4.1-2.1 0-3.4-1-4.3-2.3-2.5.2-4.8-1.5-4.8-4.2 0-1.9 1.2-3.5 3-4.1.1-2.8 2.2-4.9 5.1-4.9z" />
      <path d="M9 15.5 11.5 8l3 8" />
      <path d="M8 12h8" />
    </SvgIcon>
  );
}

export function IconExplore() {
  return (
    <SvgIcon>
      <path d="M14.5 9.5 19 5" />
      <path d="M9 13 5 17" />
      <path d="m14.5 14.5 4 4" />
      <path d="M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z" />
    </SvgIcon>
  );
}

export function IconBuild() {
  return (
    <SvgIcon>
      <path d="m5 19 6.5-6.5" />
      <path d="m14 6 4 4" />
      <path d="m12.5 4.5 1.5 1.5-6 6L6.5 10z" />
      <path d="M13.5 10.5 19 16" />
    </SvgIcon>
  );
}

export function IconReview() {
  return (
    <SvgIcon>
      <path d="M6 8a6 6 0 0 1 10-2.7L18 7" />
      <path d="M18 7V3.5" />
      <path d="M18 16a6 6 0 0 1-10 2.7L6 17" />
      <path d="M6 17v3.5" />
    </SvgIcon>
  );
}

export function IconFix() {
  return (
    <SvgIcon>
      <path d="M10 4v5l-4.5 7.5a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3L14 9V4" />
      <path d="M9 4h6" />
      <path d="M9 13h6" />
    </SvgIcon>
  );
}

export function IconArrowUp() {
  return (
    <SvgIcon>
      <path d="M12 18V6" />
      <path d="m7 11 5-5 5 5" />
    </SvgIcon>
  );
}

export function IconArrowDown() {
  return (
    <SvgIcon>
      <path d="M12 6v12" />
      <path d="m7 13 5 5 5-5" />
    </SvgIcon>
  );
}

export function IconStop() {
  return (
    <SvgIcon size={18}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.75" fill="currentColor" stroke="none" />
    </SvgIcon>
  );
}

export function IconShield() {
  return (
    <SvgIcon>
      <path d="M12 3.5 19 6v5.2c0 4.4-2.9 7.8-7 9.3-4.1-1.5-7-4.9-7-9.3V6z" />
      <path d="m9.5 12 1.7 1.7 3.5-3.8" />
    </SvgIcon>
  );
}

export function IconKnowledge() {
  return (
    <SvgIcon>
      <path d="M5 4.5h9a3 3 0 0 1 3 3V20H8a3 3 0 0 0-3 3z" />
      <path d="M5 4.5v18.5" />
      <path d="M8.5 9h5" />
      <path d="M8.5 13h5" />
    </SvgIcon>
  );
}

export function IconGpa() {
  return (
    <SvgIcon>
      <circle cx="12" cy="12" r="7.5" />
      <path d="m9.5 12 1.6 1.6 3.7-3.9" />
    </SvgIcon>
  );
}
