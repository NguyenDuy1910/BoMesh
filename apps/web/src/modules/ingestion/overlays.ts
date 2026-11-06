"use client";

import { useSyncExternalStore } from "react";

/**
 * The ingestion dialogs that open from more than one place (Sources page,
 * Connections page, source drawer): the connect-source wizard, Connect account
 * and Reconnect. One open at a time; each page renders `<IngestionDialogs/>`.
 */

export interface WizardOptions {
  /** Collection item name to preselect as the destination. */
  kb?: string;
  /** Connector name (`connectors/google_drive`): skip to the account step. */
  connector?: string;
  /** Connection name: skip to the content step. */
  connection?: string;
}

export interface ConnectAccountOptions {
  /** Fix the app (no app picker). */
  connector?: string;
}

export type IngestionOverlay =
  | { kind: "wizard"; options: WizardOptions }
  | { kind: "connect"; options: ConnectAccountOptions }
  | { kind: "reconnect"; connection: string }
  | null;

let current: IngestionOverlay = null;
const listeners = new Set<() => void>();

function set(next: IngestionOverlay) {
  current = next;
  for (const listener of listeners) listener();
}

export const openWizard = (options: WizardOptions = {}) => set({ kind: "wizard", options });
export const openConnectAccount = (options: ConnectAccountOptions = {}) => set({ kind: "connect", options });
export const openReconnect = (connection: string) => set({ kind: "reconnect", connection });
export const closeIngestionOverlay = () => set(null);

export function useIngestionOverlay(): IngestionOverlay {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
