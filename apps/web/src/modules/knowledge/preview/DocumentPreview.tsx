"use client";

import { Button, Modal } from "@heroui/react";
import clsx from "clsx";
import { ArrowUpRight, ChevronDown, ChevronUp, File, Lock, Pencil, Quote, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { ApiError, resourceId } from "@/lib/api/client";
import { rel } from "@/lib/format";

import { ResDot } from "../components/ResourceRow";
import { openEditDetails } from "../components/dialogs";
import { TrustChip, useTrust } from "../components/TrustChip";
import type { Resource } from "../model";
import { isSpreadsheetType } from "../reader/rendition";
import { readerHref } from "../reader/links";
import { documentMarks, NO_MARKS, renditionText, searchNeedles } from "../reader/marks";
import { RenditionView } from "../reader/components/RenditionView";
import { PageImageView } from "../reader/components/PageImageView";
import { useRendition } from "../reader/components/useRendition";
import { useReaderContent, usePassages } from "../reader/queries";
import { useItem, useKnowledgeModel } from "../queries";
import type { PreviewCitation, PreviewRequest } from "./store";

const relLow = (t?: string) => rel(t).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase());

/** What the preview shows right now: one passage of a citation list, or the single document it was opened with. */
interface Showing {
  item: string;
  passages: string[];
  excerpt: string;
  page?: number;
  q: string;
  from?: string;
}

function showing(request: PreviewRequest, index: number): Showing | null {
  const list = request.citations ?? [];
  if (list.length) {
    const c = list[Math.max(0, Math.min(index, list.length - 1))];
    if (!c) return null;
    return { item: c.item, passages: c.passage ? [c.passage] : [], excerpt: c.excerpt ?? "", page: c.page, q: "", from: request.from };
  }
  if (!request.item) return null;
  return { item: request.item, passages: [...(request.passages ?? [])], excerpt: "", page: request.page, q: request.q ?? "", from: request.from };
}

/* ═══════════════ The document's own pages ═══════════════ */

function PreviewDocument({ show, onFocus }: { show: Showing; onFocus: (focus: { hit: number; total: number }) => void }) {
  const itemId = resourceId(show.item);
  const content = useReaderContent(itemId, undefined);
  // Page images are the document's own pages; the rendition is downloaded only when it is what the preview shows.
  const pageImages = useMemo(
    () => [...(content.data?.pageAssets ?? [])].filter((p) => p.imageUri).sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0)),
    [content.data],
  );
  const rendition = useRendition(itemId, content.data, { enabled: !pageImages.length });
  const rd = rendition.doc;
  const passages = usePassages(itemId, show.passages);
  const resolved = useMemo(() => passages.data.filter((p): p is NonNullable<typeof p> => !!p), [passages.data]);
  const item = useItem(itemId);
  const { toResource } = useKnowledgeModel();
  const r = item.data ? toResource(item.data) : null;

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

  const [hit, setHit] = useState(0);
  const key = `${show.item}|${show.passages.join(",")}|${show.q}|${marks.total}`;
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setHit(0);
  }
  const focusHit = marks.total ? ((hit % marks.total) + marks.total) % marks.total : -1;
  useEffect(() => onFocus({ hit: focusHit, total: marks.total }), [focusHit, marks.total, onFocus]);

  /* Bring the focused mark (or the cited page) into view, without fighting the reader's own scrolling. */
  const scroll = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const sc = scroll.current?.closest<HTMLElement>(".modal__body");
    if (!sc || !rd) return;
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
  }, [focusHit, rd, show.page, marks]);

  const sheet = r ? isSpreadsheetType(r.mime) : false;
  const noAccess = item.error instanceof ApiError && (item.error.isNotFound || item.error.status === 403);

  // A citation from a document the caller can't open still shows its quote, so the claim can be checked.
  if (noAccess || (r && !r.readable)) {
    return (
      <div className="pv-doc pv-doc--none" ref={scroll}>
        {show.excerpt ? (
          <>
            <blockquote className="pv-quote">
              <mark className="evidence is-focus">{show.excerpt}</mark>
            </blockquote>
            <p className="pv-quote__note">
              {noAccess ? "This document isn’t shared with you." : "This document isn’t ready to read yet."} The quoted passage is shown so the answer can still be checked.
            </p>
          </>
        ) : (
          <div className="pv-none">
            <Lock className="i i-lg" aria-hidden />
            <p className="pv-none__title">{noAccess ? "You can’t open this document" : "There’s no preview for this file yet"}</p>
            <p className="pv-none__hint">{noAccess ? "It was removed, or it isn’t shared with you." : "Open it to read or download it."}</p>
          </div>
        )}
      </div>
    );
  }

  if (content.isPending || item.isPending || rendition.loading) {
    return (
      <div className="pv-doc" ref={scroll} aria-busy="true" aria-label="Loading">
        <span className="skeleton block" style={{ height: 420, borderRadius: "var(--radius-lg)" }} />
      </div>
    );
  }

  if (pageImages.length) {
    return (
      <div className="pv-doc" ref={scroll}>
        <PageImageView pages={pageImages} pageCount={pageImages.length} focusPage={show.page ?? 0} />
      </div>
    );
  }

  if (!rd || rendition.failed) {
    return (
      <div className="pv-doc pv-doc--none" ref={scroll}>
        <div className="pv-none">
          <File className="i i-lg" aria-hidden />
          <p className="pv-none__title">There’s no preview for this file yet</p>
          {r?.summary ? <p className="pv-none__about">{r.summary}</p> : null}
          <p className="pv-none__hint">Open it to read or download it.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx("pv-doc", sheet && "pv-doc--sheet")} ref={scroll}>
      <RenditionView rendition={rd} marks={marks} focusHit={focusHit} sheet={sheet} />
    </div>
  );
}

/* ═══════════════ The reading bar ═══════════════ */

function ReadingBar({
  show,
  citations,
  index,
  onStep,
  focus,
  onHit,
}: {
  show: Showing;
  citations: readonly PreviewCitation[];
  index: number;
  onStep: (delta: number) => void;
  focus: { hit: number; total: number };
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
  return (
    <div className="pv-bar">
      <span className="pv-bar__label">
        <Search className="i i-sm" aria-hidden />
        <span className="truncate">{`Matches for “${show.q}”`}</span>
      </span>
      <span className="grow" />
      <span className="pv-bar__count num" aria-live="polite">
        {focus.total ? `${focus.hit + 1} of ${focus.total}` : "No matches on these pages"}
      </span>
      <IconButton icon={ChevronUp} tip="Previous match" size="sm" isDisabled={focus.total < 2} onPress={() => onHit(-1)} />
      <IconButton icon={ChevronDown} tip="Next match" size="sm" isDisabled={focus.total < 2} onPress={() => onHit(1)} />
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
  const [focus, setFocus] = useState({ hit: -1, total: 0 });
  const [hitNudge, setHitNudge] = useState(0);

  const show = showing(request, index);
  const itemId = resourceId(show?.item ?? "");
  const item = useItem(itemId);
  const { toResource } = useKnowledgeModel();
  const r = item.data ? toResource(item.data) : null;

  const open = (href: string) => {
    onClose();
    router.push(href);
  };

  if (!show) return null;
  const title = r?.title || "Document";
  const href = readerHref({ item: show.item, passages: show.passages, q: show.excerpt || show.q, page: show.page, from: show.from });
  const readable = !!r?.readable;

  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal.Container placement="auto" scroll="inside">
        <Modal.Dialog className="modal__dialog--preview" aria-label={title}>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <span className="modal__icon">
              <FileIcon type={r?.ext} mime={r?.mime} />
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
                      <span translate="no">{r.base.displayName}</span>
                    </>
                  ) : null}
                  {r?.updated ? (
                    <>
                      <ResDot />
                      <span>{`Updated ${relLow(r.updated)}`}</span>
                    </>
                  ) : null}
                  {r ? <MetaTrust resource={r} /> : null}
                </span>
              </p>
            </div>
            {/* Renaming is the one edit that belongs here: the title is what this dialog is about,
                and a machine-made file name is unreadable until someone fixes it. */}
            {r?.editable ? (
              <IconButton icon={Pencil} tip="Rename" size="sm" className="pv-rename" onPress={() => openEditDetails(r.name)} />
            ) : null}
          </Modal.Header>
          <div className="modal__head">
            <ReadingBar
              show={show}
              citations={citations}
              index={index}
              onStep={(d) => {
                setIndex((i) => Math.max(0, Math.min(citations.length - 1, i + d)));
                setFocus({ hit: -1, total: 0 });
              }}
              focus={focus}
              onHit={(d) => setHitNudge((n) => n + d)}
            />
          </div>
          <Modal.Body>
            <PreviewDocument key={`${show.item}:${index}:${hitNudge}`} show={show} onFocus={setFocus} />
          </Modal.Body>
          <Modal.Footer>
            {readable ? (
              <div className="modal__footer-start">
                <Button variant="ghost" className="pv-ask" aria-label="Ask about this document" onPress={() => open(`/doc/${itemId}?ask=1`)}>
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
