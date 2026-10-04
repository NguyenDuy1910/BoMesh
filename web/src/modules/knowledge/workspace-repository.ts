/**
 * The view model the Knowledge screen renders.
 *
 * These describe how a document is shown, not how it is stored: the API
 * returns Items, and `knowledge/view-model.ts` maps one onto the other. The
 * split exists because the screen shows a person "18 pages · 1.1 MB · synced
 * 8 minutes ago", and none of those are columns.
 */
import type { ProcessingState } from "@/modules/ingestion/runs-api";

export type KnowledgeDocumentKind = "pdf" | "document" | "spreadsheet" | "archive" | "unsupported";

/**
 * Where a document stands in processing, as the backend reports it
 * (`Document.processing.state`). `unsupported` is separate from `failed` on
 * purpose: a failed document may succeed in a new run, an unsupported format
 * never will.
 */
export type KnowledgeDocumentState = ProcessingState;

/** One retrievable passage, as the agent holds it. */
export interface KnowledgeAgentSection {
  heading: string;
  body: string;
  page?: number;
  /** How often answers have quoted this passage. Omitted when never quoted. */
  citedCount?: number;
}

export interface WorkspaceKnowledgeDocument {
  id: string;
  title: string;
  kind: KnowledgeDocumentKind;
  state: KnowledgeDocumentState;
  /** The Collection Item it lives in. */
  collectionId?: string;
  collection: string;
  source: string;
  updatedLabel: string;
  size: string;
  pagesLabel: string;
  /** A lifecycle tombstone. Normal workspace reads exclude this document. */
  removedAt?: string;
  agentView: string[];

  /* Everything below is optional so the personal Library, which builds these
     records from an upload, keeps working without inventing values it has no
     way to know. Each has a derivation in `documentFacts`. */

  /** "PDF", "DOCX", "XLSX" — the word a person uses for the format. */
  fileTypeLabel?: string;
  /** Where the document lives inside its source. */
  path?: string;
  /** The file in its own source. Absent for anything with no home to open. */
  externalUrl?: string;
  owner?: string;
  modifiedAt?: string;
  /** Why its latest run could not process it, written for people. */
  processingError?: string;
  /** The latest run that included it. */
  runId?: string;
  /** Retrieval-ready passages. Falls back to `agentView` lines. */
  sections?: KnowledgeAgentSection[];
}

export interface WorkspaceKnowledgeCollection {
  /** The Collection Item this row stands for. Uploads are addressed by it. */
  id: string;
  /** Matches `WorkspaceKnowledgeDocument.collection`; it is also the scope key. */
  name: string;
  /** Where the collection comes from, in one short phrase. */
  source: string;
  kind: "folder" | "upload" | "web";
  documentCount: number;
  /** Connected sources that sync into it; 0 means people upload to it. */
  sourceCount?: number;
  /** What it holds, in its owner's words. */
  description?: string;
  /** Whether the caller may see and change who can open it. */
  canShare?: boolean;
  /** The Collection it is nested in; null at the top of the tree. */
  parentId: string | null;
  /** Whether the caller may run processing over its documents. */
  canProcess: boolean;
  /**
   * Visible but not openable. The count still reconciles with the workspace
   * total, which is why the row stays rather than being filtered away.
   */
  restricted?: boolean;
  owner?: string;
}
