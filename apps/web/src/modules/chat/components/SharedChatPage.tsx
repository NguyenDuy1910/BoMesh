"use client";

import { Link2, MessageSquarePlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { EvidenceChip } from "@/components/patterns/EvidenceChip";
import { Page } from "@/components/shell/Page";
import { Button, ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api/request";
import { usePendingFeature } from "@/lib/api/pending";
import { documentHref } from "@/modules/knowledge/preview";
import { getConversationShare, type SharedConversation, type SharedConversationSource } from "../api";
import { importSharedConversation } from "../chat-runtime";
import type { AnswerSource } from "../sources";
import { FileIcon } from "./FileIcon";
import { CitationRenderingProvider, citationRenderingSources, IncrementalMarkdown } from "./IncrementalMarkdown";

type ShareState =
  | { status: "loading" }
  | { status: "ready"; share: SharedConversation }
  | { status: "missing" }
  | { status: "error" };

/** `/s/[shareId]` — a shared chat, read-only, with only the sources the reader can open. */
export function SharedChatPage({ shareId }: { shareId: string }) {
  const enabled = usePendingFeature("chat.share");
  const [state, setState] = useState<ShareState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: "loading" });
    getConversationShare(shareId)
      .then((share) => {
        if (!cancelled) setState({ status: "ready", share });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState(cause instanceof ApiError && (cause.status === 404 || cause.status === 403) ? { status: "missing" } : { status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, enabled, shareId]);

  if (!enabled || state.status === "missing") {
    return (
      <Page width="narrow">
        <EmptyState
          action={<ButtonLink href="/chat" icon={<MessageSquarePlus aria-hidden="true" />} variant="secondary">New chat</ButtonLink>}
          description="Sharing isn’t connected to the server, so links only open in the browser that created them. If it was made here, it may have been turned off."
          icon={<Link2 aria-hidden="true" />}
          title="This shared chat isn’t available here yet"
        />
      </Page>
    );
  }
  if (state.status === "error") {
    return (
      <Page width="narrow">
        <ErrorState description="The shared chat couldn’t be opened." onAction={() => setAttempt((value) => value + 1)} />
      </Page>
    );
  }
  if (state.status === "loading") {
    return (
      <Page width="narrow">
        <div aria-busy="true" aria-label="Loading shared chat" className="flex flex-col gap-4" role="status">
          <Skeleton className="h-7 w-2/5" />
          <Skeleton className="ml-auto h-10 w-1/2 rounded-[18px]" />
          <Skeleton className="h-3 w-[92%]" />
          <Skeleton className="h-3 w-[80%]" />
        </div>
      </Page>
    );
  }
  return <SharedChat share={state.share} />;
}

function SharedChat({ share }: { share: SharedConversation }) {
  const router = useRouter();
  const toast = useToast();
  const [continuing, setContinuing] = useState(false);
  const from = share.created_by.display_name ?? "A colleague";
  const restricted = share.messages.some((message) => message.sources.some((source) => !source.available));

  const continueChat = async () => {
    setContinuing(true);
    try {
      const id = await importSharedConversation(share);
      router.push(`/chat/${encodeURIComponent(id)}`);
    } catch {
      toast.show({ tone: "err", message: "A new chat couldn’t be started. Try again." });
      setContinuing(false);
    }
  };

  return (
    <Page width="narrow">
      <PageHeader
        actions={(
          <Button icon={<MessageSquarePlus aria-hidden="true" />} loading={continuing} onClick={() => void continueChat()} variant="primary">
            Continue in a new chat
          </Button>
        )}
        sub={`Shared by ${from} on ${new Date(share.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}. Read-only.`}
        title={share.title}
        titleExtra={<PreviewTag />}
      />
      {restricted && (
        <p className="mb-5 text-meta text-text-tertiary">
          Some sources in this chat are in knowledge you can’t open, so they’re left out.
        </p>
      )}
      <ol aria-label="Messages" className="flex flex-col gap-7">
        {share.messages.map((message, index) => (
          <li key={index}>
            {message.role === "user" ? (
              <div className="flex justify-end">
                <div className="max-w-[min(85%,620px)] whitespace-pre-wrap break-words rounded-[18px_18px_6px_18px] bg-surface-inset px-4 py-2.5 text-[0.9375rem] leading-[1.55] text-text-primary">
                  {message.content}
                </div>
              </div>
            ) : (
              <SharedAnswer content={message.content} sources={message.sources} />
            )}
          </li>
        ))}
      </ol>
    </Page>
  );
}

function SharedAnswer({ content, sources }: { content: string; sources: SharedConversationSource[] }) {
  const router = useRouter();
  const { readable, dropped } = useMemo(() => {
    const byDocument = new Map<string, AnswerSource>();
    for (const source of sources) {
      if (!source.available) continue;
      const known = byDocument.get(source.document_id);
      const passage = { number: source.number, chunkId: source.chunk_id, internalUrl: documentHref(source.document_id, [source.chunk_id]), spans: [] };
      if (known) {
        known.passages.push(passage);
        continue;
      }
      byDocument.set(source.document_id, {
        id: `document:${source.document_id}`,
        index: source.number,
        title: source.title,
        itemId: source.document_id,
        chunkId: source.chunk_id,
        internalUrl: passage.internalUrl,
        used: true,
        spans: [],
        passages: [passage],
      });
    }
    return {
      readable: [...byDocument.values()],
      dropped: new Set(sources.filter((source) => !source.available).map((source) => source.number)),
    };
  }, [sources]);
  const citations = useMemo(() => ({
    sources: citationRenderingSources(readable),
    dropped,
    onOpenSource: (source: AnswerSource) => router.push(source.internalUrl),
  }), [dropped, readable, router]);

  return (
    <CitationRenderingProvider value={citations}>
      <div className="assistant-content text-reading">
        <IncrementalMarkdown
          isStreaming={false}
          text={content.replace(/\s?\[(\d{1,3})\]/g, (marker, number: string) => (dropped.has(Number(number)) ? "" : marker))}
        />
      </div>
      {readable.length > 0 && (
        <ul aria-label="Sources" className="mt-3.5 flex flex-wrap gap-1.5">
          {readable.map((source) => (
            <li key={source.id}>
              <EvidenceChip href={source.internalUrl} icon={<FileIcon name={source.title} size={16} />} n={source.index} title={source.title} />
            </li>
          ))}
        </ul>
      )}
    </CitationRenderingProvider>
  );
}
