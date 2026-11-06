"use client";

import type { ReadingList } from "../api";
import { createOverlayStore } from "./dialog-store";

/** Knowledge dialogs opened from menus and pages; rendered by `<KnowledgeDialogsHost/>`. Item arguments are full names or bare IDs. */
export type KnowledgeDialog =
  | { kind: "collect"; items: string[] }
  | { kind: "edit"; item: string }
  | { kind: "link"; item: string }
  | { kind: "move"; items: string[]; from?: string }
  | { kind: "readingList"; list?: ReadingList; items?: string[] };

export const knowledgeDialogs = createOverlayStore<KnowledgeDialog>();

/** Add to collection (reading lists): pick lists or create one. */
export const openAddToCollection = (items: string | string[]) => knowledgeDialogs.open({ kind: "collect", items: Array.isArray(items) ? items : [items] });
/** Edit details (title, type, language, owner, summary, topics). Editors only. */
export const openEditDetails = (item: string) => knowledgeDialogs.open({ kind: "edit", item });
/** Link to spaces (pin as space materials). Space leads/staff. */
export const openLinkToSpaces = (item: string) => knowledgeDialogs.open({ kind: "link", item });
/** Move documents to another knowledge base the caller can edit. `from` = current parent (for Undo). */
export const openMoveItems = (items: string[], from?: string) => knowledgeDialogs.open({ kind: "move", items, from });
/** New collection (optionally with resources) or edit an existing one (preview `col-new` / `col-edit`). */
export const openReadingListEditor = (options: { list?: ReadingList; items?: string[] } = {}) => knowledgeDialogs.open({ kind: "readingList", ...options });
