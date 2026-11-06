"use client";

import { Button, Drawer } from "@heroui/react";
import { ArrowRight, File, ListPlus, Lock, Quote, Sparkles } from "lucide-react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { FileIcon } from "@/components/ui/FileIcon";
import { plural } from "@/lib/format";

import type { ItemContent } from "../api";
import { clip, focusSection, type Resource } from "../model";
import { useGlance, useItemContent } from "../queries";
import { openAddToCollection } from "../components/dialogs";
import { HighlightText } from "../components/HighlightText";
import { ResourceDetails } from "../components/ResourceDetails";
import { ResourceMenu, SaveButton } from "../components/ResourceActions";
import { ResDot, updatedLabel } from "../components/ResourceRow";
import { SourceIcon } from "../components/SourceIcon";
import { TrustChip, useTrust } from "../components/TrustChip";

export interface PeekTarget {
  resource: Resource;
  /** Search passage for this result (shown when the rendition hasn't loaded). */
  passage?: { text: string; where?: string } | null;
}

export const readerHref = (r: Resource, q: string) => `/doc/${r.id}${q ? `?q=${encodeURIComponent(q)}` : ""}`;

/** The first two pages: page images when the document has them, else its text laid out as pages. */
function FirstPages({ content }: { content: ItemContent }) {
  const images = [...(content.pageAssets ?? [])].filter((a) => a.imageUri).sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));
  if (images.length) {
    return (
      <>
        {images.slice(0, 2).map((a) => (
          <div key={a.pageNumber} className="doc-page" style={{ padding: 0, overflow: "hidden" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived page image */}
            <img src={a.imageUri} alt="" width={a.widthPixels} height={a.heightPixels} className="block h-auto w-full" />
          </div>
        ))}
      </>
    );
  }
  const pages = new Map<number, NonNullable<ItemContent["elements"]>>();
  for (const el of content.elements ?? []) {
    const n = el.pageNumber ?? 1;
    if (n > 2 && pages.size >= 2) break;
    if (!pages.has(n)) {
      if (pages.size >= 2) break;
      pages.set(n, []);
    }
    pages.get(n)!.push(el);
  }
  return (
    <>
      {[...pages].map(([n, els]) => (
        <div key={n} className="doc-page" translate="no">
          {els.map((el, i): ReactNode => {
            const text = (el.text ?? "").trim();
            if (!text) return null;
            switch (el.kind) {
              case "HEADING":
                return (el.level ?? 1) <= 1 ? <h2 key={i}>{text}</h2> : <h3 key={i}>{text}</h3>;
              case "LIST":
                return (
                  <ul key={i}>
                    {text
                      .split(/\n+/)
                      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
                      .filter(Boolean)
                      .map((l, j) => (
                        <li key={j}>{l}</li>
                      ))}
                  </ul>
                );
              case "TABLE": {
                const rows = text
                  .split(/\n+/)
                  .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
                  .map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/\s*\|\s*|\t/));
                return (
                  <table key={i}>
                    <tbody>
                      {rows.map((cells, j) => (
                        <tr key={j}>
                          {cells.map((c, k) => (j === 0 ? <th key={k}>{c}</th> : <td key={k}>{c}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              }
              case "IMAGE":
                return null;
              default:
                return <p key={i}>{text}</p>;
            }
          })}
        </div>
      ))}
    </>
  );
}

function PeekBody({ resource: r, q, passage }: { resource: Resource; q: string; passage?: PeekTarget["passage"] }) {
  const content = useItemContent(r.name, { enabled: r.readable });
  const glance = useGlance(r);
  const trust = useTrust(r);
  const about = r.summary || glance?.opening || "";
  const focus = q && glance ? focusSection(glance, r.kind, q, r.title) : null;
  const hit = focus?.hit
    ? { where: [glance!.layout !== "sheet" && `Page ${focus.hit.page}`, focus.hit.heading].filter(Boolean).join(" · "), text: clip(focus.hit.text, 220) }
    : q && passage?.text
      ? { where: passage.where ?? "", text: clip(passage.text, 220) }
      : null;
  const href = readerHref(r, q);
  const hasPages = !!content.data && (!!content.data.pageAssets?.some((a) => a.imageUri) || !!content.data.elements?.length);
  const count = glance?.count ?? 0;
  const sections = (glance?.sections ?? []).filter((s) => s.title);
  return (
    <div className="cat-peek">
      {about ? (
        <p className="cat-peek__about" translate="no">
          <HighlightText text={about} q={q} />
        </p>
      ) : null}
      {hit ? (
        <div className="cat-peek__hit">
          <Quote className="i i-sm" aria-hidden />
          <span translate="no">
            {hit.where ? <span className="cat-peek__loc">{hit.where}</span> : null}
            <HighlightText text={hit.text} q={q} />
          </span>
        </div>
      ) : null}
      {trust.state === "verified" || trust.state === "review" ? (
        <p className="cat-peek__trust">
          <TrustChip resource={r} />
          <span>{trust.note}</span>
        </p>
      ) : null}
      {hasPages ? (
        <NextLink className="cat-peek__pages" href={href} aria-label={`Open ${r.title}`}>
          <div className="cat-peek__scale">
            <FirstPages content={content.data!} />
          </div>
          <span className="cat-peek__more">
            {count > 2 ? `${plural(count - 2, "more page")} in the reader` : "Open in the reader"}
            <ArrowRight className="i i-xs" aria-hidden />
          </span>
        </NextLink>
      ) : r.readable && content.isPending ? (
        <div className="cat-peek__pages" aria-hidden>
          <span className="skeleton block" style={{ height: 360, borderRadius: "var(--radius-lg)" }} />
        </div>
      ) : (
        <div className="cat-peek__none">
          <File className="i i-lg" aria-hidden />
          <p>There’s no preview for this file. Open or download it to read it.</p>
        </div>
      )}
      {sections.length > 1 ? (
        <section className="cat-peek__sec">
          <h3 className="cat-peek__label">Inside</h3>
          <ol className="cat-peek__toc" translate="no">
            {sections.slice(0, 10).map((s, i) => (
              <li key={i}>
                <HighlightText text={s.title} q={q} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <details className="cat-peek__details">
        <summary>Details</summary>
        <ResourceDetails resource={r} />
      </details>
    </div>
  );
}

export interface QuickPreviewProps {
  target: PeekTarget | null;
  q: string;
  onClose: () => void;
}

/**
 * Quick preview (preview `DR['cat-peek']`): what the document is for, the matching passage, trust, the real
 * first pages (click to open the Reader), its sections and details. Footer: Ask · Add to collection · Open.
 */
export function QuickPreview({ target, q, onClose }: QuickPreviewProps) {
  const router = useRouter();
  const r = target?.resource;
  const open = (href: string) => {
    onClose();
    router.push(href);
  };
  const KindIcon = r?.kindMeta.icon ?? File;
  return (
    <Drawer.Backdrop isOpen={!!target} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="drawer__dialog--lg" aria-label={r?.title ?? "Document"}>
          <Drawer.CloseTrigger aria-label="Close" />
          {r && !r.deleted ? (
            <>
              <Drawer.Header className="cat-peek-head">
                <FileIcon type={r.ext} mime={r.mime} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <Drawer.Heading translate="no">{r.title}</Drawer.Heading>
                  <p className="drawer__description">
                    <span className="row gap-6 wrap">
                      <KindIcon className="i i-xs" aria-hidden />
                      {r.kindMeta.label}
                      <ResDot />
                      <span className="res-prov">
                        <SourceIcon source={r.source.isUpload ? undefined : r.source.key} />
                        <span className="truncate" translate="no">
                          {r.base?.displayName ?? ""}
                        </span>
                      </span>
                      <ResDot />
                      <span>{updatedLabel(r.updated)}</span>
                    </span>
                  </p>
                </div>
                <div className="drawer__header-actions">
                  <SaveButton resource={r} />
                  <ResourceMenu resource={r} q={q} />
                </div>
              </Drawer.Header>
              <Drawer.Body>
                <PeekBody key={r.id} resource={r} q={q} passage={target?.passage} />
              </Drawer.Body>
              <Drawer.Footer>
                {r.readable ? (
                  <div className="drawer__footer-start row gap-8">
                    <Button variant="ghost" onPress={() => open(`/chat?${new URLSearchParams(q ? { q, send: "1", doc: r.id } : { doc: r.id })}`)}>
                      <Sparkles className="i" aria-hidden />
                      Ask about this document
                    </Button>
                  </div>
                ) : null}
                <Button variant="secondary" onPress={() => openAddToCollection(r.name)}>
                  <ListPlus className="i" aria-hidden />
                  Add to collection
                </Button>
                <Button variant="primary" onPress={() => open(readerHref(r, q))}>
                  <ArrowRight className="i" aria-hidden />
                  Open
                </Button>
              </Drawer.Footer>
            </>
          ) : (
            <>
              <Drawer.Header>
                <Drawer.Heading>Document unavailable</Drawer.Heading>
              </Drawer.Header>
              <Drawer.Body>
                <EmptyState icon={Lock} title="You can’t open this document" description="It was removed or isn’t shared with you." compact />
              </Drawer.Body>
            </>
          )}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
