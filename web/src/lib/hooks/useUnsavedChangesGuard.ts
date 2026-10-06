"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps unsaved edits from being lost by accident.
 *
 * While `dirty`, closing or reloading the tab asks the browser's own
 * "Leave site?" question, and clicking a link to another page inside the app
 * is held: `pendingHref` is set so the page can ask in its own dialog, then
 * `leave()` follows the link or `stay()` drops it. Links are caught in the
 * capture phase, before Next's `<Link>` handler runs.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const next = new URL(anchor.href, window.location.href);
      // Other sites are covered by `beforeunload`; the same page loses nothing.
      if (next.origin !== window.location.origin) return;
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingHref(`${next.pathname}${next.search}${next.hash}`);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);

  const stay = useCallback(() => setPendingHref(null), []);
  const leave = useCallback(() => {
    if (!pendingHref) return;
    dirtyRef.current = false;
    setPendingHref(null);
    router.push(pendingHref);
  }, [pendingHref, router]);

  return { pendingHref, stay, leave };
}
