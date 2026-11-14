"use client";

import { useSyncExternalStore } from "react";

/** Whether the bell's Inbox popover is open: one module store, so Home and ⌘K can open it with a plain call. */
let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useInboxOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

/** Opens the bell's Inbox popover (preview `A['inbox-show']`). */
export function openInbox(): void {
  set(true);
}

export function closeInbox(): void {
  set(false);
}

export function toggleInbox(): void {
  set(!open);
}
