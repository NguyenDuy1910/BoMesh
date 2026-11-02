"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Run `work` after `delay` ms, but only while the page is visible.
 *
 * A hidden tab defers the call until it is shown again, then runs it at once:
 * nobody is reading a background tab, and on return the first thing they see
 * should be current. Returns a cancel function.
 */
export function afterVisibleDelay(delay: number, work: () => void): () => void {
  let waiting = false;
  const run = () => {
    if (document.visibilityState === "hidden") {
      waiting = true;
      return;
    }
    work();
  };
  const onVisibility = () => {
    if (waiting && document.visibilityState === "visible") {
      waiting = false;
      work();
    }
  };
  const timer = setTimeout(run, delay);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Poll `read` for as long as the component is mounted.
 *
 * One request at a time: the next is scheduled only after the previous one
 * settles, so a slow API is never stacked with retries. `interval` is asked
 * after every read, which lets the cadence follow the data (fast while work is
 * running, slow when idle); returning `null` stops polling until `refresh`.
 * Changing `key` restarts from a fresh read, and unmounting aborts the one in
 * flight. `read` receives the request's signal and owns its own errors.
 */
export function usePolling(
  read: (signal: AbortSignal) => Promise<void>,
  interval: () => number | null,
  key: unknown = "",
): () => void {
  const readRef = useRef(read);
  readRef.current = read;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    let cancelWait: () => void = () => undefined;

    const tick = async () => {
      cancelWait();
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        await readRef.current(current.signal);
      } catch {
        // The reader reports its own failures; polling carries on regardless.
      }
      // A newer read superseded this one, or the component went away.
      if (stopped || controller !== current) return;
      controller = null;
      const delay = intervalRef.current();
      if (delay !== null) cancelWait = afterVisibleDelay(delay, () => void tick());
    };

    refreshRef.current = () => void tick();
    void tick();
    return () => {
      stopped = true;
      cancelWait();
      controller?.abort();
      refreshRef.current = () => undefined;
    };
  }, [key]);

  return useCallback(() => refreshRef.current(), []);
}
