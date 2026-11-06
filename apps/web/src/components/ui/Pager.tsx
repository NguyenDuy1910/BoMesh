"use client";

import { Pagination } from "@heroui/react";
import { fmtNum } from "@/lib/format";

export interface PagerProps {
  /** Current page, 1-based. */
  page: number;
  pageSize: number;
  /** Total items when known (client-side lists, APIs with totalSize). */
  total?: number;
  /** Items on the current page, for the range when `total` is unknown (cursor pagination). */
  pageCount?: number;
  /** Whether a next page exists when `total` is unknown (e.g. `!!nextPageToken`). */
  hasNext?: boolean;
  onPageChange: (page: number) => void;
}

/**
 * Collection footer (preview `pager()`, HeroUI Pagination): "1–20 of 87" and previous/next.
 * Works with known totals or with cursor pagination (`pageCount` + `hasNext`).
 */
export function Pager({ page, pageSize, total, pageCount, hasNext, onPageChange }: PagerProps) {
  const start = (page - 1) * pageSize + 1;
  const shown = total !== undefined ? Math.max(0, Math.min(pageSize, total - start + 1)) : (pageCount ?? 0);
  const end = start + shown - 1;
  const next = total !== undefined ? page * pageSize < total : !!hasNext;
  const range = shown === 0 ? "0 results" : total !== undefined ? `${fmtNum(start)}–${fmtNum(end)} of ${fmtNum(total)}` : `${fmtNum(start)}–${fmtNum(end)}`;
  return (
    <Pagination className="table-foot" size="sm">
      <Pagination.Summary className="num">{range}</Pagination.Summary>
      {page > 1 || next ? (
        <Pagination.Content>
          <Pagination.Item>
            <Pagination.Previous aria-label="Previous page" isDisabled={page <= 1} onPress={() => onPageChange(page - 1)}>
              <Pagination.PreviousIcon />
            </Pagination.Previous>
          </Pagination.Item>
          <Pagination.Item>
            <Pagination.Next aria-label="Next page" isDisabled={!next} onPress={() => onPageChange(page + 1)}>
              <Pagination.NextIcon />
            </Pagination.Next>
          </Pagination.Item>
        </Pagination.Content>
      ) : null}
    </Pagination>
  );
}

/** Client-side page slice (preview `paginate()`); clamps `page` to the last page. */
export function paginate<T>(rows: readonly T[], page: number, pageSize = 20): T[] {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  return rows.slice((p - 1) * pageSize, p * pageSize);
}
