"use client";

import { api, call, requestId, type Schema } from "@/lib/api/client";

import { itemName, listAllItems, quote, type Item, type RecentItem } from "../api";

/**
 * My library calls the knowledge core doesn't cover: the caller's "My files"
 * (`Member.personalCollection`), processing them, and restoring recent items
 * with their original view time (Undo of "Clear history").
 */

/** Knowledge documents in the caller's personal collection, newest first. */
export function listMyFiles(workspace: string, personalCollection: string): Promise<Item[]> {
  return listAllItems(workspace, {
    filter: `parentItem = ${quote(personalCollection)} AND itemType = DOCUMENT AND document.purpose = KNOWLEDGE`,
    orderBy: "updateTime desc",
    view: "FULL",
  });
}

/** Starts processing the given documents (`ingestionRuns`, explicit items). */
export function processDocuments(workspace: string, items: readonly string[]): Promise<Schema<"IngestionRun">> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: { selector: { items: items.map((i) => itemName(workspace, i)) }, trigger: "MANUAL" },
    }),
  );
}

/** Puts a recent item back with its original view time (Undo for Clear history). */
export function restoreRecentItem(workspace: string, recent: RecentItem): Promise<RecentItem> {
  const item = recent.mergedFrom ?? recent.item ?? "";
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/members/{member}/recentItems/{recentItem}", {
      params: { path: { workspace, member: "me", recentItem: item.slice(item.lastIndexOf("/") + 1) }, query: { allowMissing: true } },
      body: { item, viewTime: recent.viewTime },
    }),
  );
}

/** One topic (proposed topics aren't in the active taxonomy list). */
export function getTopic(workspace: string, topic: string): Promise<Schema<"Topic">> {
  return call(api.GET("/api/v1/workspaces/{workspace}/topics/{topic}", { params: { path: { workspace, topic: topic.slice(topic.lastIndexOf("/") + 1) } } }));
}
