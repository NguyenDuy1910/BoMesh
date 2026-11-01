"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { releaseConversationDocument, uploadConversationDocument } from "../api";
import { attachmentRefusal, CHAT_LIMITS } from "../attachments";
import type { ConversationDocument } from "../types";

/** One file on the next message, from the computer or from knowledge. */
export interface ComposerAttachment {
  key: string;
  name: string;
  kind: "upload" | "reference";
  stage: "uploading" | "reading" | "ready" | "failed";
  /** 0–1 while bytes are being sent. */
  fraction?: number;
  /** Why it can't be attached, in the reader's words. */
  error?: string;
  /** The Document the turn will name in `attachment_ids`, once ready. */
  document?: ConversationDocument;
  /** For a reference: the knowledge base it is read from. */
  sourceTitle?: string;
}

/** A readable workspace document added "from knowledge" — referenced by id, never copied. */
export interface ReferencedDocument {
  id: string;
  name: string;
  contentType?: string;
  sizeBytes?: number;
  collectionTitle?: string;
}

function attachmentKey(name: string) {
  return `${name}:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/**
 * The files on the composer. Uploads go to the caller's own storage as
 * conversation attachments with live progress; refused files stay visible
 * with their reason until removed. Removing a finished upload before sending
 * releases it; a reference is only unpinned.
 */
export function useComposerAttachments() {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const latest = useRef(attachments);
  latest.current = attachments;

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
  }, []);

  const patch = useCallback((key: string, next: Partial<ComposerAttachment>) => {
    setAttachments((current) => current.map((item) => item.key === key ? { ...item, ...next } : item));
  }, []);

  /** Returns how many files did not fit in this message. */
  const addFiles = useCallback((files: File[]): number => {
    const room = Math.max(0, CHAT_LIMITS.attachments - latest.current.length);
    const accepted = files.slice(0, room);
    const added: ComposerAttachment[] = accepted.map((file) => {
      const error = attachmentRefusal(file);
      return {
        key: attachmentKey(file.name),
        name: file.name,
        kind: "upload",
        stage: error ? "failed" : "uploading",
        fraction: error ? undefined : 0,
        error: error ?? undefined,
      };
    });
    latest.current = [...latest.current, ...added];
    setAttachments(latest.current);
    accepted.forEach((file, index) => {
      const item = added[index]!;
      if (item.stage === "failed") return;
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      uploadConversationDocument(file, {
        signal: controller.signal,
        onProgress: (stage, fraction) => patch(item.key, stage === "reading"
          ? { stage: "reading", fraction: undefined }
          : { stage: "uploading", fraction: fraction ?? 0 }),
      }).then((document) => {
        patch(item.key, document.status === "available"
          ? { stage: "ready", document: { ...document, origin: "upload" }, fraction: undefined }
          : { stage: "failed", error: "The file couldn’t be read", fraction: undefined });
      }).catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        patch(item.key, {
          stage: "failed",
          fraction: undefined,
          error: cause instanceof Error && cause.message ? cause.message : "The upload failed",
        });
      }).finally(() => {
        controllers.current.delete(item.key);
      });
    });
    return files.length - accepted.length;
  }, [patch]);

  /** Returns how many documents did not fit in this message. */
  const addReferences = useCallback((documents: ReferencedDocument[]): number => {
    const existing = new Set(latest.current.flatMap((item) => item.document ? [item.document.id] : []));
    const fresh = documents.filter((document) => !existing.has(document.id));
    const room = Math.max(0, CHAT_LIMITS.attachments - latest.current.length);
    const added = fresh.slice(0, room).map((document): ComposerAttachment => ({
      key: `reference:${document.id}`,
      name: document.name,
      kind: "reference",
      stage: "ready",
      sourceTitle: document.collectionTitle,
      document: {
        id: document.id,
        fileName: document.name,
        contentType: document.contentType ?? "",
        sizeBytes: document.sizeBytes ?? 0,
        mode: "indexed",
        status: "available",
        origin: "reference",
      },
    }));
    latest.current = [...latest.current, ...added];
    setAttachments(latest.current);
    return fresh.length - added.length;
  }, []);

  const remove = useCallback((key: string) => {
    const item = latest.current.find((candidate) => candidate.key === key);
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    latest.current = latest.current.filter((candidate) => candidate.key !== key);
    setAttachments(latest.current);
    if (item?.document && item.kind === "upload") void releaseConversationDocument(item.document.id).catch(() => undefined);
  }, []);

  /** After sending: the ready files now belong to the message; nothing is released. */
  const clear = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    latest.current = [];
    setAttachments([]);
  }, []);

  const readyDocuments = attachments.flatMap((item) => item.stage === "ready" && item.document ? [item.document] : []);
  const busy = attachments.some((item) => item.stage === "uploading" || item.stage === "reading");

  return { attachments, addFiles, addReferences, remove, clear, readyDocuments, busy };
}
