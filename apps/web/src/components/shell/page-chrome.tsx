"use client";

import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

/**
 * Pages own their topbar content: breadcrumbs and compact contextual actions
 * (preview `S.crumbs` / `topbarActions()`). A page renders `<PageChrome />`
 * once; the shell's Topbar reads it. Without it the topbar shows the route title.
 */
export interface Crumb {
  label: string;
  /** Omit on the last crumb (current page). */
  href?: string;
}

export interface PageChromeState {
  crumbs?: Crumb[];
  actions?: ReactNode;
}

const StateContext = createContext<PageChromeState>({});
const SetContext = createContext<(state: PageChromeState) => void>(() => undefined);

export function PageChromeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PageChromeState>({});
  return (
    <SetContext.Provider value={setState}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </SetContext.Provider>
  );
}

/** Declares this page's breadcrumbs and topbar actions. Renders nothing. */
export function PageChrome({ crumbs, actions }: PageChromeState) {
  const set = useContext(SetContext);
  useLayoutEffect(() => {
    set({ crumbs, actions });
  });
  useLayoutEffect(() => () => set({}), [set]);
  return null;
}

/** Topbar side: what the current page declared. */
export function usePageChrome(): PageChromeState {
  return useContext(StateContext);
}
