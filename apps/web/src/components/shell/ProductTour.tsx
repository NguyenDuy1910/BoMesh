"use client";

import { Button } from "@heroui/react";
import { X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { IconButton } from "@/components/ui/IconButton";
import { toast } from "@/components/ui/Toast";

import { getTourStep, setTourStep, useShellOverlays } from "./overlays";

/**
 * First-run product tour (preview `X.startTour`): four steps anchored to the
 * chat home — composer, scope, starters — and the sidebar search. Steps whose
 * anchor isn't on screen are skipped; Escape or Skip ends it.
 * Anchors: `#chat-composer`, `#chat-scope`, `#chat-starters` (chat page) and
 * `[data-tour="search"]` (sidebar).
 */
const TOUR = [
  { sel: "#chat-composer", title: "Ask in your own words", body: "Answers come from your company knowledge and cite every source they use." },
  { sel: "#chat-scope", title: "Choose what to search", body: "Search all knowledge, or narrow it to the knowledge bases that matter." },
  { sel: "#chat-starters", title: "Start from a suggestion", body: "Common questions, picked by your workspace admin." },
  { sel: '.sidebar [data-tour="search"]', title: "Find anything", body: "Search conversations, documents and pages, or press ⌘K." },
];
const TOUR_PATH = "/chat";

/** Opens the chat home and starts the tour there. */
export function startTour(): void {
  setTourStep(0);
}

function visibleSteps() {
  const width = document.body.clientWidth;
  return TOUR.filter((s) => {
    const el = document.querySelector(s.sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > 4 && r.left < width - 4;
  });
}

function focusComposer() {
  document.querySelector<HTMLElement>("#chat-composer textarea, #chat-composer [contenteditable='true']")?.focus();
}

interface Placement {
  ring: { left: number; top: number; width: number; height: number };
  card: { left: number; top: number };
}

export function ProductTour({ onStart }: { onStart: () => void }) {
  const { tour } = useShellOverlays();
  const pathname = usePathname();
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const arrived = useRef(false);
  const [steps, setSteps] = useState<typeof TOUR>([]);
  const [place, setPlace] = useState<Placement | null>(null);

  const close = useCallback((done = false) => {
    setTourStep(null);
    arrived.current = false;
    setSteps([]);
    setPlace(null);
    if (done) toast("You’re all set. Ask your first question.");
    focusComposer();
  }, []);

  // Start: go to the chat home (closing the off-canvas sidebar), then wait for its anchors.
  useEffect(() => {
    if (tour == null) return;
    if (pathname !== TOUR_PATH) {
      if (arrived.current) {
        // Left the chat home mid-tour: the tour ends.
        setTourStep(null);
        arrived.current = false;
        setSteps([]);
        setPlace(null);
        return;
      }
      router.push(TOUR_PATH);
      return;
    }
    if (arrived.current) return;
    arrived.current = true;
    onStart();
    let tries = 0;
    let timer = 0;
    const find = () => {
      const found = visibleSteps();
      if (found.length >= 3 || tries++ > 20) {
        if (!found.length) {
          setTourStep(null);
          arrived.current = false;
          return;
        }
        setSteps(found);
      } else timer = window.setTimeout(find, 100);
    };
    timer = window.setTimeout(find, 160);
    return () => window.clearTimeout(timer);
  }, [tour, pathname, router, onStart]);

  const at = tour == null ? null : Math.min(tour, steps.length - 1);
  const step = at != null && at >= 0 ? steps[at] : null;

  // Position the ring around the anchor and the card next to it (re-done on resize).
  useLayoutEffect(() => {
    if (!step) return;
    const paint = () => {
      const target = document.querySelector(step.sel);
      const card = cardRef.current;
      if (!target || !card) return;
      const r = target.getBoundingClientRect();
      const W = document.body.clientWidth;
      const H = document.body.clientHeight;
      const pad = 6;
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      let left: number;
      let top: number;
      if (r.left < 260 && r.width < 300) {
        left = r.right + 16;
        top = r.top - 8;
      } else {
        left = r.left + r.width / 2 - cw / 2;
        top = r.bottom + 14;
        if (top + ch > H - 12) top = r.top - ch - 14;
      }
      setPlace({
        ring: { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 },
        card: { left: Math.max(12, Math.min(W - cw - 12, left)), top: Math.max(12, Math.min(H - ch - 12, top)) },
      });
    };
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, [step]);

  useEffect(() => {
    if (place) nextRef.current?.focus();
  }, [place, at]);

  // Escape ends the tour (when no dialog, menu or palette is open).
  useEffect(() => {
    if (!step) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [step, close]);

  if (!step || at == null) return null;
  const last = at === steps.length - 1;
  const go = (d: number) => {
    const n = (getTourStep() ?? 0) + d;
    if (n >= steps.length) close(true);
    else setTourStep(Math.max(0, n));
  };

  return (
    <>
      <div className="chat-tour-ring" style={place ? place.ring : { visibility: "hidden" }} aria-hidden />
      <div
        ref={cardRef}
        className="chat-tour"
        role="dialog"
        aria-labelledby="chat-tour-title"
        style={place ? place.card : { visibility: "hidden", left: 0, top: 0 }}
      >
        <div className="row between">
          <span className="t-xs muted num">
            {at + 1} of {steps.length}
          </span>
          <IconButton icon={X} tip="Close tour" size="sm" onPress={() => close()} />
        </div>
        <h3 className="t-subheading" id="chat-tour-title">
          {step.title}
        </h3>
        <p className="t-sm muted">{step.body}</p>
        <div className="row between mt-8">
          <Button variant="ghost" size="sm" onPress={() => close()}>
            Skip
          </Button>
          <div className="row gap-8">
            {at > 0 && (
              <Button variant="tertiary" size="sm" onPress={() => go(-1)}>
                Back
              </Button>
            )}
            <Button ref={nextRef} variant="primary" size="sm" onPress={() => go(1)}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
