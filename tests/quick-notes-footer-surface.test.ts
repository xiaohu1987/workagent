import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../apps/desktop/src/renderer/styles.css", import.meta.url),
  "utf8"
);

type RuleBlock = { selector: string; body: string };

function ruleBlocks(css: string): RuleBlock[] {
  const blocks: RuleBlock[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(css);
  while (match) {
    blocks.push({ selector: match[1].trim(), body: match[2] });
    match = pattern.exec(css);
  }
  return blocks;
}

const footerSelector = /(^|[\s,>])\.quick-notes-footer(?![\w-])/;

describe("Quick-notes footer surface", () => {
  it("never paints the footer with a background of its own", () => {
    const footerRules = ruleBlocks(styles).filter((block) => footerSelector.test(block.selector));
    expect(footerRules.length).toBeGreaterThan(0);

    for (const block of footerRules) {
      const backgrounds = block.body.match(/background(-color)?\s*:[^;]+;/g) ?? [];
      for (const declaration of backgrounds) {
        // Only a transparent reset is allowed: the footer inherits the dialog
        // surface so it cannot look like a separate bar under the editor.
        expect(declaration.replace(/\s+/g, " ").trim()).toBe(
          "background: transparent !important;"
        );
      }
    }
  });

  it("keeps the configured image-background opacity off the footer", () => {
    const start = styles.indexOf("Soften solid inner modules inside dialogs / settings.");
    const end = styles.indexOf("body:has(.app-shell.has-app-background) .fetch-models-overlay");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const softenedModules = styles.slice(start, end);
    expect(softenedModules).toContain(".app-shell.has-app-background .quick-notes-list,");
    expect(softenedModules).not.toMatch(/\.quick-notes-footer(?!-)/);
  });

  it("keeps the light image-background sheet mask transparent on the footer", () => {
    const lightMask = styles.slice(
      styles.indexOf("Keep the configured dialog mask as one continuous surface")
    );
    expect(lightMask).toContain("  .quick-notes-footer,");
    expect(lightMask).toContain("background: transparent !important;");
  });

  it("keeps the footer as a separator line instead of a filled band", () => {
    const baseRule = styles.slice(
      styles.indexOf(".quick-notes-footer {", styles.indexOf(".quick-notes-content-input:focus"))
    );
    const body = baseRule.slice(baseRule.indexOf("{") + 1, baseRule.indexOf("}"));
    expect(body).toContain("border-top: 1px solid var(--border);");
    expect(body).not.toContain("background");
  });
});
