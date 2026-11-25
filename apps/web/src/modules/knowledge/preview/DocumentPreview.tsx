"use client";

import { Button, Modal } from "@heroui/react";
import { ArrowUpRight, ChevronDown, ChevronUp, Lock, Quote, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { ApiError, resourceId } from "@/lib/api/client";
import { relInline } from "@/lib/format";

import { RequestAccessCta } from "../bases/components/RequestAccessDialog";
import { ResDot } from "../components/ResourceRow";
import { TrustChip, useTrust } from "../components/TrustChip";
import { ContentView } from "../content/ContentView";
import { locationLabel } from "../content/reference";
import { ViewToggle, type ViewMode } from "../content/ViewToggle";
import type { Resource } from "../model";
import { useDocumentOperations } from "../operations";
import { readerHref, revisionNumber } from "../reader/links";
import { DocumentSurface, type SurfaceHighlight, type SurfaceMarks } from "../reader/components/DocumentSurface";
import { useItem, useKnowledgeModel } from "../queries";
import type { PreviewCitation, PreviewRequest } from "./store";

/** What the preview shows right now: one citation of a list, or the single document it was opened with. */
interface Showing {
  item: string;
  /** The citation in focus; `null` for a plain open (a card, a search result without a reference). */
  citation: PreviewCitation | null;
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
    return { item: c.item, citation: c, page: c.pageNumber, q: "", from: request.from, collection: c.collection };
  }
  if (!request.item) return null;
  return { item: request.item, citation: null, page: request.page, q: request.q ?? "", from: request.from, collection: request.collection };
}

/* ═══════════════ The Original: the document's own pages ═══════════════ */

function PreviewOriginal({ show, resource: r, hit, onTotal }: { show: Showing; resource: Resource; hit: number; onTotal: (total: number) => void }) {
  const ops = useDocumentOperations();
  // A citation's quote is matched as one phrase; a search is tokenised the way the Reader does. Both need a processed document.
  const quote = show.citation?.quote ?? "";
  const highlight = useMemo<SurfaceHighlight | undefined>(
    () => (r.readable ? { q: quote || show.q, cited: !!quote } : undefined),
    [r.readable, quote, show.q],
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
  mode,
  onMode,
}: {
  show: Showing;
  citations: readonly PreviewCitation[];
  index: number;
  onStep: (delta: number) => void;
  hit: number;
  total: number;
  onHit: (delta: number) => void;
  mode: ViewMode | null;
  onMode: (mode: ViewMode) => void;
}) {
  const toggle = mode ? (
    <span className="pv-bar__mode">
      <ViewToggle value={mode} onChange={onMode} />
    </span>
  ) : null;
  if (show.citation) {
    const where = locationLabel(show.citation);
    return (
      <div className="pv-bar">
        <span className="pv-bar__label">
          <Quote className="i i-sm" aria-hidden />
          <span>Đoạn được trích dẫn</span>
          {where ? (
            <span className="pv-bar__where truncate" translate="no">
              <span aria-hidden>· </span>
              {where}
            </span>
          ) : null}
        </span>
        <span className="grow" />
        {citations.length > 1 ? (
          <>
            <span className="pv-bar__count num">{`Đoạn trích ${index + 1}/${citations.length}`}</span>
            <IconButton icon={ChevronUp} tip="Đoạn trích trước" size="sm" isDisabled={index === 0} onPress={() => onStep(-1)} />
            <IconButton icon={ChevronDown} tip="Đoạn trích sau" size="sm" isDisabled={index >= citations.length - 1} onPress={() => onStep(1)} />
          </>
        ) : null}
        {toggle}
      </div>
    );
  }
  if (!show.q || mode === "content") {
    return toggle ? (
      <div className="pv-bar">
        <span className="grow" />
        {toggle}
      </div>
    ) : null;
  }
  const at = total ? ((hit % total) + total) % total : 0;
  return (
    <div className="pv-bar">
      <span className="pv-bar__label">
        <Search className="i i-sm" aria-hidden />
        <span className="truncate">{`Kết quả khớp với “${show.q}”`}</span>
      </span>
      <span className="grow" />
      <span className="pv-bar__count num" aria-live="polite">
        {total ? `${at + 1}/${total}` : "Không có kết quả khớp trên các trang này"}
      </span>
      <IconButton icon={ChevronUp} tip="Kết quả trước" size="sm" isDisabled={total < 2} onPress={() => onHit(-1)} />
      <IconButton icon={ChevronDown} tip="Kết quả tiếp theo" size="sm" isDisabled={total < 2} onPress={() => onHit(1)} />
      {toggle}
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
        <Modal.Dialog aria-label="Không có tài liệu">
          <Modal.CloseTrigger aria-label="Đóng" />
          <Modal.Header>
            <span className="modal__icon">
              <Lock className="i" aria-hidden />
            </span>
            <Modal.Heading>Không có tài liệu</Modal.Heading>
            <p className="modal__description">Tài liệu đã bị gỡ hoặc chưa được chia sẻ với bạn.</p>
          </Modal.Header>
          {show.citation?.quote ? (
            <Modal.Body>
              <figure className="cv-quote">
                <blockquote translate="no">{show.citation.quote}</blockquote>
                {locationLabel(show.citation) ? <figcaption translate="no">{locationLabel(show.citation)}</figcaption> : null}
              </figure>
              {locked ? (
                <p className="pv-quote__note">{`Hãy xin quyền từ chủ sở hữu ${locked.displayName ?? ""} để đọc toàn bộ tài liệu.`}</p>
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
              Đóng
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/**
 * The shared document preview (preview `M['doc-preview']`). A citation opens in Content View: the document's
 * extracted blocks around the cited ones, highlighted by ref; the reading bar steps through the citations and
 * toggles the Original, which is read (GetItemPreview, pdf.js) only once chosen. A plain open shows the Original,
 * matching words highlighted. Exactly two actions — Ask about this document (secondary) and Open full document
 * (primary). No Save, ⋯, editing or sharing: the row it was opened from already offers those, and the rest lives
 * in the Reader.
 */
export function DocumentPreview({ request, onClose }: { request: PreviewRequest; onClose: () => void }) {
  const router = useRouter();
  const citations = request.citations ?? [];
  const start = Math.max(0, request.n ? citations.findIndex((c) => c.n === request.n) : 0);
  const [index, setIndex] = useState(start);
  const [hit, setHit] = useState(0);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<ViewMode>(citations.length ? "content" : "original");

  const show = showing(request, index);
  const itemId = resourceId(show?.item ?? "");
  // Opened from a list: draw from the listed item at once (title, cover as page 1) while GetItem loads.
  const listed = !citations.length && request.listed && resourceId(request.listed.name) === itemId ? request.listed : undefined;
  const item = useItem(itemId || null, { placeholder: listed });
  const { toResource } = useKnowledgeModel();
  const r = item.data ? toResource(item.data) : null;
  const c = show?.citation ?? null;
  // The other citations of this document's same content version are highlighted too.
  const cited = useMemo(
    () => (c ? citations.filter((x) => x !== c && x.item === c.item && x.structureVersion === c.structureVersion).flatMap((x) => x.refs) : []),
    [citations, c],
  );

  if (!show) return null;
  if (item.error instanceof ApiError && (item.error.isNotFound || item.error.status === 403)) return <LockedPreview show={show} onClose={onClose} />;

  const open = (href: string) => {
    onClose();
    router.push(href);
  };
  const title = r?.title || "Tài liệu";
  // The toggle: always for a citation; for a plain open only once the document is processed (it has content).
  const toggle = c || r?.readable ? mode : null;
  const content = mode === "content" && (c || r?.readable);
  const href = readerHref({ item: show.item, reference: c, q: show.q, page: c ? undefined : show.page, from: show.from, view: toggle ?? undefined });

  let body: ReactNode;
  if (content) {
    body = (
      <ContentView
        key={c ? `${c.item}:${c.structureVersion}:${c.refs.join(",")}` : show.item}
        item={show.item}
        revision={c ? revisionNumber(c.revision) : undefined}
        version={c?.structureVersion}
        refs={c?.refs}
        cited={cited}
        quote={c ?? undefined}
        onOriginal={() => setMode("original")}
        variant="preview"
      />
    );
  } else if (r) {
    body = <PreviewOriginal key={`${show.item}:${index}`} show={show} resource={r} hit={hit} onTotal={setTotal} />;
  } else {
    body = (
      <div className="pv-doc" aria-busy="true" aria-label="Đang tải">
        <span className="skeleton block" style={{ height: 420, borderRadius: "var(--radius-lg)" }} />
      </div>
    );
  }
  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()} isDismissable>
      <Modal.Container placement="auto" scroll="inside">
        <Modal.Dialog className="modal__dialog--preview" aria-label={title}>
          <Modal.CloseTrigger aria-label="Đóng" />
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
                  <span>{r?.typeMeta.label ?? "Tài liệu"}</span>
                  {r?.base && !r.isPersonal ? (
                    <>
                      <ResDot />
                      <span translate={r.base.personal ? undefined : "no"}>{r.base.displayName}</span>
                    </>
                  ) : null}
                  {r?.updated ? (
                    <>
                      <ResDot />
                      <span>{`Đã cập nhật ${relInline(r.updated)}`}</span>
                    </>
                  ) : null}
                  {r ? <MetaTrust resource={r} /> : null}
                </span>
              </p>
            </div>
          </Modal.Header>
          <div className="modal__head">
            {c || r?.readable ? (
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
                mode={toggle}
                onMode={(m) => {
                  setMode(m);
                  setHit(0);
                }}
              />
            ) : null}
          </div>
          <Modal.Body>{body}</Modal.Body>
          <Modal.Footer>
            {r?.readable ? (
              <div className="modal__footer-start">
                <Button variant="ghost" className="pv-ask" aria-label="Hỏi về tài liệu này" onPress={() => open(readerHref({ item: show.item, from: show.from, ask: true }))}>
                  <Sparkles className="i" aria-hidden />
                  <span>Hỏi về tài liệu này</span>
                </Button>
              </div>
            ) : null}
            <Button variant="primary" onPress={() => open(href)}>
              <ArrowUpRight className="i" aria-hidden />
              Mở toàn bộ tài liệu
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
