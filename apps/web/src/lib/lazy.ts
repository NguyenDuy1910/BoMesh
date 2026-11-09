"use client";

import { useState } from "react";

/**
 * True from the first time `open` is true onwards. Gates a lazily loaded overlay
 * (`next/dynamic`): its code loads on first open, and it stays mounted afterwards so
 * it can animate closed and reopen instantly.
 */
export function useOpened(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}
