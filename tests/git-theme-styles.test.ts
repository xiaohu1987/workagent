import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../apps/desktop/src/renderer/styles.css", import.meta.url),
  "utf8"
);

function ruleBodyFor(selector: string): string {
  const selectorStart = styles.indexOf(selector);
  expect(selectorStart).toBeGreaterThanOrEqual(0);
  const bodyStart = styles.indexOf("{", selectorStart);
  const bodyEnd = styles.indexOf("}", bodyStart);
  return styles.slice(bodyStart + 1, bodyEnd);
}

describe("Git workspace themed background", () => {
  it("lets the app background show through the Git workspace", () => {
    expect(ruleBodyFor(".app-shell.has-app-background .git-changes-workspace"))
      .toContain("background: transparent");
  });

  it("uses the right workspace opacity for Git controls and surfaces", () => {
    const panelBody = ruleBodyFor(".app-shell.has-app-background .git-changes-header");
    const pickerBody = ruleBodyFor(".app-shell.has-app-background .git-branch-popover");

    expect(panelBody).toContain("var(--app-bg-right-panel)");
    expect(panelBody).toContain("backdrop-filter: blur(6px)");
    expect(pickerBody).toContain("background: rgba(18, 18, 22, var(--app-bg-right-panel))");
    expect(pickerBody).toContain("backdrop-filter: blur(10px)");
    expect(styles).toContain('background: rgba(255, 255, 255, var(--app-bg-right-panel)) !important;');
    expect(styles).toMatch(/\.app-shell\.has-app-background \.git-branch-create-form\s*\{[^}]*background:\s*transparent/s);
  });

  it("styles the branch picker tabs, scrollable list, and light theme", () => {
    expect(ruleBodyFor(".git-branch-list")).toContain("max-height: 280px");
    expect(ruleBodyFor(".git-branch-tabs button.active::after")).toContain("background: #4c9ff0");
    expect(ruleBodyFor(':root[data-theme="light"] .git-branch-option.is-current')).toContain("background: #ddf4ff");
    expect(styles).toMatch(/:root\[data-theme="light"\] \.app-shell \.git-branch-create-button,[^{]*\{[^}]*color:\s*#ffffff\s*!important[^}]*background:\s*var\(--action-primary\)\s*!important/s);
  });

  it("keeps the branch picker above the Git content when opened", () => {
    expect(styles).toMatch(/\.git-changes-header\s*\{[^}]*position:\s*relative[^}]*z-index:\s*40[^}]*overflow:\s*visible/s);
  });

  it("lets the right workspace panel own the configured image opacity", () => {
    const start = styles.indexOf("The right workspace opacity setting has a single owner");
    const backgroundRules = styles.slice(start);

    expect(start).toBeGreaterThan(-1);
    expect(backgroundRules).toContain("  .project-files-workspace,");
    expect(backgroundRules).toContain("  .project-files-filter,");
    expect(backgroundRules).toContain("  .git-changes-header,");
    expect(backgroundRules).toContain("  .git-commit-panel,");
    expect(backgroundRules).toContain("  .git-change-list,");
    expect(backgroundRules).toContain("  .right-workspace-empty-state");
    expect(backgroundRules).toContain("background: transparent !important;");
    expect(backgroundRules).toContain(".project-file-row:not(:hover):not(.selected)");
    expect(backgroundRules).toContain(".git-file-row {");
  });
});
