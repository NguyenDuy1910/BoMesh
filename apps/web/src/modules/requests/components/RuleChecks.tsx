"use client";

import { Button, Drawer } from "@heroui/react";
import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink, Info, XCircle, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { FileIcon } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useItem } from "@/modules/knowledge/queries";

import type { CheckLine, CheckState } from "../model";
import { LinkButton } from "./parts";

const CHECK_UI: Record<CheckState, [LucideIcon, string]> = {
  pass: [CheckCircle2, "Met"],
  warn: [AlertTriangle, "Needs attention"],
  fail: [XCircle, "Not met"],
  info: [Info, "Good to know"],
  wait: [CircleDashed, "Not checked yet"],
};

/** Eligibility lines with numbered policy citations (preview `checkLines`); a number opens the source. */
export function RuleChecks({ lines }: { lines: readonly CheckLine[] }) {
  const [open, setOpen] = useState<string | null>(null);
  let n = 0;
  return (
    <>
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
                    <button type="button" className="cite" aria-label={`Source ${num}`} onClick={() => setOpen(c.cite ?? null)}>
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
      <CitationDrawer item={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** The policy a rule cites (preview `DR['rq-quote']`): name, base, summary, Open document. */
function CitationDrawer({ item, onClose }: { item: string | null; onClose: () => void }) {
  const doc = useItem(item);
  const d = doc.data;
  const id = resourceId(item);
  return (
    <Drawer.Backdrop isOpen={!!item} onOpenChange={(o) => (o ? undefined : onClose())}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <div className="row gap-12" style={{ minWidth: 0 }}>
              <FileIcon mime={d?.document?.mimeType} name={d?.document?.fileName} size="lg" />
              <div className="grow" style={{ minWidth: 0 }}>
                <Drawer.Heading translate="no">{d?.displayName ?? (doc.isError ? "Source" : "…")}</Drawer.Heading>
              </div>
            </div>
          </Drawer.Header>
          <Drawer.Body>
            {d?.document?.summary ? (
              <blockquote className="rq-quote" translate="no">
                {d.document.summary}
              </blockquote>
            ) : null}
            <p className="t-sm muted mt-12">
              {doc.isError ? "You can’t open this document. Ask the office for the passage that applies." : "The assistant checked your request against this document."}
            </p>
          </Drawer.Body>
          {d && !doc.isError ? (
            <Drawer.Footer>
              <Button variant="tertiary" onPress={onClose}>
                Close
              </Button>
              <LinkButton href={`/doc/${id}`} variant="primary" icon={ExternalLink}>
                Open document
              </LinkButton>
            </Drawer.Footer>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
