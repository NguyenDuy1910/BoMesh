"use client";

import { AddToCollectionDialog } from "./AddToCollectionDialog";
import { closeContribute, ContributeDialog, useContributeRequest } from "./Contribute";
import { knowledgeDialogs } from "./dialogs";
import { EditDetailsDialog } from "./EditDetailsDialog";
import { LinkToSpacesDialog } from "./LinkToSpacesDialog";
import { MoveDialog } from "./MoveDialog";
import { ReadingListDialog } from "./ReadingListDialog";

/** Renders the Contribute dialog opened with `openContribute()`. Mount once inside the workspace shell. */
export function ContributeHost() {
  const request = useContributeRequest();
  if (!request) return null;
  const { key, ...options } = request;
  return <ContributeDialog key={key} {...options} isOpen onClose={closeContribute} />;
}

/** Renders the knowledge dialogs opened with `openAddToCollection`, `openEditDetails`, `openLinkToSpaces`, `openMoveItems`, `openReadingListEditor`. */
export function KnowledgeDialogsHost() {
  const dialog = knowledgeDialogs.useCurrent();
  if (!dialog) return null;
  const close = knowledgeDialogs.close;
  switch (dialog.kind) {
    case "collect":
      return <AddToCollectionDialog key={dialog.key} items={dialog.items} isOpen onClose={close} />;
    case "edit":
      return <EditDetailsDialog key={dialog.key} item={dialog.item} isOpen onClose={close} />;
    case "link":
      return <LinkToSpacesDialog key={dialog.key} item={dialog.item} isOpen onClose={close} />;
    case "move":
      return <MoveDialog key={dialog.key} items={dialog.items} from={dialog.from} isOpen onClose={close} />;
    case "readingList":
      return <ReadingListDialog key={dialog.key} list={dialog.list} items={dialog.items} isOpen onClose={close} />;
  }
}
