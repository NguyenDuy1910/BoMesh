"use client";

import { Button } from "@heroui/react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { toast } from "@/components/ui/Toast";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";
import { closeInbox } from "@/modules/inbox";

import { endTour } from "./overlays";
import { homeReady, markWelcomeSeen, shownTourSteps, TOUR, TOUR_PATH, tourTarget } from "./tour";
import { placeCard, resolveStep, revealBy, spotlightPath, stepAfter } from "./tourLayout";

/** Below this width the card is a bottom sheet. */
const SHEET = 680;
/** The ring's distance around its target. */
const PAD = 6;
/** The sheet's distance from the bottom of the screen. */
const EDGE = 12;
const ORDER = TOUR.map((s) => s.id);
/** The shell's shortcuts (⌘K, ⌘⇧O, ⌘\): nothing reaches the page while the tour runs. */
const SHORTCUTS: Readonly<Record<string, true>> = { k: true, o: true, "\\": true };
/** Keys that would scroll the page (Space too, unless it presses the focused button). */
const SCROLL_KEYS: Readonly<Record<string, true>> = { PageUp: true, PageDown: true, Home: true, End: true, ArrowUp: true, ArrowDown: true };

/**
 * Product tour on Home (preview `features/chat.js` tour): a short, modal walk through the page. It starts from Home's
 * welcome card (a new member's first visit), Getting started's "Take the tour" and Help › Product tour, once Home has
 * finished loading. The page is hidden behind a dark scrim with a spotlight hole on the step's target and inert while the
 * tour runs: no clicks, no scrolling (wheel, touch or keys; only the tour scrolls a target into view), no shortcuts, no
 * menus. Skip tour and Escape end it. Steps are resolved every time the card is painted, so one whose target isn't on
 * screen is skipped, and the ring, hole and card follow the target when the page resizes or changes.
 * The card sits next to its target, never over it (`placeCard`: right of a sidebar item, below or above main content); on
 * phones it is a bottom sheet with the target scrolled above it. Focus moves to the card only when the step changes.
 * However the tour ends, the welcome card counts as answered.
 */
export function ProductTour({ onStart }: { onStart: () => void }) {
  const { workspace, id: workspaceId } = useWorkspace();
  const user = useSession()?.user.name;
  const pathname = usePathname();
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const back = useRef<Element | null>(null);
  const focused = useRef<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [pos, setPos] = useState({ index: 0, total: 0 });
  const [sheet, setSheet] = useState(false);

  // Focus goes back where it was when the tour started (Skip, Escape).
  useEffect(() => {
    back.current = document.activeElement;
  }, []);

  const end = useCallback(
    (done: boolean) => {
      markWelcomeSeen(user, workspaceId);
      document.querySelector(".app")?.removeAttribute("inert");
      const composer = document.querySelector<HTMLTextAreaElement>("#chat-input");
      if (done) {
        composer?.scrollIntoView({ block: "center" });
        composer?.focus({ preventScroll: true });
        toast("You’re all set. Ask your first question or open a document.");
      } else {
        const to = back.current instanceof HTMLElement && back.current.isConnected && back.current !== document.body ? back.current : composer;
        to?.focus({ preventScroll: true });
      }
      endTour();
    },
    [user, workspaceId],
  );

  // Start on Home (closing the off-canvas sidebar and the Inbox) once it has finished loading; leaving Home ends the tour.
  useEffect(() => {
    if (step) {
      if (pathname !== TOUR_PATH) end(false);
      return;
    }
    if (pathname !== TOUR_PATH) {
      router.push(TOUR_PATH);
      return;
    }
    onStart();
    closeInbox();
    let tries = 0;
    let timer = 0;
    const wait = () => {
      if (homeReady()) {
        const first = shownTourSteps()[0];
        if (first) setStep(first);
        else endTour();
      } else if (tries++ < 100) timer = window.setTimeout(wait, 100);
      else endTour();
    };
    timer = window.setTimeout(wait, 100);
    return () => window.clearTimeout(timer);
  }, [step, pathname, router, onStart, end]);

  // The step on screen: ring its target, place the card, and follow both on scroll, resize and layout changes.
  useLayoutEffect(() => {
    if (!step) return;
    const app = document.querySelector(".app");
    const scroll = document.getElementById("scroll");
    const def = TOUR.find((s) => s.id === step)!;
    app?.setAttribute("inert", "");
    let raf = 0;
    let reveal = false;
    let target: Element | null = null;

    /** `moved`: the step just changed or the layout did — bring the target back into view if it isn't. */
    const paint = (moved: boolean) => {
      const card = cardRef.current;
      const ring = ringRef.current;
      if (!card || !ring) return;
      const shown = shownTourSteps();
      const id = resolveStep(ORDER, shown, step);
      if (!id) return end(false);
      if (id !== step) return setStep(id);
      const W = document.body.clientWidth;
      const H = document.body.clientHeight;
      if (W < SHEET !== sheet) return setSheet(W < SHEET);
      const index = shown.indexOf(step);
      setPos((p) => (p.index === index && p.total === shown.length ? p : { index, total: shown.length }));
      const t = tourTarget(def.sel)!;
      if (t !== target) {
        observer.disconnect();
        // The page's content too: anything above the target that grows (an image, a wrapped line) moves it.
        for (const el of [t, card, scroll, scroll?.firstElementChild]) if (el) observer.observe(el);
        target = t;
      }
      if (moved && scroll?.contains(t)) {
        const room = scroll.getBoundingClientRect();
        const bottom = sheet ? H - card.offsetHeight - 2 * EDGE : room.bottom;
        const by = revealBy(t.getBoundingClientRect(), room.top + 16, bottom - 16);
        if (Math.abs(by) > 1) scroll.scrollTop += by;
      }
      const r = t.getBoundingClientRect();
      const box = { left: r.left - PAD, top: r.top - PAD, right: r.right + PAD, bottom: r.bottom + PAD };
      Object.assign(ring.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
      if (scrimRef.current) scrimRef.current.style.clipPath = spotlightPath(box, parseFloat(getComputedStyle(ring).borderTopLeftRadius) || 0, W, H);
      if (sheet) Object.assign(card.style, { left: "", top: "" });
      else {
        const region = t.closest(".sidebar") ? "sidebar" : "main";
        const at = placeCard(box, { width: card.offsetWidth, height: card.offsetHeight }, { left: 0, top: 0, right: W, bottom: H }, region);
        Object.assign(card.style, { left: `${at.left}px`, top: `${at.top}px` });
      }
    };
    const schedule = (moved: boolean) => {
      reveal ||= moved;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = reveal;
        reveal = false;
        paint(r);
      });
    };
    const onLayout = () => schedule(true);
    const onScroll = () => schedule(false);
    const observer = new ResizeObserver(onLayout);
    const mutations = new MutationObserver(onLayout);
    if (app) mutations.observe(app, { childList: true, subtree: true });
    // Sections rising in (transforms) and panels animating open change the layout without resizing anything.
    app?.addEventListener("animationend", onLayout);
    app?.addEventListener("transitionend", onLayout);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onLayout);

    // The ring and the scrim's hole glide from step to step; following a layout change they stay glued to the target.
    const ring = ringRef.current;
    const scrim = scrimRef.current;
    const gliding = focused.current != null && focused.current !== step;
    if (gliding) for (const el of [ring, scrim]) el?.classList.add("is-moving");
    const glide = window.setTimeout(() => {
      for (const el of [ring, scrim]) el?.classList.remove("is-moving");
    }, 300);
    // Nothing scrolls the page while the tour runs: the scrim and card swallow the wheel and touch moves.
    const still = (e: Event) => e.preventDefault();
    const card0 = cardRef.current;
    for (const t of ["wheel", "touchmove"] as const) {
      scrim?.addEventListener(t, still, { passive: false });
      card0?.addEventListener(t, still, { passive: false });
    }
    paint(true);
    if (focused.current !== step) {
      focused.current = step;
      nextRef.current?.focus({ preventScroll: true });
    }

    // The page is inert: Escape ends the tour, Tab stays in the card, no key scrolls the page and no shortcut reaches it.
    const onKey = (e: KeyboardEvent) => {
      const card = cardRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        end(false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const all = [...(card?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        all[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      } else if (SCROLL_KEYS[e.key] || (e.key === " " && !(e.target as Element | null)?.closest?.("button"))) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (e.metaKey || e.ctrlKey || e.altKey || !card?.contains(e.target as Node)) {
        e.stopImmediatePropagation();
        if ((e.metaKey || e.ctrlKey) && SHORTCUTS[e.key.toLowerCase()]) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(glide);
      for (const t of ["wheel", "touchmove"] as const) {
        scrim?.removeEventListener(t, still);
        card0?.removeEventListener(t, still);
      }
      observer.disconnect();
      mutations.disconnect();
      app?.removeEventListener("animationend", onLayout);
      app?.removeEventListener("transitionend", onLayout);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("keydown", onKey, true);
      app?.removeAttribute("inert");
    };
  }, [step, sheet, end]);

  if (!step) return null;
  const def = TOUR.find((s) => s.id === step)!;
  const last = pos.index === pos.total - 1;
  const go = (delta: 1 | -1) => {
    const to = stepAfter(shownTourSteps(), step, delta);
    if (to) setStep(to);
    else if (delta > 0) end(true);
  };
  const touch = window.matchMedia("(hover: none)").matches;

  return (
    <>
      {/* Takes every pointer, wheel and touch (the page stays still); a press keeps focus in the card. */}
      <div ref={scrimRef} className="tour-scrim" onMouseDown={(e) => e.preventDefault()} aria-hidden />
      <div ref={ringRef} className="chat-tour-ring" aria-hidden />
      <div
        ref={cardRef}
        className={sheet ? "chat-tour chat-tour--sheet" : "chat-tour"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-tour-title"
        aria-describedby="chat-tour-body"
      >
        <span className="chat-tour__step num">{`Step ${pos.index + 1} of ${pos.total}`}</span>
        <h3 className="chat-tour__title" id="chat-tour-title">
          {def.title}
        </h3>
        <p className="chat-tour__body" id="chat-tour-body">
          {def.body({ workspace: workspace.displayName ?? "", touch })}
        </p>
        <div className="chat-tour__foot">
          <Button variant="ghost" size="sm" onPress={() => end(false)}>
            Skip tour
          </Button>
          <span className="grow" />
          {pos.index > 0 ? (
            <Button variant="tertiary" size="sm" onPress={() => go(-1)}>
              Back
            </Button>
          ) : null}
          <Button ref={nextRef} variant="primary" size="sm" onPress={() => go(1)}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </>
  );
}
