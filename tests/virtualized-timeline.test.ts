import { describe, expect, it } from "vitest";
import {
  clampVirtualizedRange,
  resolveMeasurementScrollAdjustment,
  resolveVirtualizedRangeAfterItemCountChange,
  resolveVirtualizedRange,
  shouldDeferVirtualTimelineMeasurement
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
