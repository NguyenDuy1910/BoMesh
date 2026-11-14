"use client";

import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

/**
 * The shell owns one top row (CompactHeader, preview `topbar()`); pages declare what goes in it
 * (preview `pageHeader()` / `crumbs()` → `S.head` / `S.crumbs`). A page renders `<PageHeader/>`
 * (components/ui) or `<PageChrome/>` once; the CompactHeader reads the state.
 *
 * - Index pages: `title` is the page's H1 in the top row, with `extra` (chips), `meta` (a short dynamic
 *   status, never a static description) and `actions` (compact, icon-only on phones).
 * - Entity pages (`hero: true`): the page renders its own `.page-hero` H1; the top row keeps the trail and
 *   actions and fades `title` in once the hero scrolls away (`is-past-hero` on `#main`).
 * - `crumbs`: the parents, a quiet trail (only the nearest one, as a Back button, on phones). The last crumb,
 *   when it has no `href`, is the current page and is ignored when `title` is set.
 */
export interface Crumb {
  label: string;
  /** Omit on the last crumb (current page). */
  href?: string;
}

export interface PageChromeState {
  title?: string;
  extra?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  crumbs?: Crumb[];
  /** The page draws its own H1 (`.page-hero` or a reader head); the top row only peeks the title. */
  hero?: boolean;
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

/** Declares this page's top-row content. Renders nothing. */
export function PageChrome(props: PageChromeState) {
  const set = useContext(SetContext);
  useLayoutEffect(() => {
    set(props);
  });
  useLayoutEffect(() => () => set({}), [set]);
  return null;
}

/** CompactHeader side: what the current page declared. */
export function usePageChrome(): PageChromeState {
  return useContext(StateContext);
}
