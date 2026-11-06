"use client";

import { useSyncExternalStore } from "react";

import type { Conversation } from "./conversations";
import type { Project } from "./types";

/**
 * Client UI state shared by the sidebar, `/chats`, project pages and the thread topbar:
 * which dialog is open (rendered once by `<ProjectDialogs/>`, so a menu that unmounts after
 * its row moves cannot take its dialog with it) and which sidebar folders are expanded.
 */
export type ProjectDialog =
  | { kind: "rename-conversation"; conversation: Conversation }
  | { kind: "new-project"; conversation?: Conversation }
  | { kind: "rename-project"; project: Project };

interface State {
  dialog: ProjectDialog | null;
  /** Explicit expand/collapse per project id; absent = expanded only when it holds the current page. */
  folders: Readonly<Record<string, boolean>>;
}

let state: State = { dialog: null, folders: {} };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useProjectsUi(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

export function openProjectDialog(dialog: ProjectDialog) {
  set({ dialog });
}

export function closeProjectDialog() {
  set({ dialog: null });
}

export function setFolderOpen(id: string, open: boolean) {
  set({ folders: { ...state.folders, [id]: open } });
}
