"use client";

import { Play, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/Button";
import { answerAvailability, documentFacts, PROCESSING_STATUS } from "@/modules/knowledge/document-facts";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";

interface DocumentDetailsDrawerProps {
  document: WorkspaceKnowledgeDocument;
  open: boolean;
  onClose: () => void;
  /** Starts a run for this document; omitted when none can be started. */
  onProcess?: () => void;
  /** Opens the run that last processed this document. */
  onViewRun?: (runId: string) => void;
  onRequestRemove?: () => void;
  showLifecycleActions?: boolean;
}

/**
 * Everything about a document that is not the document.
 *
 * It docks beside the reader instead of covering it, because the reason to
 * open it is almost always to check a fact against what is on the page. That
 * makes it non-modal: no scrim, nothing behind it goes inert, and Escape
 * closes it — a dialog's manners would be wrong for a panel you read across.
 */
export function DocumentDetailsDrawer({
  document,
  open,
  onClose,
  onProcess,
  onViewRun,
  onRequestRemove,
  showLifecycleActions = true,
}: DocumentDetailsDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = globalThis.document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    globalThis.document.addEventListener("keydown", onKeyDown);
    return () => {
      globalThis.document.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const facts = documentFacts(document);
  const status = PROCESSING_STATUS[document.state];
  const runId = document.runId;

  return (
    <aside aria-label="Document details" className="knowledge-details" ref={panelRef}>
      <header className="knowledge-details__header">
        <h3>Details</h3>
        <Button
          aria-label="Close details"
          icon={<X size={16} />}
          iconOnly
          onClick={onClose}
          size="sm"
          variant="ghost"
        />
      </header>

      <div className="knowledge-details__body">
        <dl className="knowledge-details__facts">
          <div><dt>Source</dt><dd>{document.source}</dd></div>
          <div><dt>Path</dt><dd>{facts.path}</dd></div>
          {document.owner && <div><dt>Owner</dt><dd>{document.owner}</dd></div>}
          <div><dt>Modified</dt><dd>{facts.modifiedLabel}</dd></div>
          <div><dt>File</dt><dd>{[facts.fileTypeLabel, document.pagesLabel, document.size].filter(Boolean).join(" · ")}</dd></div>
        </dl>

        <section aria-labelledby="knowledge-details-processing" className="pt-[var(--space-5)]">
          <h4 className="knowledge-eyebrow" id="knowledge-details-processing">Processing</h4>
          <dl className="knowledge-details__facts">
            <div>
              <dt>State</dt>
              <dd className={document.state === "failed" ? "text-[var(--status-danger-text)]" : undefined}>
                {status.label}
              </dd>
            </div>
            {document.state === "failed" && document.processingError && (
              <div><dt>Error</dt><dd>{document.processingError}</dd></div>
            )}
            <div><dt>In answers</dt><dd>{answerAvailability(document)}</dd></div>
          </dl>
          {runId && onViewRun && (
            <Button className="mt-[var(--space-2)]" onClick={() => onViewRun(runId)} size="sm" variant="secondary">
              View run
            </Button>
          )}
        </section>
      </div>

      {showLifecycleActions && (
        <footer className="knowledge-details__actions">
          <button
            disabled={!onProcess}
            onClick={onProcess}
            type="button"
          >
            <Play aria-hidden="true" size={16} />Run processing
          </button>
          {onRequestRemove && (
            <button className="knowledge-details__danger" onClick={onRequestRemove} type="button">
              <Trash2 aria-hidden="true" size={16} />Delete
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}
