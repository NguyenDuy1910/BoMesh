"use client";

import { ExternalLink, FileArchive, FileQuestion, LockKeyhole, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { getKnowledgeItemViewer, KnowledgeViewerRequestError } from "@/modules/knowledge/api";
import { previewPages } from "@/modules/knowledge/preview";
import type { KnowledgeItemViewer } from "@/modules/knowledge/types";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";

import { DocumentPager } from "./DocumentPager";
import { DocumentRenditionView } from "./DocumentRenditionView";
import { SourcePageImage } from "./SourcePageImage";

export interface RendererProps {
  document: WorkspaceKnowledgeDocument;
  /** One-based position in the rendered pages. */
  page: number;
  /** Find-in-document. Empty when the reader is not searching. */
  search: string;
  /** Percent. Only the paged formats honour it. */
  zoom: number;
  onPageChange: (page: number) => void;
  onZoomChange: (zoom: number) => void;
  onSearchChange: (value: string) => void;
}

/**
 * The real document, as ingestion rendered it.
 *
 * A PDF keeps its pages, because its pagination is real: a citation that says
 * page 12 has to be findable on page 12. Everything else — and a PDF read as
 * text — is the whole-document rendition, searchable in place. A document with
 * neither is told apart honestly rather than reconstructed.
 */
export function OriginalRenderer({
  document,
  page,
  search,
  zoom,
  onPageChange,
  onZoomChange,
  onSearchChange,
}: RendererProps) {
  const [viewer, setViewer] = useState<KnowledgeItemViewer>();
  const [failure, setFailure] = useState<"denied" | "unavailable">();
  const [pageError, setPageError] = useState<number>();
  const [stage, setStage] = useState<"pages" | "text">("pages");
  // Preview URLs are short-lived: a page that fails to load is retried once
  // against freshly signed URLs before it is reported as unavailable.
  const [refresh, setRefresh] = useState(0);
  const refreshedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setFailure(undefined);
    setPageError(undefined);
    void getKnowledgeItemViewer(document.id, undefined, controller.signal)
      .then(setViewer)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(cause instanceof KnowledgeViewerRequestError && (cause.status === 401 || cause.status === 403)
          ? "denied"
          : "unavailable");
      });
    return () => controller.abort();
  }, [document.id, refresh]);

  const retry = useCallback(() => {
    refreshedRef.current = false;
    setRefresh((value) => value + 1);
  }, []);

  const onPageLoadFailed = useCallback((failed: number) => {
    if (refreshedRef.current) {
      setPageError(failed);
      return;
    }
    refreshedRef.current = true;
    setRefresh((value) => value + 1);
  }, []);

  if (failure === "denied") {
    return (
      <EmptyState
        description="Your account cannot open this document's content."
        icon={<LockKeyhole size={20} />}
        title="You can’t open this document"
      />
    );
  }
  if (failure && !viewer) {
    if (document.state === "failed" || document.state === "unsupported") return <UnsupportedRenderer document={document} />;
    return (
      <EmptyState
        action={<Button onClick={retry} size="sm" variant="secondary">Retry</Button>}
        description="The document could not be loaded. BoMesh will not reconstruct missing content."
        icon={<TriangleAlert size={20} />}
        title="Document temporarily unavailable"
      />
    );
  }
  if (!viewer) return <PageLoadingSkeleton label="Loading document" />;

  const preview = viewer.preview;
  const pages = previewPages(preview);
  const rendition = preview?.rendition;
  const position = Math.min(Math.max(page, 1), pages.length);
  const pageNumber = pages[position - 1];
  const showsPages = preview && pageNumber !== undefined && (!rendition || stage === "pages");
  const originalUrl = viewer.external_url || viewer.document_url || preview?.original.url;

  return (
    <>
      {pages.length > 0 && rendition && (
        <div className="knowledge-stage-switch">
          <Tabs
            activeTab={stage}
            ariaLabel="Document view"
            density="compact"
            onChange={(next) => setStage(next === "text" ? "text" : "pages")}
            tabs={[{ id: "pages", label: "Pages" }, { id: "text", label: "Text" }]}
          />
        </div>
      )}
      {showsPages ? (
        <>
          <SourcePageImage
            failed={pageError === pageNumber}
            onLoadFailed={onPageLoadFailed}
            page={pageNumber}
            preview={preview}
            title={viewer.title}
            zoom={zoom}
          />
          <DocumentPager
            onPageChange={(next) => {
              setPageError(undefined);
              onPageChange(next);
            }}
            onZoomChange={onZoomChange}
            page={position}
            pageCount={pages.length}
            zoom={zoom}
          />
        </>
      ) : rendition ? (
        <>
          <DocumentRenditionView
            contentType={viewer.content_type}
            itemId={viewer.document_id}
            onRetry={retry}
            originalUrl={originalUrl}
            rendition={rendition}
            search={search}
          />
          <DocumentPager onSearchChange={onSearchChange} search={search} />
        </>
      ) : (
        <UnsupportedRenderer document={document} />
      )}
    </>
  );
}

/**
 * Preview is impossible, but the file is not a dead end: the source link and
 * the download still work, and the state says why there is nothing to show.
 */
export function UnsupportedRenderer({ document }: Pick<RendererProps, "document">) {
  return (
    <div className="knowledge-unsupported">
      <FileQuestion aria-hidden="true" size={22} />
      <h3>Preview unavailable</h3>
      <p>
        {document.state === "pending" || document.state === "processing"
          ? "A preview appears once this document is processed."
          : document.state === "failed"
            ? document.processingError ?? "This document couldn’t be read."
            : document.state === "unsupported"
              ? `${document.fileTypeLabel ?? "This format"} can’t be previewed or used in answers.`
              : "No preview is available for this document."}
      </p>
      {document.externalUrl && (
        <div className="knowledge-unsupported__actions">
          <a className="knowledge-open-original" href={document.externalUrl} rel="noreferrer" target="_blank">
            <ExternalLink aria-hidden="true" size={16} />
            Open in {document.source}
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * An archive is an upload record: processing unpacks it, and what it held
 * becomes Documents of the same Collection, each read and cited on its own.
 */
export function ArchiveRenderer({ document }: Pick<RendererProps, "document">) {
  return (
    <div className="knowledge-unsupported">
      <FileArchive aria-hidden="true" size={22} />
      <h3>Archive</h3>
      <p>
        {document.state === "failed"
          ? document.processingError ?? "This archive couldn’t be unpacked, so none of its files were added."
          : document.state === "ready" || document.state === "outdated"
            ? `The files in ${document.title} were added to ${document.collection} as separate documents.`
            : `The files in ${document.title} are unpacked into ${document.collection} when it’s processed.`}
      </p>
    </div>
  );
}

/**
 * Format to renderer. A new format is an entry here; nothing else changes.
 */
export const documentRenderers = {
  pdf: OriginalRenderer,
  document: OriginalRenderer,
  spreadsheet: OriginalRenderer,
  archive: ArchiveRenderer,
  unsupported: UnsupportedRenderer,
} as const;
