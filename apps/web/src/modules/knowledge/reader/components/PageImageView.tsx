"use client";

import { memo } from "react";

import type { Schema } from "@/lib/api/client";

type ItemPageAsset = Schema<"ItemPageAsset">;

export interface PageImageViewProps {
  /** Page images of the current revision, in page order. */
  pages: readonly ItemPageAsset[];
  /** The page the reader is on (`?page=`, or a citation's page): rendered eagerly. */
  focusPage?: number;
}

/**
 * The document exactly as it is (document_viewer.md "Reading (web)": *in the file's
 * native format … PDFs keep page images*). Ingestion renders one WebP per source page
 * beside the JSON rendition; this draws those pages, so a PDF keeps its own typography,
 * figures, formulas and layout instead of being reflowed into extracted text. The page
 * number is on the page itself; `data-n` feeds the viewer bar.
 *
 * The rendition is still what the assistant cites and what search matches — it is the
 * *indexed* view of the same document, a separate concern from reading it.
 */
export function PageImageView({ pages, focusPage = 0 }: PageImageViewProps) {
  return (
    <>
      {pages.map((page, index) => {
        const no = page.pageNumber ?? index + 1;
        return (
          <PageImage
            key={`${no}:${index}`}
            uri={page.imageUri!}
            no={no}
            width={page.widthPixels ?? undefined}
            height={page.heightPixels ?? undefined}
            // The first pages and the one being jumped to decode immediately; the rest on approach.
            eager={index < 2 || no === focusPage}
          />
        );
      })}
    </>
  );
}

const PageImage = memo(function PageImage({ uri, no, width, height, eager }: { uri: string; no: number; width?: number; height?: number; eager: boolean }) {
  return (
    <div className="doc-page doc-page--image" data-page={no} data-n={no}>
      {/* Not next/image: these are short-lived signed URLs on the storage host, which the
          optimizer cannot cache and would re-sign per render. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="doc-page__img"
        src={uri}
        alt={`Page ${no}`}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
      />
    </div>
  );
});
