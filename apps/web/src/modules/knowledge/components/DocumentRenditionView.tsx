"use client";

import { ExternalLink, FileWarning, Image as ImageIcon } from "lucide-react";
import { Fragment, memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Highlight } from "@/components/patterns/Highlight";
import { Button } from "@/components/ui/Button";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import {
  blockText,
  citedMarks,
  isSpreadsheetType,
  loadRendition,
  markableText,
  renditionPages,
  type CitedMark,
  type CitedMarks,
  type DocumentRendition,
  type PassageCitation,
  type RenditionBlock,
  type TableBlock,
} from "../rendition";
import type { PreviewRendition, ViewerCitation } from "../types";
import { Marked } from "./Marked";

/** Rows laid out (or skipped) together; the browser skips whole groups off screen. */
const ROW_GROUP = 100;
/** Rows sampled to size a table's columns; the rest wrap inside them. */
const COLUMN_SAMPLE = 200;
const NO_MARKS: CitedMarks = { blocks: new Map() };
const NO_PASSAGES: PassageCitation[] = [];

interface RenditionViewProps {
  itemId: string;
  rendition: PreviewRendition;
  /** Decides whether `page` reads as a sheet or a page. */
  contentType: string;
  /** One cited passage; shorthand for `passages={[{ citation, chunkText }]}`. */
  citation?: Pick<ViewerCitation, "spans"> | null;
  chunkText?: string | null;
  /** Every cited passage of this document, in citation order. */
  passages?: readonly PassageCitation[];
  /** The passage in `passages` the reader is on. */
  focusIndex?: number;
  /** `pages` sets each source page on its own sheet, as the full viewer does. */
  layout?: "column" | "pages";
  /** The document's page count, for "Page 3 of 48"; defaults to the pages present. */
  pageCount?: number | null;
  /** Find-in-document. Empty when the reader is not searching. */
  search?: string;
  originalUrl?: string | null;
  /** Re-sign the URLs; a failed download may only have outlived its URL. */
  onRetry?: () => void;
}

/**
 * The whole document, read from its rendition.
 *
 * Shared by the document viewer (`layout="pages"`: one sheet per source page),
 * the chat source panel and the chat file panel (`layout="column"`). Long
 * documents and large sheets stay cheap because blocks and row groups use
 * `content-visibility`, so only what is on screen is laid out. Cited passages
 * are evidence marks on the quoted words (rows, in a table); the focused one is
 * scrolled to whenever it changes.
 */
export function DocumentRenditionView({
  chunkText,
  citation,
  contentType,
  focusIndex = 0,
  itemId,
  layout = "column",
  onRetry,
  originalUrl,
  pageCount,
  passages,
  rendition,
  search = "",
}: RenditionViewProps) {
  const key = `${itemId}:${rendition.version}`;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; document?: DocumentRendition; failed?: true }>();
  // Each viewer read re-signs the URL; only the version names new content, so
  // a loaded version is never read again for a fresh URL.
  const loadedKey = useRef<string>(undefined);

  useEffect(() => {
    if (loadedKey.current === key) return;
    const controller = new AbortController();
    void loadRendition(itemId, rendition, controller.signal)
      .then((document) => {
        loadedKey.current = key;
        setLoaded({ key, document });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, failed: true });
      });
    return () => controller.abort();
  }, [attempt, itemId, key, rendition]);

  const document = loaded?.key === key ? loaded.document : undefined;

  if (loaded?.key === key && loaded.failed) {
    return (
      <div className="source-preview__notice" role="alert">
        <FileWarning aria-hidden="true" size={18} />
        <p className="source-preview__notice-title">The document text didn’t load</p>
        <p className="source-preview__notice-detail">Try again, or open the original file.</p>
        <Button
          className="mt-2"
          onClick={() => {
            setLoaded(undefined);
            // Re-signing hands back a new `rendition`, which reloads it.
            if (onRetry) onRetry();
            else setAttempt((value) => value + 1);
          }}
          size="sm"
          variant="secondary"
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!document) return <PageLoadingSkeleton className="doc-rendition__loading" label="Loading document text" />;
  return (
    <RenditionDocument
      chunkText={chunkText}
      citation={citation}
      contentType={contentType}
      document={document}
      focusIndex={focusIndex}
      layout={layout}
      originalUrl={originalUrl}
      pageCount={pageCount}
      passages={passages}
      search={search}
    />
  );
}

type RenditionDocumentProps = Omit<RenditionViewProps, "itemId" | "rendition" | "onRetry"> & {
  document: DocumentRendition;
};

/**
 * A rendition already in hand, drawn with its evidence marks. The viewer also
 * uses it for documents indexed before renditions existed, built from the
 * passages the index holds.
 */
export function RenditionDocument({
  chunkText,
  citation,
  contentType,
  document,
  focusIndex = 0,
  layout = "column",
  originalUrl,
  pageCount,
  passages,
  search = "",
}: RenditionDocumentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cited = useMemo(
    () => passages ?? (citation || chunkText ? [{ citation, chunkText }] : NO_PASSAGES),
    [chunkText, citation, passages],
  );
  const marks = useMemo(
    () => (cited.length ? citedMarks(document, cited, focusIndex) : NO_MARKS),
    [cited, document, focusIndex],
  );
  const query = useDeferredValue(search).trim().toLowerCase();

  // Scroll to the focused passage once its blocks are on the page.
  useEffect(() => {
    if (!marks.focusBlockId) return;
    const block = containerRef.current?.querySelector(`[data-block-id="${CSS.escape(marks.focusBlockId)}"]`);
    const target = block?.querySelector("mark[data-focus], [data-cited-row]") ?? block;
    return target ? reveal(target) : undefined;
  }, [marks]);

  useEffect(() => {
    const target = query ? containerRef.current?.querySelector("mark.knowledge-mark") : null;
    return target ? reveal(target) : undefined;
  }, [query]);

  const pageLabel = isSpreadsheetType(contentType) ? "Sheet" : "Page";
  const matching = query
    ? document.blocks.filter((block) => blockText(block).toLowerCase().includes(query))
    : document.blocks;
  const matched = new Set(matching);
  const slot = (block: RenditionBlock, separator?: string) => (
    <BlockSlot
      block={block}
      key={block.id}
      mark={marks.blocks.get(block.id)}
      query={matched.has(block) && query ? query : ""}
      separator={separator}
    />
  );
  const notes = (
    <>
      {query && !matching.length && <p className="doc-rendition__note">Nothing in this document matches “{search.trim()}”.</p>}
      {!document.blocks.length && <p className="doc-rendition__note">This document has no readable text.</p>}
      {document.truncated && (
        <p className="doc-rendition__note doc-rendition__note--end">
          Showing the first part of this file. Open the original for the rest.
          {originalUrl && (
            <a href={originalUrl} rel="noopener noreferrer" target="_blank">
              Open original <ExternalLink aria-hidden="true" size={12} />
            </a>
          )}
        </p>
      )}
    </>
  );

  if (layout === "pages") {
    const pages = renditionPages(document);
    const total = Math.max(pageCount ?? 0, ...pages.map((page) => page.page ?? 0));
    return (
      <div className="doc-rendition doc-rendition--pages" ref={containerRef}>
        {pages.map((page, index) => {
          const name = page.page === null ? undefined : `${pageLabel} ${page.page}`;
          return (
            <Fragment key={`${page.page ?? "none"}:${index}`}>
              <section
                aria-label={name}
                className={cn("doc-reader-page", pageLabel === "Sheet" && "doc-reader-page--sheet")}
                data-page={page.page ?? undefined}
              >
                {page.blocks.map((block) => slot(block))}
              </section>
              {name && pages.length > 1 && (
                <p className="doc-reader-page-no">{total > 1 ? `${name} of ${total}` : name}</p>
              )}
            </Fragment>
          );
        })}
        {(query || !document.blocks.length || document.truncated) && <div className="doc-reader-notes">{notes}</div>}
      </div>
    );
  }

  const separators = new Set(document.blocks.map((block) => block.page).filter((page) => page !== null)).size > 1;
  let currentPage: number | null = null;
  return (
    <div className="doc-rendition" ref={containerRef}>
      {document.blocks.map((block) => {
        const separator = separators && block.page !== null && block.page !== currentPage;
        if (block.page !== null) currentPage = block.page;
        return slot(block, separator ? `${pageLabel} ${block.page}` : undefined);
      })}
      {notes}
    </div>
  );
}

/**
 * A block's text with its evidence mark (the quoted words, or all of it) and
 * any find-in-document matches outside the mark.
 */
function CitedText({ text, mark, query }: { text: string; mark?: CitedMark; query: string }) {
  if (!mark) return <Marked query={query} text={text} />;
  const { start, end } = mark.range ?? { start: 0, end: text.length };
  return (
    <>
      {start > 0 && <Marked query={query} text={text.slice(0, start)} />}
      <Highlight focus={mark.focus}>{text.slice(start, end)}</Highlight>
      {end < text.length && <Marked query={query} text={text.slice(end)} />}
    </>
  );
}

/**
 * One block, memoized: a new citation or search re-renders only the blocks
 * whose highlight actually changes.
 */
const BlockSlot = memo(function BlockSlot({
  block,
  mark,
  query,
  separator,
}: {
  block: RenditionBlock;
  mark?: CitedMark;
  query: string;
  separator?: string;
}) {
  // A table with cited rows marks the rows; one without marks the whole grid.
  const boxed = mark && block.kind === "table" && !mark.rows;
  const className = `doc-rendition__block doc-rendition__${block.kind}${boxed ? " doc-rendition__cited" : ""}`;
  const text = block.kind === "table" ? "" : markableText(block);
  return (
    <>
      {separator && <div className="doc-rendition__page" role="separator">{separator}</div>}
      {block.kind === "heading" ? (
        <Heading className={className} id={block.id} level={block.level}>
          <CitedText mark={mark} query={query} text={text} />
        </Heading>
      ) : block.kind === "paragraph" ? (
        <p className={className} data-block-id={block.id}><CitedText mark={mark} query={query} text={text} /></p>
      ) : block.kind === "code" ? (
        <pre className={className} data-block-id={block.id} data-language={block.language ?? undefined}>
          <code><CitedText mark={mark} query={query} text={text} /></code>
        </pre>
      ) : block.kind === "image" ? (
        block.text ? (
          <figure className={className} data-block-id={block.id}>
            <ImageIcon aria-hidden="true" size={14} />
            <figcaption>
              <span className="doc-rendition__image-label">Image</span>
              <CitedText mark={mark} query={query} text={text} />
            </figcaption>
          </figure>
        ) : null
      ) : block.kind === "link" ? (
        <p className={className} data-block-id={block.id}>
          {/^(?:https?:|mailto:)/i.test(block.url) ? (
            <a href={block.url} rel="noopener noreferrer" target="_blank">
              <CitedText mark={mark} query={query} text={text} />
              <ExternalLink aria-hidden="true" size={12} />
            </a>
          ) : (
            <CitedText mark={mark} query={query} text={text} />
          )}
        </p>
      ) : (
        <Table block={block} className={className} citedRows={mark?.rows} query={query} />
      )}
    </>
  );
});

function Heading({
  children,
  className,
  id,
  level,
}: {
  children: React.ReactNode;
  className: string;
  id: string;
  level: number;
}) {
  const Tag = level <= 1 ? "h2" : level === 2 ? "h3" : "h4";
  return <Tag className={className} data-block-id={id}>{children}</Tag>;
}

/**
 * A table as a grid of fixed columns.
 *
 * Every row is its own grid on the same column template, so rows line up
 * without a `<table>` — whose row groups cannot take `content-visibility` —
 * and a 20,000-row sheet lays out only the groups on screen.
 */
function Table({
  block,
  citedRows,
  className,
  query,
}: {
  block: TableBlock;
  citedRows?: Set<number>;
  className: string;
  query: string;
}) {
  const layout = useMemo(() => tableLayout(block), [block]);
  const groups: number[] = [];
  for (let start = 0; start < block.rows.length; start += ROW_GROUP) groups.push(start);
  const visibleRows = Math.min(block.rows.length + 1, 20);

  return (
    <figure
      className={className}
      data-block-id={block.id}
      style={{ containIntrinsicSize: `auto ${visibleRows * 2 + 2}rem` }}
    >
      {block.caption && <figcaption className="doc-rendition__caption"><Marked query={query} text={block.caption} /></figcaption>}
      <div className="doc-rendition__table-scroll">
        <div
          aria-colcount={layout.columns.length + 1}
          aria-label={block.caption ?? undefined}
          aria-rowcount={block.total_rows + 1}
          className="doc-rendition__grid"
          role="table"
          style={{ "--doc-columns": layout.template, width: layout.width } as React.CSSProperties}
        >
          <div className="doc-rendition__head" role="rowgroup">
            <div aria-rowindex={1} className="doc-rendition__row" role="row">
              <span className="doc-rendition__rownum" role="columnheader"><span className="sr-only">Row</span></span>
              {layout.columns.map((column, index) => (
                <span key={index} role="columnheader"><Marked query={query} text={column} /></span>
              ))}
            </div>
          </div>
          {groups.map((start) => {
            const rows = block.rows.slice(start, start + ROW_GROUP);
            const end = start + rows.length;
            const cited = citedRows && [...citedRows].some((index) => index >= start && index < end) ? citedRows : undefined;
            const matches = query && rows.some((row) => row.some((cell) => cell.toLowerCase().includes(query)));
            return (
              <RowGroup
                cited={cited}
                columnCount={layout.columns.length}
                key={start}
                query={matches ? query : ""}
                rows={rows}
                start={start}
              />
            );
          })}
        </div>
      </div>
      {block.total_rows > block.rows.length && (
        <p className="doc-rendition__note">
          Showing {block.rows.length.toLocaleString()} of {block.total_rows.toLocaleString()} rows.
        </p>
      )}
    </figure>
  );
}

const RowGroup = memo(function RowGroup({
  cited,
  columnCount,
  query,
  rows,
  start,
}: {
  cited?: Set<number>;
  columnCount: number;
  query: string;
  rows: string[][];
  start: number;
}) {
  const cells = Array.from({ length: columnCount }, (_, index) => index);
  return (
    <div
      className="doc-rendition__rows"
      role="rowgroup"
      style={{ containIntrinsicSize: `auto ${rows.length * 2}rem` }}
    >
      {rows.map((row, offset) => {
        const index = start + offset;
        return (
          <div
            aria-rowindex={index + 2}
            className={cited?.has(index) ? "doc-rendition__row doc-rendition__row--cited doc-rendition__cited" : "doc-rendition__row"}
            data-cited-row={cited?.has(index) || undefined}
            key={index}
            role="row"
          >
            <span className="doc-rendition__rownum" role="rowheader">{index + 1}</span>
            {cells.map((cell) => (
              <span key={cell} role="cell">{query ? <Marked query={query} text={row[cell] ?? ""} /> : row[cell]}</span>
            ))}
          </div>
        );
      })}
    </div>
  );
});

/** Column headings and widths from the header and the first rows. */
function tableLayout(block: TableBlock): { columns: string[]; template: string; width: string } {
  let count = block.columns.length;
  for (const row of block.rows) count = Math.max(count, row.length);
  // A sheet without a header row is addressed the way a spreadsheet does.
  const columns = Array.from({ length: count }, (_, index) => block.columns[index] ?? columnLetter(index));
  const lengths = columns.map((column) => column.length);
  for (const row of block.rows.slice(0, COLUMN_SAMPLE)) {
    row.forEach((cell, index) => {
      lengths[index] = Math.max(lengths[index] ?? 0, cell.length);
    });
  }
  // About two characters per rem at body size, between a narrow and a wide column.
  const widths = lengths.map((length) => Math.min(20, Math.max(5, length * 0.5 + 1.5)));
  const rowNumber = Math.max(2.5, String(block.total_rows).length * 0.6 + 1.25);
  const last = widths.length - 1;
  const tracks = widths.map((width, index) => (index === last ? `minmax(${width}rem, 1fr)` : `${width}rem`));
  return {
    columns,
    template: [`${rowNumber}rem`, ...tracks].join(" "),
    width: `max(100%, ${rowNumber + widths.reduce((sum, width) => sum + width, 0)}rem)`,
  };
}

function columnLetter(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

/** Scroll passes before giving up on a target whose position keeps settling. */
const REVEAL_PASSES = 3;

/**
 * Center `target`, even inside blocks the browser has not laid out yet.
 *
 * Off-screen blocks and row groups only have placeholder sizes, so the first
 * scroll lands near the target; once it is on screen it gets its real box and
 * the next pass settles on it. Returns a cancel for the pending passes.
 */
function reveal(target: Element): () => void {
  let frame = 0;
  const pass = (remaining: number) => {
    target.scrollIntoView({ block: "center" });
    if (remaining > 1) frame = requestAnimationFrame(() => pass(remaining - 1));
  };
  pass(REVEAL_PASSES);
  return () => cancelAnimationFrame(frame);
}
