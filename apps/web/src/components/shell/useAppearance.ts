"use client";

import { useSyncExternalStore } from "react";

import { getAppearance, resolvedMode, subscribeAppearance, DEFAULT_LOOK, DEFAULT_MODE, type AppearanceState } from "@/lib/theme";

const SERVER_STATE: AppearanceState = { mode: DEFAULT_MODE, look: DEFAULT_LOOK };

/** The appearance plus the resolved light/dark mode; re-renders on change. */
export function useAppearance(): AppearanceState & { dark: boolean } {
  const state = useSyncExternalStore(subscribeAppearance, getAppearance, () => SERVER_STATE);
  const dark = useSyncExternalStore(subscribeAppearance, () => resolvedMode(getAppearance().mode) === "dark", () => false);
  return { ...state, dark };
}
