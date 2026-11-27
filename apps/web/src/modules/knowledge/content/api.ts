"use client";

import { api, call, resourceId, type Schema } from "@/lib/api/client";

/** A window of a document's Structured Document (GetItemContent), and its blocks. */
export type ItemContent = Schema<"ItemContent">;
export type ContentNode = Schema<"ContentNode">;
export type ContentRun = Schema<"ContentRun">;

export interface ContentWindowQuery {
  /** Revision number; default the document's indexed revision. */
  revision?: number;
  /** Structure version (a reference's `structureVersion`); default the revision's current one. */
  version?: string;
  /** A previous window's `previousPageToken` / `nextPageToken`. */
  pageToken?: string;
  pageSize?: number;
}

/** GetItemContent: one window of blocks, from the start of the document or at a page token. */
export function getItemContent(workspace: string, item: string, { revision, version, pageToken, pageSize }: ContentWindowQuery): Promise<ItemContent> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/items/{item}/content", {
      params: {
        path: { workspace, item: resourceId(item) },
        query: {
          ...(revision ? { revision } : {}),
          ...(version ? { version } : {}),
          ...(pageToken ? { pageToken } : {}),
          ...(pageSize ? { pageSize } : {}),
        },
      },
    }),
  );
}
