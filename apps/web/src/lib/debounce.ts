"use client";

import { useEffect, useState } from "react";

/** How long typing pauses before a search box reads the server. */
export const SEARCH_PAUSE_MS = 250;

/** `value` once it has stopped changing for `ms` (typed searches read the server once per pause, not per keystroke). */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
