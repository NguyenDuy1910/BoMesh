"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The ingestion dialogs that open from more than one place (Studio → Sources,
 * a collection's Sources tab, Add source anywhere, the source drawer): the
 * Add source wizard, Connect account and Reconnect. One open at a time; every
 * place that can open one renders `<IngestionDialogs/>`, and only the first
 * mounted instance (the host) draws the dialog.
 */

export interface WizardOptions {
  /** Collection item name to preselect as the destination. */
  collection?: string;
  /** Connector name (`connectors/google_drive`): skip to the account step. */
  connector?: string;
  /** Connection name: start at Content with this account. */
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
let hosts: number[] = [];
let nextHost = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function set(next: IngestionOverlay) {
  current = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const openWizard = (options: WizardOptions = {}) => set({ kind: "wizard", options });
export const openConnectAccount = (options: ConnectAccountOptions = {}) => set({ kind: "connect", options });
export const openReconnect = (connection: string) => set({ kind: "reconnect", connection });
export const closeIngestionOverlay = () => set(null);

export function useIngestionOverlay(): IngestionOverlay {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** Whether this `<IngestionDialogs/>` instance draws the dialogs (the first one mounted). Closes them when the last one unmounts. */
export function useIsDialogHost(): boolean {
  const [id] = useState(() => ++nextHost);
  useEffect(() => {
    hosts = [...hosts, id];
    emit();
    return () => {
      hosts = hosts.filter((h) => h !== id);
      if (!hosts.length) current = null;
      emit();
    };
  }, [id]);
  return useSyncExternalStore(
    subscribe,
    () => hosts[0] === id,
    () => false,
  );
}
