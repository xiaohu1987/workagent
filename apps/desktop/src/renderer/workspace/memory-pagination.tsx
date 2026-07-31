import { IconChevronLeft, IconChevronRight } from "../icons";

export const MEMORY_LIST_PAGE_SIZE = 20;

export function MemoryPagination({
  label,
  page,
  pageCount,
  totalCount,
  onPageChange
}: {
  label: string;
  page: number;
  pageCount: number;
  totalCount: number;
  onPageChange: (page: number) => void;
}) {
  if (totalCount === 0) return null;
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const rangeStart = safePage * MEMORY_LIST_PAGE_SIZE + 1;
  const rangeEnd = Math.min(totalCount, (safePage + 1) * MEMORY_LIST_PAGE_SIZE);
  return (
    <nav className="memory-pagination" aria-label={`${label}分页`}>
      <span className="memory-pagination-range">{rangeStart}-{rangeEnd} / {totalCount}</span>
      <div className="memory-pagination-controls">
        <button
          className="memory-pagination-button"
          type="button"
          disabled={safePage === 0}
          onClick={() => onPageChange(safePage - 1)}
          title="上一页"
          aria-label={`${label}上一页`}
        >
          <IconChevronLeft />
        </button>
        <span className="memory-pagination-page" aria-live="polite">
          {safePage + 1} / {pageCount}
        </span>
        <button
          className="memory-pagination-button"
          type="button"
          disabled={safePage >= pageCount - 1}
          onClick={() => onPageChange(safePage + 1)}
          title="下一页"
          aria-label={`${label}下一页`}
        >
          <IconChevronRight />
        </button>
      </div>
    </nav>
  );
}

export function sortMemoryRecordsNewestFirst<T extends { id: string; createdAt: string; updatedAt: string }>(records: readonly T[]): T[] {
  return [...records].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
      || right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id)
  );
}

export function getMemoryLastPageIndex(totalCount: number): number {
  return Math.max(0, Math.ceil(Math.max(0, totalCount) / MEMORY_LIST_PAGE_SIZE) - 1);
}
