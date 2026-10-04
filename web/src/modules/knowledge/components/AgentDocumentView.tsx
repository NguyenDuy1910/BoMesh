"use client";

import { CircleAlert, CircleCheck, Info, LoaderCircle } from "lucide-react";

import { Tooltip } from "@/components/ui/Tooltip";
import { answerAvailability, documentFacts } from "@/modules/knowledge/document-facts";
import type { WorkspaceKnowledgeDocument } from "@/modules/knowledge/workspace-repository";

/**
 * What the agent can actually retrieve and quote from this document.
 *
 * The surface answers that question by showing the passages themselves — with
 * the page they came from and how often answers have used them — rather than
 * by describing what it is. The one thing the passages cannot say (that layout
 * and images are absent) is a tooltip on the section label, not a paragraph.
 */
export function AgentDocumentView({
  document,
  search,
}: {
  document: WorkspaceKnowledgeDocument;
  search: string;
}) {
  const facts = documentFacts(document);
  const needle = search.trim().toLowerCase();
  const sections = needle
    ? facts.sections.filter((section) =>
        `${section.heading} ${section.body}`.toLowerCase().includes(needle))
    : facts.sections;

  return (
    <article aria-label="Agent view" className="knowledge-agent">
      <div className="knowledge-agent__label">
        <span className="knowledge-eyebrow">Retrievable passages</span>
        <Tooltip label="Extracted text only — layout, images and anything unreadable are not held." side="bottom">
          <span className="knowledge-agent__hint" tabIndex={0}>
            <Info aria-hidden="true" size={14} />
            <span className="sr-only">
              Extracted text only — layout, images and anything unreadable are not held.
            </span>
          </span>
        </Tooltip>
        <span className="ml-auto">{facts.sections.length} held</span>
      </div>

      {sections.length ? (
        <ol className="knowledge-agent__sections">
          {sections.map((section) => (
            <li key={section.heading}>
              <div className="knowledge-agent__section-head">
                <h3>{section.heading}</h3>
                {section.citedCount ? (
                  <span className="knowledge-agent__cited">Cited {section.citedCount}×</span>
                ) : null}
                {section.page ? <span className="knowledge-agent__page">Page {section.page}</span> : null}
              </div>
              <p>{section.body}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="knowledge-paper__empty">
          {needle ? `No held passage matches “${search}”.` : "Nothing is held for this document yet."}
        </p>
      )}

      <RetrievalSummary document={document} />
    </article>
  );
}

function RetrievalSummary({ document }: { document: WorkspaceKnowledgeDocument }) {
  const ready = document.state === "ready" || document.state === "outdated";
  const working = document.state === "processing";
  const Icon = ready ? CircleCheck : working ? LoaderCircle : CircleAlert;

  return (
    <details className={`knowledge-agent__summary knowledge-agent__summary--${document.state}`}>
      <summary>
        <Icon
          aria-hidden="true"
          className={working ? "motion-safe:animate-spin" : undefined}
          size={16}
        />
        <span>{answerAvailability(document)}</span>
        <span className="knowledge-agent__summary-toggle">Details</span>
      </summary>
      <p>
        {document.processingError
          ?? (ready
            ? "Passages come from the text read when this document was processed."
            : "Passages appear once this document is processed.")}
      </p>
    </details>
  );
}
