"use client";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  FileWarning,
  LoaderCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Tabs } from "@/components/ui/Tabs";
import { useClipboard } from "@/lib/hooks/useClipboard";
import { getKnowledgeItemViewer, KnowledgeViewerRequestError } from "../api";
import {
  adjacentPage,
  citationRegions,
  citationTarget,
  previewPage,
  previewPages,
} from "../preview";
import { isSpreadsheetType } from "../rendition";
import type { KnowledgeItemViewer } from "../types";
import { DocumentRenditionView } from "./DocumentRenditionView";
import { SourcePageImage } from "./SourcePageImage";

/**
 * A cited source beside the conversation: its rendered pages, or the whole
 * document as text with the cited passage highlighted.
 *
 * Both come from what ingestion already produced, so opening a citation never
 * re-renders a file and never asks the browser to understand where those
 * objects live.
 */
export function KnowledgeDocumentPreview({
  chunkId,
  itemId,
  onAskSource,
  page: citedPage,
  passageIds = [],
}: {
  chunkId: string;
  itemId: string;
  onAskSource?: (title: string) => void;
  page?: number;
  /** Every passage the answer cited in this document, in citation order. */
  passageIds?: string[];
}) {
  // The panel opens at the clicked passage; the reader can then step through
  // the document's other cited passages without leaving it.
  const [steppedChunk, setSteppedChunk] = useState<string>();
  useEffect(() => setSteppedChunk(undefined), [chunkId]);
  const activeChunk = steppedChunk ?? chunkId;
  const passages = passageIds.includes(chunkId) ? passageIds : [chunkId, ...passageIds].filter(Boolean);
  const passageIndex = passages.indexOf(activeChunk);
  const [viewer, setViewer] = useState<KnowledgeItemViewer>();
  const [error, setError] = useState<SourceViewerFailure>();
  const [page, setPage] = useState<number>();
  const [pageError, setPageError] = useState<number>();
  // A paged source can also be read as text when it has a rendition.
  const [stage, setStage] = useState<"pages" | "text">("pages");
  // Preview URLs are short-lived. A page that fails to load is retried once
  // against freshly signed URLs before it is reported as unavailable.
  const [refresh, setRefresh] = useState(0);
  const refreshedRef = useRef(false);
  const requestRef = useRef(0);

  // Each passage gets one silent re-sign; the refresh it triggers must not
  // grant another, or a page that keeps failing re-fetches forever.
  useEffect(() => {
    refreshedRef.current = false;
  }, [activeChunk, itemId]);

  useEffect(() => {
    const controller = new AbortController();
    // A newer citation must win even if an earlier document resolves later.
    const request = (requestRef.current += 1);
    // The panel is keyed by document, so the source on screen stays while the
    // next passage resolves: stepping moves the highlight, not the document.
    setError(undefined);
    setPageError(undefined);
    void getKnowledgeItemViewer(itemId, activeChunk, controller.signal)
      .then((resolved) => {
        if (requestRef.current !== request) return;
        setViewer(resolved);
        setPage(citationTarget(resolved.focus?.citation, resolved.preview, activeChunk === chunkId ? citedPage : undefined).page
          ?? previewPages(resolved.preview)[0]);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || requestRef.current !== request) return;
        setError(sourceViewerFailure(cause));
      });
    return () => controller.abort();
  }, [activeChunk, chunkId, citedPage, itemId, refresh]);

  const preview = viewer?.preview;
  const asset = page === undefined ? undefined : previewPage(preview, page);
  const regions = useMemo(
    () => citationRegions(viewer?.focus?.citation, page, preview),
    [page, preview, viewer],
  );
  const pages = useMemo(() => previewPages(preview), [preview]);
  const previousPage = page === undefined ? undefined : adjacentPage(preview, page, -1);
  const nextPage = page === undefined ? undefined : adjacentPage(preview, page, 1);

  const goTo = useCallback((target: number | undefined) => {
    if (target === undefined) return;
    setPageError(undefined);
    setPage(target);
  }, []);

  const onPageLoadFailed = useCallback((failed: number) => {
    if (refreshedRef.current) {
      setPageError(failed);
      return;
    }
    refreshedRef.current = true;
    setRefresh((value) => value + 1);
  }, []);

  const retry = useCallback(() => {
    refreshedRef.current = false;
    setError(undefined);
    setRefresh((value) => value + 1);
  }, []);

  if (error) {
    return error.kind === "permission_denied" ? (
      <PreviewNotice
        icon="warning"
        title="You can’t open this source"
        detail="You can continue using the grounded answer, but your account cannot open the underlying source."
      />
    ) : (
      <PreviewNotice
        icon="warning"
        title="Source temporarily unavailable"
        detail="The grounded answer remains visible, but the original document could not be loaded. BoMesh will not reconstruct missing source text."
        onRetry={retry}
      />
    );
  }
  if (!viewer) return <PreviewNotice icon="spinner" title="Opening source…" />;

  const passageText = viewer.focus?.chunk_text;
  const rendition = preview?.rendition;
  const showsPages = Boolean(asset) && (!rendition || stage === "pages");
  const showsRendition = !showsPages && Boolean(rendition);
  // Office and text files without a rendition have no page images: their
  // cited passage is the view itself, not a fallback under a warning.
  const showsPassage = !showsPages && !showsRendition && !isHtmlSource(viewer)
    && Boolean(passageText) && viewer.status !== "pending_content";

  return (
    <div className="source-preview">
      <SourceIdentity hasPages={pages.length > 0} onAskSource={onAskSource} viewer={viewer} />
      <div className="source-preview__meta">
        {asset && rendition && (
          <Tabs
            activeTab={stage}
            ariaLabel="Source view"
            density="compact"
            onChange={(next) => setStage(next === "text" ? "text" : "pages")}
            tabs={[{ id: "pages", label: "Pages" }, { id: "text", label: "Text" }]}
          />
        )}
        {viewer.focus?.citation.section && (
          <span className="source-preview__section">{viewer.focus.citation.section}</span>
        )}
        {passages.length > 1 && passageIndex >= 0 && (
          <span className="source-preview__pager">
            <button
              aria-label="Previous cited passage"
              className="source-preview__page-button"
              disabled={passageIndex === 0}
              onClick={() => setSteppedChunk(passages[passageIndex - 1])}
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={14} />
            </button>
            <span className="source-preview__page-count">
              Passage {passageIndex + 1} / {passages.length}
            </span>
            <button
              aria-label="Next cited passage"
              className="source-preview__page-button"
              disabled={passageIndex === passages.length - 1}
              onClick={() => setSteppedChunk(passages[passageIndex + 1])}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={14} />
            </button>
          </span>
        )}
        {showsPages && page !== undefined && (
          <span className="source-preview__pager">
            <button
              aria-label="Previous page"
              className="source-preview__page-button"
              disabled={previousPage === undefined}
              onClick={() => goTo(previousPage)}
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={14} />
            </button>
            <span className="source-preview__page-count">
              Page {page}
              {preview?.page_count ? ` / ${preview.page_count}` : ""}
            </span>
            <button
              aria-label="Next page"
              className="source-preview__page-button"
              disabled={nextPage === undefined}
              onClick={() => goTo(nextPage)}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={14} />
            </button>
          </span>
        )}
      </div>

      <div className="source-preview__stage">
        {showsPages && preview && page !== undefined ? (
          <SourcePageImage
            failed={pageError === page}
            onLoadFailed={onPageLoadFailed}
            page={page}
            preview={preview}
            regions={regions}
            title={viewer.title}
          />
        ) : showsRendition && rendition ? (
          <DocumentRenditionView
            chunkText={passageText}
            citation={viewer.focus?.citation}
            contentType={viewer.content_type}
            itemId={viewer.document_id}
            onRetry={retry}
            originalUrl={viewer.external_url || viewer.document_url || preview?.original.url}
            rendition={rendition}
          />
        ) : isHtmlSource(viewer) ? (
          <HtmlSourcePreview viewer={viewer} />
        ) : showsPassage ? (
          <PassageView contentType={viewer.content_type} text={passageText!} />
        ) : (
          <UnrenderedSource viewer={viewer} />
        )}
      </div>

      {/* The whole document already shows the passage in place. */}
      {passageText && !showsPassage && !showsRendition && (
        <blockquote className="source-preview__quote">{passageText}</blockquote>
      )}
      {/* Without a passage the document was opened directly, not from a claim. */}
      {chunkId && !viewer.focus?.chunk_text && (
        <p className="source-preview__no-excerpt">
          This answer is grounded in the document, but no exact passage maps cleanly to this statement.
        </p>
      )}
    </div>
  );
}

function SourceIdentity({
  hasPages,
  onAskSource,
  viewer,
}: {
  hasPages: boolean;
  onAskSource?: (title: string) => void;
  viewer: KnowledgeItemViewer;
}) {
  const { copy, copied } = useClipboard();
  const originalUrl = viewer.external_url || viewer.document_url || viewer.preview?.original.url;
  // A spreadsheet or Word file reports "page 1" for everything; only paged
  // previews have a page worth naming.
  const page = hasPages ? viewer.focus?.citation.page_start : undefined;
  const sourceType = fileKind(viewer.content_type, viewer.title);

  return (
    <section className="source-preview__identity" aria-label="Source details">
      <div className="source-preview__identity-heading">
        <span className="source-preview__identity-icon"><FileText aria-hidden="true" size={16} /></span>
        <div>
          <h3 title={viewer.title}>{viewer.title}</h3>
          <p>{sourceType}</p>
        </div>
      </div>
      <dl className="source-preview__facts">
        <div><dt>Access</dt><dd>Authorized</dd></div>
        {page && <div><dt>Page</dt><dd>{page}</dd></div>}
        {viewer.focus?.citation.section && <div><dt>Section</dt><dd>{viewer.focus.citation.section}</dd></div>}
      </dl>
      <div className="source-preview__actions">
        {originalUrl && (
          <a className="source-preview__action source-preview__action--contextual" href={originalUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink aria-hidden="true" size={14} />Open original
          </a>
        )}
        {onAskSource && (
          <button className="source-preview__action source-preview__action--soft" onClick={() => onAskSource(viewer.title)} type="button">
            Ask this document
          </button>
        )}
        {viewer.focus?.chunk_text && (
          <button className="source-preview__action source-preview__action--ghost" onClick={() => void copy(viewer.focus!.chunk_text)} type="button">
            {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
            {copied ? "Copied" : "Copy quote"}
          </button>
        )}
      </div>
    </section>
  );
}

/** Render an HTML source without granting it access to the chat application. */
function HtmlSourcePreview({ viewer }: { viewer: KnowledgeItemViewer }) {
  const sourceUrl = viewer.preview?.original.url || viewer.document_url;
  if (!sourceUrl) return <UnrenderedSource viewer={viewer} />;
  return (
    <div className="source-preview__html">
      <p className="source-preview__html-note">
        Rendered source preview in an isolated sandbox.
      </p>
      <iframe
        className="source-preview__html-frame"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src={sourceUrl}
        title={`${viewer.title} preview`}
      />
    </div>
  );
}

const FILE_KINDS: Record<string, string> = {
  "application/pdf": "PDF document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint presentation",
  "text/csv": "CSV spreadsheet",
  "text/markdown": "Markdown document",
  "text/html": "Web page",
  "text/plain": "Text document",
};

/** What kind of file this is, in words a reader uses rather than a MIME type. */
function fileKind(contentType: string, title: string): string {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = /\.([a-z0-9]{1,8})$/i.exec(title)?.[1]?.toUpperCase();
  return FILE_KINDS[normalized] ?? (extension ? `${extension} file` : "Document");
}

/**
 * The cited passage of a file with neither page images nor a rendition, as
 * the main view.
 *
 * Spreadsheet passages arrive as "row, column = value" statements; shown as
 * rows under their shared column heading they read like the sheet they came
 * from. Anything that does not parse that way is shown as written.
 */
function PassageView({ contentType, text }: { contentType: string; text: string }) {
  const table = isSpreadsheetType(contentType) ? spreadsheetPassage(text) : null;
  return (
    <section aria-label="Cited passage" className="source-preview__passage">
      <p className="source-preview__passage-label">Cited passage</p>
      {table ? (
        <div className="source-preview__passage-table">
          {table.heading && <p className="source-preview__passage-heading">{table.heading}</p>}
          <table>
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={index}>
                  <th scope="row">{row.label !== table.rows[index - 1]?.label ? row.label : ""}</th>
                  <td>{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="source-preview__passage-text">{text}</p>
      )}
    </section>
  );
}

/** Read "row, column = value. row, column = value." back into rows, or null. */
function spreadsheetPassage(text: string): { heading?: string; rows: { label: string; value: string }[] } | null {
  const statements = text.split(/\.\s+(?=[^=]{1,400}?\s=\s)/);
  const cells = statements.map((statement, index) => {
    const split = statement.indexOf(" = ");
    if (split < 0) return null;
    const key = statement.slice(0, split).trim();
    let value = statement.slice(split + 3).trim();
    // A passage can end mid-statement ("4, DANH SÁCH…" with no value yet);
    // that fragment belongs to the next passage, not to this cell.
    if (index === statements.length - 1) value = value.replace(/\.\s+[^=]*$/, "");
    value = value.replace(/\.$/, "");
    const comma = key.indexOf(", ");
    // A short leading part is the row label; the rest is the column heading.
    return comma > 0 && comma <= 40
      ? { row: key.slice(0, comma), column: key.slice(comma + 2), value }
      : { row: "", column: key, value };
  });
  if (cells.length < 2 || cells.some((cell) => cell === null)) return null;
  const parsed = cells as { row: string; column: string; value: string }[];
  // A merged title cell repeats on every row; the column most cells share is
  // the heading. A passage that starts mid-statement carries only the tail
  // of that heading, which still names the same column.
  const counts: Record<string, number> = {};
  for (const cell of parsed) counts[cell.column] = (counts[cell.column] ?? 0) + 1;
  const [dominant, seen] = Object.entries(counts).sort((left, right) => right[1] - left[1])[0];
  const heading = seen * 2 >= parsed.length ? dominant : undefined;
  const underHeading = (column: string) => heading !== undefined && (column === heading || heading.endsWith(column));
  return {
    heading,
    rows: parsed.map((cell) => ({
      label: underHeading(cell.column) ? cell.row : [cell.row, cell.column].filter(Boolean).join(" · "),
      value: cell.value,
    })),
  };
}

function isHtmlSource(viewer: KnowledgeItemViewer): boolean {
  const contentType = viewer.content_type.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "text/html" || /\.(?:html?|xhtml)$/i.test(viewer.title);
}

/** Every reason a page image is not available, told apart honestly. */
function UnrenderedSource({ viewer }: { viewer: KnowledgeItemViewer }) {
  if (viewer.status === "pending_content") {
    return (
      <PreviewNotice
        icon="spinner"
        title="Preview is still being prepared"
        detail="This document is processed. Its page previews are still being drawn."
      />
    );
  }
  return (
    <PreviewNotice
      icon="warning"
      title="No page preview for this source"
      detail={
        viewer.focus?.citation.section
          ? `The citation points at “${viewer.focus.citation.section}”.`
          : "The cited text is shown below."
      }
      link={
        viewer.external_url || viewer.document_url
          ? { href: viewer.external_url || viewer.document_url!, label: "Open original" }
          : undefined
      }
    />
  );
}

function PreviewNotice({
  detail,
  icon,
  link,
  onRetry,
  title,
}: {
  detail?: string;
  icon: "spinner" | "warning";
  link?: { href: string; label: string };
  onRetry?: () => void;
  title: string;
}) {
  return (
    <div className="source-preview__notice" role={icon === "spinner" ? "status" : "alert"}>
      {icon === "spinner" ? (
        <LoaderCircle aria-hidden="true" className="source-preview__spinner" size={18} />
      ) : (
        <FileWarning aria-hidden="true" size={18} />
      )}
      <p className="source-preview__notice-title">{title}</p>
      {detail && <p className="source-preview__notice-detail">{detail}</p>}
      {link && (
        <a
          className="source-preview__notice-link"
          href={link.href}
          rel="noopener noreferrer"
          target="_blank"
        >
          {link.label} <ExternalLink aria-hidden="true" size={12} />
        </a>
      )}
      {onRetry && <button className="source-preview__notice-retry" onClick={onRetry} type="button">Retry source</button>}
    </div>
  );
}

type SourceViewerFailure = {
  kind: "permission_denied" | "unavailable";
};

function sourceViewerFailure(cause: unknown): SourceViewerFailure {
  if (cause instanceof KnowledgeViewerRequestError && (cause.status === 401 || cause.status === 403)) {
    return { kind: "permission_denied" };
  }
  return { kind: "unavailable" };
}
