"use client";

import dynamic from "next/dynamic";

import { closeDocumentPreview, useDocumentPreview } from "../preview/store";
import { closeContribute, useContributeRequest } from "./contribute-store";
import { knowledgeDialogs } from "./dialogs";

/* The dialogs load on first open: none of them is on screen at first paint, so the shell stays light. */
const ContributeDialog = dynamic(() => import("./Contribute").then((m) => m.ContributeDialog), { ssr: false });
const AddToReadingListDialog = dynamic(() => import("./AddToReadingListDialog").then((m) => m.AddToReadingListDialog), { ssr: false });
const EditDetailsDialog = dynamic(() => import("./EditDetailsDialog").then((m) => m.EditDetailsDialog), { ssr: false });
const LinkToSpacesDialog = dynamic(() => import("./LinkToSpacesDialog").then((m) => m.LinkToSpacesDialog), { ssr: false });
const MoveDialog = dynamic(() => import("./MoveDialog").then((m) => m.MoveDialog), { ssr: false });
const ReadingListDialog = dynamic(() => import("./ReadingListDialog").then((m) => m.ReadingListDialog), { ssr: false });
const DocumentPreview = dynamic(() => import("../preview/DocumentPreview").then((m) => m.DocumentPreview), { ssr: false });

/** Renders the Contribute dialog opened with `openContribute()`. Mount once inside the workspace shell. */
export function ContributeHost() {
  const request = useContributeRequest();
  if (!request) return null;
  const { key, ...options } = request;
  return <ContributeDialog key={key} {...options} isOpen onClose={closeContribute} />;
}

/** Renders the knowledge dialogs opened with `openAddToReadingList`, `openEditDetails`, `openLinkToSpaces`, `openMoveItems`, `openMoveFolder`, `openReadingListEditor`. */
export function KnowledgeDialogsHost() {
  const dialog = knowledgeDialogs.useCurrent();
  if (!dialog) return null;
  const close = knowledgeDialogs.close;
  switch (dialog.kind) {
    case "addToList":
      return <AddToReadingListDialog key={dialog.key} items={dialog.items} isOpen onClose={close} />;
    case "edit":
      return <EditDetailsDialog key={dialog.key} item={dialog.item} isOpen onClose={close} />;
    case "link":
      return <LinkToSpacesDialog key={dialog.key} item={dialog.item} isOpen onClose={close} />;
    case "move":
      return <MoveDialog key={dialog.key} items={dialog.items} from={dialog.from} folder={dialog.folder} isOpen onClose={close} />;
    case "readingList":
      return <ReadingListDialog key={dialog.key} list={dialog.list} items={dialog.items} isOpen onClose={close} />;
  }
}

/** Renders the preview opened with `openDocumentPreview()`. Mount once inside the workspace shell. */
export function DocumentPreviewHost() {
  const request = useDocumentPreview();
  if (!request) return null;
  const { key, ...options } = request;
  return <DocumentPreview key={key} request={options} onClose={closeDocumentPreview} />;
}
