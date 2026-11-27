"use client";

import clsx from "clsx";
import { useState, type ReactNode } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { StatusChip } from "@/components/ui/StatusChip";
import { fmtDate, rel } from "@/lib/format";

import type { DocumentCover } from "../api";
import { clip, conceptOrder, indexStatusOf, type Resource } from "../model";
import { openDocumentPreview } from "../preview/store";
import { useKnowledgeModel } from "../queries";
import { HighlightText } from "./HighlightText";
import { ResourceMenu, SaveButton } from "./ResourceActions";
import { onActivateKey, stop } from "./ResourceRow";
import { conceptLabel } from "../taxonomy";
import { ConceptTag } from "./ConceptTag";
import { TrustMark } from "./TrustChip";

export interface ResourceCardProps {
  resource: Resource;
  /** Search query: highlights the title, summary and matching text. */
  q?: string;
  /** Matching text from search (the hit's content reference quote and its location), previewed when the cover has no image. */
  match?: { text: string; where?: string } | null;
  /** Context every card in the set shares, so it isn't repeated ("kb", "concept": one concept of the first classification scheme). */
  hide?: readonly ("kb" | "concept")[];
  /** What selecting the card does; default opens the shared document preview. */
  onOpen?: (resource: Resource) => void;
  /** Where the card lives (`originParam`), so the preview's Open full document leads back here. */
  from?: string;
  /** A label over the cover (Home: why the document was picked). */
  badge?: ReactNode;
  className?: string;
}

/**
 * Document card (preview `X.res.card`; DESIGN_SYSTEM "Document card"): a compact tile to recognise a document
 * and judge it without opening it — the top of its first page, its file icon and title, one line on what it's for,
 * its concepts — the first as a colored tag (+n for the rest), then how fresh (where it lives when it is filed under nothing);
 * indexing and trust only when they matter. Everything comes with the list item: a card never reads the
 * document's content. Save and ⋯ appear on hover/focus (always on touch). The whole card opens the preview,
 * Enter/Space too.
 */
export function ResourceCard({ resource: r, q = "", match, hide = [], onOpen, from, badge, className }: ResourceCardProps) {
  const { taxonomy } = useKnowledgeModel();
  const open = () => (onOpen ? onOpen(r) : openDocumentPreview({ item: r.name, listed: r.item, q: q || undefined, from }));
  const concepts = hide.includes("concept") ? [] : conceptOrder(taxonomy, r.assignments);
  const where = !concepts.length && !hide.includes("kb") ? (r.base?.displayName ?? "") : "";
  const status = indexStatusOf(r);
  // An unreachable cover image (storage host down, expired link) falls back like a missing one; remembered per URL
  // so re-renders don't retry it.
  const [broken, setBroken] = useState<string | null>(null);
  const preview = cardPreview(r, q, match, broken, setBroken);
  return (
    <article className={clsx("doc-card", className)} role="button" tabIndex={0} aria-label={r.title} onClick={open} onKeyDown={onActivateKey(open)}>
      <div className="doc-card__media">
        {preview ?? <TypeTile resource={r} />}
        {badge}
        <div className="doc-card__actions" onClick={stop} onKeyDown={stop}>
          <SaveButton resource={r} />
          <ResourceMenu resource={r} q={q} />
        </div>
      </div>
      <div className="doc-card__body">
        <div className="doc-card__head">
          <FileIcon type={r.ext} mime={r.mime} size="sm" />
          <h3 className="doc-card__title" title={r.fileName || r.title} translate="no">
            <HighlightText text={r.title} q={q} />
          </h3>
        </div>
        {r.summary ? (
          <p className="doc-card__about" title={r.summary} translate="no">
            <HighlightText text={r.summary} q={q} />
          </p>
        ) : null}
        {concepts.length ? (
          // The first concept as a plain tag (the whole card is the control); the rest as +n (a narrow card can't show two tags
          // without cutting both).
          <div className="doc-card__tags">
            <ConceptTag taxonomy={taxonomy} concept={concepts[0]} />
            {concepts.length > 1 ? (
              <span className="doc-card__more" title={concepts.slice(1).map((c) => conceptLabel(taxonomy, c)).join(", ")} translate="no">{`+${concepts.length - 1}`}</span>
            ) : null}
          </div>
        ) : null}
        <div className="doc-card__meta">
          {where ? (
            <span className="doc-card__where truncate" translate={r.base?.personal ? undefined : "no"}>
              {where}
            </span>
          ) : null}
          {r.updated ? (
            <time className="doc-card__when" dateTime={r.updated} title={`Đã cập nhật ${fmtDate(r.updated)}`}>
              {rel(r.updated)}
            </time>
          ) : null}
          {status ? <StatusChip kind="doc" value={status} size="sm" /> : null}
          <TrustMark resource={r} />
        </div>
      </div>
    </article>
  );
}

/** The card's cover alone (cover image or text in its format's shape, else the typed tile), for small tiles such as Home's Jump back in. */
export function DocThumb({ resource: r }: { resource: Resource }) {
  const [broken, setBroken] = useState<string | null>(null);
  return cardPreview(r, "", null, broken, setBroken) ?? <TypeTile resource={r} />;
}

/**
 * Card preview (preview `X.res.preview`): the cover image; else, when searching, the matching text the search
 * returned; else the cover's text in its format's shape. `null` → the typed tile. Decorative: the card's
 * text says the same for assistive tech.
 */
function cardPreview(r: Resource, q: string, match: ResourceCardProps["match"], broken: string | null, onBroken: (url: string) => void): ReactNode {
  const c = r.cover;
  const image = c?.imageUri && c.imageUri !== broken ? c.imageUri : undefined;
  if (c && image) return coverView(c, image, onBroken);
  if (q && match?.text) {
    return (
      <div className="doc-thumb doc-thumb--focus" aria-hidden inert>
        <div className="doc-focus" translate="no">
          <div className="doc-focus__head">
            <span className="doc-focus__title">{r.typeMeta.label}</span>
            {match.where ? <span className="doc-focus__page">{match.where}</span> : null}
          </div>
          <p>
            <HighlightText text={clip(match.text, 240)} q={q} />
          </p>
        </div>
      </div>
    );
  }
  return c ? coverView(c, undefined, onBroken) : null;
}

/**
 * One cover in its format's shape, inside the card's fixed 16:9 frame (nothing shifts while images load).
 * PAGE / TEXT: a portrait paper, top-aligned, fading at the bottom; SLIDE: a 16:9 slide; SHEET: a mini grid
 * with column letters and row numbers; IMAGE: the picture, cropped to fill. `null` when there is nothing to draw.
 */
function coverView(c: DocumentCover, image: string | undefined, onBroken: (url: string) => void): ReactNode {
  const img = image ? (
    // eslint-disable-next-line @next/next/no-img-element -- signed storage URL, stable within its window; the optimizer would re-sign it
    <img className="doc-cover__img" src={image} alt="" width={c.widthPixels} height={c.heightPixels} loading="lazy" decoding="async" draggable={false} onError={() => onBroken(image)} />
  ) : null;
  const title = c.title ? <p className="doc-cover__title">{c.title}</p> : null;
  const lines = c.lines ?? [];
  switch (c.kind) {
    case "IMAGE":
      return img ? (
        <div className="doc-thumb doc-thumb--image" aria-hidden inert>
          {img}
        </div>
      ) : null;
    case "SLIDE":
      if (!img && !title && !lines.length) return null;
      return (
        <div className="doc-thumb doc-thumb--slide" aria-hidden inert>
          <div className="doc-cover__slide" translate="no">
            {img ?? (
              <div className="doc-cover__text">
                {title}
                {lines.length ? (
                  <ul>
                    {lines.slice(0, 4).map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>
        </div>
      );
    case "SHEET": {
      if (img) {
        return (
          <div className="doc-thumb doc-thumb--sheet" aria-hidden inert>
            {img}
          </div>
        );
      }
      const cells = c.cells ?? [];
      if (cells.length) {
        const cols = Math.max(...cells.map((row) => row.length));
        return (
          <div className="doc-thumb doc-thumb--sheet" aria-hidden inert>
            <table className="doc-cover__grid" translate="no">
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: cols }, (_, j) => (
                    <th key={j}>{String.fromCharCode(65 + j)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cells.map((row, i) => (
                  <tr key={i}>
                    <th>{i + 1}</th>
                    {Array.from({ length: cols }, (_, j) => (
                      <td key={j}>{row[j] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      break;
    }
  }
  if (!img && !title && !lines.length) return null;
  return (
    <div className={c.kind === "TEXT" ? "doc-thumb doc-thumb--page doc-thumb--text" : "doc-thumb doc-thumb--page"} aria-hidden inert>
      <div className="doc-cover__paper" translate="no">
        {img ?? (
          <div className="doc-cover__text">
            {title}
            {lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** No cover (not made yet, or nothing to show): the format's tile, centred on its tone — the card's head names the type and title. */
function TypeTile({ resource: r }: { resource: Resource }) {
  const tone = r.typeMeta.tone ?? "default";
  return (
    <div className={`doc-thumb doc-thumb--blank doc-thumb--${tone}`} aria-hidden>
      <FileIcon type={r.ext} mime={r.mime} size="lg" />
    </div>
  );
}
