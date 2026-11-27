"use client";

import { listItems, quote } from "../api";

/** Library calls the knowledge core doesn't cover: the caller's "My files" (`Member.personalCollection`). */

/** One page of knowledge documents in the caller's personal collection, newest first; `search` narrows it (a `displayName` clause). */
export function listMyFiles(workspace: string, personalCollection: string, { search, pageSize, pageToken }: { search: string; pageSize: number; pageToken?: string }) {
  const mine = `parentItem = ${quote(personalCollection)} AND itemKind = DOCUMENT AND document.purpose = KNOWLEDGE`;
  return listItems(workspace, { filter: search ? `${mine} AND ${search}` : mine, orderBy: "updateTime desc", view: "FULL", pageSize, pageToken });
}
