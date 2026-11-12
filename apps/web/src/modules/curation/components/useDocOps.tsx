"use client";

import { Archive, Check, Download, EyeOff, FileText, Folder, Pencil, Play, Plug, RefreshCw, RotateCcw, Upload, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { toast, type RowAction } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { publishItem, unpublishItem } from "@/modules/knowledge/api";
import { openContribute } from "@/modules/knowledge/components/contribute-store";
import { openEditDetails, openMoveItems } from "@/modules/knowledge/components/dialogs";
import { useDocumentOperations } from "@/modules/knowledge/operations";

import { createIngestionRun } from "../api";
import { canArchiveRow, canPublishRow, canUnpublishRow, isLocked, isRowFix, opsFor, reviewQueueHref, studioHref, type DocOp, type DocRow } from "../model";
import { useInvalidateCuration } from "../queries";

export const OP_META: Readonly<Record<DocOp, { label: string; icon: LucideIcon; danger?: boolean }>> = {
  review: { label: "Review", icon: Check },
  publish: { label: "Publish now", icon: Play },
  retry: { label: "Retry", icon: RotateCcw },
  replace: { label: "Replace file", icon: Upload },
  update: { label: "Publish update", icon: RefreshCw },
  source: { label: "Open source", icon: Plug },
  republish: { label: "Publish again", icon: Upload },
  unpublish: { label: "Unpublish", icon: EyeOff },
  edit: { label: "Edit details…", icon: Pencil },
  move: { label: "Move to…", icon: Folder },
  open: { label: "Open", icon: FileText },
  download: { label: "Download", icon: Download },
  archive: { label: "Archive", icon: Archive, danger: true },
};

export interface DocOps {
  /** Publish (or retry, or publish the update of) rows; password-protected files are skipped and said so. */
  bulkPublish: (rows: DocRow[], done?: () => void) => Promise<void>;
  /** Unpublishing is reversible: it happens at once, with Undo (no confirmation). */
  unpublish: (rows: DocRow[], done?: () => void) => Promise<void>;
  archive: (rows: DocRow[], done?: () => void) => Promise<void>;
  /** Runs one lifecycle operation on a row (`after` closes the drawer first when the op navigates away). */
  run: (op: DocOp, row: DocRow, after?: () => void) => void;
  /** Row ⋯ (preview `MENUS['cur-row']`): what the row and the drawer footer don't already show. */
  menu: (row: DocRow, ctx: "row" | "drawer", after?: () => void) => RowAction[];
}

/** Lifecycle operations on curated documents (preview `OPS`): data first, then a toast (Undo where the API reverses it). */
export function useDocOps(): DocOps {
  const { id: ws, can } = useWorkspace();
  const router = useRouter();
  const docs = useDocumentOperations();
  const invalidate = useInvalidateCuration();

  return useMemo<DocOps>(() => {
    const fail = (error: unknown) => {
      invalidate();
      toast(errorMessage(error), { tone: "danger" });
    };
    const names = (rows: DocRow[]) => rows.flatMap((r) => (r.item?.name ? [r.item.name] : []));
    const ref = (r: DocRow) => ({ name: r.item?.name ?? "", title: r.title, fileName: r.fileName, etag: r.item?.etag });

    /** Unpublished documents go back to readers; anything not yet searchable is processed (an ingestion run). */
    async function publishRows(rows: DocRow[]) {
      const again = rows.filter((r) => r.lifecycle === "unpublished");
      await Promise.all(again.map((r) => publishItem(ws, r.item!.name!)));
      const toProcess = rows.filter((r) => r.lifecycle !== "unpublished" || r.item?.document?.indexingState !== "SUCCEEDED");
      if (names(toProcess).length) await createIngestionRun(ws, names(toProcess));
    }

    async function process(rows: DocRow[], msg: string) {
      try {
        await publishRows(rows);
        invalidate();
        toast(msg, { tone: "accent" });
      } catch (error) {
        fail(error);
      }
    }

    async function bulkPublish(rows: DocRow[], done?: () => void) {
      const ok = rows.filter(canPublishRow);
      const skipped = rows.length - ok.length;
      if (!ok.length) {
        toast(rows.some((r) => isLocked(r.item)) ? "Password-protected files can’t be published. Replace them or remove the password at the source." : "None of these need publishing", { tone: "danger" });
        return;
      }
      done?.();
      await process(ok, `Publishing ${plural(ok.length, "document")}${skipped ? ` · ${skipped} skipped` : ""}`);
    }

    async function unpublish(rows: DocRow[], done?: () => void) {
      const list = rows.filter(canUnpublishRow);
      if (!list.length) {
        toast("None of these are published", { tone: "danger" });
        return;
      }
      const one = list.length === 1;
      try {
        await Promise.all(list.map((r) => unpublishItem(ws, r.item!.name!)));
        done?.();
        invalidate();
        toast(one ? `Unpublished “${list[0].title}”. It left search and answers.` : `Unpublished ${plural(list.length, "document")}. They left search and answers.`, {
          undo: () =>
            void Promise.all(list.map((r) => publishItem(ws, r.item!.name!))).then(() => {
              invalidate();
              toast(one ? `“${list[0].title}” is published again` : `${plural(list.length, "document")} are published again`, { tone: "accent" });
            }, fail),
        });
      } catch (error) {
        fail(error);
      }
    }

    async function archive(rows: DocRow[], done?: () => void) {
      const list = rows.filter(canArchiveRow);
      if (!list.length) {
        toast("Documents in review can’t be archived", { tone: "danger" });
        return;
      }
      if (await docs.archive(list.map(ref))) {
        done?.();
        invalidate();
      }
    }

    function run(op: DocOp, r: DocRow, after?: () => void) {
      const id = resourceId(r.item?.name);
      switch (op) {
        case "review":
          after?.();
          router.push(reviewQueueHref("submissions", { sel: resourceId(r.contribution?.name) }));
          return;
        case "publish":
          void process([r], `Publishing ${r.title}`);
          return;
        case "retry":
          void process([r], `Publishing ${r.title} again`);
          return;
        case "update":
          // Changed at its source: republish from the source (never a file picker for synced documents).
          void process([r], `Publishing the update to ${r.title}`);
          return;
        case "source":
          after?.();
          router.push(can("sources.list") && r.source ? studioHref("sources", { open: resourceId(r.source) }) : studioHref("sources"));
          return;
        case "replace":
          openContribute({ item: r.item?.name });
          return;
        case "republish":
          void publishRows([r]).then(() => {
            invalidate();
            toast(`Publishing “${r.title}” again`, {
              tone: "accent",
              undo: () => void unpublishItem(ws, r.item!.name!).then(invalidate, fail),
            });
          }, fail);
          return;
        case "unpublish":
          void unpublish([r]);
          return;
        case "edit":
          openEditDetails(r.item!.name!);
          return;
        case "move":
          openMoveItems([r.item!.name!], r.item?.parentItem);
          return;
        case "open":
          after?.();
          router.push(`/doc/${id}`);
          return;
        case "download":
          void docs.download(ref(r));
          return;
        case "archive":
          void archive([r], after);
          return;
      }
    }

    function menu(r: DocRow, ctx: "row" | "drawer", after?: () => void): RowAction[] {
      const { main, more, tail } = opsFor(r);
      const item = (op: DocOp): RowAction => ({ id: op, label: OP_META[op].label, icon: OP_META[op].icon, danger: OP_META[op].danger, onAction: () => run(op, r, after) });
      const shown = ctx === "drawer" || isRowFix(main);
      return [...(shown ? [] : [main]), ...more, ...tail].map(item);
    }

    return { bulkPublish, unpublish, archive, run, menu };
  }, [ws, can, router, docs, invalidate]);
}
