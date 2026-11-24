"use client";

import { Archive, Check, CircleX, Download, Eye, EyeOff, FileText, Folder, Pencil, Play, Plug, RefreshCw, RotateCcw, Upload, type LucideIcon } from "lucide-react";
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
import { canArchiveRow, canPublishRow, canUnpublishRow, docsHref, isRowFix, opsFor, studioHref, type DocOp, type DocRow } from "../model";
import { useInvalidateCuration } from "../queries";

export const OP_META: Readonly<Record<DocOp, { label: string; icon: LucideIcon; danger?: boolean }>> = {
  review: { label: "Duyệt", icon: Check },
  process: { label: "Xử lý", icon: Play },
  retry: { label: "Xử lý lại", icon: RotateCcw },
  replace: { label: "Thay tệp", icon: Upload },
  update: { label: "Xử lý bản cập nhật", icon: RefreshCw },
  source: { label: "Mở bản gốc", icon: Plug },
  republish: { label: "Công bố", icon: Eye },
  unpublish: { label: "Ngừng công bố", icon: EyeOff },
  edit: { label: "Sửa chi tiết…", icon: Pencil },
  move: { label: "Chuyển đến…", icon: Folder },
  open: { label: "Mở", icon: FileText },
  download: { label: "Tải xuống", icon: Download },
  changes: { label: "Yêu cầu chỉnh sửa…", icon: Pencil },
  decline: { label: "Từ chối…", icon: CircleX },
  archive: { label: "Lưu trữ", icon: Archive, danger: true },
};

/** Request changes or Decline a submission waiting in Processing (the list that owns the message dialog). */
export type DecideOp = (mode: "changes" | "decline", row: DocRow) => void;

export interface DocOps {
  /** Publish unpublished rows (readers see them at once; what isn't processed stays out of search until it is). */
  bulkPublish: (rows: DocRow[], done?: () => void) => Promise<void>;
  /** Unpublishing is reversible: it happens at once, with Undo (no confirmation). */
  unpublish: (rows: DocRow[], done?: () => void) => Promise<void>;
  archive: (rows: DocRow[], done?: () => void) => Promise<void>;
  /** Runs one lifecycle operation on a row (`after` closes the drawer first when the op navigates away). */
  run: (op: DocOp, row: DocRow, after?: () => void) => void;
  /** Row ⋯ (preview `MENUS['cur-row']`): what the row and the drawer footer don't already show. */
  menu: (row: DocRow, ctx: "row" | "drawer", after?: () => void) => RowAction[];
}

/**
 * Lifecycle operations on curated documents (preview `OPS`): data first, then a toast (Undo where the API reverses it).
 * `decide` answers a submission from its row (Processing); without it, Request changes and Decline aren't offered.
 */
export function useDocOps(decide?: DecideOp): DocOps {
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

    /** Publish: readers see them at once (with Undo); what isn't processed yet stays out of search until it is. */
    async function publish(rows: DocRow[], done?: () => void) {
      const list = rows.filter(canPublishRow);
      if (!list.length) {
        toast("Không tài liệu nào đang ngừng công bố", { tone: "danger" });
        return;
      }
      try {
        await Promise.all(list.map((r) => publishItem(ws, r.item!.name!)));
        done?.();
        invalidate();
        const raw = list.filter((r) => r.processing !== "ready").length;
        const one = list.length === 1;
        const msg = one
          ? `Đã công bố “${list[0].title}”${raw ? " · chưa xử lý nên tìm kiếm chưa thấy tài liệu này" : ""}`
          : `Đã công bố ${plural(list.length, "document")}${raw ? ` · ${raw} tài liệu chưa xử lý nên tìm kiếm chưa thấy` : ""}`;
        toast(msg, { undo: () => void Promise.all(list.map((r) => unpublishItem(ws, r.item!.name!))).then(invalidate, fail) });
      } catch (error) {
        fail(error);
      }
    }

    /** Process: one ingestion run over the rows. It never publishes. */
    async function process(rows: DocRow[], msg: string) {
      try {
        await createIngestionRun(ws, { selector: { items: names(rows) } });
        invalidate();
        toast(msg, { tone: "accent" });
      } catch (error) {
        fail(error);
      }
    }

    async function unpublish(rows: DocRow[], done?: () => void) {
      const list = rows.filter(canUnpublishRow);
      if (!list.length) {
        toast("Chưa tài liệu nào được công bố", { tone: "danger" });
        return;
      }
      const one = list.length === 1;
      try {
        await Promise.all(list.map((r) => unpublishItem(ws, r.item!.name!)));
        done?.();
        invalidate();
        toast(one ? `Đã ngừng công bố “${list[0].title}”. Tài liệu không còn trong tìm kiếm và câu trả lời.` : `Đã ngừng công bố ${plural(list.length, "document")}. Chúng không còn trong tìm kiếm và câu trả lời.`, {
          undo: () =>
            void Promise.all(list.map((r) => publishItem(ws, r.item!.name!))).then(() => {
              invalidate();
              toast(one ? `“${list[0].title}” đã được công bố lại` : `${plural(list.length, "document")} đã được công bố lại`, { tone: "accent" });
            }, fail),
        });
      } catch (error) {
        fail(error);
      }
    }

    async function archive(rows: DocRow[], done?: () => void) {
      const list = rows.filter(canArchiveRow);
      if (!list.length) {
        toast("Không lưu trữ được tài liệu đang chờ duyệt", { tone: "danger" });
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
          router.push(docsHref("review", { sel: resourceId(r.contribution?.name) }));
          return;
        case "process":
          void process([r], `Đang xử lý ${r.title}`);
          return;
        case "retry":
          void process([r], `Đang xử lý lại ${r.title}`);
          return;
        case "update":
          // Changed at its source: process the source's version (never a file picker for synced documents).
          void process([r], `Đang xử lý bản cập nhật của ${r.title}`);
          return;
        case "source":
          after?.();
          router.push(can("sources.list") && r.source ? studioHref("sources", { open: resourceId(r.source) }) : studioHref("sources"));
          return;
        case "replace":
          openContribute({ item: r.item?.name });
          return;
        case "republish":
          void publish([r]);
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
        case "changes":
        case "decline":
          decide?.(op, r);
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
      return [...(shown ? [] : [main]), ...more, ...tail].filter((op) => decide || (op !== "changes" && op !== "decline")).map(item);
    }

    return { bulkPublish: publish, unpublish, archive, run, menu };
  }, [ws, can, router, docs, invalidate, decide]);
}
