"use client";

import { StatusChip } from "./StatusChip";

export interface PreviewChipProps {
  /** Tooltip explaining what is not final (default: the contract is a proposal). */
  tooltip?: string;
  /** Label (default "Preview"). */
  label?: string;
}

/** Outline "Preview" chip for headers of pages whose backend contract is still a proposal (design rule 6). */
export function PreviewChip({ tooltip = "Phần máy chủ của trang này vẫn đang ở dạng đề xuất.", label = "Xem trước" }: PreviewChipProps) {
  return <StatusChip label={label} variant="outline" dot={false} tooltip={tooltip} />;
}
