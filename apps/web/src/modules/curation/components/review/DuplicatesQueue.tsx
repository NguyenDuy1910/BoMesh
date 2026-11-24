"use client";

import { Copy } from "lucide-react";

import { EmptyState } from "@/components/ui";

import { QUEUE_HINT } from "../../governance";

/**
 * Review → Possible duplicates (preview `tabDups`). Processing doesn't flag duplicates yet (the server computes no
 * quality issues), so there is nothing to read: the list is empty and its count 0.
 */
export function DuplicatesQueue() {
  return (
    <div className="kh gov">
      <p className="gov-summary">{QUEUE_HINT.duplicates}</p>
      <EmptyState icon={Copy} tone="success" title="Không tìm thấy trùng lặp" description="Mỗi tài liệu bạn phụ trách chỉ xuất hiện một lần." boxed />
    </div>
  );
}
