"use client";

import { useSyncExternalStore } from "react";

import type { Conversation } from "./conversations";
import type { Project } from "./types";

/**
 * Which name dialog is open (rendered once per page by `<ProjectDialogs/>`, so a menu that
 * unmounts after its row moves cannot take its dialog with it).
 */
export type ProjectDialog =
  | { kind: "rename-conversation"; conversation: Conversation }
  | { kind: "new-project"; conversation?: Conversation }
  | { kind: "rename-project"; project: Project };

let dialog: ProjectDialog | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useProjectDialog(): ProjectDialog | null {
  return useSyncExternalStore(
    subscribe,
    () => dialog,
    () => null,
  );
}

export function openProjectDialog(next: ProjectDialog) {
  dialog = next;
  listeners.forEach((l) => l());
}

export function closeProjectDialog() {
  dialog = null;
  listeners.forEach((l) => l());
}
