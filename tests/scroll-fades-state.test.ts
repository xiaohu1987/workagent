import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SCROLL_FADE_SETTLE_SAMPLES,
  resolveScrollFadeState,
  type ScrollFadeState
} from "../apps/desktop/src/renderer/scroll-fades";

const INITIAL: ScrollFadeState = {
  top: false,
  bottom: false,
  topSamples: 0,
  bottomSamples: 0
};

const scrollFadeSource = readFileSync(
  new URL("../apps/desktop/src/renderer/scroll-fades.ts", import.meta.url),
  "utf8"
);

describe("scroll fade settle", () => {
  it("ignores the single-frame edge flip produced by re-pinning a growing transcript", () => {
    // A streamed answer grows, the transcript is re-pinned one frame later, so the bottom
    // edge samples "not at the end" for exactly one frame. Committing that sample rewrote
    // `mask-image` on the whole chat region every frame.
    const flipped = resolveScrollFadeState(INITIAL, { top: false, bottom: true });
    expect(flipped.bottom).toBe(false);

    const settledBack = resolveScrollFadeState(flipped, { top: false, bottom: false });
    expect(settledBack.bottom).toBe(false);
  });

  it("commits an edge once it has been reported consistently", () => {
    let state = INITIAL;
    for (let sample = 1; sample < SCROLL_FADE_SETTLE_SAMPLES; sample += 1) {
      state = resolveScrollFadeState(state, { top: false, bottom: true });
      expect(state.bottom).toBe(false);
    }

    state = resolveScrollFadeState(state, { top: false, bottom: true });
    expect(state.bottom).toBe(true);
  });

  it("keeps the same state reference when nothing has to be repainted", () => {
    expect(resolveScrollFadeState(INITIAL, { top: false, bottom: false })).toBe(INITIAL);

    const scrolled: ScrollFadeState = { top: true, bottom: true, topSamples: 0, bottomSamples: 0 };
    expect(resolveScrollFadeState(scrolled, { top: true, bottom: true })).toBe(scrolled);
  });

  it("clears the bottom edge when the transcript stays at its end", () => {
    let state: ScrollFadeState = { top: true, bottom: true, topSamples: 0, bottomSamples: 0 };
    for (let sample = 0; sample < SCROLL_FADE_SETTLE_SAMPLES; sample += 1) {
      state = resolveScrollFadeState(state, { top: true, bottom: false });
    }
    expect(state).toEqual({ top: true, bottom: false, topSamples: 0, bottomSamples: 0 });
  });
});

describe("scroll fade observation scope", () => {
  it("no longer resamples the document for every streamed text frame", () => {
    // `characterData` fires per streamed frame and `style` fires per virtual row
    // reposition; watching either made the whole document rescan scrollable ancestors
    // while an answer was streaming.
    const observeStart = scrollFadeSource.indexOf("mutationObserver.observe(");
    expect(observeStart).toBeGreaterThan(-1);
    const observeBlock = scrollFadeSource.slice(
      observeStart,
      scrollFadeSource.indexOf("});", observeStart)
    );

    expect(observeBlock).not.toContain("characterData");
    expect(observeBlock).toContain('attributeFilter: ["class", "open"]');
    expect(observeBlock).toContain("childList: true");
  });

  it("bounds the computed-style walk over a newly inserted subtree", () => {
    expect(scrollFadeSource).toContain("MAX_ADDED_SUBTREE_SCAN");
  });
});
