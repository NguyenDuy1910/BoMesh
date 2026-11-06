"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

/**
 * Reader API (`/api/v1`, document_viewer.md): passages (citation targets), revisions
 * (version history, `?v=`), citations of a conversation (`?from=`) and reprocessing a
 * document that isn't readable. Items, content, library and reading lists come from
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

/** Stored versions of a document, newest first. */
export async function listItemRevisions(workspace: string, item: string): Promise<ItemRevision[]> {
  const revisions = await listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/items/{item}/revisions", { params: { path: it(workspace, item), query: { pageSize: 100, pageToken } } })),
    (page) => page.revisions,
    500,
  );
  const n = (r: ItemRevision) => Number(resourceId(r.name));
  return revisions.sort((a, b) => n(b) - n(a));
}

/** Passages a conversation's answers cited in one document, in citation order (Reader `?from=`). */
export async function conversationCitations(workspace: string, conversation: string, item: string): Promise<Citation[]> {
  const messages = await listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}/messages", {
          params: { path: { workspace, conversation: resourceId(conversation) }, query: { pageSize: 200, pageToken } },
        }),
      ),
    (page) => page.messages,
    1000,
  );
  const itemId = resourceId(item);
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const message of messages) {
    for (const citation of message.citations ?? []) {
      if (!citation.available || !citation.passage || resourceId(citation.item) !== itemId || seen.has(citation.passage)) continue;
      seen.add(citation.passage);
      out.push(citation);
    }
  }
  return out;
}

/** Process (or retry) one document: `CreateIngestionRun` with `selector.items` (needs `ingestionRuns.create`). */
export function processDocument(workspace: string, item: string): Promise<Schema<"IngestionRun">> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: { selector: { items: [item.includes("/") ? item : `workspaces/${workspace}/items/${item}`] }, trigger: "MANUAL" },
    }),
  );
}
