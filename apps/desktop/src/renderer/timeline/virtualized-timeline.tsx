import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

const DEFAULT_ESTIMATED_ROW_HEIGHT = 196;
const DEFAULT_OVERSCAN_PX = 900;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 80;

type VirtualizedTimelineProps<T> = {
  items: T[];
  getKey: (item: T) => string;
  getAnchorId?: (item: T) => string | null;
  renderItem: (item: T, index: number) => ReactNode;
  scrollElementRef: RefObject<HTMLElement | null>;
  estimatedRowHeight?: number;
  overscanPx?: number;
  threshold?: number;
};

type VisibleRange = { start: number; end: number };

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

export function resolveMeasurementScrollAdjustment(
  previousHeight: number,
  nextHeight: number,
  rowBottom: number,
  viewportTop: number,
  pinnedToBottom: boolean
): number {
  return !pinnedToBottom && rowBottom <= viewportTop ? nextHeight - previousHeight : 0;
}

export function VirtualizedTimeline<T>({
  items,
  getKey,
  getAnchorId,
  renderItem,
  scrollElementRef,
  estimatedRowHeight = DEFAULT_ESTIMATED_ROW_HEIGHT,
  overscanPx = DEFAULT_OVERSCAN_PX,
  threshold = DEFAULT_VIRTUALIZATION_THRESHOLD
}: VirtualizedTimelineProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measurementsRef = useRef(new Map<string, number>());
  const layoutRef = useRef<{ offsets: number[]; sizes: number[]; keyIndexes: Map<string, number> }>({
    offsets: [],
    sizes: [],
    keyIndexes: new Map()
  });
  const frameRef = useRef(0);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [range, setRange] = useState<VisibleRange>(() => ({ start: 0, end: Math.min(items.length, 20) }));
  const virtualized = items.length > threshold;

  const layout = useMemo(() => {
    const offsets = new Array<number>(items.length);
    const sizes = new Array<number>(items.length);
    const keyIndexes = new Map<string, number>();
    let totalSize = 0;
    for (let index = 0; index < items.length; index += 1) {
      const key = getKey(items[index]);
      const size = measurementsRef.current.get(key) ?? estimatedRowHeight;
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

  const scheduleRangeUpdate = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      updateRange();
    });
  }, [updateRange]);

  useLayoutEffect(() => {
    scheduleRangeUpdate();
  }, [layout.totalSize, scheduleRangeUpdate]);

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
    };
  }, [scheduleRangeUpdate, scrollElementRef, virtualized]);

  const recordMeasurement = useCallback((key: string, height: number) => {
    const previous = measurementsRef.current.get(key);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
    const scrollElement = scrollElementRef.current;
    const pinnedToBottom = Boolean(
      scrollElement && scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 24
    );
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
      window.requestAnimationFrame(() => {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      });
    } else if (scrollElement && rowBottom !== null && viewportTop !== null) {
      scrollElement.scrollTop += resolveMeasurementScrollAdjustment(
        previousHeight,
        height,
        rowBottom,
        viewportTop,
        pinnedToBottom
      );
    }
  }, [estimatedRowHeight, scrollElementRef]);

  if (!virtualized) {
    return <>{items.map((item, index) => renderItem(item, index))}</>;
  }

  const visibleItems = items.slice(range.start, range.end);
  return (
    <div ref={containerRef} className="virtual-timeline" style={{ height: `${layout.totalSize}px` }}>
      {getAnchorId ? items.map((item, index) => {
        if (index >= range.start && index < range.end) return null;
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
        const index = range.start + visibleIndex;
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
