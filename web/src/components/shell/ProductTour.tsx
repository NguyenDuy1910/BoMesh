"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useCurrentWorkspace } from "@/components/shell/useCurrentWorkspace";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useModalLayer } from "@/lib/hooks/useModalLayer";

/** Prototype `POL_TOUR`: each step points at a `data-tour` anchor on the chat home or in the sidebar. */
const STEPS = [
  { anchor: "composer", title: "Ask in your own words", body: "Answers come from your company’s knowledge and cite every source they use." },
  { anchor: "scope", title: "Choose what to search", body: "Search all knowledge, or narrow to the knowledge bases that matter for this question." },
  { anchor: "starters", title: "Start from a suggestion", body: "Your admin picks these for the questions people ask most." },
  { anchor: "knowledge", title: "Browse knowledge", body: "See every knowledge base you can use, and request access to locked ones." },
  { anchor: "search", title: "Find anything with ⌘K", body: "Chats, documents, people and pages in one search." },
] as const;

const CARD_WIDTH = 300;
const MARGIN = 12;
const SPOT_PAD = 6;

export interface TourController {
  step: number | null;
  start: () => void;
  go: (delta: 1 | -1) => void;
  stop: () => void;
}

/**
 * The five-step first-run tour. It starts by itself once per account on the
 * chat home, and again whenever someone picks "Product tour".
 */
export function useFirstRunTour(): TourController {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const { session } = useCurrentWorkspace();
  const [step, setStep] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const seenKey = session ? `bomesh.tour.seen.${session.user_id}` : null;

  const start = useCallback(() => {
    setStep(null);
    setPending(true);
    router.push("/chat");
  }, [router]);

  // Show once the chat home is on screen: the first visit for this account, or on request.
  useEffect(() => {
    if (pathname !== "/chat" || !seenKey) return;
    let firstRun = false;
    try {
      firstRun = !window.localStorage.getItem(seenKey);
    } catch {
      firstRun = false;
    }
    if (!pending && !firstRun) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(seenKey, new Date().toISOString());
      } catch {
        // The tour may show again next time; nothing else depends on the flag.
      }
      setPending(false);
      setStep(0);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [pathname, pending, seenKey]);

  // The tour belongs to the chat home; leaving it ends the tour.
  useEffect(() => {
    if (pathname !== "/chat") setStep(null);
  }, [pathname]);

  const stop = useCallback(() => setStep(null), []);
  const go = useCallback((delta: 1 | -1) => {
    setStep((current) => {
      if (current === null) return null;
      const next = current + delta;
      if (next >= STEPS.length) {
        toast.show({ message: "You’re all set. Ask your first question." });
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('[data-tour="composer"] textarea, [data-tour="composer"] [contenteditable="true"]')?.focus();
        });
        return null;
      }
      return Math.max(0, next);
    });
  }, [toast]);

  return { step, start, go, stop };
}

interface Placement {
  spot: { left: number; top: number; width: number; height: number } | null;
  card: { left: number; top: number };
}

function place(anchor: string, cardHeight: number): Placement {
  const target = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
  const rect = target?.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!rect || rect.width === 0 || rect.height === 0) {
    return { spot: null, card: { left: (width - CARD_WIDTH) / 2, top: Math.max(MARGIN, (height - cardHeight) / 2) } };
  }
  let left: number;
  let top: number;
  if (rect.left < 260) {
    // Sidebar anchors: the card sits to the right.
    left = rect.right + 16;
    top = rect.top;
  } else {
    left = rect.left + rect.width / 2 - CARD_WIDTH / 2;
    top = rect.bottom + 14;
    if (top + cardHeight > height - MARGIN) top = rect.top - cardHeight - 14;
  }
  return {
    spot: { left: rect.left - SPOT_PAD, top: rect.top - SPOT_PAD, width: rect.width + SPOT_PAD * 2, height: rect.height + SPOT_PAD * 2 },
    card: {
      left: Math.max(MARGIN, Math.min(width - CARD_WIDTH - MARGIN, left)),
      top: Math.max(MARGIN, Math.min(height - cardHeight - MARGIN, top)),
    },
  };
}

/** Prototype `polTourPaint`: a spotlight on the anchor and a callout card beside it. */
export function ProductTour({ controller }: { controller: TourController }) {
  const { step, go, stop } = controller;
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const open = step !== null;

  useModalLayer({ open, onClose: stop, panelRef: cardRef, initialFocusRef: nextRef, modal: false });

  useLayoutEffect(() => {
    if (step === null) {
      setPlacement(null);
      return;
    }
    const update = () => setPlacement(place(STEPS[step].anchor, cardRef.current?.offsetHeight ?? 180));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  useEffect(() => {
    if (open) nextRef.current?.focus();
  }, [open, step]);

  if (step === null) return null;
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  return createPortal(
    <>
      {placement?.spot ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[90] rounded-[var(--radius-sheet)] shadow-[0_0_0_9999px_var(--scrim)] transition-all duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none"
          style={placement.spot}
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[90] bg-[var(--scrim)]" />
      )}
      <div
        aria-labelledby={titleId}
        className={cn(
          "fixed z-[91] rounded-[var(--radius-xl)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow-modal)] motion-safe:animate-ui-pop",
          !placement && "invisible",
        )}
        ref={cardRef}
        role="dialog"
        style={{ width: CARD_WIDTH, left: placement?.card.left ?? 0, top: placement?.card.top ?? 0 }}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[length:var(--text-size-caption)] font-medium text-[var(--text-tertiary)]">
            {step + 1} of {STEPS.length}
          </span>
          <span aria-hidden="true" className="flex gap-1">
            {STEPS.map((item, index) => (
              <span
                className={cn("size-1.5 rounded-full", index === step ? "bg-[var(--accent-primary)]" : "bg-[var(--border-default)]")}
                key={item.anchor}
              />
            ))}
          </span>
        </div>
        <h3 className="mt-1.5 text-[length:var(--text-size-section)] font-semibold text-[var(--text-primary)]" id={titleId}>
          {current.title}
        </h3>
        <p className="mt-1 text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{current.body}</p>
        <div className="mt-3.5 flex items-center justify-between">
          <Button onClick={stop} size="sm" variant="ghost">Skip tour</Button>
          <div className="flex gap-2">
            {step > 0 && <Button onClick={() => go(-1)} size="sm" variant="secondary">Back</Button>}
            <Button onClick={() => go(1)} ref={nextRef} size="sm" variant="primary">{last ? "Done" : "Next"}</Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
