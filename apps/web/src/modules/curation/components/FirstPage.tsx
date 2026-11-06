"use client";

import { useQuery } from "@tanstack/react-query";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, rawFetch, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { getItemContent, mediaPath, type Item, type ItemContent } from "@/modules/knowledge/api";

/**
 * What a reviewer can see of a document before it's published: the first rendered page when the
 * document was processed (`GetItemContent`), else the original's text for text formats
 * (`alt=media`, readable by reviewers of an open submission). Anything else has no preview yet.
 */

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml))/;
const MAX_TEXT = 6000;

export type FirstPage =
  | { kind: "page"; pages: number; image?: string; elements: NonNullable<ItemContent["elements"]> }
  | { kind: "text"; markdown: boolean; text: string }
  | { kind: "none" };

async function loadFirstPage(ws: string, item: Item): Promise<FirstPage> {
  const name = item.name ?? "";
  try {
    const content = await getItemContent(ws, name);
    const elements = (content.elements ?? []).filter((e) => (e.pageNumber ?? 1) === 1);
    const pages = Math.max(1, ...(content.elements ?? []).map((e) => e.pageNumber ?? 1), ...(content.pageAssets ?? []).map((a) => a.pageNumber ?? 1));
    const image = content.pageAssets?.find((a) => a.pageNumber === 1)?.imageUri;
    if (elements.length || image) return { kind: "page", pages, image, elements };
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
  const raw = page.kind === "text" ? page.text.replace(/[#>*_`|-]+/g, " ") : page.elements.map((e) => e.text ?? "").join(" ");
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
  if (page.kind === "page" && page.image && !page.elements.length) {
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
        {page.elements.map((e, i) =>
          e.kind === "HEADING" ? (
            (e.level ?? 1) <= 1 ? <h2 key={i}>{e.text}</h2> : <h3 key={i}>{e.text}</h3>
          ) : e.kind === "CODE" ? (
            <pre key={i}>{e.text}</pre>
          ) : (
            <p key={i}>{e.text}</p>
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
