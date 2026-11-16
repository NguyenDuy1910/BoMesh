"use client";

import { useQuery } from "@tanstack/react-query";

import { toast } from "@/components/ui/Toast";
import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { downloadItem, getItemPreview, type Item } from "@/modules/knowledge/api";
import { DocumentSurface } from "@/modules/knowledge/reader/components/DocumentSurface";
import { loadPdfJs, pdfSource } from "@/modules/knowledge/reader/pdf";
import { surfaceView } from "@/modules/knowledge/reader/preview";
import { parseTablePayload } from "@/modules/knowledge/reader/table";

/**
 * What a reviewer can see of a document before it's published: its first page, drawn from the
 * preview engine's representation (`GetItemPreview`, readable by reviewers of an open submission, and
 * independent of processing) — a PDF's page 1, a table's first rows, a text's first lines, the picture.
 */

/** The first page in the reader's page styling (the review pane), scrolling in its own pane. */
export function FirstPage({ item, onPages }: { item: Item; onPages?: (count: number) => void }) {
  const { id: ws } = useWorkspace();
  const download = () =>
    downloadItem(ws, item.name ?? "", item.document?.fileName || item.displayName || "document").catch((e: unknown) => toast(errorMessage(e), { tone: "danger" }));
  return <DocumentSurface document={{ id: resourceId(item.name), cover: item.document?.cover }} variant="first" onPages={onPages} onDownload={() => void download()} />;
}

/** Characters of first-page text kept for an excerpt. */
const EXCERPT_CHARS = 6000;
/** Rows of a table's first sheet, and lines of a text, that make its first page. */
const FIRST_ROWS = 50;
const FIRST_LINES = 60;

async function readRepresentation(uri: string): Promise<Response> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`The preview couldn’t be read (${response.status}).`);
  return response;
}

/** Plain text of a document's first page (compare excerpts); `null` while its preview is being prepared. */
async function loadFirstPageText(ws: string, item: Item): Promise<string | null> {
  const view = surfaceView(await getItemPreview(ws, item.name ?? ""));
  if (view.state === "PREPARING") return null;
  if (view.state !== "READY") return "";
  const { viewer, representation } = view;
  let raw = "";
  if (viewer === "pdf") {
    const pdfjs = await loadPdfJs();
    const task = pdfjs.getDocument(pdfSource(representation.uri, representation.sizeBytes));
    try {
      const page = await (await task.promise).getPage(1);
      const content = await page.getTextContent();
      raw = content.items.map((part) => ("str" in part ? part.str : "")).join(" ");
    } finally {
      void task.destroy();
    }
  } else if (viewer === "table") {
    const { sheets } = parseTablePayload(await (await readRepresentation(representation.uri)).json());
    raw = (sheets[0]?.rows ?? []).slice(0, FIRST_ROWS).map((row) => row.join(" ")).join(" ");
  } else if (viewer === "text") {
    const text = (await (await readRepresentation(representation.uri)).text()).split("\n", FIRST_LINES).join("\n");
    raw = representation.textFormat === "MARKDOWN" ? text.replace(/[#>*_`|-]+/g, " ") : text;
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
}

/** First-page text of a document, for excerpts beside another document. */
export function useFirstPageText(item: Item | null | undefined) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [id, "items", "first-page-text", resourceId(item?.name), item?.document?.revision ?? item?.etag ?? ""],
    enabled: !!item?.name,
    queryFn: () => loadFirstPageText(id, item!),
    staleTime: 5 * 60_000,
    retry: false,
    refetchInterval: (q) => (q.state.data === null ? 2_000 : false),
  });
}
