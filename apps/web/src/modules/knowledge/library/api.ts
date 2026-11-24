"use client";

import { api, call, type Schema } from "@/lib/api/client";

import { listItems, quote } from "../api";

/**
 * Library calls the knowledge core doesn't cover: the caller's "My files"
 * (`Member.personalCollection`) and one topic.
 */

/** One page of knowledge documents in the caller's personal collection, newest first; `search` narrows it (a `displayName` clause). */
export function listMyFiles(workspace: string, personalCollection: string, { search, pageSize, pageToken }: { search: string; pageSize: number; pageToken?: string }) {
  const mine = `parentItem = ${quote(personalCollection)} AND itemKind = DOCUMENT AND document.purpose = KNOWLEDGE`;
  return listItems(workspace, { filter: search ? `${mine} AND ${search}` : mine, orderBy: "updateTime desc", view: "FULL", pageSize, pageToken });
}

/** One topic (proposed topics aren't in the active topics list). */
export function getTopic(workspace: string, topic: string): Promise<Schema<"Topic">> {
  return call(api.GET("/api/v1/workspaces/{workspace}/topics/{topic}", { params: { path: { workspace, topic: topic.slice(topic.lastIndexOf("/") + 1) } } }));
}
