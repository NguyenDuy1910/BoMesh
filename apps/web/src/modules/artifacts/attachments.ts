"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { toast } from "@/components/ui";
import { uploadDocument, mimeOf, type Item } from "@/modules/knowledge/api";

/** Most files on one message, and the largest upload (preview `MAX`, `MAXB`). */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 100 * 1048576;
const BLOCKED = /\.(mp4|mov|avi|mkv|exe|dmg|iso|app|msi)$/i;

/** What a chip shows: an attached file on a sent message, or one in the composer. */
export interface ChipFile {
  name: string;
  mime?: string;
  /** Full item name of the document (`workspaces/w/items/i`). */
  item?: string;
  /** `ref`: a knowledge document read in place; `upload`: a file saved to My files. */
  kind?: "upload" | "ref";
  /** Knowledge base name of a reference. */
  base?: string;
  /** A reference the reader can no longer open. */
  locked?: boolean;
  /** Upload progress 0–100 while uploading. */
  progress?: number | null;
  ready?: boolean;
  /** Why it can't be attached. */
  error?: string;
}

export interface ComposerFile extends ChipFile {
  key: string;
  kind: "upload" | "ref";
  ready: boolean;
}

/** A sent attachment's chip from its item: an upload shows its file name, a knowledge reference its title. */
export function chipFileFromItem(item: Item, personalCollection?: string): ChipFile {
  const personal = !!personalCollection && (item.parentItem === personalCollection || item.ancestors?.some((a) => a.name === personalCollection));
  const upload = personal || item.document?.purpose === "CONVERSATION_ATTACHMENT";
  return {
    name: (upload ? item.document?.fileName || item.displayName : item.displayName || item.document?.fileName) || "File",
    mime: item.document?.mimeType,
    item: item.name,
    kind: upload ? "upload" : "ref",
    base: item.ancestors?.[0]?.displayName,
    ready: true,
  };
}

/* ═══════════════ Per-composer store ═══════════════ */

const stores = new Map<string, ComposerFile[]>();
const uploads = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const EMPTY: ComposerFile[] = [];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function set(key: string, next: ComposerFile[]) {
  stores.set(key, next);
  listeners.forEach((listener) => listener());
}
function patch(key: string, fileKey: string, change: Partial<ComposerFile>) {
  const files = stores.get(key);
  if (files?.some((f) => f.key === fileKey)) set(key, files.map((f) => (f.key === fileKey ? { ...f, ...change } : f)));
}

let seq = 0;

export interface ComposerAttachments {
  files: ComposerFile[];
  count: number;
  /** No upload in flight: the message can be sent. */
  ready: boolean;
  /** Item names for `ConverseRequest.attachments`. */
  attachments: string[];
  addFiles: (files: FileList | File[]) => void;
  addRefs: (items: Item[]) => void;
  remove: (index: number) => void;
  clear: () => void;
}

/**
 * Files on the message being written, per composer (`key` = "home",
 * "proj:<id>" or a conversation id), kept while navigating. Uploads go to the
 * caller's "My files" as CONVERSATION_ATTACHMENT documents; knowledge
 * documents are referenced in place (preview `addFiles`, `wk-pick-add`).
 */
export function useComposerFiles(key: string): ComposerAttachments {
  const { id: ws, member } = useWorkspace();
  const storeKey = `${ws}:${key}`;
  const files = useSyncExternalStore(subscribe, () => stores.get(storeKey) ?? EMPTY, () => EMPTY);

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const current = [...(stores.get(storeKey) ?? [])];
      const fresh: { file: File; entry: ComposerFile }[] = [];
      for (const file of Array.from(list)) {
        if (current.length >= MAX_ATTACHMENTS) {
          toast(`You can add up to ${MAX_ATTACHMENTS} files to one message.`, { tone: "accent" });
          break;
        }
        const entry: ComposerFile = { key: `f${++seq}`, name: file.name, mime: mimeOf(file), kind: "upload", ready: false, progress: 0 };
        if (BLOCKED.test(file.name)) Object.assign(entry, { error: "Video and app files can’t be attached", progress: null });
        else if (file.size > MAX_ATTACHMENT_BYTES) Object.assign(entry, { error: "Larger than 100 MB", progress: null });
        else if (!member.personalCollection) Object.assign(entry, { error: "Your My files isn’t available", progress: null });
        else fresh.push({ file, entry });
        current.push(entry);
      }
      set(storeKey, current);
      if (!fresh.length) return;
      void Promise.all(
        fresh.map(async ({ file, entry }) => {
          const controller = new AbortController();
          uploads.set(entry.key, controller);
          try {
            const item = await uploadDocument(
              ws,
              { parentItem: member.personalCollection!, file, displayName: file.name.replace(/\.[^.]+$/, ""), purpose: "CONVERSATION_ATTACHMENT" },
              (fraction) => patch(storeKey, entry.key, { progress: Math.round(fraction * 100) }),
              controller.signal,
            );
            patch(storeKey, entry.key, { item: item.name, ready: true, progress: null, mime: item.document?.mimeType ?? entry.mime });
            return true;
          } catch (error) {
            if (!controller.signal.aborted) patch(storeKey, entry.key, { error: errorMessage(error), progress: null });
            return false;
          } finally {
            uploads.delete(entry.key);
          }
        }),
      ).then((done) => {
        const added = fresh.filter((_, i) => done[i]);
        if (added.length) toast(added.length > 1 ? `Added ${added.length} files to My files` : `Added ${added[0]!.file.name} to My files`);
      });
    },
    [member.personalCollection, storeKey, ws],
  );

  const addRefs = useCallback(
    (items: Item[]) => {
      const current = [...(stores.get(storeKey) ?? [])];
      for (const item of items) {
        if (current.length >= MAX_ATTACHMENTS || current.some((f) => f.item === item.name)) continue;
        current.push({ ...chipFileFromItem(item, member.personalCollection), key: `f${++seq}`, kind: "ref", ready: true });
      }
      set(storeKey, current);
    },
    [member.personalCollection, storeKey],
  );

  const remove = useCallback(
    (index: number) => {
      const current = stores.get(storeKey) ?? [];
      const gone = current[index];
      if (gone) uploads.get(gone.key)?.abort();
      set(storeKey, current.filter((_, i) => i !== index));
    },
    [storeKey],
  );

  const clear = useCallback(() => set(storeKey, []), [storeKey]);

  return useMemo(
    () => ({
      files,
      count: files.length,
      ready: files.every((f) => f.ready || !!f.error),
      attachments: files.filter((f) => f.ready && f.item).map((f) => f.item!),
      addFiles,
      addRefs,
      remove,
      clear,
    }),
    [addFiles, addRefs, clear, files, remove],
  );
}
