"use client";

import { Button } from "@heroui/react";
import { Search } from "lucide-react";
import { EmptyState } from "./EmptyState";

export interface NoMatchesProps {
  /** What was filtered, as a Vietnamese noun ("tài liệu", "người"). Default "mục". */
  what?: string;
  /** Clears the search and filters; omit to hide the button. */
  onClear?: () => void;
}

/** Empty result of a filtered collection (preview `noMatches()`): "Không có {what} phù hợp" + Xóa bộ lọc. */
export function NoMatches({ what = "mục", onClear }: NoMatchesProps) {
  return (
    <EmptyState
      icon={Search}
      title={`Không có ${what} phù hợp`}
      description="Thử từ khác hoặc xóa bộ lọc."
      boxed
      compact
      actions={
        onClear ? (
          <Button variant="tertiary" onPress={onClear}>
            Xóa bộ lọc
          </Button>
        ) : undefined
      }
    />
  );
}
