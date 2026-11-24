"use client";

import { useSyncExternalStore } from "react";

import { closeToast, toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";

/**
 * Review decisions with a real Undo. Approve, Request changes and Decline are terminal in the
 * API (no way back to IN_REVIEW), so a decision is held for the Undo window and only then sent.
 * While held, the submissions leave the queue; Undo puts them back untouched. Leaving the queue
 * sends everything still held; leaving the page (reload, close, another site) sends it as
 * `keepalive` requests, which the browser completes after the page is gone.
 */

const UNDO_WINDOW = 7000;

/** How a held decision is sent. `keepalive`: the page is going away. */
export interface SendInit {
  keepalive?: boolean;
}

interface Held {
  /** Contribution names this decision covers. */
  names: string[];
  timer: number;
  toastId: string;
  send: (init: SendInit) => Promise<void>;
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

async function commit(h: Held, init: SendInit = {}) {
  settle(h);
  try {
    await h.send(init);
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
  /** Sends the decision; pass `init.keepalive` on to its requests so a page leave doesn't cancel them. */
  send: (init: SendInit) => Promise<void>;
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
        toast("Quyết định đã được gửi nên không thể hoàn tác", { tone: "danger" });
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

/** Sends every held decision now: leaving the queue (unmount), or the page (`keepalive`). */
export function flushDecisions(init: SendInit = {}) {
  for (const h of [...held]) {
    closeToast(h.toastId);
    void commit(h, init);
  }
}

// `pagehide` fires on reload, close and cross-site navigation; the requests start synchronously enough to go out
// before the page unloads, and `keepalive` keeps the browser from cancelling them.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => flushDecisions({ keepalive: true }));

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
