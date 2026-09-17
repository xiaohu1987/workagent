import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const timelineCss = readSource("../apps/desktop/src/renderer/timeline.css");
const stylesCss = readSource("../apps/desktop/src/renderer/styles.css");
const backendSource = readSource("../apps/desktop/src/main/app.ts");
const rendererSource = readSource("../apps/desktop/src/renderer/App.tsx");

/**
 * Enter animations that run on transcript entries. Every one of them starts from a
 * partially transparent frame, and transcript entries live under a container that may be
 * skipped by `content-visibility: auto` (see `.chat-transcript > *` in styles.css). A
 * fill-mode would hold such an entry at its `from` frame for as long as the paint is
 * skipped: the message exists in the DOM but stays invisible until the transcript is
 * remounted. Regressing this reproduces "the conclusion never rendered, but switching
 * threads showed it again" - hence the guards below.
 */
const TRANSCRIPT_ENTRY_ANIMATIONS = [
  "timeline-enter",
  "assistant-finalize-enter",
  "user-message-send",
  "subagent-narrative-enter",
  // Runs on the transcript container itself: its `from` frame is `opacity: 0`, so a
  // held fill-mode would hide the whole conversation, not just one entry.
  "thread-transcript-enter"
];

describe("transcript entry motion", () => {
  it("never fills transcript entry animations", () => {
    const declarations: string[] = [];
    for (const line of `${timelineCss}\n${stylesCss}`.split("\n")) {
      const match = /^\s*animation:\s*([a-z-]+)/.exec(line);
      if (!match || !TRANSCRIPT_ENTRY_ANIMATIONS.includes(match[1])) continue;
      declarations.push(line.trim());
    }

    expect(declarations.length).toBeGreaterThanOrEqual(4);
    for (const declaration of declarations) {
      expect(declaration).not.toMatch(/\bboth\b/);
      expect(declaration).not.toMatch(/\bforwards\b/);
    }
  });

  it("still disables the entry animations when reduced motion is requested", () => {
    const blockStart = timelineCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(blockStart).toBeGreaterThan(-1);
    const block = timelineCss.slice(blockStart, timelineCss.indexOf("\n}", blockStart));

    expect(block).toContain("animation: none;");
    expect(block).toContain(".task-timeline .message-card,");
    expect(block).toContain(".task-timeline .message-card.assistant.is-finalizing-from-draft");
    expect(block).toContain(".task-timeline .message-card.user.is-sending");
  });

  it("keeps the tail of the transcript out of content-visibility skipping", () => {
    const tailRuleStart = stylesCss.indexOf(".chat-transcript > *:nth-last-child(-n + 6)");
    expect(tailRuleStart).toBeGreaterThan(-1);
    const tailRule = stylesCss.slice(tailRuleStart, stylesCss.indexOf("}", tailRuleStart));
    expect(tailRule).toContain("content-visibility: visible;");

    // The offscreen optimisation itself must survive: only the tail is exempted.
    expect(stylesCss).toContain(".chat-transcript > * {");
    expect(stylesCss).toContain("content-visibility: auto;");
    expect(stylesCss).toContain(".chat-transcript > .message-card.user {");
  });

  it("samples the snapshot cursor watermark before reading the delta rows", () => {
    const snapshotImplementation = backendSource.slice(
      backendSource.indexOf("public getThreadSnapshot"),
      backendSource.indexOf("public getGpaState")
    );
    const watermarkIndex = snapshotImplementation.indexOf("const observedAt = new Date().toISOString();");
    expect(watermarkIndex).toBeGreaterThan(-1);
    expect(snapshotImplementation).toContain("listMessagesCreatedSince");

    // Rows are selected with `created_at >= observedAt`, so sampling the clock after the
    // reads would drop every row written in between for good: the current delta cannot
    // see them and later deltas skip them. Sampling first only risks a duplicate.
    expect(watermarkIndex).toBeLessThan(snapshotImplementation.indexOf("listMessagesCreatedSince"));
    expect(watermarkIndex).toBeLessThan(snapshotImplementation.indexOf("listToolCallSummariesChangedSince"));
    expect(watermarkIndex).toBeLessThan(snapshotImplementation.indexOf("listArtifactsCreatedSince"));
  });

  it("keeps re-pinning to the bottom after the auto-scroll release fires", () => {
    const observerStart = rendererSource.indexOf("new ResizeObserver");
    expect(observerStart).toBeGreaterThan(-1);
    const observerBlock = rendererSource.slice(
      observerStart,
      rendererSource.indexOf("observer.observe", observerStart)
    );

    // `settleAutoScroll` clears `shouldAutoScrollRef` 320ms after a turn ends, but the
    // transcript keeps growing for longer than that (async markdown highlighting, image
    // decode, font swap) and `.chat-scroll` sets `overflow-anchor: none`, so nothing
    // compensated the scroll position once the release fired. The newest answer drifted
    // below the fold - and, once the transcript was virtualized, out of the rendered
    // window entirely, which is why it only reappeared after switching threads. "Still
    // at the bottom" has to keep it pinned, while a manual scroll must still win.
    expect(observerBlock).toContain("shouldAutoScrollRef.current");
    expect(observerBlock).toContain("isTranscriptAtLatestRef.current");
    expect(observerBlock).toContain("manualTranscriptScrollRef.current");
    expect(rendererSource).toContain("isTranscriptAtLatestRef.current = isTranscriptAtLatest;");
  });
});
