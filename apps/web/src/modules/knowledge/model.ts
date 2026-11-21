import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Database,
  EyeOff,
  File,
  FileText,
  Globe,
  ImageIcon,
  LoaderCircle,
  Monitor,
  Music,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Table,
  User,
  Video,
  type LucideIcon,
} from "lucide-react";

import { fmtDate } from "@/lib/format";

import type { Contribution, DocumentCover, Item, SearchItemsFacet, SearchItemsRequest, SearchItemsResult, Topic } from "./api";
import { DOC_TYPE_LABELS, docTypeOf, fileClassOf, itemTypeOf, type DocTypeId } from "./fileClass";
import { readableTitle } from "./title";

export { docTypeOf, fileClassOf, itemTypeOf, readableTitle, type DocTypeId };

/**
 * The knowledge resource model (preview `core/catalog.js` + `core/lifecycle.js`)
 * mapped onto `/api/v1` Items: the document type (file class), topics, trust, the one
 * lifecycle label people see, and Browse's URL state ↔ SearchItems request.
 * Pure functions only: components read through `toResource()`.
 */

/* ═══════════════ Document type: the file class (`Item.itemType`; derived from the file, never edited) ═══════════════ */

export interface DocTypeMeta {
  label: string;
  icon: LucideIcon;
  /** Tone of the blank preview tile (`doc-thumb--<tone>`). */
  tone?: "danger" | "accent" | "success" | "warning";
}

const DOC_TYPE_ICONS: Readonly<Record<DocTypeId, LucideIcon>> = {
  pdf: FileText,
  word: FileText,
  presentation: Monitor,
  spreadsheet: Table,
  markdown: FileText,
  html: Globe,
  plain_text: File,
  data: Database,
  image: ImageIcon,
  audio: Music,
  video: Video,
  archive: Archive,
  other: File,
};

const DOC_TYPE_TONES: Readonly<Partial<Record<DocTypeId, DocTypeMeta["tone"]>>> = { pdf: "danger", word: "accent", spreadsheet: "success", presentation: "warning" };

export const DOC_TYPES = Object.fromEntries(
  (Object.keys(DOC_TYPE_LABELS) as DocTypeId[]).map((id) => [id, { label: DOC_TYPE_LABELS[id], icon: DOC_TYPE_ICONS[id], tone: DOC_TYPE_TONES[id] }]),
) as Readonly<Record<DocTypeId, DocTypeMeta>>;

/** Type options for a filter over the given documents' classes, by label. */
export const docTypeOptions = (types: Iterable<DocTypeId>): [DocTypeId, string][] =>
  [...new Set(types)].map((t): [DocTypeId, string] => [t, DOC_TYPES[t].label]).sort((a, b) => a[1].localeCompare(b[1]));

export const LANGS: Readonly<Record<string, string>> = { en: "English", vi: "Vietnamese" };
export const languageName = (code: string) => LANGS[code.split("-")[0]] ?? code;

/* ═══════════════ Topics (the workspace's domain → topic tree) ═══════════════ */

export interface TopicNode extends Topic {
  id: string;
  children: (Topic & { id: string })[];
}

const lastSegment = (name: string | undefined) => (name ? name.slice(name.lastIndexOf("/") + 1) : "");

/** Domains with their topics (active only), in API order. */
export function topicTree(topics: readonly Topic[]): TopicNode[] {
  const live = topics.filter((t) => !t.state || t.state === "ACTIVE");
  return live
    .filter((t) => t.kind === "DOMAIN")
    .map((d) => ({
      ...d,
      id: lastSegment(d.name),
      children: live.filter((t) => t.kind === "TOPIC" && t.parentTopic === d.name).map((t) => ({ ...t, id: lastSegment(t.name) })),
    }));
}

/** Topic name → display name. */
export function topicNames(topics: readonly Topic[]): Map<string, string> {
  return new Map(topics.map((t) => [t.name ?? "", t.displayName ?? "Untitled topic"]));
}

/* ═══════════════ Trust (verification + freshness) ═══════════════ */

export type TrustState = "verified" | "review" | "unverified" | "personal";

export const TRUST: Readonly<Record<TrustState, { tone: "success" | "warning" | "default"; label: string; icon: LucideIcon; desc: string }>> = {
  verified: { tone: "success", label: "Verified", icon: ShieldCheck, desc: "An owner confirmed it is accurate and current." },
  review: { tone: "warning", label: "Review due", icon: Clock, desc: "It may be out of date. Check with the owner before relying on it." },
  unverified: { tone: "default", label: "Not verified", icon: CircleDashed, desc: "No owner has confirmed it yet." },
  personal: { tone: "default", label: "Your file", icon: User, desc: "Only you can see it." },
};

export interface Trust {
  state: TrustState;
  /** Why: "Verified by … on …", "Verification expired …", "The original changed at the source…". Uses `verifierName` when known. */
  note: string;
  verifier?: string;
  verifyTime?: string;
  nextReviewTime?: string;
}

/** Trust of a document. Outdated at the source or past its review date → Review due. */
export function trustOf(item: Item, { personal = false, verifierName }: { personal?: boolean; verifierName?: string } = {}): Trust {
  if (personal) return { state: "personal", note: TRUST.personal.desc };
  const doc = item.document;
  const v = doc?.verification;
  const who = verifierName || "an owner";
  const base = { verifier: v?.verifier, verifyTime: v?.verifyTime, nextReviewTime: v?.nextReviewTime };
  if (doc?.indexingState === "OUTDATED") {
    return { state: "review", ...base, note: "The original changed at the source. Answers use the previous version until it’s reprocessed." };
  }
  const expired = v?.nextReviewTime && Date.parse(v.nextReviewTime) < Date.now();
  if (v?.state === "REVIEW_DUE" || (v?.state === "VERIFIED" && expired)) {
    return { state: "review", ...base, note: v?.nextReviewTime ? `Verification expired ${fmtDate(v.nextReviewTime)}.` : TRUST.review.desc };
  }
  if (v?.state === "VERIFIED") {
    const due = v.nextReviewTime ? ` · next review ${fmtDate(v.nextReviewTime)}` : "";
    return { state: "verified", ...base, note: `Verified by ${who} on ${fmtDate(v.verifyTime)}${due}.` };
  }
  return { state: "unverified", note: "No owner has confirmed this resource yet." };
}

/* ═══════════════ Lifecycle (one label for people; DOCUMENT_LIFECYCLE.md) ═══════════════ */

export type LifecycleKey =
  | "analyzing"
  | "review"
  | "changes"
  | "rejected"
  | "withdrawn"
  | "queued"
  | "publishing"
  | "published"
  | "update"
  | "failed"
  | "merged"
  | "stored"
  | "unpublished"
  | "archived";

export interface LifecycleMeta {
  tone: "default" | "accent" | "success" | "warning" | "danger";
  label: string;
  icon: LucideIcon;
  desc: string;
  live?: boolean;
  quiet?: boolean;
}

export const LIFECYCLE: Readonly<Record<LifecycleKey, LifecycleMeta>> = {
  analyzing: { tone: "accent", label: "Analyzing", icon: Sparkles, live: true, desc: "Reading the file and suggesting topics and a collection." },
  review: { tone: "accent", label: "In review", icon: Clock, desc: "A reviewer will check it before it’s published." },
  changes: { tone: "warning", label: "Changes requested", icon: Pencil, desc: "A reviewer asked for changes before it can be published." },
  rejected: { tone: "danger", label: "Declined", icon: CircleX, desc: "A reviewer declined it. It won’t be published." },
  withdrawn: { tone: "default", label: "Withdrawn", icon: Archive, desc: "You withdrew it. Reviewers don’t see it anymore." },
  queued: { tone: "default", label: "Not processed", icon: CircleDashed, desc: "Published, but not processed yet: people can open it from its collection; search and the assistant can’t use it until it’s processed." },
  publishing: { tone: "accent", label: "Processing", icon: LoaderCircle, live: true, desc: "Being read, classified and indexed. It will be searchable in a few minutes." },
  published: { tone: "success", label: "Published", icon: CircleCheck, quiet: true, desc: "Searchable and available to the assistant." },
  update: { tone: "warning", label: "Changed at the source", icon: RefreshCw, desc: "The original changed at its source. Answers use the previous version until it’s processed again." },
  failed: { tone: "danger", label: "Processing failed", icon: CircleAlert, desc: "It couldn’t be read or indexed. Its fix is in Documents → Issues." },
  merged: { tone: "success", label: "Published as new version", icon: CircleCheck, quiet: true, desc: "It replaced the earlier version of the document." },
  stored: { tone: "default", label: "Stored, not searchable", icon: File, desc: "This file type can’t be searched. People can still download it." },
  unpublished: { tone: "default", label: "Unpublished", icon: EyeOff, desc: "Hidden from readers, search and answers. Editors can publish it." },
  archived: { tone: "default", label: "Archived", icon: Archive, desc: "Removed from the library." },
};

const INDEXING_TO_LIFE: Readonly<Record<string, LifecycleKey>> = {
  PENDING: "queued",
  RUNNING: "publishing",
  SUCCEEDED: "published",
  OUTDATED: "update",
  FAILED: "failed",
  UNSUPPORTED: "stored",
};

const CONTRIBUTION_TO_LIFE: Readonly<Record<string, LifecycleKey>> = {
  ANALYZING: "analyzing",
  IN_REVIEW: "review",
  CHANGES_REQUESTED: "changes",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
};

/** Lifecycle key of a document and/or its contribution. An open contribution decides; otherwise the item's states do. */
export function lifecycleKey({ item, contribution }: { item?: Item | null; contribution?: Contribution | null }): LifecycleKey {
  if (contribution?.state && CONTRIBUTION_TO_LIFE[contribution.state]) return CONTRIBUTION_TO_LIFE[contribution.state];
  if (contribution?.state === "APPROVED" && contribution.kind === "NEW_REVISION") return "merged";
  if (!item) return contribution?.state === "APPROVED" ? "published" : "review";
  if (item.state === "DELETED") return "archived";
  const doc = item.document;
  if (doc?.publicationState === "UNPUBLISHED") return "unpublished";
  if (doc?.contentState === "FAILED") return "failed";
  if (doc?.contentState === "PENDING") return "queued";
  return INDEXING_TO_LIFE[doc?.indexingState ?? "PENDING"] ?? "published";
}

/* ═══════════════ Resource view model ═══════════════ */

export interface ModelContext {
  /** Bare workspace ID. */
  workspaceId: string;
  /** The caller's PERSONAL collection name ("My files"). */
  personalCollection?: string;
  /** Every personal collection the caller can see (theirs and, for admins, other members'). */
  personalCollections?: ReadonlySet<string>;
  /** Topic name → display name. */
  topicNames?: ReadonlyMap<string, string>;
  /** Collection name → display name (root collections, `ancestors` facet values, item ancestors). */
  collectionNames?: ReadonlyMap<string, string>;
}

export interface ResourceSource {
  /** `upload` or the source's resource name. */
  key: string;
  /** `upload` for uploads; for synced files the source name (the shell's AppIcon resolves a connector by source). */
  isUpload: boolean;
  path: string;
  url: string;
}

export interface Resource {
  item: Item;
  /** Full item name. */
  name: string;
  /** Bare item ID (routes: `/doc/{id}`). */
  id: string;
  /** Display name without a file extension. */
  title: string;
  fileName: string;
  /** Lower-case extension ("pdf"). */
  ext: string;
  mime: string;
  /** The file class (`itemType`). */
  type: DocTypeId;
  typeMeta: DocTypeMeta;
  /** Topic names (resource names). */
  topics: string[];
  /** The collection (root collection) or the parent collection when the root isn't known. `personal`: a member's own
   *  files, named by the UI (“My files”, “Lan’s files”), so the name is translated, unlike collection names. */
  base: { name: string; id: string; displayName: string; personal: boolean } | null;
  isPersonal: boolean;
  /** Member resource name accountable for the content. */
  owner?: string;
  source: ResourceSource;
  summary: string;
  language: string;
  updated?: string;
  sizeBytes: number;
  trust: Trust;
  lifecycle: LifecycleKey;
  /** Has a searchable rendition (passages, Ask). */
  readable: boolean;
  /** Caller can edit (from `access`; confirm with testIamPermissions for actions). */
  editable: boolean;
  deleted: boolean;
  /** What the first page of the current revision looks like (`DocumentFacet.cover`); comes with the item, no content read. */
  cover?: DocumentCover;
}

/** The collection an item lives in: the root ancestor (FULL view) else the parent when known. */
function baseOf(item: Item, ctx: ModelContext): Resource["base"] {
  const root = item.ancestors?.[0];
  const name = root?.name || item.parentItem || "";
  if (!name) return null;
  const displayName = ctx.collectionNames?.get(name) || root?.displayName || "";
  const personal = name === ctx.personalCollection || !!ctx.personalCollections?.has(name);
  return { name, id: lastSegment(name), displayName, personal };
}

/** Everything the knowledge UI shows about a document. Cheap; call freely. */
export function toResource(item: Item, ctx: ModelContext, extra: { contribution?: Contribution | null; verifierName?: string } = {}): Resource {
  const doc = item.document;
  const fileName = doc?.fileName || item.displayName || "";
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1] ?? "").toLowerCase();
  const title = readableTitle((item.displayName || fileName).replace(/\.[a-z0-9]{1,5}$/i, ""));
  const type = docTypeOf(item.itemType);
  const base = baseOf(item, ctx);
  const isPersonal = !!ctx.personalCollection && (base?.name === ctx.personalCollection || item.parentItem === ctx.personalCollection);
  const origin = doc?.origin;
  const index = doc?.indexingState;
  return {
    item,
    name: item.name ?? "",
    id: lastSegment(item.name),
    title,
    fileName,
    ext,
    mime: doc?.mimeType ?? "",
    type,
    typeMeta: DOC_TYPES[type],
    topics: doc?.topics ?? [],
    base: base && isPersonal ? { ...base, displayName: base.displayName || "My files" } : base,
    isPersonal,
    owner: doc?.owner,
    source: {
      key: origin?.source || "upload",
      isUpload: !origin?.source,
      path: origin?.path ?? "",
      url: origin?.externalUri ?? "",
    },
    summary: doc?.summary ?? "",
    language: doc?.languageCode || "en",
    updated: item.updateTime,
    sizeBytes: Number(doc?.sizeBytes ?? 0),
    trust: trustOf(item, { personal: isPersonal, verifierName: extra.verifierName }),
    lifecycle: lifecycleKey({ item, contribution: extra.contribution }),
    readable: index === "SUCCEEDED" || index === "OUTDATED",
    editable: item.access === "EDITOR" || item.access === "OWNER",
    deleted: item.state === "DELETED",
    cover: doc?.cover,
  };
}

/** Pipeline states only editors can act on (preview `statusChip`); `null` for healthy/readable documents. */
export function indexStatusOf(r: Resource): "pending" | "processing" | "failed" | "unsupported" | null {
  if (!r.editable || r.isPersonal) return null;
  const s = r.item.document?.indexingState;
  if (r.item.document?.contentState === "FAILED" || s === "FAILED") return "failed";
  if (s === "RUNNING") return "processing";
  if (s === "PENDING") return "pending";
  if (s === "UNSUPPORTED") return "unsupported";
  return null;
}

/* ═══════════════ Browse: facets, URL state ↔ SearchItems ═══════════════ */

export type FacetId = "topic" | "type" | "owner" | "src" | "kb" | "trust" | "upd";

export interface FacetDef {
  id: FacetId;
  label: string;
  /** SearchItems facet field (`updateTime` is an interval facet over UPDATED_WINDOWS). */
  field: string;
  single?: boolean;
}

/**
 * Browse dimensions backed by SearchItems. Missing vs the preview: Space (no item ↔ space
 * facet; space materials aren't searchable) and Language (`document.languageCode` is a facet
 * but not a filter field). See the knowledge-core report.
 */
export const FACETS: readonly FacetDef[] = [
  { id: "topic", label: "Topic", field: "document.topics" },
  { id: "type", label: "Type", field: "itemType" },
  { id: "owner", label: "Owner", field: "document.owner" },
  { id: "src", label: "Source", field: "document.origin.source" },
  { id: "kb", label: "Collection", field: "ancestors" },
  { id: "trust", label: "Trust", field: "document.verification.state" },
  { id: "upd", label: "Updated", field: "updateTime", single: true },
];

export const UPDATED_WINDOWS: ReadonlyArray<readonly [string, string, number]> = [
  ["7d", "Past week", 7],
  ["30d", "Past month", 30],
  ["365d", "Past year", 365],
];

export const SORTS_CATALOG = { relevance: "Best match", updated: "Recently updated", title: "Title A–Z" } as const;
export type CatalogSort = keyof typeof SORTS_CATALOG;

export interface CatalogParams {
  q: string;
  /** "" = default (relevance with a query, else updated). */
  sort: CatalogSort | "";
  view: "grid" | "list";
  /** Facet id → selected values (bare IDs for topics, bases, owners, sources; keys otherwise). */
  filters: Partial<Record<FacetId, string[]>>;
  /** "Only documents I saved". */
  saved?: boolean;
}

type QueryLike = URLSearchParams | Readonly<Record<string, string | undefined>>;
const read = (q: QueryLike, key: string) => (q instanceof URLSearchParams ? q.get(key) : q[key]) ?? "";

/** URL query → catalog params. Multi-value facets are comma lists (preview `parseCatalogQuery`). */
export function parseCatalogQuery(query: QueryLike): CatalogParams {
  const sort = read(query, "sort");
  const p: CatalogParams = {
    q: read(query, "q").trim(),
    sort: sort in SORTS_CATALOG ? (sort as CatalogSort) : "",
    view: read(query, "view") === "list" ? "list" : "grid",
    filters: {},
  };
  for (const f of FACETS) {
    const values = read(query, f.id).split(",").filter(Boolean);
    if (values.length) p.filters[f.id] = f.single ? [values[0]] : values;
  }
  if (read(query, "saved") === "1") p.saved = true;
  return p;
}

/** Catalog params → query record (empty values dropped) for `router.replace`/hrefs. */
export function catalogQueryOf(p: Partial<CatalogParams>): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.q) out.q = p.q;
  if (p.sort) out.sort = p.sort;
  if (p.view === "list") out.view = "list";
  if (p.saved) out.saved = "1";
  for (const f of FACETS) {
    const v = p.filters?.[f.id];
    if (v?.length) out[f.id] = v.join(",");
  }
  return out;
}

/** `/knowledge?…` (Browse) for a params patch, e.g. `catalogHref({ filters: { topic: [topicId] } })`. */
export function catalogHref(p: Partial<CatalogParams> = {}): string {
  const qs = new URLSearchParams(catalogQueryOf(p)).toString();
  return "/knowledge" + (qs ? `?${qs}` : "");
}

export const activeFilterCount = (p: CatalogParams) =>
  Object.values(p.filters).reduce((n, v) => n + (v?.length ?? 0), 0) + (p.saved ? 1 : 0);

const TRUST_STATE: Readonly<Record<string, string>> = { verified: "VERIFIED", review: "REVIEW_DUE", unverified: "UNVERIFIED" };
const TRUST_KEY: Readonly<Record<string, TrustState>> = { VERIFIED: "verified", REVIEW_DUE: "review", UNVERIFIED: "unverified" };

/** AIP-160 string literal. */
const lit = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The AIP-160 clause for one facet's selected values (OR within a facet). */
function facetClause(id: FacetId, values: readonly string[], ws: string): string {
  const any = (parts: string[]) => (parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0] ?? "");
  switch (id) {
    case "topic":
      // Hierarchical on the server: a domain also matches everything under it.
      return any(values.map((v) => `document.topics:${lit(`workspaces/${ws}/topics/${v}`)}`));
    case "type":
      return any(values.map((v) => `itemType = ${itemTypeOf(docTypeOf(v))}`));
    case "owner":
      return any(values.map((v) => `document.owner = ${lit(`workspaces/${ws}/members/${v}`)}`));
    case "src":
      return any(values.map((v) => `document.origin.source = ${lit(v === "upload" ? "" : `workspaces/${ws}/sources/${v}`)}`));
    case "kb":
      return any(values.map((v) => `ancestors:${lit(`workspaces/${ws}/items/${v}`)}`));
    case "trust":
      return any(values.filter((v) => TRUST_STATE[v]).map((v) => `document.verification.state = ${TRUST_STATE[v]}`));
    case "upd": {
      const days = UPDATED_WINDOWS.find((w) => w[0] === values[0])?.[2];
      return days ? `updateTime >= ${lit(new Date(Date.now() - days * 86_400_000).toISOString())}` : "";
    }
  }
}

/** AIP-160 filter for the selected facets (AND across facets); `base` adds extra clauses (e.g. a subtree). */
export function catalogFilter(p: CatalogParams, ws: string, { base }: { base?: string } = {}): string {
  const clauses = FACETS.map((f) => (p.filters[f.id]?.length ? facetClause(f.id, p.filters[f.id]!, ws) : "")).filter(Boolean);
  if (base) clauses.unshift(base);
  return clauses.join(" AND ");
}

export const ORDER_BY: Readonly<Record<CatalogSort, string>> = { relevance: "", updated: "updateTime desc", title: "displayName" };

/**
 * SearchItems request for Browse (facets disjunctive, snippets + passages for previews). Updated is an
 * interval facet: one `updateTime` interval per window, in UPDATED_WINDOWS order.
 */
export function catalogSearchRequest(
  p: CatalogParams,
  ws: string,
  options: { base?: string; pageSize?: number; pageToken?: string; facets?: boolean } = {},
): SearchItemsRequest {
  const sort = p.sort || (p.q ? "relevance" : "updated");
  // Window starts are floored to the hour so requests built within the hour stay equal (cache keys).
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  return {
    query: p.q || undefined,
    filter: catalogFilter(p, ws, options) || undefined,
    orderBy: ORDER_BY[sort] || undefined,
    facetSpecs:
      options.facets === false
        ? undefined
        : FACETS.map((f) =>
            f.id === "upd"
              ? { field: f.field, intervals: UPDATED_WINDOWS.map(([, , days]) => ({ minimum: new Date(hour - days * 86_400_000).toISOString() })), excludedFromFilter: true }
              : { field: f.field, limit: f.id === "topic" ? 100 : 30, excludedFromFilter: true },
          ),
    contentSearchSpec: p.q ? { snippets: true, passages: 1 } : undefined,
    pageSize: options.pageSize ?? 30,
    pageToken: options.pageToken,
  };
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  on: boolean;
}

/**
 * API facets → `{ facetId: options }` with bare-ID values, preview labels and selected
 * values kept (count 0) so people can always deselect them.
 */
export function facetOptions(
  facets: readonly SearchItemsFacet[] | undefined,
  p: CatalogParams,
  labels: { owner?: (name: string) => string; source?: (name: string) => string } = {},
): Partial<Record<FacetId, FacetOption[]>> {
  const out: Partial<Record<FacetId, FacetOption[]>> = {};
  for (const def of FACETS) {
    const counts = new Map<string, { label: string; count: number }>();
    const add = (value: string, label: string, count: number) => {
      const prev = counts.get(value);
      counts.set(value, { label: prev?.label || label, count: (prev?.count ?? 0) + count });
    };
    const api = facets?.find((f) => f.field === def.field);
    for (const [i, v] of (api?.values ?? []).entries()) {
      const raw = v.value ?? "";
      const n = v.documentCount ?? 0;
      switch (def.id) {
        case "topic":
        case "kb":
          add(lastSegment(raw), v.displayName || "Untitled", n);
          break;
        case "owner":
          add(raw ? lastSegment(raw) : "—", raw ? labels.owner?.(raw) || v.displayName || "Owner" : "No owner", n);
          break;
        case "src":
          add(raw ? lastSegment(raw) : "upload", raw ? labels.source?.(raw) || v.displayName || "Source" : "Uploaded files", n);
          break;
        case "type": {
          const key = docTypeOf(raw);
          add(key, DOC_TYPES[key].label, n);
          break;
        }
        case "trust":
          if (TRUST_KEY[raw]) add(TRUST_KEY[raw], TRUST[TRUST_KEY[raw]].label, n);
          break;
        case "upd":
          // Interval values come back in request order: one per window.
          if (UPDATED_WINDOWS[i]) add(UPDATED_WINDOWS[i][0], UPDATED_WINDOWS[i][1], n);
          break;
      }
    }
    if (def.id === "upd") for (const [key, label] of UPDATED_WINDOWS) add(key, label, 0);
    for (const v of p.filters[def.id] ?? []) if (!counts.has(v)) add(v, v, 0);
    const opts = [...counts].map(([value, x]) => ({ value, label: x.label, count: x.count, on: !!p.filters[def.id]?.includes(value) }));
    if (def.id !== "upd") opts.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    out[def.id] = opts;
  }
  return out;
}

/** Highlighted snippet (the API marks matches with `<b>…</b>` or `<mark>`); `null` when none. */
export function snippetOf(result: SearchItemsResult): string | null {
  return result.snippets?.[0] || null;
}

/** The best passage of a search hit: `{ where: "Page 2", text }`. */
export function passageOf(result: SearchItemsResult): { where: string; text: string; passage?: string } | null {
  const p = result.passages?.[0];
  if (!p?.text) return null;
  return { where: p.pageNumber ? `Page ${p.pageNumber}` : "", text: p.text, passage: p.passage };
}

/** Lowercase and strip diacritics ("Lịch" → "lich"); used for local highlighting. */
export const fold = (s: string) =>
  s.toLowerCase().replace(/[^\u0000-\u007f]/g, (c) => (c === "đ" ? "d" : c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0) || c));

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i if in is it me my of on or our the their to was we what when where which who why will with you your about this that these those there any all after before".split(" "),
);

/** Query words worth highlighting (folded, no stop words). */
export const tokens = (q: string) =>
  fold(q)
    .replace(/[“”"]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

/** Splits text into plain and matching parts for `<mark class="srch-hl">` rendering (accent-insensitive). */
export function markParts(text: string, q: string): { text: string; hit: boolean }[] {
  const toks = tokens(q);
  if (!toks.length || !text) return [{ text, hit: false }];
  const folded = fold(text);
  const marks: [number, number][] = [];
  for (const t of toks) {
    let i = folded.indexOf(t);
    while (i >= 0) {
      marks.push([i, i + t.length]);
      i = folded.indexOf(t, i + t.length);
    }
  }
  if (!marks.length) return [{ text, hit: false }];
  marks.sort((a, b) => a[0] - b[0]);
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (e <= at) continue;
    const start = Math.max(s, at);
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, e), hit: true });
    at = e;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/* ═══════════════ Contribute (document_contract.md "Formats") ═══════════════ */

/** Knowledge formats the API accepts in a member's PERSONAL collection (images are attachments only; archives only into STANDARD collections). */
export const CONTRIBUTE_TYPES = ["pdf", "docx", "xlsx", "pptx", "txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "rst", "xml", "yaml", "yml"] as const;
/** Upload limit (`FILE_TOO_LARGE` above it). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Why a file can't be contributed, or "" when it can. */
export function fileProblem(file: { name: string; size: number }): string {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (!(CONTRIBUTE_TYPES as readonly string[]).includes(ext)) return "This file type isn’t supported";
  if (file.size > MAX_UPLOAD_BYTES) return "Larger than 100 MB";
  if (!file.size) return "This file is empty";
  return "";
}

/** Clip at a word boundary with an ellipsis. */
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
