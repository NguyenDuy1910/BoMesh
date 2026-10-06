"use client";

import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileQuestion,
  FileX,
  Info,
  Link2,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Quote,
  RotateCw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Page } from "@/components/shell/Page";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { ApiError } from "@/lib/api/request";
import { invalidateApiData } from "@/lib/api/revision";
import { hasSessionPermission } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { ingestionRunsApi } from "@/modules/ingestion/runs-api";
import {
  getDocument,
  getKnowledgeCitation,
  getKnowledgeItemViewer,
  KnowledgeViewerRequestError,
} from "@/modules/knowledge/api";
import {
  knowledgeApi,
  type Collection as DocumentCollection,
  type CollectionGrant,
  type ContractDocument,
} from "@/modules/knowledge/knowledge-api";
import { askAboutDocumentHref, askAboutPassageHref } from "@/modules/knowledge/preview";
import { isSpreadsheetType } from "@/modules/knowledge/rendition";
import type { KnowledgeItemViewer } from "@/modules/knowledge/types";
import { errorMessage, formatBytes, formatDateTime, formatRelative, pluralize } from "@/lib/format";

import {
  DocumentCanvas,
  DocumentOutline,
  documentViews,
  SelectionAsk,
  useDocumentOutline,
  type DocumentView,
  type OutlineItem,
  type ViewedPassage,
} from "./DocumentViewerContent";
import { FileTypeIcon, fileTypeOf } from "./FileTypeIcon";
import { AccessRequestState } from "./RequestAccessDialog";

/** How often a document that is still being processed is re-read. */
const PROCESSING_POLL_MS = 5000;

type ViewerState =
  | { kind: "loading" }
  | { kind: "missing" }
  /** The caller cannot open this document; its knowledge base is known when the metadata was readable. */
  | { kind: "denied"; collectionId?: string; collection?: DocumentCollection }
  | { kind: "error"; message: string }
  | {
    kind: "ready";
    document: ContractDocument;
    collection: DocumentCollection | null;
    viewer?: KnowledgeItemViewer;
    /** The viewer read failed for a reason a retry may fix. */
    viewerFailed: boolean;
    passages: ViewedPassage[];
  };

function statusOfError(cause: unknown): number | undefined {
  return cause instanceof ApiError || cause instanceof KnowledgeViewerRequestError ? cause.status : undefined;
}

/**
 * `/documents/[documentId]`: one knowledge document, read whole.
 *
 * The page view of the document's rendition (or its page images), its outline
 * and its details. Opened from a citation (`?chunk=<chunk_id>`, repeatable for
 * every passage an answer cited here), it marks the cited passages, scrolls to
 * the first and steps through the rest. Any selection can be asked about.
 */
export function DocumentViewer({ documentId }: { documentId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const session = useAuthSession();
  const toast = useToast();
  const chunkKey = [...new Set(params.getAll("chunk").filter(Boolean))].join("\n");
  const [state, setState] = useState<ViewerState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const [requestedView, setRequestedView] = useState<DocumentView>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const chunkIds = chunkKey ? chunkKey.split("\n") : [];
    // A refresh keeps the page on screen; a new document starts from a skeleton.
    setState((current) => (current.kind === "ready" && current.document.id === documentId ? current : { kind: "loading" }));
    void (async () => {
      const [documentRead, viewerRead] = await Promise.allSettled([
        getDocument(documentId, signal),
        getKnowledgeItemViewer(documentId, chunkIds[0], signal),
      ]);
      if (signal.aborted) return;
      if (documentRead.status === "rejected") {
        const status = statusOfError(documentRead.reason);
        setState(status === 404 ? { kind: "missing" } : status === 403 ? { kind: "denied" } : {
          kind: "error",
          message: errorMessage(documentRead.reason, "This document"),
        });
        return;
      }
      const document = documentRead.value;
      const collection = await knowledgeApi.collection(document.collection_id).catch(() => null);
      if (signal.aborted) return;
      const viewer = viewerRead.status === "fulfilled" ? viewerRead.value : undefined;
      const viewerStatus = viewerRead.status === "rejected" ? statusOfError(viewerRead.reason) : undefined;
      if (viewerStatus === 403 || viewerStatus === 404) {
        setState({ kind: "denied", collectionId: document.collection_id, collection: collection ?? undefined });
        return;
      }
      // Every cited passage resolves on its own; one that no longer exists
      // (the document was reprocessed) stays in the list, unmarked.
      const citations = await Promise.all(chunkIds.map((chunkId) =>
        getKnowledgeCitation(documentId, chunkId, signal).then((value) => value.citation, () => null)));
      if (signal.aborted) return;
      const passages = chunkIds.map((chunkId, index): ViewedPassage => ({
        chunkId,
        citation: citations[index] ?? (index === 0 ? viewer?.focus?.citation ?? null : null),
        chunkText: index === 0 ? viewer?.focus?.chunk_text : null,
      }));
      setState({ kind: "ready", document, collection, viewer, viewerFailed: viewerRead.status === "rejected", passages });
    })();
    return () => controller.abort();
  }, [chunkKey, documentId, reload]);

  useEffect(() => setFocusIndex(0), [chunkKey, documentId]);

  const processingState = state.kind === "ready" ? state.document.processing.state : undefined;
  // A document still being processed is re-read until it is ready, then shown.
  useEffect(() => {
    if (processingState !== "pending" && processingState !== "processing") return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (globalThis.document.visibilityState === "hidden") return;
      void getDocument(documentId, controller.signal).then((next) => {
        if (next.processing.state === processingState) return;
        if (next.processing.state === "ready" || next.processing.state === "outdated") setReload((value) => value + 1);
        else setState((current) => (current.kind === "ready" ? { ...current, document: next } : current));
      }, () => undefined);
    }, PROCESSING_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [documentId, processingState]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const viewer = state.kind === "ready" ? state.viewer : undefined;
  const views = useMemo(() => documentViews(viewer), [viewer]);
  const view = requestedView && views.includes(requestedView) ? requestedView : views[0];
  const outline = useDocumentOutline(viewer, view);

  if (state.kind === "loading") return <ViewerSkeleton />;
  if (state.kind === "missing") {
    return (
      <Page width="bare">
        <div className="grid flex-1 place-items-center p-8">
          <EmptyState
            action={<ButtonLink href="/knowledge" variant="primary">Go to Knowledge</ButtonLink>}
            description="It may have been removed or archived, or it’s in a knowledge base you can’t open."
            icon={<FileX aria-hidden="true" />}
            title="This document isn’t available"
          />
        </div>
      </Page>
    );
  }
  if (state.kind === "denied") return <NoDocumentAccess collection={state.collection} collectionId={state.collectionId} />;
  if (state.kind === "error") {
    return (
      <Page width="bare">
        <div className="grid flex-1 place-items-center p-8">
          <ErrorState description={state.message} onAction={refresh} title="This document didn’t load" />
        </div>
      </Page>
    );
  }

  const { document, collection, passages } = state;
  const processing = document.processing.state;
  const readable = processing === "ready" || processing === "outdated";
  const fileType = fileTypeOf(document.content_type, document.name);
  const isSheet = isSpreadsheetType(document.content_type);
  const pageCount = isSheet ? undefined : viewer?.preview?.page_count ?? undefined;
  const originalUrl = viewer?.preview?.original.url || viewer?.document_url || undefined;
  const sourceUrl = viewer?.external_url || undefined;
  const permissions = collection?.permissions ?? [];
  const canProcess = permissions.includes("ingestion.run");
  const collectionName = collection?.title ?? "Knowledge base";
  const ask = { documentId: document.id, name: document.name, collectionId: document.collection_id };
  const focused = passages[focusIndex];
  const hasOutline = readable && Boolean(outline);

  const retryProcessing = async () => {
    setRetrying(true);
    try {
      const run = await ingestionRunsApi.create({ document_ids: [document.id], trigger: "manual" });
      invalidateApiData();
      toast.show({ tone: "info", message: `Retrying ${document.name}`, description: "It will be readable in a few minutes." });
      setState((current) => current.kind === "ready"
        ? { ...current, document: { ...current.document, processing: { state: "pending", error: null, run_id: run.id } } }
        : current);
    } catch (cause) {
      toast.show({ tone: "err", message: errorMessage(cause, "Retrying processing") });
    } finally {
      setRetrying(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/documents/${encodeURIComponent(document.id)}`);
      toast.show({ message: "Link copied" });
    } catch {
      toast.show({ tone: "err", message: "The link couldn’t be copied." });
    }
  };

  const info = (
    <DocumentInfo
      collection={collection}
      document={document}
      fileLabel={fileType.label}
      pageCount={pageCount}
      sourceUrl={sourceUrl}
    />
  );

  return (
    <Page className="@container/docreader h-full" width="bare">
      <header className="flex flex-none items-start gap-4 border-b border-border-subtle py-3.5 pr-5 pl-[22px] @max-[860px]:flex-col @max-[860px]:gap-2.5">
        <div className="min-w-0 flex-1">
          <nav aria-label="Breadcrumb" className="mb-1.5">
            <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-text-tertiary">
              <li className="flex-none"><CrumbLink href="/knowledge">Knowledge</CrumbLink></li>
              {collection && (
                <li className="inline-flex min-w-0 items-center gap-1.5">
                  <ChevronRight aria-hidden="true" className="flex-none" size={13} />
                  <CrumbLink href={`/knowledge/${encodeURIComponent(collection.id)}`}>{collection.title}</CrumbLink>
                </li>
              )}
              <li className="inline-flex min-w-0 items-center gap-1.5">
                <ChevronRight aria-hidden="true" className="flex-none" size={13} />
                <span aria-current="page" className="max-w-[280px] truncate">{document.name}</span>
              </li>
            </ol>
          </nav>
          <div className="flex items-center gap-3">
            <FileTypeIcon kind={fileType.kind} label={fileType.label} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 break-words text-[18px] leading-[1.3] font-semibold tracking-[-0.01em] text-text-primary">
                  {document.name}
                </h1>
                {processing !== "ready" && <StatusBadge kind="doc" value={processing} />}
              </div>
              <p className="mt-0.5 text-[13px] text-text-tertiary">
                {[
                  collection?.title,
                  `Updated ${formatRelative(document.updated_at, "—")}`,
                  pageCount ? pluralize(pageCount, "page") : undefined,
                ].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>
        </div>
        <div className="mt-[18px] flex flex-none flex-wrap items-center gap-2 @max-[860px]:mt-0">
          {readable && (
            <ButtonLink href={askAboutDocumentHref(ask)} icon={<Sparkles aria-hidden="true" size={16} />} variant="primary">
              Ask about this document
            </ButtonLink>
          )}
          {originalUrl && (
            <a
              className={buttonClasses({ variant: "secondary", className: "gap-2 px-3.5" })}
              download={document.name}
              href={originalUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <Download aria-hidden="true" size={16} />
              Download
            </a>
          )}
          <Tooltip label="Details">
            <Button
              aria-expanded={detailsOpen}
              aria-label="Details"
              className="@min-[861px]:hidden"
              icon={<Info aria-hidden="true" size={16} />}
              iconOnly
              onClick={() => setDetailsOpen(true)}
              variant="ghost"
            />
          </Tooltip>
          <Menu
            align="end"
            trigger={(props) => (
              <Button {...props} aria-label="More actions" icon={<MoreHorizontal aria-hidden="true" size={16} />} iconOnly variant="ghost" />
            )}
          >
            <MenuItem icon={<Link2 />} onSelect={() => void copyLink()}>Copy link</MenuItem>
            {sourceUrl && (
              <MenuItem href={sourceUrl} icon={<ExternalLink />}>Open in source</MenuItem>
            )}
          </Menu>
        </div>
      </header>

      {readable && passages.length > 0 && (
        <CitedPassageBar
          found={Boolean(focused?.citation)}
          index={focusIndex}
          onStep={setFocusIndex}
          section={focused?.citation?.section}
          total={passages.length}
        />
      )}

      <div
        className={cn(
          "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]",
          hasOutline ? "grid-cols-[220px_minmax(0,1fr)_300px]" : "grid-cols-[minmax(0,1fr)_300px]",
          "@max-[1100px]:grid-cols-[minmax(0,1fr)_280px] @max-[860px]:grid-cols-[minmax(0,1fr)]",
        )}
      >
        {hasOutline && outline && (
          <DocumentOutline
            className="overflow-auto border-r border-border-subtle px-3 py-4 @max-[1100px]:hidden"
            items={outline}
            scrollRef={scrollRef}
          />
        )}
        <div className="relative min-h-0 min-w-0" ref={stageRef}>
          <div
            aria-label="Document"
            className="h-full overflow-auto bg-surface-subtle p-7 focus-visible:outline-none focus-visible:shadow-[inset_var(--shadow-focus)] @max-[860px]:p-[18px]"
            ref={scrollRef}
            role="region"
            tabIndex={0}
          >
            {readable && views.length > 1 && view && (
              <div className="mx-auto mb-4 flex max-w-[760px] justify-end">
                <SegmentedControl
                  ariaLabel="Document view"
                  onChange={setRequestedView}
                  options={[{ value: "text", label: "Text" }, { value: "pages", label: "Pages" }]}
                  size="sm"
                  value={view}
                />
              </div>
            )}
            {readable ? (
              viewer && view ? (
                <DocumentCanvas focusIndex={focusIndex} onRetry={refresh} passages={passages} view={view} viewer={viewer} />
              ) : state.viewerFailed ? (
                <div className="grid min-h-full place-items-center">
                  <ErrorState description="Check your connection and try again." onAction={refresh} title="This document didn’t load" />
                </div>
              ) : (
                <NotPreviewable originalUrl={originalUrl} sourceUrl={sourceUrl} />
              )
            ) : (
              <ProcessingState
                canProcess={canProcess}
                collectionName={collectionName}
                document={document}
                onRetry={() => void retryProcessing()}
                originalUrl={originalUrl}
                retrying={retrying}
                showRun={hasSessionPermission(session, "ingestion.read")}
              />
            )}
          </div>
          {readable && (
            <SelectionAsk
              containerRef={stageRef}
              onAsk={(text) => router.push(askAboutPassageHref(ask, text))}
              onCopy={(text) => {
                void navigator.clipboard.writeText(text).then(
                  () => toast.show({ message: "Copied" }),
                  () => toast.show({ tone: "err", message: "The text couldn’t be copied." }),
                );
              }}
              scrollRef={scrollRef}
            />
          )}
        </div>
        <aside aria-label="Document details" className="overflow-auto border-l border-border-subtle p-[18px] @max-[860px]:hidden">
          {info}
        </aside>
      </div>

      <Drawer onClose={() => setDetailsOpen(false)} open={detailsOpen} title="Details">
        <div className="grid gap-6">
          {info}
          {hasOutline && outline && outline.length > 0 && (
            <DrawerOutline items={outline} onJump={() => setDetailsOpen(false)} scrollRef={scrollRef} />
          )}
        </div>
      </Drawer>
    </Page>
  );
}

function CrumbLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      className="block max-w-[240px] truncate rounded-xs hover:text-text-primary focus-visible:outline-none focus-visible:shadow-(--shadow-focus)"
      href={href}
    >
      {children}
    </Link>
  );
}

/**
 * The cited passage the reader arrived for, and the way to the others this
 * answer cited in the document. Evidence tokens: this is a citation surface.
 */
function CitedPassageBar({
  found,
  index,
  onStep,
  section,
  total,
}: {
  found: boolean;
  index: number;
  onStep: (index: number) => void;
  section?: string | null;
  total: number;
}) {
  return (
    <div
      className="flex flex-none items-center gap-2.5 border-b border-evidence-border bg-evidence-bg py-1.5 pr-3 pl-[22px] text-[13px] font-medium text-evidence-text"
      role="status"
    >
      <Quote aria-hidden="true" className="flex-none" size={15} />
      <span className="min-w-0 flex-1 truncate">
        {found ? (
          <>
            Cited passage{total > 1 ? ` ${index + 1} of ${total}` : ""}
            {section ? <span className="font-normal"> · {section}</span> : null}
          </>
        ) : (
          "The cited passage isn’t in this version of the document."
        )}
      </span>
      {total > 1 && (
        <span className="flex flex-none items-center gap-1">
          <Button
            aria-label="Previous cited passage"
            className="text-evidence-text hover:bg-evidence-border/40"
            disabled={index === 0}
            icon={<ChevronLeft aria-hidden="true" size={16} />}
            iconOnly
            onClick={() => onStep(index - 1)}
            size="sm"
            variant="ghost"
          />
          <Button
            aria-label="Next cited passage"
            className="text-evidence-text hover:bg-evidence-border/40"
            disabled={index === total - 1}
            icon={<ChevronRight aria-hidden="true" size={16} />}
            iconOnly
            onClick={() => onStep(index + 1)}
            size="sm"
            variant="ghost"
          />
        </span>
      )}
    </div>
  );
}

function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-caption font-medium text-text-tertiary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-[13.5px] text-text-primary">{children}</dd>
    </div>
  );
}

function DocumentInfo({
  collection,
  document,
  fileLabel,
  pageCount,
  sourceUrl,
}: {
  collection: DocumentCollection | null;
  document: ContractDocument;
  fileLabel: string;
  pageCount?: number;
  sourceUrl?: string;
}) {
  const canShare = collection?.permissions.includes("collection.share") ?? false;
  const [grants, setGrants] = useState<CollectionGrant[] | null>();
  const sourceHost = sourceUrl ? hostOf(sourceUrl) : undefined;

  useEffect(() => {
    if (!collection || !canShare) return;
    let live = true;
    void knowledgeApi.access(collection.id).then(
      (value) => live && setGrants(value),
      () => live && setGrants(null),
    );
    return () => {
      live = false;
    };
  }, [canShare, collection]);

  const names = (grants ?? []).map((grant) => grant.principal_name).filter((name): name is string => Boolean(name));

  return (
    <dl className="grid gap-4">
      <InfoField label="Knowledge base">
        {collection ? (
          <Link className="truncate text-text-accent hover:underline" href={`/knowledge/${encodeURIComponent(collection.id)}`}>
            {collection.title}
          </Link>
        ) : (
          <span className="text-text-secondary">Not available</span>
        )}
      </InfoField>
      <InfoField label="Source">
        {sourceUrl ? (
          <a className="inline-flex min-w-0 items-center gap-1.5 text-text-accent hover:underline" href={sourceUrl} rel="noopener noreferrer" target="_blank">
            <span className="truncate">{sourceHost ?? "Original location"}</span>
            <ExternalLink aria-hidden="true" className="flex-none" size={13} />
          </a>
        ) : (
          <span>Uploaded</span>
        )}
      </InfoField>
      <div className="grid grid-cols-2 gap-4">
        <InfoField label="Updated">
          <span title={formatDateTime(document.updated_at)}>{formatRelative(document.updated_at, "—")}</span>
        </InfoField>
        <InfoField label="Size">{formatBytes(document.size_bytes)}</InfoField>
        {pageCount ? <InfoField label="Pages">{pageCount.toLocaleString()}</InfoField> : null}
        <InfoField label="Type">{fileLabel}</InfoField>
      </div>
      <InfoField label="Status">
        <StatusBadge kind="doc" value={document.processing.state} />
      </InfoField>
      {collection && canShare && (
        <>
          <hr className="border-border-subtle" />
          <InfoField label="Who can see this">
            <span className="text-text-secondary">
              {grants === undefined
                ? "Loading…"
                : grants === null
                  ? "People with access to this knowledge base"
                  : names.length
                    ? names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "")
                    : "Only people with access to this knowledge base"}
            </span>
          </InfoField>
          <Link className="-mt-2 text-[13.5px] font-medium text-text-accent hover:underline" href={`/knowledge/${encodeURIComponent(collection.id)}?tab=access`}>
            Manage access
          </Link>
        </>
      )}
    </dl>
  );
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** The outline inside the details drawer, where the side column has no room. */
function DrawerOutline({
  items,
  onJump,
  scrollRef,
}: {
  items: OutlineItem[];
  onJump: () => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  return (
    <div className="-mx-2.5 border-t border-border-subtle pt-4" onClickCapture={() => window.setTimeout(onJump, 0)}>
      <DocumentOutline items={items} scrollRef={scrollRef} />
    </div>
  );
}

/** Why a document that is not ready has nothing to read yet, and what helps. */
function ProcessingState({
  canProcess,
  collectionName,
  document,
  onRetry,
  originalUrl,
  retrying,
  showRun,
}: {
  canProcess: boolean;
  collectionName: string;
  document: ContractDocument;
  onRetry: () => void;
  originalUrl?: string;
  retrying: boolean;
  showRun: boolean;
}) {
  const { state, error, run_id: runId } = document.processing;
  const download = originalUrl ? (
    <a className={buttonClasses({ variant: "secondary", className: "gap-2 px-3.5" })} href={originalUrl} rel="noopener noreferrer" target="_blank">
      <Download aria-hidden="true" size={16} />
      Download
    </a>
  ) : undefined;

  let body: React.ReactNode;
  if (state === "processing") {
    body = (
      <EmptyState
        description="It will be readable and searchable in a few minutes. This page updates by itself."
        icon={<LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />}
        title="Getting this document ready"
      />
    );
  } else if (state === "pending") {
    body = (
      <EmptyState
        description="This document is in line and will be ready soon. This page updates by itself."
        icon={<Clock aria-hidden="true" />}
        title="Waiting to be processed"
      />
    );
  } else if (state === "unsupported") {
    body = (
      <EmptyState
        action={download}
        description="Images and some file types can’t be read or searched. Download it to view."
        icon={<FileQuestion aria-hidden="true" />}
        title="This file can’t be previewed"
      />
    );
  } else {
    body = (
      <Callout
        actions={(canProcess || (showRun && runId)) ? (
          <>
            {canProcess && (
              <Button icon={<RotateCw aria-hidden="true" size={15} />} loading={retrying} onClick={onRetry} size="sm" variant="secondary">
                Retry processing
              </Button>
            )}
            {showRun && runId && (
              <ButtonLink href={`/manage/sources?run=${encodeURIComponent(runId)}`} size="sm" variant="ghost">
                View sync details
              </ButtonLink>
            )}
          </>
        ) : undefined}
        className="max-w-[560px]"
        title="This document couldn’t be read"
        tone="err"
      >
        <p>{error || "The file couldn’t be opened."}</p>
        {!canProcess && <p className="mt-1.5">Ask an owner of {collectionName} to fix the file.</p>}
      </Callout>
    );
  }
  return <div className="grid min-h-full place-items-center">{body}</div>;
}

function NotPreviewable({ originalUrl, sourceUrl }: { originalUrl?: string; sourceUrl?: string }) {
  return (
    <div className="grid min-h-full place-items-center">
      <EmptyState
        action={originalUrl ? (
          <a className={buttonClasses({ variant: "secondary", className: "gap-2 px-3.5" })} href={originalUrl} rel="noopener noreferrer" target="_blank">
            <Download aria-hidden="true" size={16} />
            Download
          </a>
        ) : sourceUrl ? (
          <a className={buttonClasses({ variant: "secondary", className: "gap-2 px-3.5" })} href={sourceUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink aria-hidden="true" size={16} />
            Open in source
          </a>
        ) : undefined}
        description="BoMesh can search this document, but it has no preview yet."
        icon={<FileQuestion aria-hidden="true" />}
        title="No preview for this document"
      />
    </div>
  );
}

/**
 * The caller may not open this document. When its knowledge base is known,
 * they can ask its owners for access right here (the same state the locked
 * knowledge base shows); otherwise Knowledge is where locked bases are listed.
 */
function NoDocumentAccess({ collection, collectionId }: { collection?: DocumentCollection; collectionId?: string }) {
  return (
    <Page width="bare">
      <header className="flex-none border-b border-border-subtle py-3.5 pr-5 pl-[22px]">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1.5 text-[13px] text-text-tertiary">
            <li><CrumbLink href="/knowledge">Knowledge</CrumbLink></li>
            {collection && (
              <li className="inline-flex min-w-0 items-center gap-1.5">
                <ChevronRight aria-hidden="true" size={13} />
                <CrumbLink href={`/knowledge/${encodeURIComponent(collection.id)}`}>{collection.title}</CrumbLink>
              </li>
            )}
          </ol>
        </nav>
      </header>
      <div className="grid flex-1 place-items-center p-8">
        {collectionId ? (
          <div className="grid w-full max-w-[560px] gap-3">
            <p className="text-center text-body text-text-secondary">
              This document is in {collection ? <strong className="font-medium text-text-primary">{collection.title}</strong> : "a knowledge base"} you can’t open.
            </p>
            <AccessRequestState collectionId={collectionId} collectionName={collection?.title} />
          </div>
        ) : (
          <EmptyState
            action={<ButtonLink href="/knowledge" variant="primary">Go to Knowledge</ButtonLink>}
            description="It’s in a knowledge base you can’t access. Request access from Knowledge."
            icon={<Lock aria-hidden="true" />}
            title="You don’t have access to this document"
          />
        )}
      </div>
    </Page>
  );
}

function ViewerSkeleton() {
  return (
    <Page className="h-full" width="bare">
      <div aria-busy="true" aria-label="Loading document" className="flex min-h-0 flex-1 flex-col" role="status">
        <div className="flex flex-none items-start gap-3 border-b border-border-subtle py-3.5 pr-5 pl-[22px]">
          <div className="grid flex-1 gap-2.5">
            <Skeleton className="h-3 w-56" />
            <div className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-[7px]" />
              <div className="grid gap-1.5">
                <Skeleton className="h-5 w-72" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          </div>
          <Skeleton className="mt-[18px] h-9 w-52" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden bg-surface-subtle p-7">
          <div className="doc-reader-page">
            <Skeleton className="h-[22px] w-[55%]" />
            {[92, 86, 95, 70, 0, 40, 90, 84, 60].map((width, index) => (width
              ? <Skeleton className="h-3" key={index} style={{ width: `${width}%` }} />
              : <span className="h-3" key={index} />))}
          </div>
        </div>
      </div>
    </Page>
  );
}
