"use client";

import { useEffect } from "react";

import { getTourStep, startTour, useShellOverlays } from "./overlays";

/** The product tour runs on Home, the landing page. */
export const TOUR_PATH = "/home";

const seenKey = (user: string, workspace: string) => `bomesh.tourSeen.${user}:${workspace}`;

/**
 * Starts the product tour by itself the first time a person lands on Home in a workspace (remembered on this device per
 * person and workspace), once Home has rendered its Ask box and nothing else is open (preview `tourAuto`).
 */
export function useTourAutoStart(pathname: string, user: string | undefined, workspace: string | undefined): void {
  const { open } = useShellOverlays();
  useEffect(() => {
    if (pathname !== TOUR_PATH || !user || !workspace || open || getTourStep() != null) return;
    const key = seenKey(user, workspace);
    if (window.localStorage.getItem(key)) return;
    let tries = 0;
    let timer = 0;
    const wait = () => {
      if (document.querySelector("#home-ask")) {
        window.localStorage.setItem(key, String(Date.now()));
        startTour();
      } else if (tries++ < 40) timer = window.setTimeout(wait, 300);
    };
    timer = window.setTimeout(wait, 300);
    return () => window.clearTimeout(timer);
  }, [pathname, user, workspace, open]);
}
