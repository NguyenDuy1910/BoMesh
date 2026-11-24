"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { deleteItem, listItems, moveItem, quote, undeleteItem, updateItem } from "../api";
import { invalidateKnowledge } from "../queries";
import { createFolder, getItemIamPolicy, setItemIamPolicy } from "./api";
import { collectionHref, COLLECTIONS_HREF, hasOwnAccess, sharesOf, withExactShares, type Item, type Share } from "./model";

/** Children moved per step when a folder is removed (one ListItems page each). */
const MOVE_PAGE = 100;

/** Collection-level operations (preview `A['kb-archive']`). */
export function useCollectionOperations() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();

  return useMemo(() => {
    const refresh = () => invalidateKnowledge(qc, ws);
    const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

    return {
      /** Archiving is reversible: it happens at once (soft delete with its documents), back to Collections, with Undo. */
      async archive(collection: Item): Promise<void> {
        const name = collection.displayName ?? "";
        try {
          await deleteItem(ws, collection.name ?? "", { force: true });
          refresh();
          router.push(COLLECTIONS_HREF);
          toast(`Đã lưu trữ “${name}”`, {
            undo: () => {
              undeleteItem(ws, collection.name ?? "").then(() => {
                refresh();
                router.push(collectionHref(collection.name, "settings"));
              }, fail);
            },
          });
        } catch (error) {
          fail(error);
        }
      },
    };
  }, [qc, ws, router]);
}

/**
 * Folder operations in a collection's Contents (preview `kb-folder-*`): create, edit details, move, remove (what's
 * in it moves up a level) and a folder's own access (`inheritAccess = false`). Each toasts, most with Undo.
 */
export function useFolderOperations() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();

  return useMemo(() => {
    const refresh = () => invalidateKnowledge(qc, ws);
    const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });
    const moveAll = (items: readonly string[], to: string) => Promise.all(items.map((name) => moveItem(ws, name, to)));

    /** Replaces the folder's collection-role grants with `shares` (read–modify–write on the latest policy). */
    async function setShares(folder: string, shares: readonly Pick<Share, "principal" | "role">[]) {
      const fresh = await getItemIamPolicy(ws, folder);
      await setItemIamPolicy(ws, folder, withExactShares(fresh, shares));
    }
    const setInherit = (folder: string, inheritAccess: boolean) => updateItem(ws, folder, { collection: { inheritAccess } }, ["collection.inheritAccess"]);

    return {
      /** New folder under `parent` (the collection or a folder); `onOpen` opens it from the toast. */
      async create(parent: string, values: { displayName: string; description: string }, onOpen: (folder: Item) => void): Promise<boolean> {
        try {
          const folder = await createFolder(ws, parent, values);
          refresh();
          toast(`Đã tạo “${folder.displayName}”`, { action: { label: "Mở", onPress: () => onOpen(folder) } });
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },

      /** Name and description; Undo puts them back. */
      async save(folder: Item, values: { displayName: string; description: string }): Promise<boolean> {
        const name = folder.name ?? "";
        const before = { displayName: folder.displayName ?? "", collection: { description: folder.collection?.description ?? "" } };
        const mask = ["displayName", "collection.description"];
        try {
          await updateItem(ws, name, { displayName: values.displayName, collection: { description: values.description } }, mask);
          refresh();
          toast("Đã lưu thư mục", { undo: () => void updateItem(ws, name, before, mask).then(refresh, fail) });
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },

      /** Moves the folder, with everything in it, under `to` (its collection or another folder in it). */
      async move(folder: Item, to: string, destination: string): Promise<boolean> {
        const name = folder.name ?? "";
        const from = folder.parentItem ?? "";
        try {
          await moveItem(ws, name, to);
          refresh();
          toast(`Đã di chuyển “${folder.displayName}” đến ${destination}`, { undo: () => void moveItem(ws, name, from).then(refresh, fail) });
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },

      /** Removes the folder; its documents and folders move up a level first (never deleted with it), one page at a time. Undo restores both. */
      async remove(folder: Item, upName: string): Promise<boolean> {
        const name = folder.name ?? "";
        const up = folder.parentItem ?? "";
        try {
          // Moved children leave `parentItem = folder`, so the first page always holds the ones still inside.
          const kids: Item[] = [];
          const moved = new Set<string>();
          for (;;) {
            const page = await listItems(ws, { filter: `parentItem = ${quote(name)}`, pageSize: MOVE_PAGE, view: "BASIC" });
            const batch = (page.items ?? []).filter((k) => k.name && !moved.has(k.name));
            if (!batch.length) break;
            await moveAll(batch.map((k) => k.name ?? ""), up);
            for (const k of batch) moved.add(k.name ?? "");
            kids.push(...batch);
          }
          await deleteItem(ws, name);
          refresh();
          const docs = kids.filter((k) => k.itemKind === "DOCUMENT").length;
          const folders = kids.length - docs;
          const what = [docs && plural(docs, "document"), folders && plural(folders, "folder")].filter(Boolean).join(" và ");
          toast(`Đã xóa “${folder.displayName}”${what ? `. ${what} trong đó đã được chuyển sang ${upName}` : ""}`, {
            undo: () =>
              void undeleteItem(ws, name)
                .then(() => moveAll(kids.map((k) => k.name ?? ""), name))
                .then(refresh, (error) => {
                  refresh();
                  fail(error);
                }),
          });
          return true;
        } catch (error) {
          refresh();
          fail(error);
          return false;
        }
      },

      /** Gives the folder its own access (or changes it): only `shares` read it and everything in it. */
      async restrict(folder: Item, shares: readonly Share[]): Promise<boolean> {
        const name = folder.name ?? "";
        const own = hasOwnAccess(folder);
        try {
          const before = own ? sharesOf(await getItemIamPolicy(ws, name)) : [];
          // Grants first, then the boundary, so nobody who should read it loses it in between.
          await setShares(name, shares);
          if (!own) await setInherit(name, false);
          refresh();
          toast(own ? "Đã lưu quyền truy cập" : `Giờ chỉ những người bạn thêm mới đọc được “${folder.displayName}”`, {
            undo: () => void (own ? setShares(name, before) : setInherit(name, true).then(() => setShares(name, []))).then(refresh, fail),
          });
          return true;
        } catch (error) {
          refresh();
          fail(error);
          return false;
        }
      },

      /** Back to the access of the level above (`inheritAccess = true`); its own grants go. `who` = who reads it then. */
      async inherit(folder: Item, sameAs: string, who: string): Promise<boolean> {
        const name = folder.name ?? "";
        try {
          const before = sharesOf(await getItemIamPolicy(ws, name));
          await setInherit(name, true);
          await setShares(name, []);
          refresh();
          toast(`“${folder.displayName}” lại có cùng quyền truy cập với ${sameAs}: ${who}`, {
            undo: () => void setShares(name, before).then(() => setInherit(name, false)).then(refresh, fail),
          });
          return true;
        } catch (error) {
          refresh();
          fail(error);
          return false;
        }
      },
    };
  }, [qc, ws]);
}
