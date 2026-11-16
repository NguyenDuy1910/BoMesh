"use client";

import type { ReactNode } from "react";

import type { DocumentCover } from "../../api";
import { PAGED_FORMATS, type DocFormat } from "../format";

/**
 * The cover the list already had (no extra request; its image is in the browser cache from the card),
 * drawn as the document's first page at reading size: its image, else its text in the format's shape —
 * a page with the title and first lines, a slide with its title and bullets, the first sheet's top-left
 * cells (preview reader.js `coverPages`). While the file loads or its preview is prepared (`loading`), a
 * paged document gets a sized blank after it, so nothing moves when the pages arrive. `null` without a
 * cover to draw.
 */
export function coverPages(cover: DocumentCover | undefined, format: DocFormat, { loading = true }: { loading?: boolean } = {}): ReactNode {
  if (!cover || cover.kind === "IMAGE") return null;
  const busy = loading ? ({ "aria-busy": true, "aria-label": "Loading" } as const) : {};
  if (cover.imageUri) {
    const aspectRatio = cover.widthPixels && cover.heightPixels ? `${cover.widthPixels} / ${cover.heightPixels}` : cover.kind === "SLIDE" ? "16 / 9" : "8.5 / 11";
    return (
      <div className={`doc-viewer doc-viewer--${PAGED_FORMATS[format] ? format : "pdf"}`} {...busy}>
        <div className="doc-viewer__pages" translate="no">
          <div className="doc-page doc-page--image doc-page--cover" style={{ aspectRatio }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the card's cover, already cached */}
            <img className="doc-page__img" src={cover.imageUri} alt="" width={cover.widthPixels} height={cover.heightPixels} decoding="async" draggable={false} />
          </div>
          {loading ? <div className="doc-page doc-page--image doc-page--blank" style={{ aspectRatio }} /> : null}
        </div>
      </div>
    );
  }
  const lines = cover.lines ?? [];
  const cells = cover.cells ?? [];
  const title = cover.title ? <h2>{cover.title}</h2> : null;
  if (cover.kind === "SHEET" && cells.length) {
    const cols = Math.max(...cells.map((row) => row.length));
    return (
      <div className="doc-viewer doc-viewer--sheet" translate="no" {...busy}>
        <div className="doc-page doc-page--sheet doc-page--cover">
          <div className="doc-sheet">
            <table>
              <thead>
                <tr>
                  <th className="doc-sheet__rn" />
                  {Array.from({ length: cols }, (_, j) => (
                    <th key={j}>{String.fromCharCode(65 + j)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cells.map((row, i) => (
                  <tr key={i} className={i ? undefined : "doc-sheet__hdr"}>
                    <td className="doc-sheet__rn">{i + 1}</td>
                    {Array.from({ length: cols }, (_, j) => (
                      <td key={j}>{row[j] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }
  if (!title && !lines.length) return null;
  const slide = cover.kind === "SLIDE";
  const pageClass = slide ? "doc-page--slide" : `doc-page--${format}`;
  const first = (
    <div className={`doc-page ${pageClass} doc-page--cover`}>
      {title}
      {slide ? (
        lines.length ? (
          <ul>
            {lines.slice(0, 5).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null
      ) : (
        lines.map((l, i) => <p key={i}>{l}</p>)
      )}
    </div>
  );
  if (!PAGED_FORMATS[format] && !slide) {
    return (
      <article className={`doc-viewer doc-viewer--flow doc-viewer--${format}`} translate="no" {...busy}>
        {first}
      </article>
    );
  }
  return (
    <div className={`doc-viewer doc-viewer--${slide ? "slide" : format}`} {...busy}>
      <div className="doc-viewer__pages" translate="no">
        {first}
        {loading ? <div className={`doc-page ${pageClass} doc-page--blank`} /> : null}
      </div>
    </div>
  );
}
