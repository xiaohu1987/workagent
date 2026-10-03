import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

const DEFAULT_ESTIMATED_ROW_HEIGHT = 196;
const DEFAULT_OVERSCAN_PX = 900;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 80;
const PINNED_TO_BOTTOM_SLACK_PX = 24;

type VirtualizedTimelineProps<T> = {
  items: T[];
  getKey: (item: T) => string;
  getAnchorId?: (item: T) => string | null;
  renderItem: (item: T, index: number) => ReactNode;
  scrollElementRef: RefObject<HTMLElement | null>;
  scrollInteractionActive?: boolean;
  followLatest?: boolean;
  /**
   * Hands "scroll to the newest content" back to the parent while a measurement correction
   * is applied. Without it the correction writes `scrollTop` itself, in the same frame as
   * the parent's own follow write, and the two writes land as the jerk this prop removes.
   */
  requestFollowLatest?: () => void;
  estimatedRowHeight?: number;
  overscanPx?: number;
  threshold?: number;
};

type VisibleRange = { start: number; end: number };

export function clampVirtualizedRange(range: VisibleRange, itemCount: number): VisibleRange {
  if (itemCount <= 0) {
    return { start: 0, end: 0 };
  }
  if (range.start < itemCount) {
    return {
      start: Math.max(0, range.start),
      end: Math.max(Math.min(range.end, itemCount), Math.min(range.start + 1, itemCount))
    };
  }
  const windowSize = Math.max(1, range.end - range.start);
  return {
    start: Math.max(0, itemCount - windowSize),
    end: itemCount
  };
}

export function resolveVirtualizedRangeAfterItemCountChange(
  range: VisibleRange,
  previousItemCount: number,
  itemCount: number,
  followLatest: boolean
): VisibleRange {
  const clamped = clampVirtualizedRange(range, itemCount);
  if (!followLatest || previousItemCount <= 0 || range.end < previousItemCount) {
    return clamped;
  }
  const windowSize = Math.max(1, range.end - range.start);
  return {
    start: Math.max(0, itemCount - windowSize),
    end: itemCount
  };
}

export function resolveVirtualizedRange(
  offsets: number[],
  sizes: number[],
  viewportStart: number,
  viewportEnd: number
): VisibleRange {
  let start = 0;
  while (start < offsets.length && offsets[start] + sizes[start] < viewportStart) start += 1;
  let end = start;
  while (end < offsets.length && offsets[end] < viewportEnd) end += 1;
  return { start, end };
}

/**
 * The range that is actually rendered.
 *
 * `followLatest` means the user is still tracking the newest content, and then the
 * newest row must stay mounted no matter what the measurement bookkeeping says. A
 * freshly appended answer is the tallest row in the transcript and its height only
 * settles after async markdown highlighting and image decode; during that window the
 * computed range can sit one row short of the end. A row that never mounts cannot be
 * found by scrolling, so the answer looks like it was never rendered until a thread
 * switch remounts the list. Keeping the trailing window pinned costs one row of
 * rendering and removes that failure mode entirely.
 */
export function resolveVirtualizedRenderRange(
  range: VisibleRange,
  itemCount: number,
  followLatest: boolean
): VisibleRange {
  const clamped = clampVirtualizedRange(range, itemCount);
  if (!followLatest || itemCount <= 0 || clamped.end >= itemCount) {
    return clamped;
  }
  const windowSize = Math.max(1, clamped.end - clamped.start);
  return { start: Math.max(0, itemCount - windowSize), end: itemCount };
}

export function resolveMeasurementScrollAdjustment(
  previousHeight: number,
  nextHeight: number,
  rowBottom: number,
  viewportTop: number,
  pinnedToBottom: boolean
): number {
  return !pinnedToBottom && rowBottom <= viewportTop ? nextHeight - previousHeight : 0;
}

export function shouldDeferVirtualTimelineMeasurement(
  scrollInteractionActive: boolean,
  deferredCommitPending: boolean
): boolean {
  return scrollInteractionActive || deferredCommitPending;
}

/**
 * Reserved height for rows that have never been mounted.
 *
 * One constant cannot describe a transcript whose rows differ by an order of magnitude: tool
 * groups and long answers are several times taller than a short user turn, so every
 * never-measured row above the viewport reserves far less space than it really occupies. The
 * offsets then collapse, and the rows jump as soon as the real heights land. Averaging the
 * heights that were actually measured keeps the reserved space in the same order of magnitude
 * as the content, and it converges as more rows get measured.
 */
export function resolveVirtualizedRowEstimate(measuredHeights: Iterable<number>, fallback: number): number {
  let total = 0;
  let count = 0;
  for (const height of measuredHeights) {
    if (!Number.isFinite(height) || height <= 0) continue;
    total += height;
    count += 1;
  }
  return count > 0 ? total / count : fallback;
}

/**
 * Whether the newest content must stay mounted.
 *
 * `followLatest` is the parent's own bookkeeping and it can lag the DOM: the follow loop
 * releases it on wheel/press, the composer gates it per turn, and a turn can finish while it is
 * still false although the reader never left the bottom. Appending the answer inside that window
 * left the row outside the rendered range, and an unmounted row cannot be reached by scrolling,
 * so the answer looked like it was never rendered until the list was rebuilt (the "conclusion
 * only shows up after a refresh" report). The live scroll geometry therefore has the final word.
 */
export function shouldVirtualizedTimelineFollowTail(
  followLatest: boolean,
  scrollElement: { scrollHeight: number; scrollTop: number; clientHeight: number } | null
): boolean {
  if (followLatest) return true;
  if (!scrollElement) return false;
  return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight <
    PINNED_TO_BOTTOM_SLACK_PX;
}

export function VirtualizedTimeline<T>({
  items,
  getKey,
  getAnchorId,
  renderItem,
  scrollElementRef,
  scrollInteractionActive = false,
  followLatest = false,
  requestFollowLatest,
  estimatedRowHeight = DEFAULT_ESTIMATED_ROW_HEIGHT,
  overscanPx = DEFAULT_OVERSCAN_PX,
  threshold = DEFAULT_VIRTUALIZATION_THRESHOLD
}: VirtualizedTimelineProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measurementsRef = useRef(new Map<string, number>());
  const deferredMeasurementsRef = useRef(new Map<string, number>());
  const deferMeasurementsRef = useRef(scrollInteractionActive);
  const deferredScrollCorrectionRef = useRef<{
    applyAfterVersion: number;
    adjustment: number;
    pinnedToBottom: boolean;
  } | null>(null);
  const layoutRef = useRef<{ offsets: number[]; sizes: number[]; keyIndexes: Map<string, number> }>({
    offsets: [],
    sizes: [],
    keyIndexes: new Map()
  });
  const frameRef = useRef(0);
  const frameRerunRef = useRef(false);
  const previousItemCountRef = useRef(items.length);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [range, setRange] = useState<VisibleRange>(() => ({ start: 0, end: Math.min(items.length, 20) }));
  const virtualized = items.length > threshold;
  if (scrollInteractionActive) deferMeasurementsRef.current = true;

  const layout = useMemo(() => {
    const offsets = new Array<number>(items.length);
    const sizes = new Array<number>(items.length);
    const keyIndexes = new Map<string, number>();
    const fallbackHeight = resolveVirtualizedRowEstimate(measurementsRef.current.values(), estimatedRowHeight);
    let totalSize = 0;
    for (let index = 0; index < items.length; index += 1) {
      const key = getKey(items[index]);
      const size = measurementsRef.current.get(key) ?? fallbackHeight;
      keyIndexes.set(key, index);
      offsets[index] = totalSize;
      sizes[index] = size;
      totalSize += size;
    }
    return { offsets, sizes, totalSize, keyIndexes };
  }, [estimatedRowHeight, getKey, items, measurementVersion]);
  layoutRef.current = layout;

  const updateRange = useCallback(() => {
    if (!virtualized) return;
    const scrollElement = scrollElementRef.current;
    const container = containerRef.current;
    if (!scrollElement || !container) return;
    const scrollBounds = scrollElement.getBoundingClientRect();
    const containerBounds = container.getBoundingClientRect();
    const viewportStart = Math.max(0, scrollBounds.top - containerBounds.top - overscanPx);
    const viewportEnd = viewportStart + scrollElement.clientHeight + overscanPx * 2;
    const { start, end } = resolveVirtualizedRange(layout.offsets, layout.sizes, viewportStart, viewportEnd);
    setRange((current) => current.start === start && current.end === end ? current : { start, end });
  }, [items.length, layout.offsets, layout.sizes, overscanPx, scrollElementRef, virtualized]);

  const updateRangeRef = useRef(updateRange);
  updateRangeRef.current = updateRange;
  const scheduleRangeUpdateRef = useRef<() => void>(() => {});
  /**
   * Queues a range recompute on the next frame.
   *
   * Dropping a request because a frame was already pending lost the recompute that follows a
   * fresh measurement or a new item: the queued frame still ran the closure from the older
   * layout, and when nothing else scheduled afterwards the rendered window stayed stale until a
   * scroll, a resize or a reload rebuilt it (the "tool records come back only after a refresh"
   * report). Recording the extra request and rerunning once keeps the window in sync with the
   * layout this render produced.
   */
  const scheduleRangeUpdate = useCallback(() => {
    if (frameRef.current) {
      frameRerunRef.current = true;
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      updateRangeRef.current();
      if (frameRerunRef.current) {
        frameRerunRef.current = false;
        scheduleRangeUpdateRef.current();
      }
    });
  }, []);
  scheduleRangeUpdateRef.current = scheduleRangeUpdate;

  useLayoutEffect(() => {
    scheduleRangeUpdate();
  }, [items, layout.offsets, layout.sizes, scheduleRangeUpdate]);

  useLayoutEffect(() => {
    const previousItemCount = previousItemCountRef.current;
    previousItemCountRef.current = items.length;
    if (!virtualized || previousItemCount === items.length) return;
    setRange((current) => {
      const next = resolveVirtualizedRangeAfterItemCountChange(
        current,
        previousItemCount,
        items.length,
        shouldVirtualizedTimelineFollowTail(followLatest, scrollElementRef.current)
      );
      return current.start === next.start && current.end === next.end ? current : next;
    });
  }, [followLatest, items.length, virtualized]);

  useLayoutEffect(() => {
    if (scrollInteractionActive) return;
    if (deferredMeasurementsRef.current.size === 0) {
      deferMeasurementsRef.current = false;
      return;
    }
    const scrollElement = scrollElementRef.current;
    const container = containerRef.current;
    const currentLayout = layoutRef.current;
    const pinnedToBottom = shouldVirtualizedTimelineFollowTail(false, scrollElement);
    const containerTop = container?.getBoundingClientRect().top ?? null;
    const viewportTop = scrollElement?.getBoundingClientRect().top ?? null;
    let adjustment = 0;

    for (const [key, height] of deferredMeasurementsRef.current) {
      const index = currentLayout.keyIndexes.get(key);
      const previousHeight = index === undefined
        ? estimatedRowHeight
        : currentLayout.sizes[index] ?? estimatedRowHeight;
      if (index !== undefined && containerTop !== null && viewportTop !== null) {
        const rowBottom = containerTop + currentLayout.offsets[index] + previousHeight;
        adjustment += resolveMeasurementScrollAdjustment(
          previousHeight,
          height,
          rowBottom,
          viewportTop,
          pinnedToBottom
        );
      }
      measurementsRef.current.set(key, height);
    }

    deferredMeasurementsRef.current.clear();
    deferMeasurementsRef.current = false;
    deferredScrollCorrectionRef.current = {
      applyAfterVersion: measurementVersion + 1,
      adjustment,
      pinnedToBottom
    };
    setMeasurementVersion((current) => current + 1);
  }, [estimatedRowHeight, measurementVersion, scrollElementRef, scrollInteractionActive]);

  useLayoutEffect(() => {
    const correction = deferredScrollCorrectionRef.current;
    if (scrollInteractionActive || !correction || measurementVersion < correction.applyAfterVersion) return;
    deferredScrollCorrectionRef.current = null;
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    if (correction.pinnedToBottom) {
      if (requestFollowLatest) {
        requestFollowLatest();
      } else {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    } else if (correction.adjustment !== 0) {
      scrollElement.scrollTop += correction.adjustment;
    }
  }, [layout.totalSize, measurementVersion, requestFollowLatest, scrollElementRef, scrollInteractionActive]);

  useEffect(() => {
    if (!virtualized) return;
    const scrollElement = scrollElementRef.current;
    if (!scrollElement) return;
    const observer = new ResizeObserver(scheduleRangeUpdate);
    observer.observe(scrollElement);
    scrollElement.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    return () => {
      observer.disconnect();
      scrollElement.removeEventListener("scroll", scheduleRangeUpdate);
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      frameRerunRef.current = false;
    };
  }, [scheduleRangeUpdate, scrollElementRef, virtualized]);

  const recordMeasurement = useCallback((key: string, height: number) => {
    const previous = deferredMeasurementsRef.current.get(key) ?? measurementsRef.current.get(key);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
    if (shouldDeferVirtualTimelineMeasurement(scrollInteractionActive, deferMeasurementsRef.current)) {
      deferredMeasurementsRef.current.set(key, height);
      return;
    }
    const scrollElement = scrollElementRef.current;
    const pinnedToBottom = shouldVirtualizedTimelineFollowTail(false, scrollElement);
    const container = containerRef.current;
    const currentLayout = layoutRef.current;
    const index = currentLayout.keyIndexes.get(key);
    const previousHeight = index === undefined
      ? estimatedRowHeight
      : currentLayout.sizes[index] ?? estimatedRowHeight;
    const rowBottom = scrollElement && container && index !== undefined
      ? container.getBoundingClientRect().top + currentLayout.offsets[index] + previousHeight
      : null;
    const viewportTop = scrollElement?.getBoundingClientRect().top ?? null;
    measurementsRef.current.set(key, height);
    setMeasurementVersion((current) => current + 1);
    if (pinnedToBottom && scrollElement) {
      // Prefer the parent's animated follow. The direct write stays as the fallback so a
      // caller that renders this list on its own keeps the previous pinned behaviour.
      if (requestFollowLatest) {
        requestFollowLatest();
      } else {
        window.requestAnimationFrame(() => {
          scrollElement.scrollTop = scrollElement.scrollHeight;
        });
      }
    } else if (scrollElement && rowBottom !== null && viewportTop !== null) {
      scrollElement.scrollTop += resolveMeasurementScrollAdjustment(
        previousHeight,
        height,
        rowBottom,
        viewportTop,
        pinnedToBottom
      );
    }
  }, [estimatedRowHeight, requestFollowLatest, scrollElementRef, scrollInteractionActive]);

  if (!virtualized) {
    return <>{items.map((item, index) => renderItem(item, index))}</>;
  }

  const followTail = shouldVirtualizedTimelineFollowTail(followLatest, scrollElementRef.current);
  const visibleRange = resolveVirtualizedRenderRange(range, items.length, followTail);
  const visibleItems = items.slice(visibleRange.start, visibleRange.end);
  return (
    <div ref={containerRef} className="virtual-timeline" style={{ height: `${layout.totalSize}px` }}>
      {getAnchorId ? items.map((item, index) => {
        if (index >= visibleRange.start && index < visibleRange.end) return null;
        const anchorId = getAnchorId(item);
        return anchorId ? (
          <span
            key={`anchor-${getKey(item)}`}
            id={anchorId}
            className="virtual-timeline-anchor"
            style={{ transform: `translateY(${layout.offsets[index]}px)` }}
          />
        ) : null;
      }) : null}
      {visibleItems.map((item, visibleIndex) => {
        const index = visibleRange.start + visibleIndex;
        const key = getKey(item);
        const style = { transform: `translateY(${layout.offsets[index]}px)` } as CSSProperties;
        return (
          <VirtualTimelineRow key={key} itemKey={key} style={style} onMeasure={recordMeasurement}>
            {renderItem(item, index)}
          </VirtualTimelineRow>
        );
      })}
    </div>
  );
}

function VirtualTimelineRow({
  itemKey,
  style,
  onMeasure,
  children
}: {
  itemKey: string;
  style: CSSProperties;
  onMeasure: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => onMeasure(itemKey, row.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [itemKey, onMeasure]);
  return <div ref={rowRef} className="virtual-timeline-row" style={style}>{children}</div>;
}
