"use client";

import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { StatusChip } from "@/components/ui/StatusChip";

import { clip, FORMAT_TONE, focusSection, indexStatusOf, type Glance, type Resource } from "../model";
import { useGlance, useKnowledgeModel } from "../queries";
import { HighlightText } from "./HighlightText";
import { ResourceActions } from "./ResourceActions";
import { ResDot, stop } from "./ResourceRow";
import { TrustMark } from "./TrustChip";

export interface ResourceCardProps {
  resource: Resource;
  /** Search query: previews the matching section and highlights it. */
  q?: string;
  /** Matching text from search (passage or snippet), previewed when the rendition isn't loaded. */
  passage?: { text: string; where?: string } | null;
  /** Context every card in the set shares, so it isn't repeated ("kb", "topic"). */
  hide?: readonly ("kb" | "topic")[];
  /** What selecting the card does (e.g. open a quick preview); default opens the Reader. */
  onOpen?: (resource: Resource) => void;
  /** Load the document's content for the preview (default true; off for very large sets). */
  loadPreview?: boolean;
}

/**
 * Document card (preview `X.res.card`; DESIGN_SYSTEM "Document card and preview"): a content preview,
 * the title, one line on what it's for, type · topic (or base), trust only when it matters.
 * Save and ⋯ appear on hover/focus (always on touch). Double-click opens the Reader.
 */
export function ResourceCard({ resource: r, q = "", passage, hide = [], onOpen, loadPreview = true }: ResourceCardProps) {
  const router = useRouter();
  const { ctx } = useKnowledgeModel();
  const glance = useGlance(r, { enabled: loadPreview });
  const reader = `/doc/${r.id}${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  const open = () => (onOpen ? onOpen(r) : router.push(reader));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
  const topic = r.topics[0];
  const where = !hide.includes("topic") && topic ? (ctx.topicNames?.get(topic) ?? "") : !hide.includes("kb") ? (r.base?.displayName ?? "") : "";
  const about = r.summary || glance?.opening || "";
  const status = indexStatusOf(r);
  const KindIcon = r.kindMeta.icon;
  return (
    <article className="doc-card" role="button" tabIndex={0} aria-label={r.title} onClick={open} onDoubleClick={() => router.push(reader)} onKeyDown={onKeyDown}>
      <div className="doc-card__media">
        <CardPreview resource={r} glance={glance} q={q} passage={passage} />
        {glance || passage ? (
          <>
            <span className="doc-card__type">
              <FileIcon type={r.ext} mime={r.mime} size="sm" />
            </span>
            {glance ? <span className="doc-card__extent">{glance.extent}</span> : null}
          </>
        ) : null}
        <div className="doc-card__actions" onClick={stop} onKeyDown={stop} onDoubleClick={stop}>
          <ResourceActions resource={r} q={q} />
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
              {r.kindMeta.label}
              {where ? (
                <>
                  <ResDot />
                  <span translate="no">{where}</span>
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
 * Card preview: sheets and slides show their first page; text documents their most useful section at a
 * readable size (the matching one when searching); a search passage when content isn't available yet;
 * else a tinted type tile. Decorative: the card's text says the same for assistive tech.
 */
function CardPreview({ resource: r, glance: g, q, passage }: { resource: Resource; glance: Glance | null; q: string; passage?: { text: string; where?: string } | null }) {
  if (g && g.layout !== "text" && g.pageImage) {
    return (
      <div className={g.layout === "slides" ? "doc-thumb doc-thumb--slide" : "doc-thumb"} aria-hidden inert>
        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived page image */}
        <img src={g.pageImage} alt="" className="h-full w-full object-cover object-top" />
      </div>
    );
  }
  const focus = g?.sections.length ? focusSection(g, r.kind, q, r.title) : null;
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
  const tone = FORMAT_TONE[r.format] ?? "default";
  const KindIcon = r.kindMeta.icon;
  return (
    <div className={`doc-thumb doc-thumb--blank doc-thumb--${tone}`} aria-hidden>
      <FileIcon type={r.ext} mime={r.mime} size="lg" />
      <span className="doc-thumb__title" translate="no">
        {r.title}
      </span>
      <span className="doc-thumb__kind">
        <KindIcon className="i i-xs" aria-hidden />
        {r.kindMeta.label}
      </span>
    </div>
  );
}
