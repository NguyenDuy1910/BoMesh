import type { StatusTone } from "@/components/ui/StatusPill";
import type { ProcessingState } from "@/modules/ingestion/runs-api";
import { formatDateTime } from "@/modules/workspace-control/format";

import type {
  KnowledgeAgentSection,
  WorkspaceKnowledgeDocument,
} from "./workspace-repository";

/**
 * One reading of a document, shared by the list, the viewer and the drawer.
 *
 * Records reach the interface from two places — the workspace snapshot, which
 * knows everything, and a personal upload, which knows only what the file
 * itself carries. Deriving the missing facts once, here, is what lets a single
 * row and a single viewer present both without either growing a branch.
 */
export interface DocumentFacts {
  fileTypeLabel: string;
  /** "6 sheets" / "48 pages" — the unit that matches the format. */
  extentLabel: string;
  path: string;
  modifiedLabel: string;
  sections: KnowledgeAgentSection[];
  /** Whether the format can be paged through at all. */
  pageable: boolean;
}

const KIND_LABEL = {
  pdf: "PDF",
  document: "Document",
  spreadsheet: "Spreadsheet",
  archive: "Archive",
  unsupported: "File",
} as const;

export function documentFacts(document: WorkspaceKnowledgeDocument): DocumentFacts {
  const extension = document.title.split(".").pop()?.toUpperCase();
  const fileTypeLabel =
    document.fileTypeLabel
    ?? (extension && extension.length <= 8 && extension !== document.title.toUpperCase()
      ? extension
      : KIND_LABEL[document.kind]);

  const sections = document.sections
    ?? document.agentView.map((line, index) => ({
      heading: index === 0 ? line : `Passage ${index}`,
      body: line,
    }));

  return {
    fileTypeLabel,
    extentLabel: document.pagesLabel,
    path: document.path ?? document.collection ?? "Unfiled",
    modifiedLabel: document.modifiedAt ? formatDateTime(document.modifiedAt) : document.updatedLabel,
    sections,
    pageable: document.kind !== "unsupported" && document.kind !== "archive",
  };
}

export interface DocumentStatus {
  label: string;
  tone: StatusTone;
}

/**
 * How each processing state reads, in the words every surface uses.
 *
 * `unsupported` is neutral rather than red: nothing went wrong and no run can
 * change it, so an alarm colour would send the reader looking for a fix that
 * does not exist.
 */
export const PROCESSING_STATUS: Record<ProcessingState, DocumentStatus> = {
  pending: { label: "Pending", tone: "neutral" },
  processing: { label: "Processing", tone: "info" },
  ready: { label: "Ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  outdated: { label: "Outdated", tone: "warning" },
  unsupported: { label: "Unsupported", tone: "neutral" },
};

/**
 * Whether the assistant can find this knowledge, in one phrase — the only
 * processing fact Knowledge shows. Ready and outdated content is searchable;
 * how it got there is Ingestion's business. `undefined` means nothing to say.
 */
export function searchAvailability(document: WorkspaceKnowledgeDocument): string | undefined {
  switch (document.state) {
    case "ready":
    case "outdated":
      return undefined;
    case "unsupported":
      return "Can’t be searched";
    default:
      return "Not searchable yet";
  }
}

/** Whether a run would do anything for this document. */
export function canProcess(document: WorkspaceKnowledgeDocument): boolean {
  return document.state !== "unsupported" && document.state !== "processing";
}

/** Whether answers can quote this document right now. */
export function answerAvailability(document: WorkspaceKnowledgeDocument): string {
  if (document.kind === "archive") {
    return document.state === "ready"
      ? "Its files were added as separate documents"
      : "Its files are unpacked when it is processed";
  }
  switch (document.state) {
    case "ready":
    case "outdated":
      return "Used in answers";
    case "unsupported":
      return "This format can’t be used in answers";
    default:
      return "Not available for search yet";
  }
}

/** Where a run is read in detail. */
export function runHref(runId: string): string {
  return `/workspace-control/ingestion?run=${encodeURIComponent(runId)}`;
}

/**
 * The supporting line under a document's name.
 *
 * Two things shape it. Inside a collection, the collection is already the
 * heading, so repeating it on every row spends the line on something the
 * reader just read. And the narrow layout has no date column, so the date
 * joins the line there and only there — never in both places at once.
 */
export function documentMeta(
  document: WorkspaceKnowledgeDocument,
  { scoped = false, layout = "full" }: { scoped?: boolean; layout?: "full" | "narrow" } = {},
): string {
  const facts = documentFacts(document);
  return [
    scoped ? null : document.collection,
    facts.fileTypeLabel,
    document.size,
    layout === "narrow" ? document.updatedLabel : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
