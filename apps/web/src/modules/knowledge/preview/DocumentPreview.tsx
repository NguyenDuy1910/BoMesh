"use client";

import { Button, Modal } from "@heroui/react";
import { ArrowUpRight, ChevronDown, ChevronUp, Lock, Quote, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { ApiError, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";

import { RequestAccessCta } from "../bases/components/RequestAccessDialog";
import { ResDot } from "../components/ResourceRow";
import { TrustChip, useTrust } from "../components/TrustChip";
import type { Resource } from "../model";
import { docFormat, PAGED_FORMATS } from "../reader/format";
import { readerHref } from "../reader/links";
import { documentMarks, NO_MARKS, renditionText, searchNeedles } from "../reader/marks";
import { DocumentViewer } from "../reader/components/DocumentViewer";
import { renditionPageCount, RenditionView } from "../reader/components/RenditionView";
import { coverPages, PageImageView } from "../reader/components/PageImageView";
import { useRendition } from "../reader/components/useRendition";
import { useReaderContent, usePassages } from "../reader/queries";
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
  const itemId = resourceId(show.item);
  const content = useReaderContent(itemId, undefined, { enabled: r.readable });
  // Page images are the document's own pages; the rendition is downloaded only when it is what the preview shows.
  const pageImages = useMemo(
    () => [...(content.data?.pageAssets ?? [])].filter((p) => p.imageUri).sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0)),
    [content.data],
  );
  const rendition = useRendition(itemId, content.data, { enabled: !pageImages.length });
  const rd = rendition.doc;
  const passages = usePassages(itemId, show.passages);
  const resolved = useMemo(() => passages.data.filter((p): p is NonNullable<typeof p> => !!p), [passages.data]);

  const text = useMemo(() => (rd ? renditionText(rd) : ""), [rd]);
  // A citation's quote is matched verbatim; a search is tokenised the way the Reader does.
  const needles = useMemo(() => {
    if (!rd) return [];
    if (show.excerpt && !show.passages.length) return [show.excerpt];
    return show.q ? searchNeedles(show.q, text, false) : [];
  }, [rd, show.excerpt, show.passages.length, show.q, text]);
  const marks = useMemo(
    () => (rd && (resolved.length || needles.length) ? documentMarks(rd, { passages: resolved, needles }) : NO_MARKS),
    [rd, resolved, needles],
  );
  const focusHit = marks.total ? ((hit % marks.total) + marks.total) % marks.total : -1;
  useEffect(() => onTotal(marks.total), [marks.total, onTotal]);

  /* Bring the focused mark (or the cited page) into view on open and on every step, not on re-renders. */
  const scroll = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const sc = scroll.current?.closest<HTMLElement>(".modal__body");
    if (!sc || (!rd && !pageImages.length)) return;
    const mark = focusHit >= 0 ? sc.querySelector<HTMLElement>(`mark.evidence[data-hit="${focusHit}"]`) : null;
    const target = mark ?? (show.page ? sc.querySelector<HTMLElement>(`.doc-page[data-page="${show.page}"]`) : null);
    if (!target) {
      if (first.current) sc.scrollTop = 0;
      first.current = false;
      return;
    }
    const top = sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - (mark ? sc.clientHeight / 3 : 24);
    sc.scrollTo({ top: Math.max(0, top), behavior: first.current ? "auto" : "smooth" });
    first.current = false;
  }, [focusHit, rd, pageImages.length, show.page, marks]);

  const format = docFormat({ ext: r.ext, mime: r.mime });
  // No rendition (not processed yet, or it failed): the message, then the cover made when the content arrived.
  const coverBelow = coverPages(r.cover, format, { loading: false });
  const none = (
    <div ref={scroll}>
      <div className="pv-none">
        {coverBelow ? null : <FileIcon type={r.ext} mime={r.mime} name={r.fileName} size="lg" />}
        <p className="pv-none__title">There’s no preview for this file yet</p>
        {r.summary ? (
          <p className="pv-none__about" translate="no">
            {r.summary}
          </p>
        ) : null}
        <p className="pv-none__hint">Open it to read or download it.</p>
      </div>
      {coverBelow ? <div className={`pv-doc pv-doc--${format}`}>{coverBelow}</div> : null}
    </div>
  );

  if (!r.readable) return none;
  if (content.isPending || rendition.loading) {
    // Cover first: the card's cover is the first page (or slide, or sheet) at once while the pages or rendition load.
    const cover = coverPages(r.cover, format);
    if (cover) {
      return (
        <div className={`pv-doc pv-doc--${format}`} ref={scroll}>
          {cover}
        </div>
      );
    }
    return (
      <div className="pv-doc" ref={scroll} aria-busy="true" aria-label="Loading">
        <span className="skeleton block" style={{ height: 420, borderRadius: "var(--radius-lg)" }} />
      </div>
    );
  }
  const assetPages = content.data?.pageAssets?.length ?? 0;
  if (pageImages.length) {
    return (
      <div className="pv-doc pv-doc--pdf" ref={scroll}>
        <DocumentViewer format={PAGED_FORMATS[format] ? format : "pdf"} count={assetPages} bar={false}>
          <PageImageView pages={pageImages} focusPage={show.page ?? 0} coverUri={r.cover?.imageUri} />
        </DocumentViewer>
      </div>
    );
  }
  if (!rd?.blocks.length || rendition.failed || content.isError) return none;
  return (
    <div className={`pv-doc pv-doc--${format}`} ref={scroll}>
      <DocumentViewer format={format} count={renditionPageCount(rd, format, assetPages)} bar={false}>
        <RenditionView rendition={rd} marks={marks} focusHit={focusHit} format={format} pageCount={assetPages} />
      </DocumentViewer>
    </div>
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
