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
  /** Preferences section to scroll to when the dialog opens. */
  prefsFocus: PreferencesSection | null;
}

export type PreferencesSection = "notifications";

let state: OverlayState = { open: null, query: "", tour: null, prefsFocus: null };
const listeners = new Set<() => void>();

function set(patch: Partial<OverlayState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const SERVER: OverlayState = { open: null, query: "", tour: null, prefsFocus: null };

export function useShellOverlays(): OverlayState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

/** ⌘K: one search for everything the caller may open. */
export function openCommandPalette(query = ""): void {
  set({ open: "palette", query });
}

/** Preferences; `focus` scrolls to a section (the Inbox's Notification settings opens Email notifications). */
export function openPreferences(focus: PreferencesSection | null = null): void {
  set({ open: "preferences", prefsFocus: focus });
}

/** The Appearance drawer replaces an open Preferences dialog (preview `X.appearance.open`). */
export function openAppearance(): void {
  set({ open: "appearance" });
}

export function openShortcuts(): void {
  set({ open: "shortcuts" });
}

export function closeOverlay(): void {
  set({ open: null, query: "", prefsFocus: null });
}

export function setTourStep(step: number | null): void {
  set({ tour: step });
}

/** Opens the chat home and starts the product tour there. */
export function startTour(): void {
  setTourStep(0);
}

export function getTourStep(): number | null {
  return state.tour;
}
