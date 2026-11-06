"use client";

import { Button } from "@heroui/react";
import clsx from "clsx";
import { ArrowUpRight, ChevronLeft, ChevronRight, Copy, Lock, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef } from "react";

import { Callout } from "@/components/ui/Callout";
import { FileIcon } from "@/components/ui/FileIcon";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListItem } from "@/components/ui/List";
import { StatusChip } from "@/components/ui/StatusChip";
import { ApiError } from "@/lib/api/client";
import { useItem, useKnowledgeModel } from "@/modules/knowledge/queries";
import { readerHref } from "@/modules/knowledge/reader/links";

import { copyText } from "../download";
import type { AnswerSource } from "../turn";

/** A cited document that can't be read right now (preview `status('doc', d.status)`). */
function docStatus(state: string | null | undefined): "pending" | "processing" | "failed" | "unsupported" {
  if (state === "RUNNING") return "processing";
  if (state === "FAILED") return "failed";
  if (state === "UNSUPPORTED") return "unsupported";
  return "pending";
}

export interface CitationPanelProps {
  /** Conversation ID (the Reader links back to it); none for a shared conversation. */
  conversation?: string;
  /** The answer's sources the reader can open. */
  sources: readonly AnswerSource[];
  /** The source shown. */
  n: number;
  onShow: (n: number) => void;
  onClose: () => void;
}

/**
 * Source side panel (preview `citePanel`): the cited passages of one document,
 * previous/next across the answer's sources, Open document at the passage,
 * Copy citation. Overlays the thread below 1024 px (layout.css `.split__panel`).
 */
export function CitationPanel({ conversation, sources, n, onShow, onClose }: CitationPanelProps) {
  const router = useRouter();
  const index = Math.max(0, sources.findIndex((s) => s.n === n));
  const source = sources[index]!;
  const item = useItem(source.item);
  const { toResource } = useKnowledgeModel();
  const resource = item.data ? toResource(item.data) : null;
  const noAccess = item.error instanceof ApiError && item.error.isNotFound;
  const title = source.title || resource?.title || "Document";
  const page = source.passages.find((p) => p.page)?.page;
  const href = readerHref({ item: source.item, passages: source.passages.map((p) => p.passage), from: conversation, page });
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [n]);

  const first = source.passages[0];
  const citation = `${first?.excerpt ? `“${first.excerpt}” — ` : ""}${title}${page ? `, page ${page}` : ""}${resource?.base ? ` (${resource.base.displayName})` : ""}`;

  return (
    <aside className="split__panel chat-cite" aria-label={`Source ${source.n}`}>
      <div className="panel__header">
        <h2 className="panel__title">{`Source ${index + 1} of ${sources.length}`}</h2>
        <IconButton icon={ChevronLeft} tip="Previous source" size="sm" isDisabled={index === 0} onPress={() => onShow(sources[index - 1]!.n)} />
        <IconButton icon={ChevronRight} tip="Next source" size="sm" isDisabled={index === sources.length - 1} onPress={() => onShow(sources[index + 1]!.n)} />
        <IconButton icon={X} tip="Close" size="sm" onPress={onClose} />
      </div>
      <div className="panel__body" ref={body}>
        <div className="row gap-12">
          <FileIcon name={title} mime={resource?.mime} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            {noAccess ? (
              <span className="chat-cite__name truncate" translate="no">
                {title}
              </span>
            ) : (
              <Link className="chat-cite__name truncate" href={href} translate="no">
                {title}
              </Link>
            )}
            <div className="t-xs muted truncate">
              {[resource?.base?.displayName, page ? `Page ${page}` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
          {resource && !resource.readable ? <StatusChip kind="doc" value={docStatus(resource.item.document?.indexingState)} /> : null}
        </div>
        {noAccess ? (
          <Callout className="mt-16" icon={Lock} title="You can’t open this document" description="It was moved, unpublished or restricted after this answer was written." />
        ) : (
          source.passages.map((p, i) => (
            <Fragment key={p.passage}>
              {source.passages.length > 1 && p.page ? <div className="t-xs muted mt-16 chat-cite__page">{`Page ${p.page}`}</div> : null}
              <blockquote className="chat-cite__quote">
                <mark className={clsx("evidence", i === 0 && "is-focus")}>{p.excerpt || "The cited passage"}</mark>
              </blockquote>
            </Fragment>
          ))
        )}
        {sources.length > 1 ? (
          <>
            <div className="t-label mt-24 mb-8">In this answer</div>
            <List plain>
              {sources.map((s) => (
                <ListItem
                  key={s.n}
                  className={clsx("chat-cite__other", s.n === source.n && "is-on")}
                  lead={
                    <span className="cite" aria-hidden>
                      {s.n}
                    </span>
                  }
                  title={<span translate="no">{s.title || "Document"}</span>}
                  label={`Source ${s.n}: ${s.title || "Document"}`}
                  description={s.passages[0]?.page ? `Page ${s.passages[0].page}` : undefined}
                  onPress={() => onShow(s.n)}
                />
              ))}
            </List>
          </>
        ) : null}
      </div>
      <div className="panel__footer">
        <Button variant="primary" isDisabled={noAccess} onPress={() => router.push(href)}>
          <ArrowUpRight className="i" aria-hidden />
          Open document
        </Button>
        <Button variant="ghost" onPress={() => void copyText(citation, "Citation copied")}>
          <Copy className="i" aria-hidden />
          Copy citation
        </Button>
      </div>
    </aside>
  );
}
