import { describe, expect, it } from "vitest";
import {
  resolveMeasurementScrollAdjustment,
  resolveVirtualizedRange
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

  it("preserves the reading anchor when an earlier row changes height", () => {
    expect(resolveMeasurementScrollAdjustment(180, 260, 400, 500, false)).toBe(80);
    expect(resolveMeasurementScrollAdjustment(180, 260, 540, 500, false)).toBe(0);
    expect(resolveMeasurementScrollAdjustment(180, 260, 400, 500, true)).toBe(0);
  });
});
