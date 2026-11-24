"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore, type ReactNode } from "react";

import { useOpened } from "@/lib/lazy";

const ConfirmDialog = dynamic(() => import("./ConfirmDialog").then((m) => m.ConfirmDialog), { ssr: false });

export interface ConfirmOptions {
  title: string;
  /** Consequence in plain language (what happens, whether it can be undone). */
  description?: ReactNode;
  /** Confirm button label (default "Confirm"); name the action ("Remove member"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for destructive actions (red button, alert dialog), `accent` for consequential ones. Default `danger`. */
  tone?: "danger" | "accent";
  /** Typed confirmation: the confirm button stays disabled until this exact text is typed. */
  typed?: string;
}

export interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let current: PendingConfirm | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function setCurrent(next: PendingConfirm | null) {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Asks for confirmation before an irreversible action (preview `confirmAction()`).
 * Resolves `true` on confirm, `false` on cancel/close. Rendered by `<ConfirmHost/>`.
 *
 * ```ts
 * if (await confirm({ title: "Remove Linh?", description: "They lose access now.", confirmLabel: "Remove" })) remove();
 * ```
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  current?.resolve(false);
  return new Promise<boolean>((resolve) => setCurrent({ ...options, id: ++seq, resolve }));
}

function settle(ok: boolean) {
  const pending = current;
  if (!pending) return;
  setCurrent(null);
  pending.resolve(ok);
}

/** Closes the open confirmation as cancelled: for a link in its description that leads elsewhere. */
export function dismissConfirm(): void {
  settle(false);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Confirmation dialog host; mount once in the root providers. The dialog loads on the first `confirm()`. */
export function ConfirmHost() {
  const pending = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  const opened = useOpened(pending !== null);
  return opened ? <ConfirmDialog pending={pending} onSettle={settle} /> : null;
}
