"use client";

import { ArrowRight, BookOpen, FileText, FolderTree, Lock, RefreshCw, Upload } from "lucide-react";

import { cn } from "@/lib/cn";
import type { WorkspaceKnowledgeCollection } from "@/modules/knowledge/workspace-repository";
import { pluralize } from "@/modules/workspace-control/format";

/**
 * Hues a collection can wear. They stay clear of green, amber and red, which
 * mean a status in this console; a collection is a place, not a state.
 */
const TONES = ["violet", "indigo", "sky", "cyan", "magenta", "slate"] as const;

/** FNV-1a: neighbouring ids still land on different hues. */
function toneFor(seed: string): (typeof TONES)[number] {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  return TONES[hash % TONES.length];
}

/** A collection's mark: the same colour for the same collection everywhere. */
export function CollectionTile({
  collection,
  size = "md",
}: {
  collection: WorkspaceKnowledgeCollection;
  size?: "md" | "lg";
}) {
  const Icon = collection.restricted ? Lock : BookOpen;
  return (
    <span
      aria-hidden="true"
      className={cn("knowledge-tile", size === "lg" && "knowledge-tile--lg")}
      data-tone={collection.restricted ? "muted" : toneFor(collection.id)}
    >
      <Icon size={size === "lg" ? 22 : 18} />
    </span>
  );
}

/** How much a collection holds and where it comes from, as short facts. */
export function CollectionFacts({
  collection,
  inside,
}: {
  collection: WorkspaceKnowledgeCollection;
  inside: number;
}) {
  return (
    <span className="knowledge-facts">
      <span>
        <FileText aria-hidden="true" size={13} />
        {collection.documentCount ? pluralize(collection.documentCount, "item") : "Empty"}
      </span>
      {inside > 0 && (
        <span>
          <FolderTree aria-hidden="true" size={13} />
          {pluralize(inside, "collection")}
        </span>
      )}
      <span>
        {collection.sourceCount ? <RefreshCw aria-hidden="true" size={13} /> : <Upload aria-hidden="true" size={13} />}
        {collection.sourceCount ? `Synced from ${pluralize(collection.sourceCount, "source")}` : "Uploads"}
      </span>
    </span>
  );
}

/**
 * Collections as the shelves of the workspace's library. Opening one is the
 * main way into knowledge, so each card is a single large target.
 */
export function CollectionCards({
  collections,
  nested,
  onOpen,
}: {
  collections: readonly WorkspaceKnowledgeCollection[];
  /** How many collections sit directly inside each one, by id. */
  nested: ReadonlyMap<string, number>;
  onOpen: (collection: WorkspaceKnowledgeCollection) => void;
}) {
  return (
    <ul className="knowledge-shelf">
      {collections.map((collection) => (
        <li key={collection.id}>
          <button
            className="knowledge-shelf__card"
            disabled={collection.restricted}
            onClick={() => onOpen(collection)}
            type="button"
          >
            <span className="knowledge-shelf__head">
              <CollectionTile collection={collection} />
              <ArrowRight aria-hidden="true" className="knowledge-shelf__go" size={16} />
            </span>
            <strong className="knowledge-shelf__name">{collection.name}</strong>
            {(collection.restricted || collection.description) && (
              <span className="knowledge-shelf__about">
                {collection.restricted ? "You don’t have access to this collection." : collection.description}
              </span>
            )}
            <CollectionFacts collection={collection} inside={nested.get(collection.id) ?? 0} />
          </button>
        </li>
      ))}
    </ul>
  );
}
