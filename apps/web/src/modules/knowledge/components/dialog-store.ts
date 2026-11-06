"use client";

import { useSyncExternalStore } from "react";

/**
 * A tiny module-level store for imperatively opened overlays (menus open
 * dialogs that outlive the menu). One store per host; `open()` replaces the
 * current overlay, `close()` clears it.
 */
export function createOverlayStore<T>() {
  let current: (T & { key: number }) | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  return {
    open(value: T) {
      current = { ...value, key: ++seq };
      emit();
    },
    close() {
      current = null;
      emit();
    },
    useCurrent() {
      return useSyncExternalStore(
        subscribe,
        () => current,
        () => null,
      );
    },
  };
}
