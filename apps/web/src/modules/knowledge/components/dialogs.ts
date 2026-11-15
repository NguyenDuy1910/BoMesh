"use client";

import type { ReadingList } from "../api";
import { createOverlayStore } from "./dialog-store";

/** Knowledge dialogs opened from menus and pages; rendered by `<KnowledgeDialogsHost/>`. Item arguments are full names or bare IDs. */
export type KnowledgeDialog =
  | { kind: "addToList"; items: string[] }
  | { kind: "edit"; item: string }
  | { kind: "link"; item: string }
  | { kind: "move"; items: string[]; from?: string; folder?: boolean }
  | { kind: "readingList"; list?: ReadingList; items?: string[] };

export const knowledgeDialogs = createOverlayStore<KnowledgeDialog>();

/** Add to reading list (preview `res-collect`): pick reading lists or create one. */
export const openAddToReadingList = (items: string | string[]) => knowledgeDialogs.open({ kind: "addToList", items: Array.isArray(items) ? items : [items] });
/** Edit details (title, type, topics, summary, language, owner). Editors only. */
export const openEditDetails = (item: string) => knowledgeDialogs.open({ kind: "edit", item });
/** Link to spaces (show in a space's materials). Space leads/staff. */
export const openLinkToSpaces = (item: string) => knowledgeDialogs.open({ kind: "link", item });
/** Move documents to a collection or folder the caller can edit. `from` = current parent (for Undo). */
export const openMoveItems = (items: string[], from?: string) => knowledgeDialogs.open({ kind: "move", items, from });
/** Move a folder, with everything in it, inside its collection. */
export const openMoveFolder = (folder: string, from?: string) => knowledgeDialogs.open({ kind: "move", items: [folder], from, folder: true });
/** New reading list (optionally with resources) or edit an existing one (preview `col-new` / `col-edit`). */
export const openReadingListEditor = (options: { list?: ReadingList; items?: string[] } = {}) => knowledgeDialogs.open({ kind: "readingList", ...options });
