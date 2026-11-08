"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Info, XCircle, type LucideIcon } from "lucide-react";

import { openDocumentPreview } from "@/modules/knowledge/preview/store";

import type { CheckLine, CheckState } from "../model";

const CHECK_UI: Record<CheckState, [LucideIcon, string]> = {
  pass: [CheckCircle2, "Met"],
  warn: [AlertTriangle, "Needs attention"],
  fail: [XCircle, "Not met"],
  info: [Info, "Good to know"],
  wait: [CircleDashed, "Not checked yet"],
};

/** Eligibility lines with numbered policy citations (preview `checkLines`); a number opens the source. */
export function RuleChecks({ lines }: { lines: readonly CheckLine[] }) {
  let n = 0;
  return (
    <ul className="rq-checks">
      {lines.map((c) => {
        const [Icon, label] = CHECK_UI[c.state];
        const num = c.cite ? ++n : 0;
        return (
          <li key={c.key} className={`rq-check rq-check--${c.state}`}>
            <span className="rq-check__icon">
              <Icon className="i" aria-hidden />
              <span className="sr-only">{label}:</span>
            </span>
            <div className="rq-check__body">
              <div className="rq-check__label">
                <span translate="no">{c.label}</span>
                {c.cite ? (
                  <button type="button" className="cite" aria-label={`Source ${num}`} onClick={() => c.cite && openDocumentPreview({ item: c.cite })}>
                    {num}
                  </button>
                ) : null}
              </div>
              {c.detail ? <div className="rq-check__detail">{c.detail}</div> : null}
              {c.consequence ? <div className="rq-check__note">{c.consequence}</div> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
