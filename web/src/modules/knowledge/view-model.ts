/**
 * Turning the API's Items into what the Knowledge screen shows.
 *
 * The API answers in durable facts — an Item's status, its MIME type, when it
 * was last touched. A person reads "PDF · 1.1 MB · 2 days ago". Every such
 * phrase is derived here, in one place, so no screen invents one of its own
 * and no two screens word the same fact differently.
 */

import type { DocumentProcessing } from "@/modules/ingestion/runs-api";
import { fileKind, formatBytes, formatRelative } from "@/modules/workspace-control/format";
import type {
  KnowledgeDocumentKind,
  WorkspaceKnowledgeCollection,
  WorkspaceKnowledgeDocument,
} from "@/modules/knowledge/workspace-repository";

export interface ApiKnowledgeSource {
  id: string;
  connector_key: string;
  display_name: string | null;
  external_url?: string | null;
}

export interface ApiKnowledgeDocument {
  id: string;
  title: string;
  collection_id: string;
  content_type: string | null;
  document_type: string | null;
  processing: DocumentProcessing;
  updated_at: string;
  size_bytes?: number | null;
  source?: ApiKnowledgeSource | null;
}

export interface ApiKnowledgeCollection {
  id: string;
  title: string;
  description: string | null;
  parent_item_id: string | null;
  document_count: number;
  source_count: number;
  updated_at: string;
  /** What the caller may do in this Collection. */
  permissions: string[];
}

const SPREADSHEET = /sheet|excel|csv/i;
const PDF = /pdf/i;
const ARCHIVE = /(^|[/\s])(zip|x-zip-compressed|archive)(\s|$)|\.zip$/i;

/** What a person calls the format, from the MIME type or the file name. */
export function documentKind(document: ApiKnowledgeDocument): KnowledgeDocumentKind {
  // An archive is checked first: "report.pdf.zip" is an archive of a PDF.
  if (ARCHIVE.test(document.content_type ?? "") || ARCHIVE.test(document.title)
    || document.document_type === "archive") return "archive";
  const hint = `${document.content_type ?? ""} ${document.document_type ?? ""} ${document.title}`;
  if (PDF.test(hint)) return "pdf";
  if (SPREADSHEET.test(hint)) return "spreadsheet";
  if (document.processing.state === "unsupported") return "unsupported";
  return "document";
}

export function toWorkspaceDocument(
  document: ApiKnowledgeDocument,
  collectionTitle: string,
): WorkspaceKnowledgeDocument {
  return {
    id: document.id,
    title: document.title,
    kind: documentKind(document),
    state: document.processing.state,
    collectionId: document.collection_id,
    collection: collectionTitle,
    source: document.source?.display_name ?? "Uploaded to this workspace",
    updatedLabel: formatRelative(document.updated_at),
    size: formatBytes(document.size_bytes),
    // Page counts come from the document viewer, which reads the processed
    // content. A list row must not claim a number nobody has counted.
    pagesLabel: "",
    fileTypeLabel: fileKind(document.title, document.document_type),
    externalUrl: document.source?.external_url ?? undefined,
    processingError: document.processing.error ?? undefined,
    runId: document.processing.run_id ?? undefined,
    modifiedAt: document.updated_at,
    agentView: [],
  };
}

export function toWorkspaceCollection(
  collection: ApiKnowledgeCollection,
): WorkspaceKnowledgeCollection {
  return {
    id: collection.id,
    name: collection.title,
    source: collection.source_count
      ? `${collection.source_count} ${collection.source_count === 1 ? "source" : "sources"}`
      : "Uploads",
    sourceCount: collection.source_count,
    description: collection.description?.trim() || undefined,
    canShare: collection.permissions.includes("collection.share"),
    kind: collection.source_count ? "folder" : "upload",
    documentCount: collection.document_count,
    parentId: collection.parent_item_id,
    canProcess: collection.permissions.includes("ingestion.run"),
  };
}
