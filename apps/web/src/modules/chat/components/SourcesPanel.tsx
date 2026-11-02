"use client";

import { ArrowUpRight, ChevronLeft, ChevronRight, Quote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Passage } from "@/components/patterns/Passage";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { getKnowledgeItemViewer, KnowledgeViewerRequestError } from "@/modules/knowledge/api";
import { documentHref } from "@/modules/knowledge/preview";
import type { AnswerPassage, AnswerSource } from "../sources";
import { FileIcon } from "./FileIcon";

/**
 * The sources of one answer: a card per cited document with the cited
 * passage, stepping through the document's other cited passages, and a link
 * to read it in the document reader at that passage.
 */
export function SourcesPanel({
  sources,
  activeSourceId,
  activeChunkId,
  onSelect,
  onClose,
}: {
  sources: AnswerSource[];
  activeSourceId?: string;
  activeChunkId?: string;
  onSelect: (source: AnswerSource, chunkId?: string) => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!activeSourceId) return;
    const card = body.current?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(activeSourceId)}"]`);
    card?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [activeSourceId, activeChunkId]);

  return (
    <aside aria-label="Sources" className="flex h-full w-[420px] max-w-full flex-col border-l border-border-subtle bg-surface-base">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border-subtle pl-[18px] pr-3">
        <h2 className="flex-1 text-section font-semibold text-text-primary">
          Sources <span className="font-normal text-text-tertiary">{sources.length}</span>
        </h2>
        <Button aria-label="Close sources" data-layer-close icon={<X aria-hidden="true" />} iconOnly onClick={onClose} size="sm" variant="ghost" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4" ref={body}>
        {sources.length ? (
          <ul className="flex flex-col gap-3">
            {sources.map((source) => (
              <li key={source.id}>
                <SourceCard
                  active={source.id === activeSourceId}
                  chunkId={source.id === activeSourceId ? activeChunkId : undefined}
                  onSelect={(chunkId) => onSelect(source, chunkId)}
                  source={source}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Quote aria-hidden="true" />} size="sm" title="No sources for this answer" />
        )}
      </div>
    </aside>
  );
}

type PassageState =
  | { status: "loading" }
  | { status: "ready"; text: string; meta?: string }
  | { status: "unavailable" }
  | { status: "error" };

function SourceCard({
  source,
  active,
  chunkId,
  onSelect,
}: {
  source: AnswerSource;
  active: boolean;
  chunkId?: string;
  onSelect: (chunkId?: string) => void;
}) {
  const passages = source.passages.length ? source.passages : [{ number: source.index, chunkId: source.chunkId, internalUrl: source.internalUrl, spans: [] } as AnswerPassage];
  const index = Math.max(0, passages.findIndex((passage) => passage.chunkId === chunkId));
  const passage = passages[index]!;
  const [state, setState] = useState<PassageState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    getKnowledgeItemViewer(source.itemId, passage.chunkId, controller.signal)
      .then((viewer) => {
        const focus = viewer.focus;
        if (!focus?.chunk_text) {
          setState({ status: "unavailable" });
          return;
        }
        const page = focus.citation.page_start;
        const meta = [focus.citation.section, typeof page === "number" ? `Page ${page}` : passage.locator].filter(Boolean).join(" · ");
        setState({ status: "ready", text: focus.chunk_text, meta: meta || undefined });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState(cause instanceof KnowledgeViewerRequestError && (cause.status === 403 || cause.status === 404)
          ? { status: "unavailable" }
          : { status: "error" });
      });
    return () => controller.abort();
  }, [attempt, passage.chunkId, passage.locator, source.itemId]);

  // The reader opens at the passage shown here, then steps through the rest.
  const ordered = [passage.chunkId, ...passages.map((item) => item.chunkId).filter((id) => id !== passage.chunkId)];

  return (
    <article
      aria-current={active || undefined}
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border bg-surface-base px-3.5 py-3 transition-[border-color,box-shadow] duration-(--duration-fast)",
        active ? "border-(--evidence-line) shadow-[0_0_0_1px_var(--evidence-line)]" : "border-border-subtle hover:border-border-default",
      )}
      data-source-id={source.id}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a,button")) return;
        onSelect(passage.chunkId);
      }}
    >
      <header className="flex items-center gap-3">
        <span aria-hidden="true" className="inline-flex h-[18px] min-w-[19px] items-center justify-center rounded-[5px] bg-evidence-bg px-[5px] font-mono text-[11px] font-semibold text-evidence-text shadow-[inset_0_0_0_1px_var(--evidence-border)]">
          {source.index}
        </span>
        <FileIcon name={source.title} size={28} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-text-primary" title={source.title}>
            <span className="sr-only">Source {source.index}: </span>{source.title}
          </h3>
          {(state.status === "ready" ? state.meta : passage.locator) && (
            <p className="truncate text-caption text-text-tertiary">{state.status === "ready" ? state.meta : passage.locator}</p>
          )}
        </div>
      </header>
      {state.status === "loading" ? (
        <div aria-busy="true" aria-label="Loading passage" className="flex flex-col gap-2">
          <Skeleton className="h-3 w-[92%]" />
          <Skeleton className="h-3 w-[80%]" />
          <Skeleton className="h-3 w-[64%]" />
        </div>
      ) : state.status === "ready" ? (
        <Passage className="max-h-[260px] overflow-y-auto whitespace-pre-line">{state.text}</Passage>
      ) : state.status === "unavailable" ? (
        <p className="text-meta text-text-tertiary">This passage can’t be shown. Open the document to read it.</p>
      ) : (
        <p className="flex items-center gap-2 text-meta text-text-tertiary">
          This passage didn’t load.
          <Button onClick={() => setAttempt((value) => value + 1)} size="sm" variant="link">Try again</Button>
        </p>
      )}
      <div className="flex items-center gap-2">
        <ButtonLink href={documentHref(source.itemId, ordered)} icon={<ArrowUpRight aria-hidden="true" />} size="sm" variant="secondary">
          Open document
        </ButtonLink>
        {passages.length > 1 && (
          <span className="ml-auto inline-flex items-center gap-0.5 text-caption text-text-tertiary">
            <Button
              aria-label="Previous passage"
              disabled={index === 0}
              icon={<ChevronLeft aria-hidden="true" />}
              iconOnly
              onClick={() => onSelect(passages[index - 1]!.chunkId)}
              size="sm"
              variant="ghost"
            />
            <span aria-live="polite">Passage {index + 1} of {passages.length}</span>
            <Button
              aria-label="Next passage"
              disabled={index === passages.length - 1}
              icon={<ChevronRight aria-hidden="true" />}
              iconOnly
              onClick={() => onSelect(passages[index + 1]!.chunkId)}
              size="sm"
              variant="ghost"
            />
          </span>
        )}
      </div>
    </article>
  );
}
