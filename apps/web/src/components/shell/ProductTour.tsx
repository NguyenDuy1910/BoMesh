"use client";

import { Button } from "@heroui/react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { toast } from "@/components/ui/Toast";
import { useWorkspace } from "@/lib/workspace";

import { getTourStep, setTourStep, useShellOverlays } from "./overlays";
import { TOUR_PATH } from "./tour";

/**
 * Product tour on Home, the real landing page (preview `features/chat.js` tour): starts by itself the first time a person
 * lands on Home in a workspace (`useTourAutoStart`), and from the account menu any time. Steps skip what isn't on screen
 * (the sidebar on phones). The card never covers what it points at: it sits beside the target, or as a bottom sheet on
 * phones with the target scrolled above it. One way out: Skip tour (or Escape).
 */
interface Step {
  sel: string;
  title: string;
  body: (ctx: { workspace: string; touch: boolean }) => string;
}

const TOUR: Step[] = [
  {
    sel: ".home-starts",
    title: "Start from what you need",
    body: ({ workspace }) => `Find a document, ask a question answered from ${workspace} documents with citations, or share what you know.`,
  },
  {
    sel: ".home-sec--attention, .home-sec--continue",
    title: "Pick up where you left off",
    body: () =>
      document.querySelector(".home-sec--continue")
        ? "What needs you and the documents you were reading. Ask about a document right from its row."
        : "What needs you shows up here, with the documents you were reading once you start.",
  },
  { sel: ".home-sec--explore", title: "Explore what’s here", body: () => "Each topic shows what it covers and how much there is. Open one to browse it in Knowledge." },
  { sel: "#nav-chat", title: "AI Chat", body: () => "AI Chat: start a conversation or pick up an earlier one. Attach files or choose exactly what to search." },
  {
    sel: "#side-search, #topbar-search",
    title: "Find anything",
    body: ({ touch }) => (touch ? "Search conversations, documents and pages." : "Search conversations, documents and pages, or press ⌘K."),
  },
];

/** Below this width the card is a bottom sheet. */
const SHEET = 680;

/** The first on-screen element a step points at (phones show some controls in other places, or not at all). */
function stepTarget(sel: string): Element | null {
  const width = document.body.clientWidth;
  return (
    [...document.querySelectorAll(sel)].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 4 && r.left < width - 4;
    }) ?? null
  );
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export function ProductTour({ onStart }: { onStart: () => void }) {
  const { tour } = useShellOverlays();
  const { workspace } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [place, setPlace] = useState<{ ring: CSSProperties; card: CSSProperties; sheet: boolean } | null>(null);

  const close = useCallback(() => {
    setTourStep(null);
    setSteps([]);
    setPlace(null);
  }, []);

  // Start: go to Home (closing the off-canvas sidebar), then wait for its sections. Leaving Home ends the tour.
  useEffect(() => {
    if (tour == null) return;
    if (pathname !== TOUR_PATH) {
      if (steps.length) close();
      else router.push(TOUR_PATH);
      return;
    }
    if (steps.length) return;
    onStart();
    let tries = 0;
    let timer = 0;
    const find = () => {
      const found = TOUR.filter((s) => stepTarget(s.sel));
      if (found.length >= 3 || tries++ > 30) {
        if (found.length) setSteps(found);
        else close();
      } else timer = window.setTimeout(find, 100);
    };
    timer = window.setTimeout(find, 200);
    return () => window.clearTimeout(timer);
  }, [tour, pathname, router, onStart, steps.length, close]);

  const at = tour == null || !steps.length ? null : Math.min(tour, steps.length - 1);
  const step = at != null ? steps[at] : null;

  // Bring the target into view (above the sheet on phones), ring it, and place the card where it covers nothing.
  useLayoutEffect(() => {
    if (!step) return;
    const paint = () => {
      const target = stepTarget(step.sel);
      const card = cardRef.current;
      if (!target || !card) return;
      const W = document.body.clientWidth;
      const H = document.body.clientHeight;
      const sheet = W < SHEET;
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const scroll = document.getElementById("scroll");
      const r0 = target.getBoundingClientRect();
      if (scroll?.contains(target)) {
        const room = sheet ? H - ch - 24 : H - 16;
        if (r0.bottom > room || r0.top < 64) scroll.scrollTop += r0.top - (sheet ? Math.max(64, (room - r0.height) / 2) : 96);
      }
      const r = target.getBoundingClientRect();
      const pad = 6;
      const rr = { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
      const ring = { left: rr.left, top: rr.top, width: rr.right - rr.left, height: rr.bottom - rr.top };
      if (sheet) return setPlace({ ring, card: {}, sheet });
      const gap = 12;
      const clampX = (x: number) => Math.max(12, Math.min(W - cw - 12, x));
      const clampY = (y: number) => Math.max(12, Math.min(H - ch - 12, y));
      const cx = (rr.left + rr.right) / 2 - cw / 2;
      const cy = (rr.top + rr.bottom) / 2 - ch / 2;
      const spots: [number, number][] = [
        [clampX(cx), rr.bottom + gap],
        [clampX(cx), rr.top - gap - ch],
        [rr.right + gap, clampY(cy)],
        [rr.left - gap - cw, clampY(cy)],
      ];
      const fits = ([x, y]: [number, number]) => x >= 12 && y >= 12 && x + cw <= W - 12 && y + ch <= H - 12 && !overlaps({ left: x, top: y, right: x + cw, bottom: y + ch }, rr);
      const [x, y] = spots.find(fits) ?? [W - cw - 16, H - ch - 16];
      setPlace({ ring, card: { left: x, top: y }, sheet });
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
    if (n >= steps.length) {
      close();
      toast("You’re all set. Start with a topic or ask a question.");
    } else setTourStep(Math.max(0, n));
  };
  const touch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

  return (
    <>
      <div className="chat-tour-ring" style={place ? place.ring : { visibility: "hidden" }} aria-hidden />
      <div
        ref={cardRef}
        className={place?.sheet ? "chat-tour chat-tour--sheet" : "chat-tour"}
        role="dialog"
        aria-labelledby="chat-tour-title"
        aria-describedby="chat-tour-body"
        style={place ? place.card : { visibility: "hidden", left: 0, top: 0 }}
      >
        <span className="chat-tour__step num">
          {at + 1} of {steps.length}
        </span>
        <h3 className="chat-tour__title" id="chat-tour-title">
          {step.title}
        </h3>
        <p className="chat-tour__body" id="chat-tour-body">
          {step.body({ workspace: workspace.displayName, touch })}
        </p>
        <div className="chat-tour__foot">
          <Button variant="ghost" size="sm" onPress={close}>
            Skip tour
          </Button>
          <span className="grow" />
          {at > 0 ? (
            <Button variant="tertiary" size="sm" onPress={() => go(-1)}>
              Back
            </Button>
          ) : null}
          <Button ref={nextRef} variant="primary" size="sm" onPress={() => go(1)} id="chat-tour-next">
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </>
  );
}
