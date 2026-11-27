"use client";

import { createOverlayStore } from "./dialog-store";

/** Knowledge dialogs opened from menus and pages; rendered by `<KnowledgeDialogsHost/>`. Item arguments are full names or bare IDs. */
export type KnowledgeDialog =
  | { kind: "edit"; item: string }
  | { kind: "link"; item: string }
  | { kind: "move"; items: string[]; from?: string; folder?: boolean };

export const knowledgeDialogs = createOverlayStore<KnowledgeDialog>();

/** Edit details (title, summary, concepts per classification scheme, document facts, language, owner). Editors only. */
export const openEditDetails = (item: string) => knowledgeDialogs.open({ kind: "edit", item });
/** Link to spaces (show in a space's materials). Space leads/staff. */
export const openLinkToSpaces = (item: string) => knowledgeDialogs.open({ kind: "link", item });
/** Move documents to a collection or folder the caller can edit. `from` = current parent (for Undo). */
export const openMoveItems = (items: string[], from?: string) => knowledgeDialogs.open({ kind: "move", items, from });
/** Move a folder, with everything in it, inside its collection. */
export const openMoveFolder = (folder: string, from?: string) => knowledgeDialogs.open({ kind: "move", items: [folder], from, folder: true });
