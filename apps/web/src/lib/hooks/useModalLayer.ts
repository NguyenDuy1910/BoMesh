"use client";

import { type RefObject, useEffect, useRef } from "react";

/**
 * Everything a layer above the page owes a keyboard and screen-reader user,
 * implemented once for dialogs, drawers and menus.
 *
 * Open layers form a stack. Escape and the Tab trap only ever act on the top
 * layer, so a menu inside a dialog closes before the dialog, and a dialog
 * opened from a drawer closes before the drawer. Modal layers additionally
 * make the page behind them inert, lock body scroll (reference-counted, so a
 * nested layer closing does not unlock the page under the outer one) and
 * return focus to whatever opened them.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const TEXT_ENTRY =
  'input:not([disabled]):not([readonly]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea:not([disabled]):not([readonly]), select:not([disabled])';

/** Visible, focusable descendants in DOM order. */
function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.closest("[hidden],[inert]") && element.getClientRects().length > 0,
  );
}

interface Layer {
  modal: boolean;
  panelRef: RefObject<HTMLElement | null>;
  /** Escape requests a close through this; it decides whether it may close. */
  requestClose: () => void;
}

const layers: Layer[] = [];

function onDocumentKeyDown(event: KeyboardEvent) {
  const top = layers.at(-1);
  if (!top) return;
  if (event.key === "Escape") {
    // A control inside the layer (a combobox, an inline editor) that handled
    // Escape itself has already prevented the default.
    if (event.defaultPrevented || event.isComposing) return;
    event.preventDefault();
    top.requestClose();
    return;
  }
  if (event.key !== "Tab" || !top.modal) return;
  const panel = top.panelRef.current;
  const focusable = focusableElements(panel);
  if (!panel || !focusable.length) {
    event.preventDefault();
    panel?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (!panel.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function pushLayer(layer: Layer) {
  // Listening on window (bubble phase) runs after every handler inside the
  // React tree, so `defaultPrevented` reliably reports an inner handler.
  if (!layers.length) window.addEventListener("keydown", onDocumentKeyDown);
  layers.push(layer);
}

function removeLayer(layer: Layer) {
  const index = layers.indexOf(layer);
  if (index >= 0) layers.splice(index, 1);
  if (!layers.length) window.removeEventListener("keydown", onDocumentKeyDown);
}

/* Reference-counted so nested modal layers can close in any order. */
const inertState = new Map<HTMLElement, { count: number; inert: boolean; ariaHidden: string | null }>();

function makeInert(element: HTMLElement) {
  const entry = inertState.get(element);
  if (entry) {
    entry.count += 1;
    return;
  }
  inertState.set(element, {
    count: 1,
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  });
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function releaseInert(element: HTMLElement) {
  const entry = inertState.get(element);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count > 0) return;
  inertState.delete(element);
  element.inert = entry.inert;
  if (entry.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", entry.ariaHidden);
}

let scrollLocks = 0;
let savedOverflow = "";

function lockScroll() {
  if (scrollLocks === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
}

function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
}

function initialFocusTarget(panel: HTMLElement): HTMLElement {
  const marked = panel.querySelector<HTMLElement>("[data-autofocus]");
  if (marked && !marked.matches(":disabled")) return marked;
  const field = Array.from(panel.querySelectorAll<HTMLElement>(TEXT_ENTRY)).find(
    (element) => element.getClientRects().length > 0,
  );
  if (field) return field;
  const focusable = focusableElements(panel);
  return focusable.find((element) => !element.hasAttribute("data-layer-close")) ?? focusable[0] ?? panel;
}

export interface ModalLayerOptions {
  open: boolean;
  /** Called when Escape is pressed on the top layer and the layer is dismissible. */
  onClose: () => void;
  /** The layer's panel. Focus is kept inside it; for modal layers everything outside becomes inert. */
  panelRef: RefObject<HTMLElement | null>;
  /**
   * Where focus lands on open. Defaults to `[data-autofocus]`, then the first
   * text field, then the first focusable that is not the close button.
   * Pass `false` to leave focus alone (a menu focuses its own first item).
   */
  initialFocusRef?: RefObject<HTMLElement | null> | false;
  /** `false` while a submission is in flight: Escape is swallowed instead of closing. Defaults to `true`. */
  dismissible?: boolean;
  /**
   * Modal layers (dialogs, drawers) trap Tab, make the page inert and lock
   * scroll. Non-modal layers (menus) only take part in Escape ordering.
   * Defaults to `true`.
   */
  modal?: boolean;
  /** Return focus to the element that was focused when the layer opened. Defaults to `true`. */
  restoreFocus?: boolean;
}

export function useModalLayer({
  open,
  onClose,
  panelRef,
  initialFocusRef,
  dismissible = true,
  modal = true,
  restoreFocus = true,
}: ModalLayerOptions) {
  const latest = useRef({ onClose, dismissible, initialFocusRef, restoreFocus });
  latest.current = { onClose, dismissible, initialFocusRef, restoreFocus };

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer: Layer = {
      modal,
      panelRef,
      requestClose: () => {
        if (latest.current.dismissible) latest.current.onClose();
      },
    };
    pushLayer(layer);
    if (modal) lockScroll();

    let background: HTMLElement[] = [];
    // Deferred a frame so the portal is in the document and can be excluded
    // from the elements made inert.
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (modal) {
        const overlayRoot = panel?.closest("body > *");
        background = Array.from(document.body.children).filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement &&
            element !== overlayRoot &&
            !element.hasAttribute("data-layer-persistent") &&
            element.tagName !== "SCRIPT",
        );
        background.forEach(makeInert);
      }
      const focusRef = latest.current.initialFocusRef;
      if (focusRef === false || !panel) return;
      if (panel.contains(document.activeElement)) return;
      (focusRef?.current ?? initialFocusTarget(panel)).focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      removeLayer(layer);
      background.forEach(releaseInert);
      if (modal) unlockScroll();
      if (
        latest.current.restoreFocus &&
        previouslyFocused?.isConnected &&
        // Focus already moved somewhere deliberate (another layer, a link): leave it.
        (!document.activeElement ||
          document.activeElement === document.body ||
          panelRef.current?.contains(document.activeElement))
      ) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [modal, open, panelRef]);
}
