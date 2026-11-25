"use client";

import { api, call, resourceId, type Schema } from "@/lib/api/client";

import { referenceOf, sameReference, type Reference } from "../content/reference";

/**
 * Reader API (`/api/v1`, document_viewer.md): revisions (version history, `?v=`), the references a
 * conversation cited (`?from=`) and reprocessing a document that isn't readable. Items, content and the
 * library come from the knowledge core (`../api`); the Structured Document from `../content`.
 */

export type ItemRevision = Schema<"ItemRevision">;

const it = (workspace: string, item: string) => ({ workspace, item: resourceId(item) });

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
 * References a conversation's answers cited in one document, in citation order (Reader `?from=`): one page of the
 * conversation's messages that cite it (`citations.item`), never the whole conversation.
 */
export async function conversationCitations(workspace: string, conversation: string, item: string): Promise<Reference[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}/messages", {
      params: {
        path: { workspace, conversation: resourceId(conversation) },
        query: { filter: `role = ASSISTANT AND citations.item:"workspaces/${workspace}/items/${resourceId(item)}"`, pageSize: CITING_PAGE },
      },
    }),
  );
  const itemId = resourceId(item);
  const out: Reference[] = [];
  for (const message of page.messages ?? []) {
    for (const citation of message.citations ?? []) {
      const reference = citation.available ? referenceOf(citation) : null;
      if (!reference || resourceId(reference.item) !== itemId || out.some((r) => sameReference(r, reference))) continue;
      out.push(reference);
    }
  }
  return out;
}
