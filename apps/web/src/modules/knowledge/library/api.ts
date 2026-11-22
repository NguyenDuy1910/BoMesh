"use client";

import { api, call, type Schema } from "@/lib/api/client";

import { listAllItems, quote, type Item } from "../api";

/**
 * Library calls the knowledge core doesn't cover: the caller's "My files"
 * (`Member.personalCollection`) and one topic.
 */

/** Knowledge documents in the caller's personal collection, newest first. */
export function listMyFiles(workspace: string, personalCollection: string): Promise<Item[]> {
  return listAllItems(workspace, {
    filter: `parentItem = ${quote(personalCollection)} AND itemKind = DOCUMENT AND document.purpose = KNOWLEDGE`,
    orderBy: "updateTime desc",
    view: "FULL",
  });
}

/** One topic (proposed topics aren't in the active topics list). */
export function getTopic(workspace: string, topic: string): Promise<Schema<"Topic">> {
  return call(api.GET("/api/v1/workspaces/{workspace}/topics/{topic}", { params: { path: { workspace, topic: topic.slice(topic.lastIndexOf("/") + 1) } } }));
}
