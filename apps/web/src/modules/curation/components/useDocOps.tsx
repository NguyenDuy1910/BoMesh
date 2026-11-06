"use client";

import { Archive, Check, Download, EyeOff, FileText, Folder, Info, Pencil, Play, RefreshCw, RotateCcw, Upload, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { confirm, toast, type RowAction } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";
import { publishItem, unpublishItem } from "@/modules/knowledge/api";
import { openContribute } from "@/modules/knowledge/components/Contribute";
import { openEditDetails, openMoveItems } from "@/modules/knowledge/components/dialogs";
import { useDocumentOperations } from "@/modules/knowledge/operations";

import { createIngestionRun } from "../api";
import { canPublishRow, canUnpublishRow, DOCS_BASE, opsFor, type DocOp, type DocRow } from "../model";
import { useInvalidateCuration } from "../queries";

export const OP_META: Readonly<Record<DocOp, { label: string; icon: LucideIcon; danger?: boolean }>> = {
  review: { label: "Review", icon: Check },
  publish: { label: "Publish now", icon: Play },
  retry: { label: "Retry", icon: RotateCcw },
  replace: { label: "Replace file", icon: Upload },
  update: { label: "Publish update", icon: RefreshCw },
  republish: { label: "Publish again", icon: Upload },
  unpublish: { label: "Unpublish", icon: EyeOff },
  edit: { label: "Edit details…", icon: Pencil },
  move: { label: "Move to…", icon: Folder },
  open: { label: "Open", icon: FileText },
  download: { label: "Download", icon: Download },
  archive: { label: "Archive", icon: Archive, danger: true },
};

export interface DocOps {
  /** Starts processing (Publish now · Retry · Publish update). */
  process: (rows: DocRow[], how: "now" | "again" | "update") => Promise<void>;
  bulkPublish: (rows: DocRow[], done?: () => void) => Promise<void>;
  unpublish: (rows: DocRow[], done?: () => void) => Promise<void>;
  archive: (rows: DocRow[], done?: () => void) => Promise<void>;
  /** Runs one lifecycle operation on a row. */
  run: (op: DocOp, row: DocRow, after?: () => void) => void;
  /** Row ⋯ menu (preview `MENUS['cur-row']`). */
  menu: (row: DocRow, details: () => void) => RowAction[];
}

/** Lifecycle operations of All documents (preview `OPS`): data first, then a toast (Undo where the API reverses it). */
export function useDocOps(): DocOps {
  const { id: ws } = useWorkspace();
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

    async function process(rows: DocRow[], how: "now" | "again" | "update") {
      const items = names(rows);
      if (!items.length) return;
      try {
        await createIngestionRun(ws, items);
        invalidate();
        const what = rows.length === 1 ? rows[0].title : plural(rows.length, "document");
        toast(how === "update" ? `Publishing the update to ${what}` : how === "again" ? `Publishing ${what} again` : `Publishing ${what}`, { tone: "accent" });
      } catch (error) {
        fail(error);
      }
    }

    /** Unpublished documents go back to readers; anything not yet searchable is processed. */
    async function publishRows(rows: DocRow[]) {
      const again = rows.filter((r) => r.lifecycle === "unpublished");
      await Promise.all(again.map((r) => publishItem(ws, r.item!.name!)));
      const toProcess = rows.filter((r) => r.lifecycle !== "unpublished" || r.item?.document?.indexingState !== "SUCCEEDED");
      if (names(toProcess).length) await createIngestionRun(ws, names(toProcess));
    }

    async function bulkPublish(rows: DocRow[], done?: () => void) {
      const ok = rows.filter(canPublishRow);
      const skipped = rows.length - ok.length;
      if (!ok.length) {
        toast("None of these need publishing", { tone: "danger" });
        return;
      }
      try {
        await publishRows(ok);
        done?.();
        invalidate();
        toast(`Publishing ${plural(ok.length, "document")}${skipped ? ` · ${skipped} skipped` : ""}`, { tone: "accent" });
      } catch (error) {
        fail(error);
      }
    }

    async function unpublish(rows: DocRow[], done?: () => void) {
      const list = rows.filter(canUnpublishRow);
      if (!list.length) {
        toast("None of these are published", { tone: "danger" });
        return;
      }
      const one = list.length === 1;
      const ok = await confirm({
        title: one ? `Unpublish “${list[0].title}”?` : `Unpublish ${plural(list.length, "document")}?`,
        description: `${one ? "It" : "They"} leave${one ? "s" : ""} Browse, search and answers. ${one ? "It stays" : "They stay"} here, and you can publish ${one ? "it" : "them"} again.`,
        confirmLabel: "Unpublish",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await Promise.all(list.map((r) => unpublishItem(ws, r.item!.name!)));
        done?.();
        invalidate();
        toast(one ? `Unpublished “${list[0].title}”` : `Unpublished ${plural(list.length, "document")}`, {
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
      const list = rows.filter((r) => r.item?.name);
      if (!list.length) return;
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
          router.push(`${DOCS_BASE}?tab=review&sel=${resourceId(r.contribution?.name)}`);
          return;
        case "publish":
          void process([r], "now");
          return;
        case "retry":
          void process([r], "again");
          return;
        case "update":
          void process([r], "update");
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

    function menu(r: DocRow, details: () => void): RowAction[] {
      const { main, more, tail } = opsFor(r);
      const item = (op: DocOp): RowAction => ({ id: op, label: OP_META[op].label, icon: OP_META[op].icon, danger: OP_META[op].danger, onAction: () => run(op, r) });
      return [{ id: "details", label: "Details", icon: Info, onAction: details }, item(main), ...more.map(item), ...tail.map(item)];
    }

    return { process, bulkPublish, unpublish, archive, run, menu };
  }, [ws, router, docs, invalidate]);
}
