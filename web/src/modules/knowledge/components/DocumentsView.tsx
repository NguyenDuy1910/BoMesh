"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";

import { DocumentRow } from "@/components/patterns";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageLoadingSkeleton } from "@/components/ui/Skeleton";
import { documentMeta, searchAvailability } from "@/modules/knowledge/document-facts";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";
import { pluralize } from "@/modules/workspace-control/format";

import { DocumentBulkBar } from "./DocumentBulkBar";
import { FileTypeIcon } from "./FileTypeIcon";

/** Rows shown before the reader asks for more. */
const PAGE = 50;

interface DocumentsViewProps {
  /** What the list is: a collection's items, or search results. */
  heading: string;
  documents: WorkspaceKnowledgeDocument[];
  /** The collection being browsed, or "" for the whole workspace. */
  scope: string;
  search: string;
  /** Nothing has loaded yet. A refetch keeps the list on screen instead. */
  loading: boolean;
  selectedId: string;
  selection: string[];
  /** The list sits beside the viewer and drops its secondary columns. */
  compact: boolean;
  /** A run is being created for the selection. */
  processingSelection: boolean;
  onOpenDocument: (document: WorkspaceKnowledgeDocument) => void;
  onToggleDocument: (id: string, checked: boolean) => void;
  onClearSelection: () => void;
  /** Omitted when the caller may not start a run. */
  onProcessSelection?: () => void;
  onRemoveSelection: () => void;
  onClearSearch: () => void;
  /** Omitted outside a collection, where there is nothing wider to search. */
  onSearchEverywhere?: () => void;
  /** Omitted when the empty list should not invite adding (search results). */
  onUpload?: () => void;
}

/**
 * Knowledge items, as a list to open and read.
 *
 * A row names the item, its format and where it lives. Whether the assistant
 * can search it yet is the only processing fact, and it sits quietly in the
 * row's meta line rather than as a badge on every row.
 */
export function DocumentsView({
  heading,
  documents,
  scope,
  search,
  loading,
  selectedId,
  selection,
  compact,
  processingSelection,
  onOpenDocument,
  onToggleDocument,
  onClearSelection,
  onProcessSelection,
  onRemoveSelection,
  onClearSearch,
  onSearchEverywhere,
  onUpload,
}: DocumentsViewProps) {
  const [shown, setShown] = useState(PAGE);
  // A new list starts from the top again.
  useEffect(() => setShown(PAGE), [scope, search]);

  if (loading) {
    return (
      <div className="knowledge-document-list">
        <PageLoadingSkeleton label="Loading knowledge" />
      </div>
    );
  }

  if (!documents.length) {
    if (!search && !onUpload) return null;
    return (
      <div className="knowledge-document-list">
        {search ? (
          <EmptyState
            action={onSearchEverywhere
              ? <Button onClick={onSearchEverywhere} variant="secondary">Search all knowledge</Button>
              : <Button onClick={onClearSearch} variant="secondary">Clear search</Button>}
            description={`Nothing in ${scope || "this workspace"} matches “${search}”.`}
            icon={<Search size={20} />}
            size="sm"
            title="No matching items"
          />
        ) : (
          <EmptyState
            action={<Button onClick={onUpload} variant="secondary">Upload files</Button>}
            description="Upload files here, or connect a source from Add."
            size="sm"
            title={`Nothing in ${scope} yet`}
          />
        )}
      </div>
    );
  }

  const selectionSet = new Set(selection);
  const visible = documents.slice(0, shown);

  return (
    <div className="knowledge-document-list">
      <section
        aria-label={compact ? scope || heading : undefined}
        aria-labelledby={compact ? undefined : "knowledge-documents-heading"}
      >
        {!compact && (
          <div className="knowledge-list-heading">
            <h2 className="knowledge-eyebrow" id="knowledge-documents-heading">{heading}</h2>
            <span>{pluralize(documents.length, "item")}</span>
          </div>
        )}

        {selection.length > 0 && (
          <DocumentBulkBar
            count={selection.length}
            onClear={onClearSelection}
            onProcess={onProcessSelection}
            onRemove={onRemoveSelection}
            processing={processingSelection}
          />
        )}

        <div className="knowledge-rows" data-selecting={selection.length > 0 || undefined}>
          {visible.map((document) => {
            const meta = documentMeta(document, { scoped: compact || Boolean(scope), layout: compact ? "narrow" : "full" });
            const availability = searchAvailability(document);
            return (
              <DocumentRow
                checked={selectionSet.has(document.id)}
                icon={<FileTypeIcon kind={document.kind} label={document.fileTypeLabel} />}
                key={document.id}
                layout={compact ? "narrow" : "full"}
                meta={availability && !compact ? `${meta} · ${availability}` : meta}
                onCheckedChange={compact ? undefined : (checked) => onToggleDocument(document.id, checked)}
                onSelect={() => onOpenDocument(document)}
                selected={document.id === selectedId}
                title={document.title}
                updated={document.updatedLabel}
              />
            );
          })}
        </div>

        {documents.length > shown && (
          <div className="knowledge-more">
            <Button onClick={() => setShown((count) => count + PAGE)} variant="ghost">
              Show {Math.min(PAGE, documents.length - shown)} more
            </Button>
            <span>{shown.toLocaleString()} of {documents.length.toLocaleString()}</span>
          </div>
        )}
      </section>
    </div>
  );
}
