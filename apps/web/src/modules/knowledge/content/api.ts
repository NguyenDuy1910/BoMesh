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
  /** Block ref the window opens around. Exclusive with `pageToken`. */
  anchor?: string;
  /** A previous window's `previousPageToken` / `nextPageToken`. */
  pageToken?: string;
  view?: "FULL" | "OUTLINE";
  pageSize?: number;
}

/** GetItemContent: one window of blocks (FULL), or the document's headings (OUTLINE). */
export function getItemContent(workspace: string, item: string, { revision, version, anchor, pageToken, view, pageSize }: ContentWindowQuery): Promise<ItemContent> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/items/{item}/content", {
      params: {
        path: { workspace, item: resourceId(item) },
        query: {
          ...(revision ? { revision } : {}),
          ...(version ? { version } : {}),
          ...(pageToken ? { pageToken } : anchor ? { anchor } : {}),
          ...(view ? { view } : {}),
          ...(pageSize ? { pageSize } : {}),
        },
      },
    }),
  );
}
