"use client";

import { useSyncExternalStore } from "react";

/**
 * Shell overlays (preview `S.palette`, `S.modal`, `S.drawer`): one module
 * store, so any page or menu can open them with a plain function call and
 * the AppShell renders them.
 */
export type ShellOverlay = "palette" | "preferences" | "appearance" | "shortcuts" | null;

interface OverlayState {
  open: ShellOverlay;
  /** Initial palette query. */
  query: string;
  /** Product tour step, or null when it is not running. */
  tour: number | null;
}

let state: OverlayState = { open: null, query: "", tour: null };
const listeners = new Set<() => void>();

function set(patch: Partial<OverlayState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const SERVER: OverlayState = { open: null, query: "", tour: null };

export function useShellOverlays(): OverlayState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

/** ⌘K: one search for everything the caller may open. */
export function openCommandPalette(query = ""): void {
  set({ open: "palette", query });
}

export function openPreferences(): void {
  set({ open: "preferences" });
}

/** The Appearance drawer replaces an open Preferences dialog (preview `X.appearance.open`). */
export function openAppearance(): void {
  set({ open: "appearance" });
}

export function openShortcuts(): void {
  set({ open: "shortcuts" });
}

export function closeOverlay(): void {
  set({ open: null, query: "" });
}

export function setTourStep(step: number | null): void {
  set({ tour: step });
}

export function getTourStep(): number | null {
  return state.tour;
}
