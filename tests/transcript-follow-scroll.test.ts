import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_FOLLOW_IDLE_STOP_MS,
  TRANSCRIPT_FOLLOW_MAX_FRAME_MS,
  TRANSCRIPT_FOLLOW_MAX_SPEED_PX_PER_MS,
  TRANSCRIPT_FOLLOW_MIN_SPEED_PX_PER_MS,
  TRANSCRIPT_FOLLOW_SETTLE_EPSILON_PX,
  TRANSCRIPT_FOLLOW_SPEED_GAIN,
  resolveTranscriptFollowSpeed,
  resolveTranscriptFollowStep,
  shouldContinueTranscriptFollow
} from "../apps/desktop/src/renderer/App";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const rendererSource = readSource("../apps/desktop/src/renderer/App.tsx");
const timelineEntriesSource = readSource("../apps/desktop/src/renderer/timeline/timeline-entries.tsx");
const virtualizedTimelineSource = readSource("../apps/desktop/src/renderer/timeline/virtualized-timeline.tsx");

/**
 * The transcript used to reach the bottom by writing `scrollTop = scrollHeight` whenever
 * content arrived. Streaming marks each write as its own anchor-less jump, so the answer
 * visibly stuttered while it was being written. The follow loop below advances a bounded
 * distance per frame instead: steady while the answer grows, fast only for a large block.
 */
describe("transcript follow pacing", () => {
  it("scales the per-frame speed with the remaining distance and clamps it", () => {
    expect(resolveTranscriptFollowSpeed(0)).toBe(0);
    expect(resolveTranscriptFollowSpeed(-120)).toBe(0);

    // A short hop still glides at the minimum pace instead of crawling to a stop.
    expect(resolveTranscriptFollowSpeed(4)).toBeCloseTo(
      TRANSCRIPT_FOLLOW_MIN_SPEED_PX_PER_MS + 4 * TRANSCRIPT_FOLLOW_SPEED_GAIN,
      6
    );

    // 0.35 + 400 * 0.012 = 5.15, well past the ceiling.
    expect(resolveTranscriptFollowSpeed(400)).toBe(TRANSCRIPT_FOLLOW_MAX_SPEED_PX_PER_MS);
    expect(resolveTranscriptFollowSpeed(100_000)).toBe(TRANSCRIPT_FOLLOW_MAX_SPEED_PX_PER_MS);
  });

  it("never decelerates as the lag grows", () => {
    let previous = resolveTranscriptFollowSpeed(0);
    for (const distance of [1, 8, 30, 120, 260, 600, 1500, 4000]) {
      const speed = resolveTranscriptFollowSpeed(distance);
      expect(speed).toBeGreaterThanOrEqual(previous);
      previous = speed;
    }
  });

  it("bounds the per-frame step by both the lag and a single frame", () => {
    for (const distance of [3, 60, 900]) {
      for (const elapsed of [4, 16.67, 33, 5000]) {
        const step = resolveTranscriptFollowStep(distance, elapsed);
        expect(step).toBeGreaterThan(0);
        // Never overshoot: the last step lands exactly on the bottom.
        expect(step).toBeLessThanOrEqual(distance);
      }
    }

    // A window resumed from suspension reports a huge delta. Without the frame budget the
    // loop would travel a screenful in one go, which reads as the old jump.
    const resumed = resolveTranscriptFollowStep(20_000, 9_000);
    expect(resumed).toBeCloseTo(resolveTranscriptFollowStep(20_000, TRANSCRIPT_FOLLOW_MAX_FRAME_MS), 6);
    expect(resumed).toBeLessThanOrEqual(TRANSCRIPT_FOLLOW_MAX_SPEED_PX_PER_MS * TRANSCRIPT_FOLLOW_MAX_FRAME_MS);
    expect(resumed).toBeLessThan(200);

    expect(resolveTranscriptFollowStep(500, 0)).toBe(0);
    expect(resolveTranscriptFollowStep(500, -16)).toBe(0);
  });

  it("keeps the loop alive across the gap between streamed chunks", () => {
    expect(shouldContinueTranscriptFollow(400, 0)).toBe(true);
    expect(shouldContinueTranscriptFollow(TRANSCRIPT_FOLLOW_SETTLE_EPSILON_PX + 0.001, 5000)).toBe(true);

    // Arrived: the loop survives a short lull so the next chunk does not restart it cold,
    // but it does release once the transcript has been quiet for the idle window.
    expect(shouldContinueTranscriptFollow(0, 0)).toBe(true);
    expect(shouldContinueTranscriptFollow(0, TRANSCRIPT_FOLLOW_IDLE_STOP_MS - 1)).toBe(true);
    expect(shouldContinueTranscriptFollow(0, TRANSCRIPT_FOLLOW_IDLE_STOP_MS)).toBe(false);
    expect(shouldContinueTranscriptFollow(TRANSCRIPT_FOLLOW_SETTLE_EPSILON_PX, 10_000)).toBe(false);
  });
});

describe("smooth transcript follow wiring", () => {
  it("routes every follow call site through the animated loop", () => {
    // One definition plus the three places that used to jump straight to the bottom:
    // new content, content growth, and the deferred bottom correction.
    const callSites = rendererSource.match(/startSmoothTranscriptFollow\(\)/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    expect(rendererSource).toContain("function startSmoothTranscriptFollow() {");
  });

  it("lets a manual scroll win over the running follow loop", () => {
    expect(rendererSource).toContain("cancelAnimationFrame(autoScrollFrameRef.current)");
    expect(rendererSource).toContain("autoScrollFrameRef.current = null");
    expect(rendererSource).toContain("manualTranscriptScrollRef.current = true");
  });

  it("hands pinned corrections back to the parent instead of snapping scrollTop", () => {
    expect(virtualizedTimelineSource).toContain("requestFollowLatest?: () => void;");

    // Both correction paths - the measurement commit and the per-row measurement - must
    // prefer the parent's loop. A direct `scrollTop` write here lands in the same frame as
    // the parent's own follow write, and the two together are what the eye reads as the jerk.
    const guards = virtualizedTimelineSource.match(/if \(requestFollowLatest\) \{/g) ?? [];
    expect(guards.length).toBe(2);
    expect(virtualizedTimelineSource).toContain("}, [layout.totalSize, measurementVersion, requestFollowLatest, scrollElementRef, scrollInteractionActive]);");
    expect(virtualizedTimelineSource).toContain("}, [estimatedRowHeight, requestFollowLatest, scrollElementRef, scrollInteractionActive]);");

    // The direct write stays as a fallback for a list rendered without a parent.
    const directWrites = virtualizedTimelineSource.match(/scrollElement\.scrollTop = scrollElement\.scrollHeight;/g) ?? [];
    expect(directWrites.length).toBeGreaterThanOrEqual(2);

    // A stable callback keeps the effect dependencies from re-running on every render.
    expect(rendererSource).toContain("const requestSmoothFollowLatestEvent = useStableEvent(() => {");
    expect(rendererSource).toContain("onRequestFollowLatest={requestSmoothFollowLatestEvent}");
    expect(timelineEntriesSource).toContain("requestFollowLatest={onRequestFollowLatest}");
  });
});
