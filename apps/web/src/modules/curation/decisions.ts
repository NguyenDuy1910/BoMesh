"use client";

import { useSyncExternalStore } from "react";

import { closeToast, toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";

/**
 * Review decisions with a real Undo. Approve, Request changes and Decline are terminal in the
 * API (no way back to IN_REVIEW), so a decision is held for the Undo window and only then sent.
 * While held, the submissions leave the queue; Undo puts them back untouched. Leaving the page
 * sends everything still held.
 */

const UNDO_WINDOW = 7000;

interface Held {
  /** Contribution names this decision covers. */
  names: string[];
  timer: number;
  toastId: string;
  send: () => Promise<void>;
  onSent: () => void;
  onFailed: (error: unknown) => void;
}

let held: Held[] = [];
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit() {
  snapshot = new Set(held.flatMap((h) => h.names));
  listeners.forEach((l) => l());
}

function settle(h: Held) {
  held = held.filter((x) => x !== h);
  window.clearTimeout(h.timer);
}

async function commit(h: Held) {
  settle(h);
  try {
    await h.send();
    h.onSent();
  } catch (error) {
    h.onFailed(error);
    toast(errorMessage(error), { tone: "danger" });
  } finally {
    emit();
  }
}

export interface HoldOptions {
  names: string[];
  /** Toast shown with Undo. */
  message: string;
  /** Message after Undo. */
  undoneMessage: string;
  send: () => Promise<void>;
  /** After the decision reached the server (refresh caches). */
  onSent: () => void;
  /** Undo pressed in time (re-open the item). */
  onUndo?: () => void;
  onFailed?: (error: unknown) => void;
}

/** Holds a decision for the Undo window, then sends it. */
export function holdDecision(o: HoldOptions) {
  const h: Held = {
    names: o.names,
    send: o.send,
    onSent: o.onSent,
    onFailed: o.onFailed ?? (() => undefined),
    toastId: "",
    timer: window.setTimeout(() => void commit(h), UNDO_WINDOW),
  };
  h.toastId = toast(o.message, {
    duration: UNDO_WINDOW,
    undo: () => {
      if (!held.includes(h)) {
        toast("It was already sent, so it can’t be undone", { tone: "danger" });
        return;
      }
      settle(h);
      emit();
      o.onUndo?.();
      toast(o.undoneMessage, { tone: "accent" });
    },
  });
  held = [...held, h];
  emit();
}

/** Sends every held decision now (page leave, unmount). */
export function flushDecisions() {
  for (const h of [...held]) {
    closeToast(h.toastId);
    void commit(h);
  }
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushDecisions);

/** Contribution names with a decision in its Undo window (hidden from the queue). */
export function useHeldDecisions(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}
