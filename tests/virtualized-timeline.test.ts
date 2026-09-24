import { describe, expect, it } from "vitest";
import {
  clampVirtualizedRange,
  resolveMeasurementScrollAdjustment,
  resolveVirtualizedRangeAfterItemCountChange,
  resolveVirtualizedRange,
  resolveVirtualizedRenderRange,
  resolveVirtualizedRowEstimate,
  shouldDeferVirtualTimelineMeasurement,
  shouldVirtualizedTimelineFollowTail
} from "../apps/desktop/src/renderer/timeline/virtualized-timeline";

describe("virtualized timeline range", () => {
  it("returns only rows intersecting the overscanned viewport", () => {
    expect(resolveVirtualizedRange(
      [0, 100, 300, 420, 600],
      [100, 200, 120, 180, 90],
      250,
      500
    )).toEqual({ start: 1, end: 4 });
  });

  it("returns an empty tail range after the final measured row", () => {
    expect(resolveVirtualizedRange([0, 100], [100, 100], 300, 500)).toEqual({ start: 2, end: 2 });
  });

  it("keeps a partially visible first row mounted", () => {
    expect(resolveVirtualizedRange([0, 240], [240, 120], 200, 260)).toEqual({ start: 0, end: 2 });
  });

  it("pins the window to the new tail after a rewind shrinks the list", () => {
    expect(clampVirtualizedRange({ start: 90, end: 110 }, 40)).toEqual({ start: 20, end: 40 });
    expect(clampVirtualizedRange({ start: 85, end: 100 }, 90)).toEqual({ start: 85, end: 90 });
    expect(clampVirtualizedRange({ start: 0, end: 20 }, 5)).toEqual({ start: 0, end: 5 });
    expect(clampVirtualizedRange({ start: 4, end: 8 }, 0)).toEqual({ start: 0, end: 0 });
  });

  it("mounts an appended tail row immediately while the transcript follows latest", () => {
    expect(resolveVirtualizedRangeAfterItemCountChange(
      { start: 80, end: 100 },
      100,
      101,
      true
    )).toEqual({ start: 81, end: 101 });
    expect(resolveVirtualizedRangeAfterItemCountChange(
      { start: 80, end: 100 },
      100,
      101,
      false
    )).toEqual({ start: 80, end: 100 });
    expect(resolveVirtualizedRangeAfterItemCountChange(
      { start: 40, end: 60 },
      100,
      101,
      true
    )).toEqual({ start: 40, end: 60 });
  });

  it("preserves the reading anchor when an earlier row changes height", () => {
    expect(resolveMeasurementScrollAdjustment(180, 260, 400, 500, false)).toBe(80);
    expect(resolveMeasurementScrollAdjustment(180, 260, 540, 500, false)).toBe(0);
    expect(resolveMeasurementScrollAdjustment(180, 260, 400, 500, true)).toBe(0);
  });

  it("defers row measurements throughout a scrollbar drag and its release batch", () => {
    expect(shouldDeferVirtualTimelineMeasurement(true, false)).toBe(true);
    expect(shouldDeferVirtualTimelineMeasurement(false, true)).toBe(true);
    expect(shouldDeferVirtualTimelineMeasurement(false, false)).toBe(false);
  });
});

describe("virtualized timeline tail pinning", () => {
  it("mounts the newest row while the user follows the latest content", () => {
    // A freshly appended answer is the tallest row in the transcript and its height only
    // settles after async markdown highlighting and image decode, so the measured range
    // can sit one row short of the end. A row that never mounts cannot be scrolled into
    // view: the answer looked like it was never rendered until a thread switch remounted
    // the list. Pinning the trailing window keeps it mounted.
    expect(resolveVirtualizedRenderRange({ start: 80, end: 100 }, 101, true))
      .toEqual({ start: 81, end: 101 });
    expect(resolveVirtualizedRenderRange({ start: 0, end: 20 }, 50, true))
      .toEqual({ start: 30, end: 50 });
  });

  it("leaves the range alone once the user has scrolled away", () => {
    expect(resolveVirtualizedRenderRange({ start: 80, end: 100 }, 101, false))
      .toEqual({ start: 80, end: 100 });
    expect(resolveVirtualizedRenderRange({ start: 90, end: 110 }, 40, false))
      .toEqual({ start: 20, end: 40 });
  });

  it("keeps a range that already covers the tail untouched", () => {
    expect(resolveVirtualizedRenderRange({ start: 95, end: 101 }, 101, true))
      .toEqual({ start: 95, end: 101 });
    expect(resolveVirtualizedRenderRange({ start: 0, end: 0 }, 0, true))
      .toEqual({ start: 0, end: 0 });
  });
});

describe("virtualized timeline row estimate", () => {
  it("reserves the average of the heights that were measured", () => {
    expect(resolveVirtualizedRowEstimate([120, 480, 300], 196)).toBe(300);
  });

  it("keeps a tool heavy transcript from collapsing onto the constant estimate", () => {
    // Tool groups and long answers are several times taller than a short user turn. Reserving
    // the constant for every never-measured row under-estimated the content badly, so the
    // mounted rows jumped as soon as the real heights landed.
    expect(resolveVirtualizedRowEstimate([600, 900, 750], 196)).toBe(750);
  });

  it("falls back to the configured estimate before anything was measured", () => {
    expect(resolveVirtualizedRowEstimate([], 196)).toBe(196);
    expect(resolveVirtualizedRowEstimate([Number.NaN, 0, -5], 196)).toBe(196);
  });
});

describe("virtualized timeline follow detection", () => {
  it("treats a scroll element resting at the bottom as following the tail", () => {
    expect(shouldVirtualizedTimelineFollowTail(false, { scrollHeight: 1200, scrollTop: 1030, clientHeight: 180 }))
      .toBe(true);
    expect(shouldVirtualizedTimelineFollowTail(false, { scrollHeight: 1200, scrollTop: 700, clientHeight: 180 }))
      .toBe(false);
    expect(shouldVirtualizedTimelineFollowTail(true, null)).toBe(true);
    expect(shouldVirtualizedTimelineFollowTail(false, null)).toBe(false);
  });

  it("mounts a row appended while the reader sits at the bottom even when the flag lags", () => {
    // The follow flag is released on wheel/press and gated per turn, so a turn can finish while
    // it is false although the reader never left the bottom. Appending the answer in that window
    // left it outside the rendered range, and an unmounted row cannot be reached by scrolling:
    // the conclusion only appeared after a refresh.
    const followLatest = shouldVirtualizedTimelineFollowTail(false, {
      scrollHeight: 1200,
      scrollTop: 1030,
      clientHeight: 180
    });
    expect(resolveVirtualizedRangeAfterItemCountChange({ start: 80, end: 100 }, 100, 101, followLatest))
      .toEqual({ start: 81, end: 101 });
  });
});
