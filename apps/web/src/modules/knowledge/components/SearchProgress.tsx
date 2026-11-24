"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

/** Quick searches show no status line; past these, "Searching…" and then why it can take a while. */
const SHOW_AFTER_MS = 1_500;
const SLOW_AFTER_MS = 6_000;

/**
 * The status line of a search that takes a while (preview `searchProgress`): nothing for a quick one, then "Searching…",
 * then that matching by meaning can take a few seconds. The search itself ends at the server's deadline (or the client's
 * backstop) with an error that offers Try again, so this line never stays forever.
 */
export function SearchProgress({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    setPhase(0);
    if (!active) return;
    const shown = window.setTimeout(() => setPhase(1), SHOW_AFTER_MS);
    const slow = window.setTimeout(() => setPhase(2), SLOW_AFTER_MS);
    return () => {
      window.clearTimeout(shown);
      window.clearTimeout(slow);
    };
  }, [active]);
  if (!active || !phase) return null;
  return (
    <p className="search-progress" role="status">
      <LoaderCircle className="i spin" aria-hidden />
      <span>{phase === 1 ? "Searching…" : "Still searching. Matching by meaning can take a few seconds."}</span>
    </p>
  );
}
