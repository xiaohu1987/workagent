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
    const inputBody = ruleBodyFor(".app-shell.has-app-background .git-branch-select select");

    expect(panelBody).toContain("var(--app-bg-right-panel)");
    expect(panelBody).toContain("backdrop-filter: blur(6px)");
    expect(inputBody).toContain("var(--app-bg-right-panel)");
    expect(inputBody).toContain("backdrop-filter: blur(6px)");
  });
});
