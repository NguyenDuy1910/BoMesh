"use client";

import { BookOpen, Files, Globe, Search } from "lucide-react";

import { CollectionRow, DocumentRow } from "@/components/patterns";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import {
  documentMeta,
  documentStatus,
} from "@/modules/knowledge/document-facts";
import type {
  WorkspaceKnowledgeCollection,
  WorkspaceKnowledgeDocument,
} from "@/modules/knowledge/workspace-repository";
import { pluralize } from "@/modules/workspace-control/format";

import { DocumentBulkBar } from "./DocumentBulkBar";
import { DocumentSelectMenu } from "./DocumentSelectMenu";
import { FileTypeIcon } from "./FileTypeIcon";

const COLLECTION_ICON = {
  folder: BookOpen,
  upload: Files,
  web: Globe,
} as const;

interface DocumentsViewProps {
  collections: WorkspaceKnowledgeCollection[];
  documents: WorkspaceKnowledgeDocument[];
  /** Everything in the workspace, for the counts a filtered list cannot state. */
  totalDocumentCount: number;
  scope: string;
  search: string;
  /** True once a filter is narrowing the list beyond scope and search. */
  filtered: boolean;
  /** Nothing has loaded yet. A refetch keeps the list on screen instead. */
  loading: boolean;
  selectedId: string;
  selection: string[];
  /** The list sits beside the viewer and drops its secondary columns. */
  compact: boolean;
  onOpenCollection: (name: string) => void;
  onOpenDocument: (document: WorkspaceKnowledgeDocument) => void;
  onToggleDocument: (id: string, checked: boolean) => void;
  /** Replaces the selection, e.g. with every shown document, or one status. */
  onSelectDocuments: (ids: string[]) => void;
  onClearSelection: () => void;
  /** Re-indexes the selected documents; the backend refuses the ones it cannot. */
  onReindexSelection: () => void;
  onRemoveSelection: () => void;
  onClearFilters: () => void;
  onWidenScope: () => void;
  onUpload: () => void;
  onConnectSource: () => void;
  /** Omitted for members who cannot create one, so it is never offered. */
  onCreateCollection?: () => void;
}

export function DocumentsView({
  collections,
  documents,
  totalDocumentCount,
  scope,
  search,
  filtered,
  loading,
  selectedId,
  selection,
  compact,
  onOpenCollection,
  onOpenDocument,
  onToggleDocument,
  onSelectDocuments,
  onClearSelection,
  onReindexSelection,
  onRemoveSelection,
  onClearFilters,
  onWidenScope,
  onUpload,
  onConnectSource,
  onCreateCollection,
}: DocumentsViewProps) {
  if (loading) {
    return (
      <div className="knowledge-document-list">
        <PageLoadingSkeleton label="Loading documents" />
      </div>
    );
  }

  const browsing = !scope && !search && !filtered;
  const showCollections = browsing && !compact && collections.length > 0;
  const selectionSet = new Set(selection);
  // Filling an empty collection and adding a first document ask for the same
  // two things, so both empties offer the same pair of actions.
  const addActions = (
    <>
      <Button onClick={onUpload} variant="secondary">Upload files</Button>
      <Button onClick={onConnectSource} variant="ghost">Connect a source</Button>
    </>
  );

  if (!documents.length && !showCollections) {
    return (
      <div className="knowledge-document-list">
        {search || filtered ? (
          <SearchEmptyState
            onClearFilters={onClearFilters}
            onWidenScope={onWidenScope}
            scope={scope}
            search={search}
            totalDocumentCount={totalDocumentCount}
          />
        ) : scope ? (
          <EmptyState
            action={addActions}
            description="Upload files or connect a source to fill it."
            size="sm"
            title={`No documents in ${scope} yet`}
          />
        ) : (
          <EmptyState
            action={
              <>
                {onCreateCollection && (
                  <Button onClick={onCreateCollection} variant="secondary">Create collection</Button>
                )}
                <Button onClick={onConnectSource} variant="ghost">Connect a source</Button>
              </>
            }
            description="Collections group uploads and connected sources into knowledge the assistant can answer from."
            title="Start with a collection"
          />
        )}
      </div>
    );
  }

  return (
    <div className="knowledge-document-list">
      {showCollections && (
        <section aria-labelledby="knowledge-collections-heading">
          <div className="knowledge-list-heading">
            <h2 className="knowledge-eyebrow" id="knowledge-collections-heading">Collections</h2>
            <span>{pluralize(collections.length, "collection")}</span>
          </div>
          <div className="knowledge-rows">
            {collections.map((collection) => (
              <CollectionRow
                count={collection.documentCount}
                icon={COLLECTION_ICON[collection.kind]}
                key={collection.name}
                name={collection.name}
                onOpen={() => onOpenCollection(collection.name)}
                restricted={collection.restricted}
                source={collection.source}
              />
            ))}
          </div>
        </section>
      )}

      {/* Beside the reader the heading is dropped — the scope control above
          already names the list — so the section labels itself instead of
          pointing at an element that is no longer rendered. A workspace with
          collections but no documents yet gets the next step, not a heading
          over nothing. */}
      {documents.length ? (
        <section
          aria-label={compact ? scope || "Documents" : undefined}
          aria-labelledby={compact ? undefined : "knowledge-documents-heading"}
        >
          {!compact && (
            <div className="knowledge-list-heading">
              <div className="knowledge-list-heading__title">
                <DocumentSelectMenu documents={documents} onSelect={onSelectDocuments} selection={selection} />
                <h2 className="knowledge-eyebrow" id="knowledge-documents-heading">
                  {browsing ? "Recently updated" : scope || "Results"}
                </h2>
              </div>
              <span>
                {browsing
                  ? `${totalDocumentCount.toLocaleString()} in this workspace`
                  : pluralize(documents.length, "document")}
              </span>
            </div>
          )}

          {selection.length > 0 && (
            <DocumentBulkBar
              count={selection.length}
              onClear={onClearSelection}
              onReindex={onReindexSelection}
              onRemove={onRemoveSelection}
            />
          )}

          <div className="knowledge-rows" data-selecting={selection.length > 0 || undefined}>
            {documents.map((document) => {
              const status = documentStatus(document);
              return (
                <DocumentRow
                  checked={selectionSet.has(document.id)}
                  icon={<FileTypeIcon kind={document.kind} label={document.fileTypeLabel} />}
                  key={document.id}
                  layout={compact ? "narrow" : "full"}
                  meta={documentMeta(document, { scoped: compact || Boolean(scope), layout: compact ? "narrow" : "full" })}
                  onCheckedChange={compact ? undefined : (checked) => onToggleDocument(document.id, checked)}
                  onSelect={() => onOpenDocument(document)}
                  selected={document.id === selectedId}
                  status={status.label}
                  statusTone={status.tone}
                  title={document.title}
                  updated={document.updatedLabel}
                />
              );
            })}
          </div>
        </section>
      ) : (
        <section aria-label="Documents">
          <EmptyState
            action={addActions}
            description="Upload files or connect a source to add the first documents."
            size="sm"
            title="No documents yet"
          />
        </section>
      )}
    </div>
  );
}

/**
 * A search that found nothing states what it covered before offering the one
 * action that widens it — otherwise the reader cannot tell whether the phrase
 * is absent from the collection or absent from the workspace.
 */
function SearchEmptyState({
  scope,
  search,
  totalDocumentCount,
  onWidenScope,
  onClearFilters,
}: {
  scope: string;
  search: string;
  totalDocumentCount: number;
  onWidenScope: () => void;
  onClearFilters: () => void;
}) {
  const where = scope || "this workspace";
  return (
    <EmptyState
      action={
        scope
          ? <Button onClick={onWidenScope} variant="secondary">Search all {pluralize(totalDocumentCount, "document")}</Button>
          : <Button onClick={onClearFilters} variant="secondary">Clear filters</Button>
      }
      description={search ? `Nothing in ${where} matches “${search}”.` : `Nothing in ${where} matches these filters.`}
      icon={<Search size={20} />}
      size="sm"
      title="No matching documents"
    />
  );
}
