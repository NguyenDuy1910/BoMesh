"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/Button";

/** "26–50 of 80" with a step either way. Renders nothing while one page holds everything. */
export function Pager({
  page,
  pageSize,
  total,
  onChange,
  noun,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  /** What is being paged, for assistive technology: "runs", "documents". */
  noun: string;
}) {
  if (total <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav aria-label={`Pages of ${noun}`} className="ingestion-pager">
      <span aria-live="polite">
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
      </span>
      <Button
        aria-label={`Previous ${noun}`}
        disabled={page <= 1}
        icon={<ChevronLeft size={16} />}
        iconOnly
        onClick={() => onChange(page - 1)}
        size="sm"
        variant="ghost"
      />
      <Button
        aria-label={`Next ${noun}`}
        disabled={last >= total}
        icon={<ChevronRight size={16} />}
        iconOnly
        onClick={() => onChange(page + 1)}
        size="sm"
        variant="ghost"
      />
    </nav>
  );
}
