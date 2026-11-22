import { docTypeOf, itemTypeOf } from "../knowledge/fileClass";
import { PROCESSING_ORDER, PROCESSING_STATE, type ProcessingKey } from "./lifecycle";

/**
 * Documents → All's filters as the ListItems AIP-160 document filter (preview `allRows`): the processing-state pills
 * (`document.indexingState`) and the facets — Collection (`ancestors:`), Publication, Origin (`document.origin.source`;
 * uploads and contributions have none), Type (the file class, `itemType`), Topic (hierarchical) — plus search on the name (`displayName` with
 * AIP-160 wildcards). The same string is the run selector's `filter` when "Select all matching" processes the list.
 * Pure (no React) so the mapping is unit-tested.
 */

/** All's URL state: `?processing= &kb= &pub= &src= &type= &topic= &q=` (bare IDs; `src=upload` or `contrib` = no source; `type=pdf`). */
export interface DocQuery {
  processing: ProcessingKey | "";
  kb: string;
  pub: "published" | "unpublished" | "";
  src: string;
  type: string;
  topic: string;
  q: string;
}

/** The facets (filter dropdowns); the processing pills and search are apart. */
export const DOC_FACETS = ["kb", "pub", "src", "type", "topic"] as const;
export type DocFacet = (typeof DOC_FACETS)[number];

/** Origin values without a source: uploads by editors and members' contributions (the API can't tell them apart). */
const NO_SOURCE: Readonly<Record<string, true>> = { upload: true, contrib: true };

/** All's query from the address (unknown values are left out). */
export function docQueryOf(get: (key: string) => string | null): DocQuery {
  const processing = get("processing") ?? "";
  const pub = get("pub") ?? "";
  return {
    processing: (PROCESSING_ORDER as readonly string[]).includes(processing) ? (processing as ProcessingKey) : "",
    kb: get("kb") ?? "",
    pub: pub === "published" || pub === "unpublished" ? pub : "",
    src: get("src") ?? "",
    type: get("type") ?? "",
    topic: get("topic") ?? "",
    q: (get("q") ?? "").trim(),
  };
}

/** AIP-160 string literal (`"` and `\` escaped). */
export const aipString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A full resource name for a bare ID (`kb=…`, `topic=…`, `src=…` carry bare IDs; full names pass through). */
const full = (workspace: string, collection: string, id: string) => (id.includes("/") ? id : `workspaces/${workspace}/${collection}/${id}`);

/**
 * The document filter for `query` over `scope` (the collections the caller looks after: full item names). A
 * Collection facet replaces the scope. Clauses are ANDed; the scope is one OR group.
 */
export function documentFilter(query: DocQuery, { workspace, scope }: { workspace: string; scope: readonly string[] }): string {
  const and: string[] = [];
  if (query.kb) and.push(`ancestors:${aipString(full(workspace, "items", query.kb))}`);
  else if (scope.length) and.push(scope.length === 1 ? `ancestors:${aipString(scope[0])}` : `(${scope.map((s) => `ancestors:${aipString(s)}`).join(" OR ")})`);
  if (query.processing) and.push(`document.indexingState = ${PROCESSING_STATE[query.processing]}`);
  if (query.pub) and.push(`document.publicationState = ${query.pub.toUpperCase()}`);
  if (query.src) and.push(NO_SOURCE[query.src] ? "document.origin.source = null" : `document.origin.source = ${aipString(full(workspace, "sources", query.src))}`);
  if (query.type) and.push(`itemType = ${itemTypeOf(docTypeOf(query.type))}`);
  if (query.topic) and.push(`document.topics:${aipString(full(workspace, "topics", query.topic))}`);
  if (query.q) and.push(`displayName = ${aipString(`*${query.q.replace(/\*/g, "")}*`)}`);
  return and.join(" AND ");
}

/** ListItems' filter for All: knowledge documents, then the document filter. */
export function listFilter(documents: string): string {
  return ["itemKind = DOCUMENT", "document.purpose = KNOWLEDGE", documents].filter(Boolean).join(" AND ");
}
