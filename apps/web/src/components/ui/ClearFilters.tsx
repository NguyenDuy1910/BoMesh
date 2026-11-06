"use client";

import { Button } from "@heroui/react";

export interface ClearFiltersProps {
  /** Whether any search text or filter is set; the button renders only then. */
  isActive: boolean;
  onClear: () => void;
}

/** "Clear" ghost button for a collection toolbar (preview `clearFilters()`); hidden when nothing is filtered. */
export function ClearFilters({ isActive, onClear }: ClearFiltersProps) {
  if (!isActive) return null;
  return (
    <Button variant="ghost" size="sm" onPress={onClear}>
      Clear
    </Button>
  );
}
