import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../apps/desktop/src/renderer/styles.css", import.meta.url),
  "utf8"
);

const cloudNotesPage = readFileSync(
  new URL(
    "../apps/desktop/src/renderer/settings/pages/connections/cloud-notes-page.tsx",
    import.meta.url
  ),
  "utf8"
);

function ruleBodyFor(selector: string): string {
  const selectorStart = styles.indexOf(selector);
  expect(selectorStart).toBeGreaterThanOrEqual(0);
  const bodyStart = styles.indexOf("{", selectorStart);
  const bodyEnd = styles.indexOf("}", bodyStart);
  return styles.slice(bodyStart + 1, bodyEnd);
}

describe("Cloud notes linked-quick-note tag", () => {
  it("renders the linked tag through the cloud-notes-tag base class", () => {
    expect(cloudNotesPage).toContain('className="cloud-notes-tag is-linked"');
  });

  it("reuses the quick-notes pill treatment for the linked tag", () => {
    const linked = ruleBodyFor(".cloud-notes-tag.is-linked");
    const quickNotesTag = ruleBodyFor(".quick-notes-cloud-tag");

    // Same blue identity rail: primary color text plus a translucent primary fill.
    expect(linked).toContain("color: var(--action-primary);");
    expect(linked).toContain(
      "border-color: color-mix(in srgb, var(--action-primary) 46%, transparent);"
    );
    expect(linked).toContain(
      "background: color-mix(in srgb, var(--action-primary) 15%, transparent);"
    );
    // The pill geometry stays on the shared base class so both tag variants match.
    expect(ruleBodyFor(".cloud-notes-tag")).toContain("border-radius: 999px;");
    expect(quickNotesTag).toContain(
      "border: 1px solid color-mix(in srgb, var(--action-primary) 46%, transparent);"
    );
    expect(quickNotesTag).toContain(
      "background: color-mix(in srgb, var(--action-primary) 15%, transparent);"
    );
  });

  it("leads the linked tag with the same status dot as the quick-notes tag", () => {
    const dot = ruleBodyFor(".cloud-notes-tag.is-linked::before");
    expect(dot).toContain("background: currentColor;");
    expect(dot).toContain("border-radius: 999px;");
    expect(dot).toContain(
      "box-shadow: 0 0 0 3px color-mix(in srgb, var(--action-primary) 20%, transparent);"
    );
  });

  it("keeps the linked tag theme-driven instead of hardcoding colors", () => {
    const linked = ruleBodyFor(".cloud-notes-tag.is-linked");
    const dot = ruleBodyFor(".cloud-notes-tag.is-linked::before");

    expect(linked).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(dot).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(linked).not.toMatch(/rgba?\(/);
    expect(dot).not.toMatch(/rgba?\(/);
  });

  it("keeps the pending tag and the linked tag visually distinct", () => {
    const pending = ruleBodyFor(".cloud-notes-tag.is-pending");
    const linked = ruleBodyFor(".cloud-notes-tag.is-linked");
    expect(pending).toContain("var(--action-primary)");
    expect(linked).not.toBe(pending);
  });
});
