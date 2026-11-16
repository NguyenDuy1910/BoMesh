import clsx from "clsx";
import type { ReactNode } from "react";

import type { MarkRange } from "../marks";

/** Text with its evidence marks (`mark.evidence[data-hit]`); the focused one is `is-focus`. */
export function Marked({ text, ranges, focusHit }: { text: string; ranges?: readonly MarkRange[]; focusHit: number }) {
  if (!ranges?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) out.push(text.slice(at, r.start));
    out.push(
      <mark key={r.start} className={clsx("evidence", r.hit === focusHit && "is-focus")} data-hit={r.hit}>
        {text.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
