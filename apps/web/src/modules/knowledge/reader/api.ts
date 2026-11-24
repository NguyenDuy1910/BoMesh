"use client";

import { api, call, resourceId, type Schema } from "@/lib/api/client";

/**
 * Reader API (`/api/v1`, document_viewer.md): passages (citation targets), revisions
 * (version history, `?v=`), citations of a conversation (`?from=`) and reprocessing a
 * document that isn't readable. Items, content and the library come from
 * the knowledge core (`../api`).
 */

export type ItemPassage = Schema<"ItemPassage">;
export type ItemRevision = Schema<"ItemRevision">;
export type Citation = Schema<"Citation">;

const it = (workspace: string, item: string) => ({ workspace, item: resourceId(item) });

/** One citation target (always of the document's `indexedRevision`). */
export function getPassage(workspace: string, item: string, passage: string): Promise<ItemPassage> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/items/{item}/passages/{passage}", {
      params: { path: { ...it(workspace, item), passage: resourceId(passage) } },
    }),
  );
}

/** Versions the Reader lists (one page, newest first); an older one past it is read on its own (`getItemRevision`). */
const REVISIONS_PAGE = 50;

/** The newest stored versions of a document (one page), newest first. */
export async function listItemRevisions(workspace: string, item: string): Promise<ItemRevision[]> {
  const page = await call(api.GET("/api/v1/workspaces/{workspace}/items/{item}/revisions", { params: { path: it(workspace, item), query: { pageSize: REVISIONS_PAGE } } }));
  const n = (r: ItemRevision) => Number(resourceId(r.name));
  return (page.revisions ?? []).sort((a, b) => n(b) - n(a));
}

/** One stored version of a document (by number). */
export function getItemRevision(workspace: string, item: string, revision: number): Promise<ItemRevision> {
  return call(api.GET("/api/v1/workspaces/{workspace}/items/{item}/revisions/{revision}", { params: { path: { ...it(workspace, item), revision: String(revision) } } }));
}

/** Cited messages read for the Reader's `?from=` (one page: the answers that cite this document). */
const CITING_PAGE = 50;

/**
 * Passages a conversation's answers cited in one document, in citation order (Reader `?from=`): one page of the
 * conversation's messages that cite it (`citations.item`), never the whole conversation.
 */
export async function conversationCitations(workspace: string, conversation: string, item: string): Promise<Citation[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}/messages", {
      params: {
        path: { workspace, conversation: resourceId(conversation) },
        query: { filter: `role = ASSISTANT AND citations.item:"workspaces/${workspace}/items/${resourceId(item)}"`, pageSize: CITING_PAGE },
      },
    }),
  );
  const itemId = resourceId(item);
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const message of page.messages ?? []) {
    for (const citation of message.citations ?? []) {
      if (!citation.available || !citation.passage || resourceId(citation.item) !== itemId || seen.has(citation.passage)) continue;
      seen.add(citation.passage);
      out.push(citation);
    }
  }
  return out;
}
