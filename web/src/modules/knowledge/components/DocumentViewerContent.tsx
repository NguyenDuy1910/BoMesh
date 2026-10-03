"use client";

import { LockKeyhole, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";

import { AgentDocumentView } from "./AgentDocumentView";
import { documentRenderers } from "./DocumentRenderers";

interface DocumentViewerContentProps {
  document: WorkspaceKnowledgeDocument;
  page: number;
  search: string;
  view: "original" | "agent";
  zoom: number;
  onPageChange: (page: number) => void;
  onZoomChange: (zoom: number) => void;
  onSearchChange: (value: string) => void;
  /** Set only when there is a failed indexing to retry. */
  onRetryIndexing?: () => void;
}

/**
 * The stage.
 *
 * It decides three things and nothing else: whether there is anything to show
 * at all, which representation was asked for, and which renderer draws the
 * format. The renderer offers only the page, zoom and find controls its
 * content supports; everything else a reader operates lives in the shell.
 */
export function DocumentViewerContent({
  document,
  page,
  search,
  view,
  zoom,
  onPageChange,
  onZoomChange,
  onSearchChange,
  onRetryIndexing,
}: DocumentViewerContentProps) {
  if (document.state === "restricted") {
    return (
      <div className="knowledge-viewer__stage">
        <EmptyState
          description={`Permissions in ${document.source} changed, so this document can no longer be read here. Its owner can restore access.`}
          icon={<LockKeyhole size={20} />}
          title="Access to this document has changed"
        />
      </div>
    );
  }

  const Renderer = documentRenderers[document.kind];

  return (
    <div className="knowledge-viewer__stage">
      {document.state === "failed" && (
        <div className="knowledge-notice knowledge-notice--danger" role="alert">
          <TriangleAlert aria-hidden="true" size={16} />
          <div>
            <strong>
              {document.latestIngestion && document.latestIngestion.attempt > 1
                ? `Indexing failed after ${document.latestIngestion.attempt} attempts`
                : "This document could not be indexed"}
            </strong>
            <p>{document.failureReason ?? "BoThesis could not read the file, so it never appears in an answer."}</p>
          </div>
          {onRetryIndexing && (
            <Button onClick={onRetryIndexing} size="sm" variant="secondary">Retry indexing</Button>
          )}
        </div>
      )}

      {view === "agent" ? (
        <AgentDocumentView document={document} search={search} />
      ) : (
        <Renderer
          document={document}
          onPageChange={onPageChange}
          onSearchChange={onSearchChange}
          onZoomChange={onZoomChange}
          page={page}
          search={search}
          zoom={zoom}
        />
      )}
    </div>
  );
}
