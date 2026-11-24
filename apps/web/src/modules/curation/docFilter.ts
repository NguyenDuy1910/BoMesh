import { docTypeOf, itemTypeOf } from "../knowledge/fileClass";
import { PROCESSING_ORDER, PROCESSING_STATE, type ProcessingKey } from "./lifecycle";
import type { QueueFilter } from "./model";

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
  if (query.q) and.push(nameSearch(query.q));
  return and.join(" AND ");
}

/** ListItems' filter for All: knowledge documents, then the document filter. */
export function listFilter(documents: string): string {
  return ["itemKind = DOCUMENT", "document.purpose = KNOWLEDGE", documents].filter(Boolean).join(" AND ");
}

/* ═══════════════ Studio queues: one server filter per view and count ═══════════════ */

/**
 * Every Documents view is one server-paged list and every count the same filter with `pageSize=1` (`totalSize`):
 * nothing reads a whole queue. `scope` = the shared root collections the caller looks after (full names, non-empty;
 * the All view's scope).
 */

const anyOf = (field: string, values: readonly string[]) => `(${values.map((v) => `${field} = ${v}`).join(" OR ")})`;

/** Open submissions (ListContributions). */
const OPEN = '(state = "IN_REVIEW" OR state = "ANALYZING")';

/** Review (ListContributions): open submissions ready to decide — every new version, a new document once processed (or a format that can't be). */
export const REVIEW_READY = `${OPEN} AND (kind = NEW_REVISION OR itemIndexingState = SUCCEEDED OR itemIndexingState = OUTDATED OR itemIndexingState = UNSUPPORTED)`;

/**
 * Processing's submissions (ListContributions): members' new documents not processed yet. A source's candidates are
 * unpublished documents in its shared collection, so ListItems lists them with the documents.
 */
export const SUBMISSIONS_TO_PROCESS = `${OPEN} AND kind = NEW_DOCUMENT AND origin = MEMBER AND ${anyOf("itemIndexingState", ["PENDING", "RUNNING", "FAILED"])}`;

/** Processing states Processing lists (`document.indexingState`): not processed for the current revision. */
export const TO_PROCESS_STATES = ["PENDING", "RUNNING", "FAILED", "OUTDATED"] as const;

/** The scoped knowledge documents (ListItems) with `clauses` ANDed. */
export const curatedFilter = (scope: readonly string[], ...clauses: string[]) => listFilter([documentFilter({ processing: "", kb: "", pub: "", src: "", type: "", topic: "", q: "" }, { workspace: "", scope }), ...clauses].filter(Boolean).join(" AND "));

/** Processing's documents (ListItems): not processed, failed or changed since (`states` narrows it, e.g. a pill). */
export const documentsToProcess = (scope: readonly string[], states: readonly string[] = TO_PROCESS_STATES) => curatedFilter(scope, anyOf("document.indexingState", states));

const PUBLISHED = "document.publicationState = PUBLISHED";

/** Why a published document is due for re-verification (Re-verification due's Reason filter). */
export const REVERIFY_REASON = {
  expired: "document.verification.state = REVIEW_DUE",
  never: "(document.verification.state = UNVERIFIED AND document.indexingState = SUCCEEDED)",
} as const;

/** Re-verification due (ListItems): published, not changed at its source, and past its review date or processed and never verified (`reason` narrows it). */
export const reverifyFilter = (scope: readonly string[], reason?: keyof typeof REVERIFY_REASON) =>
  curatedFilter(scope, PUBLISHED, "document.indexingState != OUTDATED", reason ? REVERIFY_REASON[reason] : `(${REVERIFY_REASON.expired} OR ${REVERIFY_REASON.never})`);

/** The detail a published document lacks (Missing details' Missing filter). */
export const DETAIL_GAP = { topic: "NOT document.topics:*", owner: "NOT document.owner:*", summary: "NOT document.summary:*" } as const;

/** Missing details (ListItems): published without a topic, an owner or a summary (`gap` narrows it to one). */
export const detailsFilter = (scope: readonly string[], gap?: keyof typeof DETAIL_GAP) =>
  curatedFilter(scope, PUBLISHED, gap ? DETAIL_GAP[gap] : `(${DETAIL_GAP.topic} OR ${DETAIL_GAP.owner} OR ${DETAIL_GAP.summary})`);

/** Published documents in scope (ListItems), or only the verified ones (Knowledge health's share). */
export const publishedFilter = (scope: readonly string[], { verified = false }: { verified?: boolean } = {}) => curatedFilter(scope, PUBLISHED, verified ? "document.verification.state = VERIFIED" : "");

/** The contributions about a page of documents (ListContributions, `item` = the candidate), at most a page's worth. */
export const contributionsOf = (items: readonly string[]) => items.map((n) => `item = ${aipString(n)}`).join(" OR ");

/** Search on the name: `displayName` with AIP-160 wildcards (typed `*` dropped), or nothing for a blank query. */
export function nameSearch(q: string): string {
  const term = q.trim().replace(/\*/g, "");
  return term ? `displayName = ${aipString(`*${term}*`)}` : "";
}

/** Topics → Suggestions → Without a topic (ListItems): processed documents in scope the assistant gave no topic. */
export const withoutTopicFilter = (scope: readonly string[]) => curatedFilter(scope, "document.indexingState = SUCCEEDED", DETAIL_GAP.topic);

/**
 * Documents in scope carrying `topic` as the assistant applied it, unconfirmed (a card's sample; what Confirm topic
 * confirms), or carrying any such topic (the `document.assistantTopics` facet that counts Topics to confirm).
 */
export const assistantTaggedFilter = (scope: readonly string[], topic?: string) => curatedFilter(scope, `document.assistantTopics:${topic ? aipString(topic) : "*"}`);

/** A topic's published documents in one collection (a topic's Distribution: one count per collection in scope). */
export const publishedWithTopic = (collection: string, topic: string) => curatedFilter([collection], PUBLISHED, `document.topics:${aipString(topic)}`);

/* ═══════════════ Review and Processing: their filters as server clauses ═══════════════ */

/** Search on a submission's document name (ListContributions `itemDisplayName`, wildcards as `nameSearch`). */
export function itemNameSearch(q: string): string {
  const term = q.trim().replace(/\*/g, "");
  return term ? `itemDisplayName = ${aipString(`*${term}*`)}` : "";
}

/** Review's queue filters (`QUEUE_FILTERS`) as ListContributions clauses: Flagged = any flag (a new version always is one). */
export const QUEUE_FILTER_CLAUSE = {
  all: "",
  flagged: "(flags:DUPLICATE OR flags:NEW_REVISION OR flags:PERSONAL_DATA OR flags:UNSEARCHABLE_FORMAT OR kind = NEW_REVISION)",
  version: "kind = NEW_REVISION",
  sync: "origin = SOURCE",
} as const satisfies Readonly<Record<QueueFilter, string>>;

/** Review's list: ready to decide, narrowed by a queue filter, a target collection (bare ID or name) and a search. */
export function reviewFilter({ queue, collection, q }: { queue: QueueFilter; collection: string; q: string }, workspace: string): string {
  return [REVIEW_READY, QUEUE_FILTER_CLAUSE[queue], collection ? `targetCollection = ${aipString(full(workspace, "items", collection))}` : "", itemNameSearch(q)].filter(Boolean).join(" AND ");
}

/** Processing's state pills the server filters (the processing state); Waiting and Processed are the run's tasks. */
export const PROCESSING_PILL_STATE = { pending: "PENDING", processing: "RUNNING", failed: "FAILED", outdated: "OUTDATED" } as const;
export type ProcessingPill = keyof typeof PROCESSING_PILL_STATE;

/** Processing's filters: a server pill, the Collection (bare ID or name), the search. */
export interface ProcessingQuery {
  state: ProcessingPill | "";
  kb: string;
  q: string;
}

/** Processing's submissions for its filters (`targetCollection` for the Collection); null when the pill holds none (a submission is never changed at its source). */
export function processingSubmissions(query: ProcessingQuery, workspace: string): string | null {
  if (query.state === "outdated") return null;
  return [
    SUBMISSIONS_TO_PROCESS,
    query.state ? `itemIndexingState = ${PROCESSING_PILL_STATE[query.state]}` : "",
    query.kb ? `targetCollection = ${aipString(full(workspace, "items", query.kb))}` : "",
    itemNameSearch(query.q),
  ]
    .filter(Boolean)
    .join(" AND ");
}

/** Processing's documents for its filters (the Collection replaces the scope); null with nowhere to look. */
export function processingDocuments(scope: readonly string[], query: ProcessingQuery, workspace: string): string | null {
  const within = query.kb ? [full(workspace, "items", query.kb)] : scope;
  if (!within.length) return null;
  return [documentsToProcess(within, query.state ? [PROCESSING_PILL_STATE[query.state]] : TO_PROCESS_STATES), nameSearch(query.q)].filter(Boolean).join(" AND ");
}
