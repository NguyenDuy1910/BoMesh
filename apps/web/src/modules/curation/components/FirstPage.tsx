"use client";

import { useQuery } from "@tanstack/react-query";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, rawFetch, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { getItemContent, mediaPath, type Item } from "@/modules/knowledge/api";
import { blockText, loadRendition, type RenditionBlock } from "@/modules/knowledge/reader/rendition";

/**
 * What a reviewer can see of a document before it's published: the first page of its stored
 * rendition and page image when the document was processed (`GetItemContent`, never the search
 * index), else the original's text for text formats (`alt=media`, readable by reviewers of an
 * open submission). Anything else has no preview yet.
 */

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml))/;
const MAX_TEXT = 6000;

export type FirstPage =
  | { kind: "page"; pages: number; image?: string; blocks: RenditionBlock[] }
  | { kind: "text"; markdown: boolean; text: string }
  | { kind: "none" };

async function loadFirstPage(ws: string, item: Item): Promise<FirstPage> {
  const name = item.name ?? "";
  try {
    const content = await getItemContent(ws, name);
    const rendition = content.rendition?.uri
      ? await loadRendition(resourceId(name), { uri: content.rendition.uri, version: content.rendition.version ?? 1, revision: content.revision })
      : null;
    const all = rendition?.blocks ?? [];
    const blocks = all.filter((b) => (b.page ?? 1) === 1);
    const pages = Math.max(1, ...all.map((b) => b.page ?? 1), ...(content.pageAssets ?? []).map((a) => a.pageNumber ?? 1));
    const image = content.pageAssets?.find((a) => a.pageNumber === 1)?.imageUri;
    if (blocks.length || image) return { kind: "page", pages, image, blocks };
  } catch (error) {
    // Not rendered yet (FAILED_PRECONDITION) is expected before publishing; anything else is real.
    if (!(error instanceof ApiError) || error.status >= 500) throw error;
  }
  const mime = item.document?.mimeType ?? "";
  if (!TEXT_MIME.test(mime)) return { kind: "none" };
  const response = await rawFetch(mediaPath(ws, name));
  const text = (await response.text()).slice(0, MAX_TEXT);
  return { kind: "text", markdown: /markdown/.test(mime) || /\.(md|markdown)$/i.test(item.document?.fileName ?? ""), text };
}

export function useFirstPage(item: Item | null | undefined) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [id, "items", "first-page", resourceId(item?.name), item?.document?.revision ?? item?.etag ?? ""],
    enabled: !!item?.name,
    queryFn: () => loadFirstPage(id, item!),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Plain text of the first page (compare excerpts). */
export function firstPageText(page: FirstPage | undefined): string {
  if (!page || page.kind === "none") return "";
  const raw = page.kind === "text" ? page.text.replace(/[#>*_`|-]+/g, " ") : page.blocks.map(blockText).join(" ");
  return raw.replace(/\s+/g, " ").trim();
}

/* Headings start one level down: the page title is h2 in the reader's page styling. */
const MD: Components = {
  h1: ({ children }) => <h2>{children}</h2>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h3>{children}</h3>,
  h4: ({ children }) => <h3>{children}</h3>,
  a: ({ children }) => <span>{children}</span>,
  img: () => null,
};

/** The first page in the reader's page styling (`.doc-page`). Workspace content: not translated. */
export function FirstPageCanvas({ page }: { page: Exclude<FirstPage, { kind: "none" }> }) {
  if (page.kind === "page" && page.image && !page.blocks.length) {
    return (
      <div className="doc-page" translate="no">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived page image */}
        <img src={page.image} alt="First page" className="w-full" />
      </div>
    );
  }
  if (page.kind === "page") {
    return (
      <div className="doc-page" translate="no">
        {page.blocks.map((b) =>
          b.kind === "heading" ? (
            b.level <= 1 ? <h2 key={b.id}>{b.text}</h2> : <h3 key={b.id}>{b.text}</h3>
          ) : b.kind === "code" ? (
            <pre key={b.id}>{b.text}</pre>
          ) : (
            <p key={b.id}>{blockText(b)}</p>
          ),
        )}
      </div>
    );
  }
  return (
    <div className="doc-page" translate="no">
      {page.markdown ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
          {page.text}
        </ReactMarkdown>
      ) : (
        <p className="whitespace-pre-wrap">{page.text}</p>
      )}
    </div>
  );
}
