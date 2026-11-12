"use client";

import { useState } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { StatusChip } from "@/components/ui/StatusChip";
import { plural } from "@/lib/format";

import { clip, FORMAT_TONE, focusSection, indexStatusOf, type Glance, type Resource } from "../model";
import { openDocumentPreview } from "../preview/store";
import { useGlance, useKnowledgeModel } from "../queries";
import { HighlightText } from "./HighlightText";
import { ResourceMenu, SaveButton } from "./ResourceActions";
import { onActivateKey, ResDot, stop } from "./ResourceRow";
import { TrustMark } from "./TrustChip";

export interface ResourceCardProps {
  resource: Resource;
  /** Search query: previews the matching section and highlights it. */
  q?: string;
  /** Matching text from search (passage or snippet), previewed when the rendition isn't loaded. */
  passage?: { text: string; where?: string } | null;
  /** Context every card in the set shares, so it isn't repeated ("kb", "topic"). */
  hide?: readonly ("kb" | "topic")[];
  /** What selecting the card does; default opens the shared document preview. */
  onOpen?: (resource: Resource) => void;
  /** Where the card lives (`originParam`), so the preview's Open full document leads back here. */
  from?: string;
  /** Type tile instead of a content preview (e.g. when previews in a set would look alike). */
  plain?: boolean;
  /** Read the document's content for the preview (default true; off for very large sets). */
  loadPreview?: boolean;
}

/** Length as the file's own app would put it (preview `glance.extent`): pages, slides, a spreadsheet — or just the format for web-like files. */
function extentOf(g: Glance, ext: string): string {
  if (g.layout === "sheet") return "Spreadsheet";
  if (g.layout === "slides") return plural(g.count, "slide");
  if (ext === "md" || ext === "markdown") return "Markdown";
  if (ext === "html" || ext === "htm") return "Web page";
  if (ext === "txt") return "Plain text";
  return plural(g.count, "page");
}

/**
 * Document card (preview `X.res.card`; DESIGN_SYSTEM "Document card and preview"): recognise a document and
 * judge it without opening it — a content preview, the title, one line on what it's for, type · topic
 * (or collection), and trust only when it matters. Save and ⋯ appear on hover/focus (always on touch).
 * The whole card opens the preview, Enter/Space too.
 */
export function ResourceCard({ resource: r, q = "", passage, hide = [], onOpen, from, plain = false, loadPreview = true }: ResourceCardProps) {
  const { ctx } = useKnowledgeModel();
  // Text documents preview their most useful section, so their content is read; sheets and slides show
  // their first page, which comes with the item — their content is only read when searching.
  const textual = r.format !== "sheet" && r.format !== "slides" && r.format !== "image";
  const glance = useGlance(r, { enabled: loadPreview && !plain && (textual || !!q) });
  const open = () => (onOpen ? onOpen(r) : openDocumentPreview({ item: r.name, q: q || undefined, from }));
  const topic = r.topics[0];
  const byTopic = !hide.includes("topic") && !!topic;
  const where = byTopic ? (ctx.topicNames?.get(topic) ?? "") : !hide.includes("kb") ? (r.base?.displayName ?? "") : "";
  const about = r.summary || glance?.opening || "";
  const status = indexStatusOf(r);
  const KindIcon = r.kindMeta.icon;
  // An unreachable page image (storage host down, expired link) falls back like a missing one; remembered per URL so
  // re-renders don't retry it. Kept here so the corner format badge disappears with it (the type tile shows the format).
  const [broken, setBroken] = useState<string | null>(null);
  const thumb = r.thumbnailUri && r.thumbnailUri !== broken ? r.thumbnailUri : undefined;
  return (
    <article className="doc-card" role="button" tabIndex={0} aria-label={r.title} onClick={open} onKeyDown={onActivateKey(open)}>
      <div className="doc-card__media">
        <CardPreview resource={r} glance={plain ? null : glance} q={q} passage={plain ? null : passage} broken={broken} onBroken={setBroken} />
        {!plain && (glance || thumb || passage?.text) ? (
          <span className="doc-card__type">
            <FileIcon type={r.ext} mime={r.mime} size="sm" />
          </span>
        ) : null}
        {glance ? <span className="doc-card__extent">{extentOf(glance, r.ext)}</span> : null}
        <div className="doc-card__actions" onClick={stop} onKeyDown={stop}>
          <SaveButton resource={r} />
          <ResourceMenu resource={r} q={q} />
        </div>
      </div>
      <div className="doc-card__body">
        <h3 className="doc-card__title" title={r.fileName || r.title} translate="no">
          <HighlightText text={r.title} q={q} />
        </h3>
        {about ? (
          <p className="doc-card__about" translate="no">
            <HighlightText text={about} q={q} />
          </p>
        ) : null}
        <div className="doc-card__meta">
          <span className="doc-card__kind">
            <KindIcon className="i i-xs" aria-hidden />
            <span className="truncate">
              {r.typeLabel}
              {where ? (
                <>
                  <ResDot />
                  <span translate={!byTopic && r.base?.personal ? undefined : "no"}>{where}</span>
                </>
              ) : null}
            </span>
          </span>
          {status ? <StatusChip kind="doc" value={status} size="sm" /> : null}
          <TrustMark resource={r} />
        </div>
      </div>
    </article>
  );
}

/**
 * Card preview (preview `X.res.preview`). Text documents show their most useful section at a readable size
 * (the matching one when searching); sheets and slides show their first page. Without a readable rendition:
 * the search passage, else the first page image ingestion rendered, else a tinted type tile.
 * Decorative: the card's text says the same for assistive tech.
 */
function CardPreview({ resource: r, glance: g, q, passage, broken, onBroken }: { resource: Resource; glance: Glance | null; q: string; passage?: { text: string; where?: string } | null; broken: string | null; onBroken: (url: string) => void }) {
  const src = r.thumbnailUri ?? g?.pageImage;
  const cover = src && src !== broken ? src : undefined;
  const image = cover ? (
    <div className={r.format === "slides" ? "doc-thumb doc-thumb--slide" : "doc-thumb"} aria-hidden inert>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived page image */}
      <img src={cover} alt="" className="h-full w-full object-cover object-top" decoding="async" onError={() => onBroken(cover)} />
    </div>
  ) : null;
  // Sheets and slides are their first page. A text document shows its best section (a search passage while
  // its content loads); its first page only when it has neither.
  if (image && (g ? g.layout !== "text" : !(q && passage?.text))) return image;
  const focus = g?.layout === "text" && g.sections.length ? focusSection(g, r.kind, q, r.title) : null;
  if (focus) {
    const s = focus.section;
    const items = s.blocks.filter((b) => b.kind === "li" || b.kind === "row");
    const paras = s.blocks.filter((b) => b.kind === "p");
    const from = focus.hit ? Math.max(0, items.indexOf(focus.hit)) : 0;
    const shown = items.slice(from, from + 4);
    const asParagraph = items.length < 2 || (focus.hit && !items.includes(focus.hit));
    const lead = focus.hit ?? paras[0] ?? s.blocks[0];
    const heads = shown[0]?.cells ? shown[0].text.split(" · ").map((x) => x.slice(0, Math.max(0, x.indexOf(": ")))) : [];
    return (
      <div className="doc-thumb doc-thumb--focus" aria-hidden inert>
        <div className="doc-focus" translate="no">
          <div className="doc-focus__head">
            <span className="doc-focus__title">{s.title || r.kindMeta.label}</span>
            {g!.count > 1 ? <span className="doc-focus__page">p. {focus.hit?.page ?? s.page}</span> : null}
          </div>
          {asParagraph ? (
            <p>
              <HighlightText text={clip(lead.text, 240)} q={q} />
            </p>
          ) : shown.every((b) => b.kind === "row" && b.cells) ? (
            <table>
              <thead>
                <tr>
                  {heads.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((b, i) => (
                  <tr key={i}>
                    {b.cells!.map((c, j) => (
                      <td key={j}>
                        <HighlightText text={clip(c, 60)} q={q} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul>
              {shown.map((b, i) => (
                <li key={i}>
                  <HighlightText text={clip(b.text, 110)} q={q} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }
  if (passage?.text) {
    return (
      <div className="doc-thumb doc-thumb--focus" aria-hidden inert>
        <div className="doc-focus" translate="no">
          <div className="doc-focus__head">
            <span className="doc-focus__title">{r.kindMeta.label}</span>
            {passage.where ? <span className="doc-focus__page">{passage.where}</span> : null}
          </div>
          <p>
            <HighlightText text={clip(passage.text, 240)} q={q} />
          </p>
        </div>
      </div>
    );
  }
  if (image) return image;
  // The tile names the format and kind only: the card's title and summary sit right below it.
  const tone = FORMAT_TONE[r.format] ?? "default";
  const KindIcon = r.kindMeta.icon;
  return (
    <div className={`doc-thumb doc-thumb--blank doc-thumb--${tone}`} aria-hidden>
      <FileIcon type={r.ext} mime={r.mime} size="lg" />
      <span className="doc-thumb__kind">
        <KindIcon className="i i-xs" aria-hidden />
        {r.typeLabel}
      </span>
    </div>
  );
}
