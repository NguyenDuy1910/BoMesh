"use client";

import { ArrowRight } from "lucide-react";
import NextLink from "next/link";

import { FileIcon } from "@/components/ui/FileIcon";
import { rel } from "@/lib/format";

import type { RecentItem } from "../api";
import { useItem, useKnowledgeModel, useRecentItems } from "../queries";

function ContinueItem({ recent }: { recent: RecentItem }) {
  const item = useItem(recent.item);
  const { toResource } = useKnowledgeModel();
  if (!item.data || item.data.state === "DELETED" || item.data.itemType !== "DOCUMENT") return null;
  const r = toResource(item.data);
  return (
    <NextLink className="cat-continue__item" href={`/doc/${r.id}`}>
      <FileIcon type={r.ext} mime={r.mime} size="sm" />
      <span className="cat-continue__body">
        <span className="cat-continue__title truncate" translate="no">
          {r.title}
        </span>
        <span className="cat-continue__sub truncate">Opened {rel(recent.viewTime).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}</span>
      </span>
      <ArrowRight className="i i-sm" aria-hidden />
    </NextLink>
  );
}

/** Landing only: up to three documents opened recently (preview `continueReading`). Absent without history. */
export function ContinueReading() {
  const recent = useRecentItems(3);
  const list = (recent.data ?? []).slice(0, 3);
  if (!list.length) return null;
  return (
    <section className="cat-continue" aria-labelledby="cat-continue-h">
      <h2 className="cat-head__title" id="cat-continue-h">
        Continue reading
      </h2>
      <div className="cat-continue__list">
        {list.map((x) => (
          <ContinueItem key={x.name ?? x.item} recent={x} />
        ))}
      </div>
    </section>
  );
}
