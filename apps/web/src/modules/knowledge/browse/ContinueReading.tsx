"use client";

import { ArrowRight } from "lucide-react";
import NextLink from "next/link";

import { FileIcon } from "@/components/ui/FileIcon";
import { rel } from "@/lib/format";

import { useItemsByName, useKnowledgeModel, useRecentItems } from "../queries";

/**
 * Landing only: up to three documents opened recently (preview `continueReading`). Absent without
 * history. One batch read for the three (FULL, so opening one reuses it in the Reader).
 */
export function ContinueReading() {
  const recent = useRecentItems(3);
  const list = (recent.data ?? []).slice(0, 3);
  const items = useItemsByName(list.map((r) => r.item));
  const { toResource } = useKnowledgeModel();
  const rows = list.flatMap((x) => {
    const item = x.item ? items.items.get(x.item) : undefined;
    return item && item.state !== "DELETED" && item.itemType === "DOCUMENT" ? [{ recent: x, r: toResource(item) }] : [];
  });
  if (!rows.length) return null;
  return (
    <section className="cat-continue" aria-labelledby="cat-continue-h">
      <h2 className="cat-head__title" id="cat-continue-h">
        Continue reading
      </h2>
      <div className="cat-continue__list">
        {rows.map(({ recent: x, r }) => (
          <NextLink key={x.name ?? x.item} className="cat-continue__item" href={`/doc/${r.id}`}>
            <FileIcon type={r.ext} mime={r.mime} size="sm" />
            <span className="cat-continue__body">
              <span className="cat-continue__title truncate" translate="no">
                {r.title}
              </span>
              <span className="cat-continue__sub truncate">Opened {rel(x.viewTime).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}</span>
            </span>
            <ArrowRight className="i i-sm" aria-hidden />
          </NextLink>
        ))}
      </div>
    </section>
  );
}
