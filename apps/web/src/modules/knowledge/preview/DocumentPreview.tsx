"use client";

import { Button, Modal } from "@heroui/react";
import { ArrowUpRight, ChevronDown, ChevronUp, Lock, Quote, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { ApiError, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";

import { RequestAccessCta } from "../bases/components/RequestAccessDialog";
import { ResDot } from "../components/ResourceRow";
import { TrustChip, useTrust } from "../components/TrustChip";
import type { Resource } from "../model";
import { useDocumentOperations } from "../operations";
import { readerHref } from "../reader/links";
import { DocumentSurface, type SurfaceHighlight, type SurfaceMarks } from "../reader/components/DocumentSurface";
import { usePassages } from "../reader/queries";
import { useItem, useKnowledgeModel } from "../queries";
import type { PreviewCitation, PreviewRequest } from "./store";

/** What the preview shows right now: one passage of a citation list, or the single document it was opened with. */
interface Showing {
  item: string;
  passages: string[];
  excerpt: string;
  page?: number;
  q: string;
  from?: string;
  collection?: string;
}

function showing(request: PreviewRequest, index: number): Showing | null {
  const list = request.citations ?? [];
  if (list.length) {
    const c = list[Math.max(0, Math.min(index, list.length - 1))];
    if (!c) return null;
    return { item: c.item, passages: c.passage ? [c.passage] : [], excerpt: c.excerpt ?? "", page: c.page, q: "", from: request.from, collection: c.collection };
  }
  if (!request.item) return null;
  return { item: request.item, passages: [...(request.passages ?? [])], excerpt: "", page: request.page, q: request.q ?? "", from: request.from, collection: request.collection };
}

/* ═══════════════ The document's own pages ═══════════════ */

function PreviewDocument({ show, resource: r, hit, onTotal }: { show: Showing; resource: Resource; hit: number; onTotal: (total: number) => void }) {
  const ops = useDocumentOperations();
  const passages = usePassages(resourceId(show.item), show.passages);
  const resolved = useMemo(() => passages.data.filter((p): p is NonNullable<typeof p> => !!p), [passages.data]);
  // A citation's quote is matched verbatim; a search is tokenised the way the Reader does. Both need a processed document.
  const quote = !!show.excerpt && !show.passages.length;
  const highlight = useMemo<SurfaceHighlight | undefined>(
    () => (r.readable ? { passages: resolved, q: quote ? show.excerpt : show.q, cited: quote } : undefined),
    [r.readable, resolved, quote, show.excerpt, show.q],
  );
  const [total, setTotal] = useState(0);
  const onMarks = useCallback((m: SurfaceMarks) => setTotal(m.total), []);
  useEffect(() => onTotal(total), [total, onTotal]);
  const focusHit = total ? ((hit % total) + total) % total : -1;
  return (
    <DocumentSurface
      document={r}
      variant="preview"
      highlight={highlight}
      focusHit={focusHit}
      page={show.page}
      onMarks={onMarks}
      onDownload={() => void ops.download(r)}
    />
  );
}

/* ═══════════════ The reading bar ═══════════════ */

function ReadingBar({
  show,
  citations,
  index,
  onStep,
  hit,
  total,
  onHit,
}: {
  show: Showing;
  citations: readonly PreviewCitation[];
  index: number;
  onStep: (delta: number) => void;
  hit: number;
  total: number;
  onHit: (delta: number) => void;
}) {
  const cited = show.passages.length > 0 || !!show.excerpt;
  if (cited) {
    const where = show.page ? `Cited passage · page ${show.page}` : "Cited passage";
    return (
      <div className="pv-bar">
        <span className="pv-bar__label">
          <Quote className="i i-sm" aria-hidden />
          <span className="truncate">{where}</span>
        </span>
        <span className="grow" />
        {citations.length > 1 ? (
          <>
            <span className="pv-bar__count num">{`Passage ${index + 1} of ${citations.length}`}</span>
            <IconButton icon={ChevronUp} tip="Previous passage" size="sm" isDisabled={index === 0} onPress={() => onStep(-1)} />
            <IconButton icon={ChevronDown} tip="Next passage" size="sm" isDisabled={index >= citations.length - 1} onPress={() => onStep(1)} />
          </>
        ) : null}
      </div>
    );
  }
  if (!show.q) return null;
  const at = total ? ((hit % total) + total) % total : 0;
  return (
    <div className="pv-bar">
      <span className="pv-bar__label">
        <Search className="i i-sm" aria-hidden />
        <span className="truncate">{`Matches for “${show.q}”`}</span>
      </span>
      <span className="grow" />
      <span className="pv-bar__count num" aria-live="polite">
        {total ? `${at + 1} of ${total}` : "No matches on these pages"}
      </span>
      <IconButton icon={ChevronUp} tip="Previous match" size="sm" isDisabled={total < 2} onPress={() => onHit(-1)} />
      <IconButton icon={ChevronDown} tip="Next match" size="sm" isDisabled={total < 2} onPress={() => onHit(1)} />
    </div>
  );
}

/* ═══════════════ The preview ═══════════════ */

/** Trust next to the metadata, but only when it means something (Verified or Review due). */
function MetaTrust({ resource }: { resource: Resource }) {
  const trust = useTrust(resource);
  if (trust.state !== "verified" && trust.state !== "review") return null;
  return (
    <span className="pv-meta__trust">
      <TrustChip resource={resource} />
    </span>
  );
}

/**
 * A citation from a document the caller can't open (preview `M['doc-preview']` without access): the
 * quote itself, so the claim can still be checked, and Request access when its collection is known
 * (the API answers 403 alike for missing and unshared documents and names no collection).
 */
function LockedPreview({ show, onClose }: { show: Showing; onClose: () => void }) {
  const base = useItem(show.collection ?? null);
  const locked = base.data?.access === "LOCKED" ? base.data : null;
  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal.Container placement="auto">
        <Modal.Dialog aria-label="Document unavailable">
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <span className="modal__icon">
              <Lock className="i" aria-hidden />
            </span>
            <Modal.Heading>Document unavailable</Modal.Heading>
            <p className="modal__description">It was removed, or it isn’t shared with you.</p>
          </Modal.Header>
          {show.excerpt ? (
            <Modal.Body>
              <blockquote className="pv-quote" translate="no">
                <mark className="evidence is-focus">{show.excerpt}</mark>
              </blockquote>
              {locked ? (
                <p className="pv-quote__note">{`Ask the owners of ${locked.displayName ?? ""} for access to read the whole document.`}</p>
              ) : null}
            </Modal.Body>
          ) : null}
          <Modal.Footer>
            {locked ? (
              <div className="modal__footer-start">
                <RequestAccessCta base={locked} size="md" />
              </div>
            ) : null}
            <Button variant="primary" onPress={onClose}>
              Close
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/**
 * The shared document preview (preview `M['doc-preview']`): the document's own pages over the page
 * the caller came from, the cited passage or matching words highlighted and scrolled into view, and
 * exactly two actions — Ask about this document (secondary) and Open full document (primary).
 * No Save, ⋯, editing or sharing: the row it was opened from already offers those, and the rest
 * lives in the Reader.
 */
export function DocumentPreview({ request, onClose }: { request: PreviewRequest; onClose: () => void }) {
  const router = useRouter();
  const citations = request.citations ?? [];
  const start = Math.max(0, request.n ? citations.findIndex((c) => c.n === request.n) : 0);
  const [index, setIndex] = useState(start);
  const [hit, setHit] = useState(0);
  const [total, setTotal] = useState(0);

  const show = showing(request, index);
  const itemId = resourceId(show?.item ?? "");
  // Opened from a list: draw from the listed item at once (title, cover as page 1) while GetItem loads.
  const listed = !citations.length && request.listed && resourceId(request.listed.name) === itemId ? request.listed : undefined;
  const item = useItem(itemId || null, { placeholder: listed });
  const { toResource } = useKnowledgeModel();
  const r = item.data ? toResource(item.data) : null;

  if (!show) return null;
  if (item.error instanceof ApiError && (item.error.isNotFound || item.error.status === 403)) return <LockedPreview show={show} onClose={onClose} />;

  const open = (href: string) => {
    onClose();
    router.push(href);
  };
  const title = r?.title || "Document";
  const page = show.excerpt || show.passages.length ? show.page : undefined;
  const href = readerHref({ item: show.item, passages: show.passages, q: show.excerpt || show.q, page, from: show.from });

  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal.Container placement="auto" scroll="inside">
        <Modal.Dialog className="modal__dialog--preview" aria-label={title}>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <span className="modal__icon">
              <FileIcon type={r?.ext} mime={r?.mime} name={r?.fileName} />
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <Modal.Heading translate="no" title={title}>
                {title}
              </Modal.Heading>
              <p className="modal__description">
                <span className="pv-meta">
                  <span>{r?.typeLabel ?? "Document"}</span>
                  {r?.base && !r.isPersonal ? (
                    <>
                      <ResDot />
                      <span translate={r.base.personal ? undefined : "no"}>{r.base.displayName}</span>
                    </>
                  ) : null}
                  {r?.updated ? (
                    <>
                      <ResDot />
                      <span>{`Updated ${rel(r.updated).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}`}</span>
                    </>
                  ) : null}
                  {r ? <MetaTrust resource={r} /> : null}
                </span>
              </p>
            </div>
          </Modal.Header>
          <div className="modal__head">
            {r?.readable ? (
              <ReadingBar
                show={show}
                citations={citations}
                index={index}
                onStep={(d) => {
                  setIndex((i) => Math.max(0, Math.min(citations.length - 1, i + d)));
                  setHit(0);
                }}
                hit={hit}
                total={total}
                onHit={(d) => setHit((h) => h + d)}
              />
            ) : null}
          </div>
          <Modal.Body>
            {r ? (
              <PreviewDocument key={`${show.item}:${index}`} show={show} resource={r} hit={hit} onTotal={setTotal} />
            ) : (
              <div className="pv-doc" aria-busy="true" aria-label="Loading">
                <span className="skeleton block" style={{ height: 420, borderRadius: "var(--radius-lg)" }} />
              </div>
            )}
          </Modal.Body>
          <Modal.Footer>
            {r?.readable ? (
              <div className="modal__footer-start">
                <Button variant="ghost" className="pv-ask" aria-label="Ask about this document" onPress={() => open(readerHref({ item: show.item, from: show.from, ask: true }))}>
                  <Sparkles className="i" aria-hidden />
                  <span>Ask about this document</span>
                </Button>
              </div>
            ) : null}
            <Button variant="primary" onPress={() => open(href)}>
              <ArrowUpRight className="i" aria-hidden />
              Open full document
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
