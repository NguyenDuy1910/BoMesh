"use client";

import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/Button";
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
  /** Starts a run for this document; omitted when none can be started. */
  onProcess?: () => void;
  /** Opens the run that last processed this document. */
  onViewRun?: (runId: string) => void;
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
  onProcess,
  onViewRun,
}: DocumentViewerContentProps) {
  const Renderer = documentRenderers[document.kind];
  const runId = document.runId;

  return (
    <div className="knowledge-viewer__stage">
      {document.state === "failed" && (
        <div className="knowledge-notice knowledge-notice--danger" role="alert">
          <TriangleAlert aria-hidden="true" size={16} />
          <div>
            <strong>Processing failed</strong>
            <p>{document.processingError ?? "This document couldn’t be read, so it isn’t used in answers."}</p>
          </div>
          {runId && onViewRun && (
            <Button onClick={() => onViewRun(runId)} size="sm" variant="ghost">View run</Button>
          )}
          {onProcess && (
            <Button onClick={onProcess} size="sm" variant="secondary">Run processing</Button>
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
