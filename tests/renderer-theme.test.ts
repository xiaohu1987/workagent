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
const conversationLogWindowMain = readFileSync(
  new URL("../apps/desktop/src/main/conversation-log-window.ts", import.meta.url),
  "utf8"
);
const liveEditPreviewWindowMain = readFileSync(
  new URL("../apps/desktop/src/main/live-edit-preview-window.ts", import.meta.url),
  "utf8"
);
const app = readFileSync(
  new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url),
  "utf8"
);
const appearanceSettingsPage = readFileSync(
  new URL("../apps/desktop/src/renderer/settings/pages/application/appearance-page.tsx", import.meta.url),
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
const liveEditPreviewStyles = readFileSync(
  new URL("../apps/desktop/src/renderer/live-edit-preview/live-edit-preview.css", import.meta.url),
  "utf8"
);
const conversationLogWindowStyles = readFileSync(
  new URL("../apps/desktop/src/renderer/conversation-log-window/conversation-log-window.css", import.meta.url),
  "utf8"
);
const transcript = readFileSync(
  new URL("../apps/desktop/src/renderer/timeline/transcript.tsx", import.meta.url),
  "utf8"
);
const runtimeCards = readFileSync(
  new URL("../apps/desktop/src/renderer/cards/runtime-cards.tsx", import.meta.url),
  "utf8"
);
const chartStyles = readFileSync(
  new URL("../apps/desktop/src/renderer/charts/echarts-message-chart.css", import.meta.url),
  "utf8"
);
const chartRenderer = readFileSync(
  new URL("../apps/desktop/src/renderer/charts/echarts-message-chart.tsx", import.meta.url),
  "utf8"
);
const mermaidStyles = readFileSync(
  new URL("../apps/desktop/src/renderer/charts/mermaid-message-diagram.css", import.meta.url),
  "utf8"
);
const mermaidRenderer = readFileSync(
  new URL("../apps/desktop/src/renderer/charts/mermaid-message-diagram.tsx", import.meta.url),
  "utf8"
);

describe("renderer theme", () => {
  it("keeps legacy system preferences on the existing dark appearance", () => {
    expect(resolveAppTheme("system")).toBe("dark");
    expect(resolveAppTheme("dark")).toBe("dark");
    expect(resolveAppTheme("light")).toBe("light");
  });

  it("defines a layered white workbench with light-blue primary actions", () => {
    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain("--window: #f6f8fa");
    expect(styles).toContain("--surface-soft: #f3f7fb");
    expect(styles).toContain("--border: #d0d7de");
    expect(styles).toContain("--text: #1f2328");
    expect(styles).toContain("--action-primary: #2196f3");
    expect(styles).toContain("--action-primary-hover: #1976d2");
    expect(styles).toContain("--accent-purple: #8b5cf6");
    expect(styles).toContain("--accent-teal: #0f766e");
    expect(styles).toContain("--accent-pink: #db2777");
    expect(styles).toContain("--accent-amber: #d97706");
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
    expect(timelineStyles).toContain('Compact semantic event stream for the light workbench');
    expect(timelineStyles).toContain('background: #ddf4ff !important;');
    expect(timelineStyles).toContain('background: #dafbe1 !important;');
    expect(timelineStyles).toContain('background: #fff8c5 !important;');
    expect(timelineStyles).toContain('background: #ffebe9 !important;');
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
    expect(styles).toContain("later component styles cannot turn Send back to blue");
    expect(styles).toContain(':root[data-theme="light"] .app-shell .send-button.running:not(:disabled)');
  });

  it("uses one glowing outer composer frame without inner input lines", () => {
    expect(styles).toContain("Light depth system: keep the application canvas white");
    expect(styles).toContain("--shadow-blue-control:");
    expect(styles).toContain("0 0 0 1px rgba(51, 156, 255, 0.16)");
    expect(styles).toContain("0 0 24px 5px rgba(51, 156, 255, 0.13)");
    expect(styles).toContain(':root[data-theme="light"] .app-shell .chat-composer {');
    expect(styles).toContain("background: #ffffff !important;");
    expect(styles).toContain("box-shadow: var(--shadow-blue-control) !important;");
    expect(styles).toContain(':root[data-theme="light"] .app-shell .chat-composer:focus-within {');
    expect(styles).toContain("0 0 0 2px rgba(51, 156, 255, 0.18)");
    expect(styles).toContain("border: 0 !important;");
    expect(styles).toContain("background: transparent !important;");
    expect(styles).toContain("box-shadow: none !important;");
    expect(styles).toContain(':root[data-theme="light"] .chat-composer .composer-toolbar {');
    expect(styles).toContain("border-top: 0 !important;");
    expect(styles).toContain(':root[data-theme="light"] .app-shell:is(.has-app-background, .has-realtime-character) .chat-composer {');
  });

  it("uses restrained blue depth for structural edges and elevated surfaces", () => {
    expect(styles).toContain("--shadow-blue-edge:");
    expect(styles).toContain("--shadow-blue-elevated:");
    expect(styles).toContain(':root[data-theme="light"] .windowbar {');
    expect(styles).toContain(':root[data-theme="light"] .sidebar {');
    expect(styles).toContain(':root[data-theme="light"] .right-workspace-panel {');
    expect(styles).toContain("box-shadow: var(--shadow-blue-elevated) !important;");
    expect(styles).toContain("box-shadow: 0 3px 10px rgba(33, 150, 243, 0.13) !important;");
  });

  it("renders sidebar navigation and history as flat rows without card frames", () => {
    expect(styles).toContain("Sidebar navigation is a flat list");
    expect(styles).toContain(':root[data-theme="light"] .app-shell:is(.has-app-background, .has-realtime-character) .sidebar-nav-button,');
    expect(styles).toContain(':root[data-theme="light"] .app-shell:is(.has-app-background, .has-realtime-character) .history-item {');
    expect(styles).toContain("border: 0 !important;");
    expect(styles).toContain("background: transparent !important;");
    expect(styles).toContain(':root[data-theme="light"] .history-item.selected,');
    expect(styles).toContain("box-shadow: inset 2px 0 0 var(--accent-blue) !important;");
  });

  it("keeps changed-files compact until its file panel is explicitly expanded", () => {
    expect(timelineStyles).toContain("The closed trigger is a quiet action row");
    expect(timelineStyles).toContain(':root[data-theme="light"] .generated-file-list {');
    expect(timelineStyles).toContain("width: fit-content;");
    expect(timelineStyles).toContain(':root[data-theme="light"] .generated-file-list:has(.generated-file-list-toggle.is-expanded) {');
    expect(timelineStyles).toContain("width: min(100%, 920px);");
    expect(timelineStyles).toContain("border-left: 3px solid var(--list-accent, #339cff) !important;");
    expect(timelineStyles).toContain("background: #f3f7fb !important;");
    expect(timelineStyles).toContain(':root[data-theme="light"] .generated-file-list:has(.generated-file-list-toggle.is-expanded) .generated-file-list-items {');
    expect(timelineStyles).toContain("background: #ffffff !important;");
    expect(timelineStyles).toContain("background: #ddf4ff !important;");
  });

  it("keeps file counts and Markdown list markers quiet in the light transcript", () => {
    expect(timelineStyles).toContain("Counts and Markdown list markers support scanning");
    expect(timelineStyles).toContain("color: #57606a !important;");
    expect(timelineStyles).toContain('content: "·";');
    expect(timelineStyles).toContain("background: #9aa7b4;");
  });

  it("renders compact tool activity as a neutral execution record", () => {
    expect(timelineStyles).toContain("Tool activity is a compact execution record");
    expect(timelineStyles).toContain(':root[data-theme="light"] .tool-activity-details {');
    expect(timelineStyles).toContain("border-bottom-color: #e5e9ee !important;");
    expect(timelineStyles).toContain("Targets stay inline here");
    expect(timelineStyles).toContain(':root[data-theme="light"] .tool-activity-compact-summary code {');
    expect(timelineStyles).toContain("background: transparent !important;");
    expect(timelineStyles).toContain("border-left: 2px solid #aab6c2;");
    expect(timelineStyles).toContain("border-left-color: #dc2626;");
  });

  it("renders message editing as a neutral workspace form instead of a blue bubble", () => {
    expect(timelineStyles).toContain("Editing a sent message is a focused work surface");
    expect(timelineStyles).toContain(':root[data-theme="light"] .task-timeline .message-user-content.is-editing {');
    expect(timelineStyles).toContain("border: 1px solid #d0d7de;");
    expect(timelineStyles).toContain(':root[data-theme="light"] .message-user-edit-input:focus-visible {');
    expect(timelineStyles).toContain("outline: 2px solid rgba(33, 150, 243, 0.14);");
    expect(timelineStyles).toContain(':root[data-theme="light"] .message-user-edit-actions {');
    expect(timelineStyles).toContain('.message-card.user .message-user-content.is-editing .message-user-bubble');
    expect(timelineStyles).toContain('.message-user-content.is-editing .message-user-edit-head');
    expect(timelineStyles).toContain('.message-user-content.is-editing .message-user-edit-actions');
    expect(timelineStyles).toContain('.message-user-content.is-editing .message-user-edit-button.primary');
  });

  it("keeps normal light chat white while allowing image backgrounds", () => {
    expect(app).toContain('const showImageBackground = backgroundMode === "image" && chatBackgroundImages.length > 0');
    expect(app).toContain('const showRealtimeBackground = appTheme === "dark" && backgroundMode === "dynamic"');
    expect(styles).toContain('Keep the normal light conversation canvas pure white');
    expect(styles).toContain(':root[data-theme="light"] :is(.chat-canvas, .chat-scroll)');
    expect(styles).toContain('background: #ffffff !important;');
    expect(styles).toContain('Image backgrounds remain available in light mode');
    expect(styles).toContain(':root[data-theme="light"] .app-shell.has-app-background .workspace');
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-workspace)) !important;');
    expect(styles).toContain(':root[data-theme="light"] .app-shell.has-app-background :is(.chat-canvas, .chat-scroll, .chat-transcript)');
    expect(styles).toContain('background: transparent !important;');
    expect(styles).toContain('background-image: none !important;');
    expect(styles).toContain('Structural chrome must');
    expect(styles).toContain('  .right-workspace-view,');
    expect(styles).toContain('  .composer-shell');
    expect(styles).toContain('backdrop-filter: none;');
  });

  it("disables dynamic backgrounds in light mode and resets them during theme changes", () => {
    expect(app).toContain('if (backgroundMode === "dynamic" && isLightTheme)');
    expect(app).toContain('if (mode === "dynamic" && resolveAppTheme(config?.desktop.theme) === "light")');
    expect(app).toContain('const shouldResetDynamicBackground = nextTheme === "light" && backgroundMode === "dynamic"');
    expect(app).toContain('updateChatBackgroundSettings({ mode: "none", enabled: false });');
    expect(app).toContain('updateChatBackgroundSettings({ mode: "dynamic", enabled: previousBackgroundEnabled });');
    expect(app).toContain('dynamicBackgroundDisabled={appTheme === "light"}');
    expect(appearanceSettingsPage).toContain('const disabled = option.value === "dynamic" && dynamicBackgroundDisabled;');
    expect(appearanceSettingsPage).toContain('disabled={disabled}');
    expect(appearanceSettingsPage).toContain('if (disabled) return;');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-mode-option.is-disabled:hover');
    expect(styles).toContain('cursor: not-allowed;');
  });

  it("uses the shared blue-white control language throughout the light appearance editor", () => {
    expect(appearanceSettingsPage).toContain('function getRangeProgressStyle');
    expect(appearanceSettingsPage).toContain('style={getRangeProgressStyle(settings.opacity, 0, 100)}');
    expect(styles).toContain('Light appearance editor: use the same blue-white control language');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-mode-option.is-selected:not(.is-disabled)');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-preview-bar');
    expect(styles).toContain(':root[data-theme="light"] .preview-bubble-user');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-add-button');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-image-item.is-active');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-toggle input:checked + span,');
    expect(styles).toContain('input[type="range"]::-webkit-slider-runnable-track');
    expect(styles).toContain('#2196f3 0 var(--range-progress, 0%)');
    expect(styles).toContain(':root[data-theme="light"] .chat-background-actions .background-action-danger:hover:not(:disabled)');
  });

  it("applies every image-background opacity control to its light-theme surface", () => {
    expect(styles).toContain('Keep every light image-background surface connected to its opacity control');
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-windowbar)) !important;');
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-sidebar)) !important;');
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-workspace)) !important;');
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-right-panel)) !important;');
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-terminal)) !important;');
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-dialog)) !important;');
    expect(styles).toContain(':root[data-theme="light"] .app-shell.has-app-background .right-workspace-panel');
    expect(styles).toContain(':root[data-theme="light"] .app-shell.has-app-background .workspace-terminal-drawer');
    expect(styles).toContain('nested regions stay transparent');
    expect(styles).toContain('Do not repaint the full sidebar footer');
    expect(styles).toContain('  .sidebar-settings:hover,');
    expect(styles).toContain('  .sidebar-settings-button:hover');
    expect(styles).toContain('.sidebar-settings-button:hover .sidebar-settings-main');
    expect(styles).toContain('Sidebar help stays a plain icon action');
    expect(styles).toContain(':root[data-theme="light"] .sidebar-settings-help:hover,');
    expect(styles).toContain('.app-shell.has-app-background .sidebar-settings-help:focus-visible {');
    expect(styles).toContain('border: 0 !important;');
    expect(styles).toContain('background: transparent !important;');
    expect(styles).toContain('A light image background needs a light scrim');
    expect(styles).toContain('  .settings-overlay,');
    expect(styles).toContain('  .project-sheet-overlay,');
    expect(styles).toContain('background: rgba(246, 248, 250, min(0.28, calc(var(--app-bg-dialog) * 0.3))) !important;');
    expect(styles).toContain("Keep the configured dialog mask as one continuous surface");
    expect(styles).toContain('  .provider-settings-layout,');
    expect(styles).toContain('  .settings-topbar,\n  .settings-sidebar');
    expect(styles).toContain('  .provider-list-panel,\n  .provider-detail-panel');
    expect(styles).toContain("Settings navigation follows the dark-mode interaction model");
    expect(styles).toContain('.app-shell.has-app-background .settings-strip-tab.active');
    expect(styles).toContain('  .quick-notes-sheet > .project-sheet-header,');
    expect(styles).toContain('  .quick-notes-footer,');
    expect(styles).toContain('The composer surround belongs to the conversation surface');
    expect(styles).toContain('  .composer-shell,\n  .composer-meta-row');
  });

  it("lets the configured dialog shell own opacity without inner background fills", () => {
    const start = styles.indexOf("The dialog shell is the only owner of the configured opacity");
    const end = styles.indexOf("The composer surround belongs to the conversation surface", start);
    const dialogSurfaceRules = styles.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(dialogSurfaceRules).toContain("--light-dialog-hover: rgba(33, 150, 243, calc(var(--app-bg-dialog) * 0.08));");
    expect(dialogSurfaceRules).toContain("--light-dialog-selected: rgba(33, 150, 243, calc(var(--app-bg-dialog) * 0.14));");
    expect(dialogSurfaceRules).toContain("  .settings-topbar,");
    expect(dialogSurfaceRules).toContain("  .settings-sidebar,");
    expect(dialogSurfaceRules).toContain("  .knowledge-import-panel,");
    expect(dialogSurfaceRules).toContain("  .knowledge-source-list,");
    expect(dialogSurfaceRules).toContain("  .mcp-server-row,");
    expect(dialogSurfaceRules).toContain("  .skill-row,");
    expect(dialogSurfaceRules).toContain("  .chat-background-motion-setting,");
    expect(dialogSurfaceRules).toContain("  .quick-notes-sheet .quick-notes-item,");
    expect(dialogSurfaceRules).toContain("  .history-search-dialog .history-search-result,");
    expect(dialogSurfaceRules).toContain("  .fetch-models-dialog .fetch-models-item");
    expect(dialogSurfaceRules).toContain("background: transparent !important;");
    expect(dialogSurfaceRules).not.toContain("--light-dialog-layer:");
    expect(dialogSurfaceRules).not.toContain("--light-dialog-control:");
    expect(dialogSurfaceRules).not.toContain("background: #ffffff");
  });

  it("uses pure white for every normal light-mode application region", () => {
    expect(styles).toContain("Normal light mode uses a genuinely white application canvas");
    expect(styles).toContain(':root[data-theme="light"] .app-shell:not(.has-app-background):not(.has-realtime-character) {');
    expect(styles).toContain('.app-shell:not(.has-app-background):not(.has-realtime-character) :is(');
    expect(styles).toContain("  .sidebar,");
    expect(styles).toContain("  .workspace,");
    expect(styles).toContain("  .chat-canvas,");
    expect(styles).toContain("  .right-workspace-panel,");
    expect(styles).toContain("background: #ffffff !important;");
    expect(styles).toContain("background-image: none !important;");
    expect(styles).toContain('.app-shell:is(.has-app-background, .has-realtime-character) :is(.chat-canvas, .chat-scroll, .chat-transcript)');
    expect(mainProcess).toContain('mainWindow.setBackgroundColor(theme === "light" ? "#ffffff" : "#09090a")');
    expect(mainProcess).toContain('backgroundColor: backend.getConfig().desktop.theme === "light" ? "#ffffff" : "#09090a"');
    expect(conversationLogWindowMain).toContain('this.#options.getTheme() === "light" ? "#ffffff" : "#090d13"');
    expect(liveEditPreviewWindowMain).toContain('this.#options.getTheme() === "light" ? "#ffffff" : "#0b0c0e"');
  });

  it("uses a themed in-app tooltip for browser-source details", () => {
    expect(transcript).toContain('className="message-browser-source-tooltip"');
    expect(transcript).toContain('role="tooltip"');
    expect(transcript).not.toContain('title={`网页来源');
    expect(styles).toContain(':root[data-theme="light"] .message-browser-source-tooltip {');
    expect(styles).toContain('background: var(--surface) !important;');
    expect(styles).toContain('box-shadow: 0 8px 22px rgba(31, 35, 40, 0.12) !important;');
  });

  it("uses the shared light popover treatment for conversation rail previews", () => {
    expect(timelineStyles).toContain("conversation rail preview aligned with the shared light popover");
    expect(timelineStyles).toContain(':root[data-theme="light"] .conversation-turn-preview {');
    expect(timelineStyles).toContain("border-color: #d0d7de;");
    expect(timelineStyles).toContain("background: #ffffff;");
    expect(timelineStyles).toContain("box-shadow: 0 8px 22px rgba(31, 35, 40, 0.12);");
    expect(timelineStyles).toContain(':root[data-theme="light"] .conversation-turn-preview-copy {');
    expect(timelineStyles).toContain(':root[data-theme="light"] .conversation-turn-preview-files .conversation-turn-preview-file {');
    expect(timelineStyles).toContain("background: #eef7fc;");
  });

  it("distinguishes subagent phase progress with semantic light-theme colors", () => {
    expect(styles).toContain("Phase progress uses compact semantic color");
    expect(styles).toContain(':root[data-theme="light"] .subagent-phase.completed { color: #1a7f37 !important; }');
    expect(styles).toContain(':root[data-theme="light"] .subagent-phase.current { color: #0969da !important; }');
    expect(styles).toContain(':root[data-theme="light"] .subagent-phase.current.is-waiting { color: #9a6700 !important; }');
    expect(styles).toContain(':root[data-theme="light"] .subagent-phase.failed { color: #cf222e !important; }');
    expect(styles).toContain(':root[data-theme="light"] .subagent-phase.cancelled { color: #6e7781 !important; }');
    expect(runtimeCards).toContain('getSubagentPhaseToneClass(phase)');
  });

  it("renders the composer queue as a hierarchical light-theme list", () => {
    expect(styles).toContain("composer queue follows the shared list hierarchy");
    expect(styles).toContain(':root[data-theme="light"] .composer-queue-item:first-child {');
    expect(styles).toContain("border-left-color: #2196f3 !important;");
    expect(styles).toContain("background: #f3f8fc !important;");
    expect(styles).toContain(':root[data-theme="light"] .composer-queue-item:hover {');
    expect(styles).toContain(':root[data-theme="light"] .chat-composer .composer-queue-steer {');
    expect(styles).toContain("color: #ffffff !important;");
    expect(styles).toContain(':root[data-theme="light"] .chat-composer .composer-queue-delete:hover:not(:disabled)');
    expect(styles).toContain("background: #dc2626 !important;");
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

  it("distinguishes light reasoning text from the assistant response with neutral gray", () => {
    expect(timelineStyles).toContain("Reasoning stays readable but uses a neutral gray");
    expect(timelineStyles).toContain("  .streaming-reasoning > summary,");
    expect(timelineStyles).toContain("  .streaming-reasoning-body");
    expect(timelineStyles).toContain("color: #6e7781 !important;");
    expect(timelineStyles).toContain("color: #24425d !important;");
  });

  it("matches the light project context pill to the white file-change summary", () => {
    expect(styles).toContain("Match the project context to the adjacent file-change summary");
    expect(styles).toContain(':root[data-theme="light"] .composer-project-pill {');
    expect(styles).toContain("border: 1px solid #cfddea !important;");
    expect(styles).toContain("background: #ffffff !important;");
    expect(styles).toContain("box-shadow: none !important;");
    expect(styles).toContain(':root[data-theme="light"] .composer-project-pill:hover,');
    expect(styles).toContain("background: #eaf5ff !important;");
  });

  it("renders every supported Markdown primitive with a light document hierarchy", () => {
    expect(styles).toContain('Markdown reads as a document');
    expect(styles).toContain('font-size: 14px;');
    expect(styles).toContain('line-height: 1.7;');
    expect(styles).toContain('border-bottom: 1px solid var(--border);');
    expect(styles).toContain('.markdown-link.file { color: var(--accent-teal) !important; }');
    expect(styles).toContain('.markdown-task-list input { accent-color: var(--accent-blue); }');
    expect(styles).toContain('.markdown-code-block {');
    expect(styles).toContain('.copy-text-button.is-copied');
    expect(styles).toContain('color: #8250df;');
    expect(styles).toContain('color: #1a7f37;');
    expect(styles).toContain('color: #9a6700;');
    expect(styles).toContain('.markdown-table tbody tr:hover { background: var(--accent-blue-soft) !important; }');
    expect(styles).toContain('.markdown-image-button:hover .markdown-image');
  });

  it("gives light Markdown code and lists a layered reading treatment", () => {
    expect(styles).toContain('Markdown reading surface: add hierarchy');
    expect(styles).toContain('grid-template-columns: 52px minmax(0, 1fr);');
    expect(styles).toContain('background: linear-gradient(180deg, #f3f8fc, #eaf2f8) !important;');
    expect(styles).toContain('box-shadow: 0 8px 24px rgba(51, 79, 107, 0.1) !important;');
    expect(styles).toContain('ul:not(.markdown-task-list) > li::before');
    expect(styles).toContain('counter-reset: markdown-list-item;');
    expect(styles).toContain('background: #eef7fc !important;');
    expect(styles).toContain('.markdown-table tbody tr:nth-child(even) { background: #f7fafc !important; }');
  });

  it("uses a standard neutral code surface and shared blue list marker in light mode", () => {
    expect(styles).toContain('Final Markdown polish: use the standard neutral document and code palette');
    expect(styles).toContain('background: #f6f8fa !important;');
    expect(styles).toContain('box-shadow: none !important;');
    expect(styles).toContain('border-left: 2px solid #e8eef4;');
    expect(timelineStyles).toContain('border-left: 3px solid var(--list-accent, #339cff) !important;');
  });

  it("uses the reference blue for repeated list identification rails", () => {
    expect(styles).toContain("--list-accent: #339cff;");
    expect(styles).toContain("Repeated entity lists share the same reference-blue identification rail");
    expect(styles).toContain("  .mcp-server-row,");
    expect(styles).toContain("  .database-connection-card,");
    expect(styles).toContain("  .project-file-row,");
    expect(styles).toContain("  .composer-queue-item");
    expect(styles).toContain("border-left: 3px solid var(--list-accent) !important;");
  });

  it("uses a red identification rail for provider and model configuration rows", () => {
    expect(styles).toContain("Provider and model configuration rows use the requested red identity rail");
    expect(styles).toContain(':root[data-theme="light"] .settings-dialog :is(');
    expect(styles).toContain("  .provider-list-card,");
    expect(styles).toContain("  .provider-model-row");
    expect(styles).toContain("border-left: 3px solid var(--accent-red) !important;");
    expect(styles).toContain('.settings-dialog .provider-list-card:is(:hover, .selected)');
  });

  it("places the plain active thread title above the main workspace", () => {
    const windowbarStart = app.indexOf('<header className="windowbar">');
    const windowbarEnd = app.indexOf("</header>", windowbarStart);
    const titleIndex = app.indexOf("workspace-thread-title windowbar-thread-title");
    const workspaceStart = app.indexOf('<main className="workspace">');

    expect(windowbarStart).toBeGreaterThan(-1);
    expect(titleIndex).toBeGreaterThan(windowbarStart);
    expect(titleIndex).toBeLessThan(windowbarEnd);
    expect(workspaceStart).toBeGreaterThan(windowbarEnd);
    expect(styles).toContain(".windowbar > .windowbar-thread-title {");
    expect(styles).toContain("left: calc(var(--sidebar-pane-width) + 28px);");
    expect(styles).toContain("padding: 0;");
    expect(styles).toContain("border: 0 !important;");
    expect(styles).toContain("background: transparent !important;");
    expect(styles).toContain("box-shadow: none !important;");
    expect(styles).toContain("-webkit-user-select: none;");
    expect(styles).toContain("user-select: none;");
    expect(styles).toContain(".windowbar > .windowbar-thread-title::selection,");
    expect(styles).toContain(".windowbar > .windowbar-thread-title *::selection {");
    expect(styles).toContain(':root[data-theme="light"] .windowbar > .windowbar-thread-title {');
    expect(styles).toContain("transform: translateY(-50%);");
    expect(styles).toContain(".app-shell.sidebar-collapsed .windowbar > .windowbar-thread-title {");
    expect(styles).toContain(".app-shell.has-app-background .windowbar > .windowbar-thread-title {");
  });

  it("keeps light Markdown code blocks vertically compact", () => {
    expect(styles).toContain("Compact light code blocks so short examples");
    expect(styles).toContain("margin-top: 12px;");
    expect(styles).toContain("min-height: 32px;");
    expect(styles).toContain("padding: 6px 0 8px;");
    expect(styles).toContain("line-height: 1.45;");
    expect(styles).toContain("grid-template-columns: 44px minmax(0, 1fr);");
    expect(styles).toContain("min-height: 18px;");
    expect(styles).toContain(':root[data-theme="light"] .markdown-code-block .copy-text-button {');
    expect(styles).toContain("width: 26px;");
  });

  it("uses the requested two-level document hierarchy for light Markdown", () => {
    expect(styles).toContain("Final light Markdown document contract");
    expect(styles).toContain(":is(h1, h2) {");
    expect(styles).toContain("font-size: 20px;");
    expect(styles).toContain("border-left: 3px solid #8b5cf6;");
    expect(styles).toContain("line-height: 1.75;");
    expect(styles).toContain(".markdown-mermaid,");
    expect(styles).toContain(".message-chart {");
  });

  it("renders Mermaid and ECharts with matching light report surfaces", () => {
    expect(mermaidRenderer).toContain('securityLevel: "strict"');
    expect(mermaidRenderer).toContain('theme === "light"');
    expect(mermaidRenderer).toContain("mermaidRenderQueue");
    expect(mermaidStyles).toContain(':root[data-theme="light"] .markdown-mermaid {');
    expect(mermaidStyles).toContain("background: #ffffff;");
    expect(chartRenderer).toContain("ECHARTS_LIGHT_THEME");
    expect(chartRenderer).toContain("ECHARTS_THEME_NAMES[theme]");
    expect(chartStyles).toContain(':root[data-theme="light"] .message-chart,');
    expect(chartStyles).toContain("background: #ffffff;");
  });

  it("uses the same light code and surface system in detached windows", () => {
    expect(liveEditPreviewStyles).toContain('Match the primary renderer\'s light workbench');
    expect(liveEditPreviewStyles).toContain('background: #f6f8fa;');
    expect(liveEditPreviewStyles).toContain('color: #8250df;');
    expect(liveEditPreviewStyles).toContain('color: #1a7f37;');
    expect(conversationLogWindowStyles).toContain('The detached log uses the same canvas');
    expect(conversationLogWindowStyles).toContain('background: #f3f7fb;');
  });
});
