"use client";

import { StatusChip } from "./StatusChip";

export interface PreviewChipProps {
  /** Tooltip explaining what is not final (default: the contract is a proposal). */
  tooltip?: string;
  /** Label (default "Preview"). */
  label?: string;
}

/** Outline "Preview" chip for headers of pages whose backend contract is still a proposal (design rule 6). */
export function PreviewChip({ tooltip = "This page’s backend contract is still a proposal.", label = "Preview" }: PreviewChipProps) {
  return <StatusChip label={label} variant="outline" dot={false} tooltip={tooltip} />;
}
