"use client";

import { Button } from "@heroui/react";
import { Search } from "lucide-react";
import { EmptyState } from "./EmptyState";

export interface NoMatchesProps {
  /** Plural noun of what was filtered ("documents", "people"). Default "items". */
  what?: string;
  /** Clears the search and filters; omit to hide the button. */
  onClear?: () => void;
}

/** Empty result of a filtered collection (preview `noMatches()`): "No {what} match" + Clear filters. */
export function NoMatches({ what = "items", onClear }: NoMatchesProps) {
  return (
    <EmptyState
      icon={Search}
      title={`No ${what} match`}
      description="Try another word or clear the filters."
      boxed
      compact
      actions={
        onClear ? (
          <Button variant="tertiary" onPress={onClear}>
            Clear filters
          </Button>
        ) : undefined
      }
    />
  );
}
