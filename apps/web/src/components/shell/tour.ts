"use client";

import { getSession } from "@/lib/session";

/** The product tour runs on Home, the landing page. */
export const TOUR_PATH = "/home";

export interface TourStep {
  id: string;
  /** What the step points at; the first match on screen. */
  sel: string;
  title: string;
  body: (ctx: { workspace: string; touch: boolean }) => string;
}

/**
 * The tour's steps in order (preview `features/chat.js` TOUR): the Ask box, Getting started, Picked for you, Explore by
 * domain, New chat and Search. A step whose target isn't on screen is skipped.
 */
export const TOUR: readonly TourStep[] = [
  {
    id: "ask",
    sel: "#home-ask",
    title: "Ask anything",
    body: ({ workspace }) =>
      `Answers come only from documents you can read in ${workspace}, with their sources. Attach files or choose what to search; the suggestions are questions people in your role ask.`,
  },
  {
    id: "start",
    sel: ".home-start:not(.home-start--done)",
    title: "What to do first",
    body: () => "Three first steps, each with its button. They tick themselves off as you do them.",
  },
  { id: "picks", sel: ".home-picks", title: "Picked for you", body: () => "Chosen from your role’s questions, your spaces and what you read. The label on each card says why." },
  { id: "domains", sel: ".home-domains", title: "Everything, by domain", body: () => "A domain opens Knowledge filtered to it; a topic goes straight to its documents." },
  {
    id: "chat",
    sel: "#nav-chat",
    title: "New chat",
    body: () => "Start a conversation here, with files and a chosen scope. Your conversations are listed under Recent, lower in the sidebar.",
  },
  {
    id: "search",
    sel: "#side-search, #topbar-search",
    title: "Find anything",
    body: ({ touch }) => (touch ? "Search conversations, documents and pages." : "Search conversations, documents and pages, or press ⌘K."),
  },
];

/** The first on-screen element a step points at (phones show some controls in other places, or not at all). */
export function tourTarget(sel: string): Element | null {
  const width = document.body.clientWidth;
  return (
    [...document.querySelectorAll(sel)].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 4 && r.left < width - 4;
    }) ?? null
  );
}

/** The steps on screen right now, in tour order (their ids). */
export function shownTourSteps(): string[] {
  return TOUR.filter((s) => tourTarget(s.sel)).map((s) => s.id);
}

/** Home has finished loading: its Ask box is there and no skeleton is left. */
export function homeReady(): boolean {
  return !!document.querySelector("#home-ask") && !document.querySelector("#scroll .home-skel");
}

/*
 * Home's welcome card (modules/home `HomeWelcome`) greets a new member once per person and workspace on this device.
 * Answering it (Later, Escape) or ending the tour it offers — however the tour ends — records it as seen.
 */
const seenKey = (user: string, workspace: string) => `bomesh.tourSeen.${user}:${workspace}`;

export function welcomeSeen(user: string, workspace: string): boolean {
  return !!window.localStorage.getItem(seenKey(user, workspace));
}

export function markWelcomeSeen(user: string | undefined, workspace: string): void {
  if (user) window.localStorage.setItem(seenKey(user, workspace), String(Date.now()));
}

/**
 * Whether Home's welcome card will greet the person arriving at `path` in `workspace` (a new member's first Home visit on
 * this device). Joining confirms itself with a toast only when it won't: the card says hello in its place.
 */
export function welcomesOnArrival(workspace: string, path: string): boolean {
  const user = getSession()?.user.name;
  return path === TOUR_PATH && !!user && !welcomeSeen(user, workspace);
}
