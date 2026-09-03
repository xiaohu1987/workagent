import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAppTheme } from "../apps/desktop/src/renderer/theme";

const styles = readFileSync(
  new URL("../apps/desktop/src/renderer/styles.css", import.meta.url),
  "utf8"
);
const preload = readFileSync(
  new URL("../apps/desktop/src/preload/index.ts", import.meta.url),
  "utf8"
);
const mainProcess = readFileSync(
  new URL("../apps/desktop/src/main/index.ts", import.meta.url),
  "utf8"
);
const app = readFileSync(
  new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url),
  "utf8"
);
const timelineStyles = readFileSync(
  new URL("../apps/desktop/src/renderer/timeline.css", import.meta.url),
  "utf8"
);
const apiCardStyles = readFileSync(
  new URL("../apps/desktop/src/renderer/cards/api-card-message.css", import.meta.url),
  "utf8"
);
const workspacePanels = readFileSync(
  new URL("../apps/desktop/src/renderer/workspace/panels.tsx", import.meta.url),
  "utf8"
);

describe("renderer theme", () => {
  it("keeps legacy system preferences on the existing dark appearance", () => {
    expect(resolveAppTheme("system")).toBe("dark");
    expect(resolveAppTheme("dark")).toBe("dark");
    expect(resolveAppTheme("light")).toBe("light");
  });

  it("defines a white theme with light-blue primary actions", () => {
    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain("--window: #f7fbff");
    expect(styles).toContain("--action-primary: #2196f3");
    expect(styles).toContain("--action-primary-hover: #1687dc");
    expect(styles).toContain("color: #ffffff;");
    expect(styles).toContain(':root[data-theme="light"] .right-workspace-panel');
    expect(styles).toContain(':root[data-theme="light"] .right-workspace-view.active');
    expect(styles).toContain(':root[data-theme="light"] .notification-center-panel');
    expect(styles).toContain(':root[data-theme="light"] .chat-composer');
    expect(styles).toContain(':root[data-theme="light"] .token-usage-panel');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-motion-setting');
    expect(styles).toContain(':root[data-theme="light"] .message-user-bubble');
    expect(styles).toContain(':root[data-theme="light"] .app-notice');
    expect(styles).toContain(':root[data-theme="light"] .quick-notes-sheet');
    expect(styles).toContain(':root[data-theme="light"] .history-search-dialog');
    expect(styles).toContain(':root[data-theme="light"] .fetch-models-dialog');
    expect(styles).toContain(':root[data-theme="light"] .markdown-code-block');
    expect(styles).toContain(':root[data-theme="light"] .terminal-output');
    expect(styles).toContain(':root[data-theme="light"] .git-changes-workspace');
    expect(styles).toContain(':root[data-theme="light"] .project-files-filter');
    expect(styles).toContain(':root[data-theme="light"] .gpa-popover');
    expect(styles).toContain(':root[data-theme="light"] .mcp-create-mode');
    expect(styles).toContain(':root[data-theme="light"] .api-card-button.is-primary');
    expect(styles).toContain(':root[data-theme="light"] .panel-resize-handle');
    expect(styles).toContain(':root[data-theme="light"] .sidebar-settings');
    expect(styles).toContain(':root[data-theme="light"] .history-search-input-wrap input');
    expect(styles).toContain(':root[data-theme="light"] .project-files-filter input');
    expect(styles).toContain(':root[data-theme="light"] .fetch-models-dialog {');
    expect(styles).toContain('border-radius: 18px !important');
    expect(styles).toContain(':root[data-theme="light"] .quick-notes-add');
    expect(styles).toContain(':root[data-theme="light"] .skill-row');
    expect(styles).toContain(':root[data-theme="light"] .skills-toolbar');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-preview');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-empty');
    expect(styles).toContain(':root[data-theme="light"] .skill-lab-mode-choice');
    expect(styles).toContain(':root[data-theme="light"] .app-notice-copy {');
    expect(styles).toContain('background: transparent !important');
    expect(styles).toContain('.mcp-server-row');
    expect(styles).toContain('.memory-solution-card');
    expect(styles).toContain('border-left-color: #75b8f5 !important');
    expect(styles).toContain(':root[data-theme="light"] .mcp-tool-row');
    expect(styles).toContain('.database-connection-card');
    expect(styles).toContain('.api-favorites-card');
    expect(styles).toContain(':root[data-theme="light"] .message-user-actions');
    expect(styles).toContain(':root[data-theme="light"] .message-user-edit-button');
    expect(timelineStyles).toContain(':root[data-theme="light"] .task-timeline .message-card.user .message-user-bubble');
    expect(timelineStyles).toContain('background: #eaf5ff !important;');
    expect(timelineStyles).toContain(':root[data-theme="light"] :is(\n  .plan-timeline,');
    expect(timelineStyles).toContain('  .gpa-confirmation,');
    expect(timelineStyles).toContain('  .execution-step,');
    expect(timelineStyles).toContain('  .tool-activity-details,');
    expect(timelineStyles).toContain('  .approval-card,');
    expect(timelineStyles).toContain('  .user-input-prompt-card:not(.resolved),');
    expect(timelineStyles).toContain('  .event-block:not(.commentary):not(.final),');
    expect(timelineStyles).toContain('background: #ffffff !important;');
    expect(timelineStyles).toContain('background: #f7fbff !important;');
    expect(timelineStyles).toContain('  .runtime-activity-panel,');
    expect(timelineStyles).toContain('  .streaming-assistant,');
    expect(timelineStyles).toContain('  .generated-file-list,');
    expect(timelineStyles).toContain('  .generated-file-list-item');
    expect(styles).toContain(':root[data-theme="light"] .copy-text-button');
    expect(styles).toContain(':root[data-theme="light"] .composer-meta-row');
    expect(styles).toContain(':root[data-theme="light"] .composer-project-pill {');
    expect(styles).toContain(':root[data-theme="light"] .composer-attachment-chip');
    expect(styles).toContain(':root[data-theme="light"] .composer-attachment-icon');
    expect(styles).toContain(':root[data-theme="light"] .sidebar-brand .sidebar-brand-accent');
    expect(styles).toContain('color: #ef4444 !important');
    expect(styles).toContain(':root[data-theme="light"] .subagent-status-panel');
    expect(styles).toContain(':root[data-theme="light"] .subagent-task');
    expect(styles).toContain(':root[data-theme="light"] .subagent-instruction-form');
    expect(styles).toContain(':root[data-theme="light"] .welcome-panel');
    expect(styles).toContain(':root[data-theme="light"] .welcome-card');
    expect(styles).toContain(':root[data-theme="light"] .welcome-card:hover,');
    expect(styles).toContain(':root[data-theme="light"] .welcome-card-icon');
    expect(styles).toContain(':root[data-theme="light"] .default-home-model');
    expect(styles).toContain(':root[data-theme="light"] .composer-plan');
    expect(styles).toContain(':root[data-theme="light"] .composer-plan-summary');
    expect(styles).toContain(':root[data-theme="light"] .composer-plan-panel');
    expect(styles).toContain(':root[data-theme="light"] .gpa-plan-answers-toggle');
    expect(styles).toContain(':root[data-theme="light"] .gpa-plan-resume-sheet');
    expect(styles).toContain(':root[data-theme="light"] .composer-task-changes-trigger');
    expect(styles).toContain(':root[data-theme="light"] .composer-task-changes-popover');
    expect(styles).toContain(':root[data-theme="light"] .composer-task-change-file');
    expect(styles).toContain(':root[data-theme="light"] .workspace-context-menu');
    expect(styles).toContain(':root[data-theme="light"] .workspace-context-menu button.is-danger');
    expect(styles).toContain(':root[data-theme="light"] .generated-file-diff-popover');
    expect(styles).toContain('background: #fff6f6;');
    expect(styles).toContain('background: #f2fbf6;');
  });

  it("uses the same blue-and-white primary action treatment across independent controls", () => {
    expect(styles).toContain(".approval-session-button {");
    expect(styles).toContain(".approval-card-actions:not(.explicit-authorization) .approval-allow-button");
    expect(styles).toContain(".explicit-authorization .approval-allow-button {");
    expect(styles).toContain("button.settings-add-provider,");
    expect(styles).toContain("color: #ffffff !important;");
    expect(timelineStyles).toContain(".gpa-confirmation-button.primary {");
    expect(timelineStyles).toContain("background: var(--action-primary);");
    expect(apiCardStyles).toContain(".api-card-button.is-primary {");
    expect(apiCardStyles).toContain("background: var(--action-primary);");
  });

  it("uses green to send and red to stop an active task", () => {
    expect(styles).toContain(".send-button:not(:disabled),");
    expect(styles).toContain("background: #16a34a !important;");
    expect(styles).toContain(".send-button.running:not(:disabled),");
    expect(styles).toContain("background: #dc2626 !important;");
  });

  it("keeps image and realtime backgrounds out of the white theme", () => {
    expect(app).toContain('const showImageBackground = backgroundMode === "image"');
    expect(app).toContain('const showRealtimeBackground = backgroundMode === "dynamic"');
  });

  it("exposes and broadcasts theme changes to auxiliary windows", () => {
    expect(preload).toContain("onThemeChanged");
    expect(mainProcess).toContain("function broadcastTheme()");
    expect(mainProcess).toContain('webContents.send("theme:changed", theme)');
  });

  it("keeps destructive context-menu actions visibly distinct", () => {
    expect(workspacePanels).toContain('className={action.destructive ? "is-danger" : undefined}');
  });

  it("limits reasoning output to half of its previous maximum height before it becomes scrollable", () => {
    expect(timelineStyles).toContain(".streaming-reasoning-body {");
    expect(timelineStyles).toContain("max-height: min(21vh, 180px);");
    expect(timelineStyles).not.toContain(".streaming-reasoning-body {\n  display: block;\n  height: 200px;");
  });
});
