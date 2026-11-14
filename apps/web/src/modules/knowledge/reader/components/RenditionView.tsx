"use client";

import { Button } from "@heroui/react";
import clsx from "clsx";
import { memo, useState, type ReactNode } from "react";

import { fmtNum } from "@/lib/format";

import type { DocFormat } from "../format";
import type { BlockMarks, DocumentMarks, MarkRange } from "../marks";
import { markableText, renditionPages, type DocumentRendition, type RenditionBlock, type TableBlock, type TextBlock } from "../rendition";

/** Rows shown before "Show more rows"; cited rows past it are always shown. */
const ROW_STEP = 300;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface RenditionViewProps {
  rendition: DocumentRendition;
  marks: DocumentMarks;
  /** The mark the reader is on (`mark.evidence.is-focus`). */
  focusHit?: number;
  /** The file's native format: decides the page chrome (running header, page/slide numbers). */
  format: DocFormat;
  /** Pages of the source, for "Page 3 of 48" and the gaps between rendered pages. */
  pageCount?: number;
  /** PDF running header on every page after the first: the document and its workspace. */
  runningHead?: readonly [string, string];
}

/** Pages a rendition reads as in its native format (preview documents.js `model().count`). */
export function renditionPageCount(rendition: DocumentRendition, format: DocFormat, pageCount = 0): number {
  const pages = renditionPages(rendition);
  if (format === "slide") return pages.length;
  return Math.max(pageCount, 1, ...pages.map((p) => p.page ?? 0));
}

/**
 * The document's own pages (preview reader.js `viewerHtml` + documents.js `model`): the rendition's
 * headings, paragraphs, lists and tables laid out as the file's app shows them — PDF and Word pages
 * with their print chrome, a slide deck, sheets with gridlines and tabs, or one continuous page for
 * Markdown, web pages, text and email — with evidence marks on cited passages and search matches.
 * Paged formats carry `data-n` (page or slide number) for the viewer bar. Document content is never
 * localized (`translate="no"`).
 */
export function RenditionView({ rendition, marks, focusHit = -1, format, pageCount = 0, runningHead }: RenditionViewProps) {
  const body = (blocks: readonly RenditionBlock[]) =>
    blocks.map((block) => {
      const blockMarks = marks.blocks.get(block.id);
      // Only marked blocks depend on the focused mark, so the rest stay memoized while stepping.
      return <Block key={block.id} block={block} marks={blockMarks} focusHit={blockMarks ? focusHit : -1} title={block === rendition.blocks[0] && block.kind === "heading"} />;
    });

  const pages = renditionPages(rendition);
  const truncated = rendition.truncated ? <p className="doc-gap">Showing the first part of this file. Download it for the rest.</p> : null;
  // A "sheet" without tables reads as pages (preview: no sheet pages → pdf).
  const f: DocFormat = format === "sheet" && !rendition.blocks.some((b) => b.kind === "table") ? "pdf" : format;

  if (f === "sheet") {
    return (
      <>
        {pages.map((page, index) => (
          <div key={`${page.page ?? "none"}:${index}`} className="doc-page doc-page--sheet" data-page={page.page ?? undefined} translate="no">
            <SheetPage blocks={page.blocks} marks={marks} focusHit={focusHit} />
            {pages.length > 1 ? (
              <div className="doc-sheet__tabs">
                {pages.map((p, i) => (
                  <span key={i} className={clsx(i === index && "is-on")}>
                    {`Sheet ${p.page ?? i + 1}`}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {truncated}
      </>
    );
  }

  if (f !== "pdf" && f !== "docx" && f !== "slide") {
    // Web-like files have no pages: one continuous page (passages keep their page for citations).
    return (
      <>
        <section className={`doc-page doc-page--${f}`} data-page={pages[0]?.page ?? 1}>
          {body(rendition.blocks)}
        </section>
        {truncated}
      </>
    );
  }

  const total = renditionPageCount(rendition, f, pageCount);
  const out: ReactNode[] = [];
  let prev = 0;
  const gap = (from: number, to: number) => (
    <div key={`gap-${from}`} className="doc-gap">
      {from === to ? `Page ${from}` : `Pages ${from}–${to}`}
    </div>
  );
  pages.forEach((page, index) => {
    const no = page.page ?? prev + 1;
    const n = f === "slide" ? index + 1 : no;
    if (f !== "slide" && no > prev + 1) out.push(gap(prev + 1, no - 1));
    const titleSlide = f === "slide" && index === 0 && page.blocks[0] === rendition.blocks[0] && page.blocks[0]?.kind === "heading";
    out.push(
      <div key={`${no}:${index}`} className={clsx("doc-page", `doc-page--${f}`, titleSlide && "doc-slide--title")} data-page={no} data-n={n}>
        {f === "pdf" && index > 0 && runningHead ? (
          <div className="doc-run" aria-hidden>
            <span>{runningHead[0]}</span>
            <span>{runningHead[1]}</span>
          </div>
        ) : null}
        {body(page.blocks)}
        <div className="doc-foot" aria-hidden>
          {f === "docx" ? `Page ${no} of ${total}` : String(n)}
        </div>
      </div>,
    );
    prev = no;
  });
  if (f !== "slide" && total > prev) out.push(gap(prev + 1, total));
  return (
    <>
      {out}
      {truncated}
    </>
  );
}

/* ═══════════════ Marked text ═══════════════ */

function Marked({ text, ranges, focusHit }: { text: string; ranges?: readonly MarkRange[]; focusHit: number }) {
  if (!ranges?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) out.push(text.slice(at, r.start));
    out.push(
      <mark key={r.hit} className={clsx("evidence", r.hit === focusHit && "is-focus")} data-hit={r.hit}>
        {text.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** All of a cell's text as one mark (a cited row, or a cited table). */
function WholeMark({ text, hit, focusHit }: { text: string; hit: number; focusHit: number }) {
  if (!text) return null;
  return (
    <mark className={clsx("evidence", hit === focusHit && "is-focus")} data-hit={hit}>
      {text}
    </mark>
  );
}

/* ═══════════════ Blocks ═══════════════ */

const Block = memo(function Block({ block, marks, focusHit, title }: { block: RenditionBlock; marks?: BlockMarks; focusHit: number; title: boolean }) {
  if (block.kind === "table") return <TableView block={block} marks={marks} focusHit={focusHit} />;
  const text = <Marked text={markableText(block)} ranges={marks?.text} focusHit={focusHit} />;
  switch (block.kind) {
    case "heading":
      return title ? (
        <h2 data-block-id={block.id}>{text}</h2>
      ) : (
        <h3 id={`dh-${block.id}`} data-block-id={block.id}>
          {text}
        </h3>
      );
    case "code":
      return (
        <pre data-block-id={block.id}>
          <code>{text}</code>
        </pre>
      );
    case "image":
      return block.text ? (
        <p className="doc-sub" data-block-id={block.id}>
          {text}
        </p>
      ) : null;
    case "link":
      return (
        <p data-block-id={block.id}>
          {/^(?:https?:|mailto:)/i.test(block.url) ? (
            <a className="link" href={block.url} target="_blank" rel="noopener noreferrer">
              {text}
            </a>
          ) : (
            text
          )}
        </p>
      );
    default:
      return <p data-block-id={block.id}>{text}</p>;
  }
});

/** Rows to render: the first `ROW_STEP` (and every cited row), more on request. */
function useRowLimit(block: TableBlock, marks?: BlockMarks) {
  const cited = marks?.rows ? Math.max(...marks.rows.keys()) + 1 : 0;
  const [limit, setLimit] = useState(ROW_STEP);
  const shown = Math.min(block.rows.length, Math.max(limit, cited));
  return { shown, more: shown < block.rows.length ? () => setLimit(shown + ROW_STEP) : undefined };
}

function cellMark(marks: BlockMarks | undefined, r: number, c: number, value: string, focusHit: number) {
  const whole = marks?.rows?.get(r) ?? marks?.whole;
  if (whole !== undefined) return <WholeMark text={value} hit={whole} focusHit={focusHit} />;
  return <Marked text={value} ranges={marks?.cells?.get(`${r}:${c}`)} focusHit={focusHit} />;
}

function MoreRows({ block, shown, more }: { block: TableBlock; shown: number; more?: () => void }) {
  const hidden = block.total_rows - shown;
  if (hidden <= 0) return null;
  return (
    <p className="doc-note">
      {`Showing ${fmtNum(shown)} of ${fmtNum(block.total_rows)} rows.`}
      {more ? (
        <Button size="sm" variant="ghost" onPress={more}>
          Show more rows
        </Button>
      ) : null}
    </p>
  );
}

function TableView({ block, marks, focusHit }: { block: TableBlock; marks?: BlockMarks; focusHit: number }) {
  const { shown, more } = useRowLimit(block, marks);
  const width = Math.max(block.columns.length, ...block.rows.slice(0, shown).map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => i);
  return (
    <div data-block-id={block.id}>
      {block.caption ? (
        <p className="doc-sub">
          <Marked text={block.caption} ranges={marks?.text} focusHit={focusHit} />
        </p>
      ) : null}
      <table>
        {block.columns.length ? (
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>
                  <Marked text={block.columns[c] ?? ""} ranges={marks?.cells?.get(`-1:${c}`)} focusHit={focusHit} />
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {block.rows.slice(0, shown).map((row, r) => (
            <tr key={r}>
              {cols.map((c) => (
                <td key={c}>{cellMark(marks, r, c, row[c] ?? "", focusHit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <MoreRows block={block} shown={shown} more={more} />
    </div>
  );
}

/* ═══════════════ Sheets ═══════════════ */

const NUMERIC = /^-?[\d.,\s]+%?$/;

/** Spreadsheet column name (0 → A, 26 → AA). */
export function columnLetter(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = LETTERS[(value - 1) % 26] + name;
  return name;
}

/** A sheet page (preview `b.sheet`): its tables as a grid with row numbers and column letters, other blocks as notes. */
function SheetPage({ blocks, marks, focusHit }: { blocks: readonly RenditionBlock[]; marks: DocumentMarks; focusHit: number }) {
  const notes = blocks.filter((b): b is Exclude<TextBlock, { kind: "heading" }> => b.kind !== "table" && b.kind !== "heading");
  return (
    <>
      {blocks.map((b) => (b.kind === "table" ? <SheetTable key={b.id} block={b} marks={marks.blocks.get(b.id)} focusHit={focusHit} /> : null))}
      {notes.length ? (
        <div className="doc-sheet__notes">
          {notes.map((b) => (
            <p key={b.id} className="doc-note" data-block-id={b.id}>
              <Marked text={markableText(b)} ranges={marks.blocks.get(b.id)?.text} focusHit={focusHit} />
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}

function SheetTable({ block, marks, focusHit }: { block: TableBlock; marks?: BlockMarks; focusHit: number }) {
  const { shown, more } = useRowLimit(block, marks);
  const width = Math.max(block.columns.length, ...block.rows.slice(0, shown).map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => i);
  const header = block.columns.length > 0;
  return (
    <div className="doc-sheet" data-block-id={block.id}>
      <table>
        <thead>
          <tr>
            <th className="doc-sheet__rn" />
            {cols.map((c) => (
              <th key={c}>{columnLetter(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {header ? (
            <tr className="doc-sheet__hdr">
              <td className="doc-sheet__rn">1</td>
              {cols.map((c) => (
                <td key={c}>
                  <Marked text={block.columns[c] ?? ""} ranges={marks?.cells?.get(`-1:${c}`)} focusHit={focusHit} />
                </td>
              ))}
            </tr>
          ) : null}
          {block.rows.slice(0, shown).map((row, r) => (
            <tr key={r}>
              <td className="doc-sheet__rn">{r + (header ? 2 : 1)}</td>
              {cols.map((c) => (
                <td key={c} className={clsx(NUMERIC.test(row[c] ?? "") && "num")}>
                  {cellMark(marks, r, c, row[c] ?? "", focusHit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <MoreRows block={block} shown={shown} more={more} />
    </div>
  );
}
