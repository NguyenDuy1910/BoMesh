"use client";

import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { listKnowledgeDocuments, type Collection, type KnowledgeDocumentChoice } from "../api";
import { chatTimeLabel } from "../chat-list";
import type { ReferencedDocument } from "../hooks/useComposerAttachments";
import { plural } from "../work";
import { FileIcon } from "./FileIcon";

/**
 * "Add from knowledge": reference documents the caller can read instead of
 * uploading copies. Nothing is copied, and access rules still apply.
 */
export function KnowledgePicker({
  open,
  onClose,
  collections,
  room,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  collections: Collection[];
  /** How many more files this message can take. */
  room: number;
  onAdd: (documents: ReferencedDocument[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, KnowledgeDocumentChoice>>(new Map());
  const [documents, setDocuments] = useState<KnowledgeDocumentChoice[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Map());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setStatus("loading");
    listKnowledgeDocuments(query, controller.signal)
      .then((items) => {
        setDocuments(items);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [attempt, open, query]);

  const groups = useMemo(() => {
    const titles = new Map(collections.map((collection) => [collection.id, collection.title]));
    const byCollection = new Map<string, KnowledgeDocumentChoice[]>();
    for (const document of documents) {
      const list = byCollection.get(document.collection_id) ?? [];
      list.push(document);
      byCollection.set(document.collection_id, list);
    }
    return [...byCollection.entries()].map(([collectionId, items]) => ({
      collectionId,
      title: titles.get(collectionId) ?? "Knowledge",
      items: query.trim() ? items.slice(0, 20) : items.slice(0, 6),
    }));
  }, [collections, documents, query]);

  const count = selected.size;
  const now = Date.now();
  const titles = new Map(collections.map((collection) => [collection.id, collection.title]));

  const toggle = (document: KnowledgeDocumentChoice, checked: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(document.id, document);
      else next.delete(document.id);
      return next;
    });
  };

  const add = () => {
    onAdd([...selected.values()].map((document) => ({
      id: document.id,
      name: document.name,
      contentType: document.content_type,
      sizeBytes: document.size_bytes,
      collectionTitle: titles.get(document.collection_id),
    })));
    onClose();
  };

  return (
    <Dialog
      bodyClassName="flex flex-col gap-3"
      description="The assistant reads these where they are. Nothing is copied, and access rules still apply."
      footer={(
        <>
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button disabled={!count} onClick={add} variant="primary">
            {count ? `Add ${plural(count, "document")}` : "Add documents"}
          </Button>
        </>
      )}
      footerStart={(
        <span className="text-meta text-text-tertiary">
          {room <= 0 ? "This message can’t take more files" : `${count} of ${room} selected`}
        </span>
      )}
      onClose={onClose}
      open={open}
      size="lg"
      title="Add from knowledge"
    >
      <SearchInput ariaLabel="Search documents you can access" autoFocus onChange={setQuery} placeholder="Search documents you can access" value={query} />
      <div className="max-h-[52vh] min-h-[220px] overflow-y-auto">
        {status === "loading" ? (
          <SkeletonRows columns={2} label="Loading documents" rows={6} />
        ) : status === "error" ? (
          <ErrorState description="Your documents couldn’t be loaded." layout="inline" onAction={() => setAttempt((value) => value + 1)} />
        ) : !groups.length ? (
          <EmptyState
            description={query.trim() ? "Try another word." : "Documents you can open will appear here."}
            icon={<Search aria-hidden="true" />}
            size="sm"
            title={query.trim() ? "No documents match" : "No documents yet"}
          />
        ) : (
          groups.map((group) => (
            <section aria-label={group.title} className="mb-3.5" key={group.collectionId}>
              <h3 className="mb-1.5 text-caption font-semibold text-text-tertiary">{group.title}</h3>
              <ul className="flex flex-col">
                {group.items.map((document) => {
                  const checked = selected.has(document.id);
                  return (
                    <li key={document.id}>
                      <label className="flex cursor-pointer items-center gap-3 rounded-md px-1.5 py-2 hover:bg-surface-hover has-disabled:cursor-default has-disabled:opacity-60">
                        <Checkbox
                          aria-label={document.name}
                          checked={checked}
                          disabled={!checked && count >= room}
                          onCheckedChange={(next) => toggle(document, next)}
                        />
                        <FileIcon name={document.name} size={28} />
                        <span className="min-w-0 flex-1 truncate text-body">{document.name}</span>
                        <span className="shrink-0 text-caption text-text-tertiary">
                          {chatTimeLabel(Date.parse(document.updated_at), now)}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </Dialog>
  );
}
