import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebar = readFileSync(new URL("../apps/desktop/src/renderer/history/history-sidebar.tsx", import.meta.url), "utf8");
// styles.css is checked out with CRLF on Windows; normalize so the assertions
// match the same text on every platform.
const styles = readFileSync(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("history sidebar sections", () => {
  it("shows tasks and projects as two sections in one list", () => {
    expect(sidebar).toContain('label: "任务"');
    expect(sidebar).toContain('label: "项目"');
    expect(sidebar).toContain("HISTORY_TASKS_SECTION_KEY");
    expect(sidebar).toContain("HISTORY_PROJECTS_SECTION_KEY");
    expect(sidebar).toContain("tasksFold.visibleThreads.map(renderThread)");
  });

  it("folds the projects section to the preview count and expands on click", () => {
    expect(sidebar).toContain("pickVisibleHistorySlice(projectGroups, { expanded: projectsSectionExpanded, previewCount: HISTORY_SECTION_PREVIEW_COUNT })");
    expect(sidebar).toContain("items: projectsFold.visibleItems.map((group) => {");
    expect(sidebar).not.toContain("items: projectGroups.map(");
    expect(sidebar).toContain("onClick={() => toggleGroup(setExpandedGroups, options.sectionKey)}");
  });

  it("no longer renders the project/task tab strip", () => {
    expect(sidebar).not.toContain("sidebar-history-tab");
    expect(sidebar).not.toContain("historyView");
  });

  it("collapses both sections from their headings", () => {
    expect(sidebar).toContain("toggleCollapsedSection(options.sectionKey)");
    expect(styles).toContain(".history-section-heading {");
    expect(styles).toContain(".history-section-count {");
  });

  it("keeps text left aligned, puts the disclosure after the text and shows times on project tasks", () => {
    expect(sidebar).not.toContain("showTime");
    expect(sidebar).toContain('<span className="history-section-label">{options.label}</span><span className="history-section-count">({options.count})</span><span className={`history-project-disclosure');
    expect(sidebar).toContain("{options.heading}<span className={`history-project-disclosure");
    expect(sidebar).toContain('<span className="history-item-time">{formatRelativeTime(thread.updatedAt)}</span>');
    expect(styles).toContain(".history-section-heading {\n  display: flex;");
    expect(styles).toContain(".history-section-label {\n  flex: 0 1 auto;\n  min-width: 0;");
  });

  it("gives project sub tasks one indent level while task rows stay flush left", () => {
    // The tasks section reuses the project container, so the base rule must stay at 0
    // and the indent has to be scoped to project groups only.
    expect(styles).toContain(".history-project-threads {\n  display: grid;\n  gap: 3px;\n  min-width: 0;\n  padding-left: 0;\n}");
    expect(styles).toContain(".history-project-group > .history-project-threads {\n  padding-left: 16px;\n}");
    expect(sidebar).toContain('<div className="history-project-threads">{visibleThreads.map(renderThread)');
  });
});
