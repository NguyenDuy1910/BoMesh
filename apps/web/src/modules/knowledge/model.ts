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

import type {
  ConceptScheme,
  Contribution,
  DocumentConcept,
  DocumentCover,
  Item,
  SearchItemsFacet,
  SearchItemsInterpretation,
  SearchItemsRequest,
  SearchItemsResult,
} from "./api";
import { locationLabel, referenceOf, type Reference } from "./content/reference";
import { DOC_TYPE_LABELS, docTypeOf, fileClassOf, itemTypeOf, type DocTypeId } from "./fileClass";
import { acceptedConcepts, classSchemes, conceptNameOf, conceptsOf, resourceKey as lastSegment, schemeOfConcept, type Taxonomy } from "./taxonomy";
import { readableTitle } from "./title";

export { docTypeOf, fileClassOf, itemTypeOf, readableTitle, type DocTypeId };

/**
 * The knowledge resource model (preview `core/catalog.js` + `core/lifecycle.js`)
 * mapped onto `/api/v1` Items: the document type (file class), concepts, trust, the one
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

export const LANGS: Readonly<Record<string, string>> = { en: "Tiếng Anh", vi: "Tiếng Việt" };
export const languageName = (code: string) => LANGS[code.split("-")[0]] ?? code;

/* ═══════════════ Trust (verification + freshness) ═══════════════ */

export type TrustState = "verified" | "review" | "unverified" | "personal";

/** How a trust state looks; its label and description are the catalog's (`m.state.verification[state]`). */
export const TRUST: Readonly<Record<TrustState, { tone: "success" | "warning" | "default"; icon: LucideIcon }>> = {
  verified: { tone: "success", icon: ShieldCheck },
  review: { tone: "warning", icon: Clock },
  unverified: { tone: "default", icon: CircleDashed },
  personal: { tone: "default", icon: User },
};

export interface Trust {
  state: TrustState;
  /**
   * Why, when it says more than the state's description: "Verified by … on …", "Verification expired …", "The original
   * changed at the source…" (uses `verifierName` when known); "" otherwise (show `m.state.verification[state].desc`).
   */
  note: string;
  verifier?: string;
  verifyTime?: string;
  nextReviewTime?: string;
}

/** Trust of a document. Outdated at the source or past its review date → Re-verification due. */
export function trustOf(item: Item, { personal = false, verifierName }: { personal?: boolean; verifierName?: string } = {}): Trust {
  if (personal) return { state: "personal", note: "" };
  const doc = item.document;
  const v = doc?.verification;
  const who = verifierName || "chủ sở hữu";
  const base = { verifier: v?.verifier, verifyTime: v?.verifyTime, nextReviewTime: v?.nextReviewTime };
  if (doc?.indexingState === "OUTDATED") {
    return { state: "review", ...base, note: "Bản gốc đã thay đổi tại nguồn. Câu trả lời dùng phiên bản trước cho đến khi được xử lý lại." };
  }
  const expired = v?.nextReviewTime && Date.parse(v.nextReviewTime) < Date.now();
  if (v?.state === "REVIEW_DUE" || (v?.state === "VERIFIED" && expired)) {
    return { state: "review", ...base, note: v?.nextReviewTime ? `Xác minh đã hết hạn ${fmtDate(v.nextReviewTime)}.` : "" };
  }
  if (v?.state === "VERIFIED") {
    const due = v.nextReviewTime ? ` · xác minh lại vào ${fmtDate(v.nextReviewTime)}` : "";
    return { state: "verified", ...base, note: `Đã được ${who} xác minh vào ${fmtDate(v.verifyTime)}${due}.` };
  }
  return { state: "unverified", note: "" };
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

/** How a lifecycle state looks; its label and description are the catalog's (`m.state.lifecycle[key]`). */
export interface LifecycleMeta {
  tone: "default" | "accent" | "success" | "warning" | "danger";
  icon: LucideIcon;
  live?: boolean;
  quiet?: boolean;
}

export const LIFECYCLE: Readonly<Record<LifecycleKey, LifecycleMeta>> = {
  analyzing: { tone: "accent", icon: Sparkles, live: true },
  review: { tone: "accent", icon: Clock },
  changes: { tone: "warning", icon: Pencil },
  rejected: { tone: "danger", icon: CircleX },
  withdrawn: { tone: "default", icon: Archive },
  queued: { tone: "default", icon: CircleDashed },
  publishing: { tone: "accent", icon: LoaderCircle, live: true },
  published: { tone: "success", icon: CircleCheck, quiet: true },
  update: { tone: "warning", icon: RefreshCw },
  failed: { tone: "danger", icon: CircleAlert },
  merged: { tone: "success", icon: CircleCheck, quiet: true },
  stored: { tone: "default", icon: File },
  unpublished: { tone: "default", icon: EyeOff },
  archived: { tone: "default", icon: Archive },
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
  /** The workspace taxonomy (concept names, paths and looks). */
  taxonomy?: Taxonomy;
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
  /** The document's assignments (`document.concepts`: ACCEPTED and SUGGESTED; reads omit REJECTED). */
  assignments: DocumentConcept[];
  /** Concepts it is filed under (ACCEPTED assignments' concept names). */
  concepts: string[];
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
  /** Has searchable content (citations, Ask). */
  readable: boolean;
  /** Caller can edit (from `access`; confirm with testIamPermissions for actions). */
  editable: boolean;
  deleted: boolean;
  /** What the first page of the current revision looks like (`DocumentFacet.cover`); comes with the item, no content read. */
  cover?: DocumentCover;
}

/**
 * The collection an item lives in: the root ancestor (FULL view) else the parent when known. Another member's personal
 * collection (admins can read them; each is also called "My files") is "Personal files".
 */
function baseOf(item: Item, ctx: ModelContext): Resource["base"] {
  const root = item.ancestors?.[0];
  const name = root?.name || item.parentItem || "";
  if (!name) return null;
  const mine = name === ctx.personalCollection;
  const personal = mine || item.document?.collectionKind === "PERSONAL";
  const displayName = ctx.collectionNames?.get(name) || (personal && !mine ? "Tệp cá nhân" : root?.displayName) || "";
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
    assignments: doc?.concepts ?? [],
    concepts: acceptedConcepts(doc?.concepts),
    base: base && isPersonal ? { ...base, displayName: base.displayName || "Tệp của tôi" } : base,
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

/** A static Browse dimension; every classification scheme adds one more, keyed by the scheme's ID. */
export type StaticFacetId = "type" | "owner" | "src" | "kb" | "trust" | "upd";
/** A Browse facet: a classification scheme's ID or a {@link StaticFacetId}. */
export type FacetId = string;

/**
 * A Browse dimension SearchItems serves. A static one is named by the catalog (`m.knowledge.browse.facets[id]`); a
 * classification scheme's by the scheme (content, never translated).
 */
export interface FacetDef {
  id: FacetId;
  /** SearchItems facet field (`updateTime` is an interval facet over UPDATED_WINDOWS). */
  field: string;
  single?: boolean;
  /** A classification scheme's facet: the scheme's full name (`document.concepts` with `prefixes: [scheme]`). */
  scheme?: string;
}

/**
 * Browse dimensions besides the classification schemes, backed by SearchItems. Missing vs the preview: Space and
 * Language are Browse's own (`browse/catalog.ts`).
 */
export const FACETS: readonly FacetDef[] = [
  { id: "type", field: "itemType" },
  { id: "owner", field: "document.owner" },
  { id: "src", field: "document.origin.source" },
  { id: "kb", field: "ancestors" },
  { id: "trust", field: "document.verification.state" },
  { id: "upd", field: "updateTime", single: true },
];
const STATIC_FACETS: ReadonlySet<string> = new Set(FACETS.map((f) => f.id));

/** A classification scheme's facet id (anything the static dimensions don't name). */
export const isSchemeFacet = (id: FacetId) => !STATIC_FACETS.has(id);

/** A classification scheme as a Browse facet (preview `schemeFacet`): a document counts under every broader concept. */
export const schemeFacet = (s: ConceptScheme): FacetDef => ({ id: lastSegment(s.name), field: "document.concepts", scheme: s.name ?? "" });

/** Every Browse dimension (preview `facetsOn`): one per classification scheme in tab order, then the static ones. */
export const catalogFacets = (t: Taxonomy): FacetDef[] => [...classSchemes(t).map(schemeFacet), ...FACETS];

/** Facet ids in URL order: the scheme facets present (in their order), then the static ones. */
const filterOrder = (filters: Partial<Record<FacetId, string[]>> | undefined) => [...Object.keys(filters ?? {}).filter(isSchemeFacet), ...FACETS.map((f) => f.id)];

/** The Updated facet's windows: [key, days]; each is named in the catalog (`m.knowledge.browse.updated[key]`). */
export type UpdatedWindow = "7d" | "30d" | "365d";
export const UPDATED_WINDOWS: ReadonlyArray<readonly [UpdatedWindow, number]> = [
  ["7d", 7],
  ["30d", 30],
  ["365d", 365],
];

export const SORTS_CATALOG = { relevance: "Phù hợp nhất", updated: "Mới cập nhật", title: "Tiêu đề A–Z" } as const;
export type CatalogSort = keyof typeof SORTS_CATALOG;

export interface CatalogParams {
  q: string;
  /** "" = default (relevance with a query, else updated). */
  sort: CatalogSort | "";
  view: "grid" | "list";
  /** Facet id → selected values (bare IDs for concepts, bases, owners, sources; keys otherwise). */
  filters: Partial<Record<FacetId, string[]>>;
  /** "Only documents I saved". */
  saved?: boolean;
}

type QueryLike = URLSearchParams | Readonly<Record<string, string | undefined>>;
const read = (q: QueryLike, key: string) => (q instanceof URLSearchParams ? q.get(key) : q[key]) ?? "";

/** URL query → catalog params (preview `parseCatalogQuery`). Multi-value facets are comma lists; `facets` names the
 *  dimensions to read (default the static ones; Browse passes {@link catalogFacets}). */
export function parseCatalogQuery(query: QueryLike, facets: readonly FacetDef[] = FACETS): CatalogParams {
  const sort = read(query, "sort");
  const p: CatalogParams = {
    q: read(query, "q").trim(),
    sort: sort in SORTS_CATALOG ? (sort as CatalogSort) : "",
    view: read(query, "view") === "list" ? "list" : "grid",
    filters: {},
  };
  for (const f of facets) {
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
  for (const id of filterOrder(p.filters)) {
    const v = p.filters?.[id];
    if (v?.length) out[id] = v.join(",");
  }
  return out;
}

/** `/knowledge?…` (Browse) for a params patch, e.g. `catalogHref({ filters: { [schemeId]: [conceptId] } })`. */
export function catalogHref(p: Partial<CatalogParams> = {}): string {
  const qs = new URLSearchParams(catalogQueryOf(p)).toString();
  return "/knowledge" + (qs ? `?${qs}` : "");
}

/** Browse filtered to one concept (preview `conceptHref`): its scheme's facet, narrower concepts included. */
export const conceptHref = (concept: string) => catalogHref({ filters: { [lastSegment(schemeOfConcept(concept))]: [lastSegment(concept)] } });

export const activeFilterCount = (p: CatalogParams) =>
  Object.values(p.filters).reduce((n, v) => n + (v?.length ?? 0), 0) + (p.saved ? 1 : 0);

const TRUST_STATE: Readonly<Record<string, string>> = { verified: "VERIFIED", review: "REVIEW_DUE", unverified: "UNVERIFIED" };
const TRUST_KEY: Readonly<Record<string, TrustState>> = { VERIFIED: "verified", REVIEW_DUE: "review", UNVERIFIED: "unverified" };

/** AIP-160 string literal. */
const lit = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The AIP-160 clause for one facet's selected values (OR within a facet). */
function facetClause(id: FacetId, values: readonly string[], ws: string): string {
  const any = (parts: string[]) => (parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0] ?? "");
  // Hierarchical on the server: a concept also matches everything under it.
  if (isSchemeFacet(id)) return any(values.map((v) => `document.concepts:${lit(conceptNameOf(`workspaces/${ws}/conceptSchemes/${id}`, v))}`));
  switch (id as StaticFacetId) {
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
      const days = UPDATED_WINDOWS.find((w) => w[0] === values[0])?.[1];
      return days ? `updateTime >= ${lit(new Date(Date.now() - days * 86_400_000).toISOString())}` : "";
    }
    default:
      return "";
  }
}

/** AIP-160 filter for the selected facets (OR within a scheme or facet, AND across them); `base` adds extra clauses (e.g. a subtree). */
export function catalogFilter(p: CatalogParams, ws: string, { base }: { base?: string } = {}): string {
  const clauses = filterOrder(p.filters).map((id) => (p.filters[id]?.length ? facetClause(id, p.filters[id]!, ws) : "")).filter(Boolean);
  if (base) clauses.unshift(base);
  return clauses.join(" AND ");
}

export const ORDER_BY: Readonly<Record<CatalogSort, string>> = { relevance: "", updated: "updateTime desc", title: "displayName" };

/**
 * SearchItems request for Browse (facets disjunctive, snippets + a content reference for previews). `facets`: the
 * dimensions to count (default the static ones; `false` = none). A scheme facet is `document.concepts` with `prefixes`
 * (one per scheme); Updated is an interval facet: one `updateTime` interval per window, in UPDATED_WINDOWS order.
 */
export function catalogSearchRequest(
  p: CatalogParams,
  ws: string,
  options: { base?: string; pageSize?: number; pageToken?: string; facets?: readonly FacetDef[] | false } = {},
): SearchItemsRequest {
  const sort = p.sort || (p.q ? "relevance" : "updated");
  // Window starts are floored to the hour so requests built within the hour stay equal (cache keys).
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const facets = options.facets ?? FACETS;
  return {
    query: p.q || undefined,
    filter: catalogFilter(p, ws, options) || undefined,
    orderBy: ORDER_BY[sort] || undefined,
    facetSpecs:
      facets === false
        ? undefined
        : facets.map((f) =>
            f.id === "upd"
              ? { field: f.field, intervals: UPDATED_WINDOWS.map(([, days]) => ({ minimum: new Date(hour - days * 86_400_000).toISOString() })), excludedFromFilter: true }
              : f.scheme
                ? { field: f.field, prefixes: [f.scheme], limit: 100, excludedFromFilter: true }
                : { field: f.field, limit: 30, excludedFromFilter: true },
          ),
    contentSearchSpec: p.q ? { snippets: true, references: 1 } : undefined,
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
 * API facets → `{ facetId: options }` with bare-ID values, preview labels and selected values kept (count 0) so people
 * can always deselect them. A scheme facet takes its scheme's concepts from the `document.concepts` facets (values are
 * concept names; each is counted once), in the scheme's concept order when `labels.taxonomy` is given. Verification
 * and Updated values are labelled with their keys: Browse names them from the catalog (`browse/labels.ts`).
 */
export function facetOptions(
  facets: readonly SearchItemsFacet[] | undefined,
  p: CatalogParams,
  labels: { owner?: (name: string) => string; source?: (name: string) => string; taxonomy?: Taxonomy } = {},
  defs: readonly FacetDef[] = FACETS,
): Partial<Record<FacetId, FacetOption[]>> {
  const out: Partial<Record<FacetId, FacetOption[]>> = {};
  for (const def of defs) {
    const counts = new Map<string, { label: string; count: number }>();
    const add = (value: string, label: string, count: number) => {
      const prev = counts.get(value);
      counts.set(value, { label: prev?.label || label, count: (prev?.count ?? 0) + count });
    };
    if (def.scheme) {
      for (const f of facets ?? [])
        if (f.field === def.field)
          for (const v of f.values ?? []) {
            const key = lastSegment(v.value);
            if (v.value && schemeOfConcept(v.value) === def.scheme && !counts.has(key)) add(key, v.displayName || "Khái niệm chưa đặt tên", v.documentCount ?? 0);
          }
    }
    const api = def.scheme ? undefined : facets?.find((f) => f.field === def.field);
    for (const [i, v] of (api?.values ?? []).entries()) {
      const raw = v.value ?? "";
      const n = v.documentCount ?? 0;
      switch (def.id as StaticFacetId) {
        case "kb":
          add(lastSegment(raw), v.displayName || "Chưa đặt tên", n);
          break;
        case "owner":
          add(raw ? lastSegment(raw) : "—", raw ? labels.owner?.(raw) || v.displayName || "Chủ sở hữu" : "Chưa có chủ sở hữu", n);
          break;
        case "src":
          add(raw ? lastSegment(raw) : "upload", raw ? labels.source?.(raw) || v.displayName || "Nguồn dữ liệu" : "Tệp đã tải lên", n);
          break;
        case "type": {
          const key = docTypeOf(raw);
          add(key, DOC_TYPES[key].label, n);
          break;
        }
        case "trust":
          if (TRUST_KEY[raw]) add(TRUST_KEY[raw], TRUST_KEY[raw], n);
          break;
        case "upd":
          // Interval values come back in request order: one per window.
          if (UPDATED_WINDOWS[i]) add(UPDATED_WINDOWS[i][0], UPDATED_WINDOWS[i][0], n);
          break;
      }
    }
    if (def.id === "upd") for (const [key] of UPDATED_WINDOWS) add(key, key, 0);
    for (const v of p.filters[def.id] ?? []) if (!counts.has(v)) add(v, v, 0);
    const opts = [...counts].map(([value, x]) => ({ value, label: x.label, count: x.count, on: !!p.filters[def.id]?.includes(value) }));
    if (def.scheme && labels.taxonomy) {
      const order = conceptsOf(labels.taxonomy, def.scheme).map((c) => lastSegment(c.name));
      const at = (v: string) => (order.includes(v) ? order.indexOf(v) : order.length);
      opts.sort((a, b) => at(a.value) - at(b.value) || b.count - a.count);
    } else if (def.id !== "upd") opts.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    out[def.id] = opts;
  }
  return out;
}

/** A document's accepted concepts in reading order (preview `conceptOrder`): the first classification scheme's (its
 *  primary first), then the other schemes' in their tab order. Concepts the taxonomy no longer has are left out. */
export function conceptOrder(t: Taxonomy, assignments: readonly DocumentConcept[]): string[] {
  const pos = new Map(classSchemes(t).map((s, i) => [s.name, i]));
  const at = (c: string) => pos.get(schemeOfConcept(c)) ?? pos.size;
  return assignments
    .filter((a) => a.state !== "SUGGESTED" && a.concept && t.byName.has(a.concept))
    .map((a, i) => ({ c: a.concept!, primary: a.primary ? 0 : 1, i }))
    .sort((a, b) => at(a.c) - at(b.c) || a.primary - b.primary || a.i - b.i)
    .map((x) => x.c);
}

/* ═══════════════ Search: the concepts a query names (SearchItems.interpretation; `conversation_loop.md` "Knowledge retrieval"; `api_design.md` SearchItems) ═══════════════ */

/** One understood reading: the query words it came from and its concepts in one scheme (an expansion group is one). */
export interface UnderstoodTerm {
  key: string;
  text: string;
  /** Scheme name. */
  scheme: string;
  /** Concept names. */
  concepts: string[];
}

/** What the search understood, one term per query words and scheme (preview `understand` chips). */
export function understoodTerms(interpretation: SearchItemsInterpretation | undefined): UnderstoodTerm[] {
  const out: UnderstoodTerm[] = [];
  for (const c of interpretation?.concepts ?? []) {
    if (!c.concept) continue;
    const text = c.text ?? "";
    const scheme = schemeOfConcept(c.concept);
    const key = `${text}|${scheme}`;
    let term = out.find((x) => x.key === key);
    if (!term) out.push((term = { key, text, scheme, concepts: [] }));
    if (!term.concepts.includes(c.concept)) term.concepts.push(c.concept);
  }
  return out;
}

export type QueryAmbiguity = NonNullable<SearchItemsInterpretation["ambiguities"]>[number];
export type AmbiguityOption = NonNullable<QueryAmbiguity["options"]>[number];

/** A meaning is picked when its scheme's facet selects every one of its concepts. */
export function optionPicked(option: AmbiguityOption, p: CatalogParams): boolean {
  const on = p.filters[lastSegment(option.scheme)] ?? [];
  return !!option.concepts?.length && option.concepts.every((c) => on.includes(lastSegment(c)));
}

/** Picking a meaning: its concepts join its scheme's filter (the clause the option's own `filter` names). */
export function pickOption<P extends CatalogParams>(p: P, option: AmbiguityOption): P {
  const id = lastSegment(option.scheme);
  return { ...p, filters: { ...p.filters, [id]: [...new Set([...(p.filters[id] ?? []), ...(option.concepts ?? []).map(lastSegment)])] } };
}

/** Back to the choice: the meaning's concepts leave its scheme's filter. */
export function unpickOption<P extends CatalogParams>(p: P, option: AmbiguityOption): P {
  const id = lastSegment(option.scheme);
  const drop = new Set((option.concepts ?? []).map(lastSegment));
  return { ...p, filters: { ...p.filters, [id]: (p.filters[id] ?? []).filter((v) => !drop.has(v)) } };
}

/**
 * The query without the words a reading came from (accent- and case-insensitive), so the search no longer names it.
 * SearchItems has no way to set a reading aside, so × on an understood concept searches without its words.
 */
export function queryWithout(q: string, text: string): string {
  const needle = fold(text.trim());
  const at = needle ? fold(q).indexOf(needle) : -1;
  if (at < 0) return q;
  return `${q.slice(0, at)} ${q.slice(at + needle.length)}`.replace(/\s+/g, " ").trim();
}

/** Highlighted snippet (the API marks matches with `<b>…</b>` or `<mark>`); `null` when none. */
export function snippetOf(result: SearchItemsResult): string | null {
  return result.snippets?.[0] || null;
}

/** A snippet without its match marks, for plain-text surfaces that highlight locally. */
export const plainSnippet = (s: string | null) => (s ? s.replace(/<\/?(?:b|mark|em|strong)>/gi, "") : null);

/** The best content reference of a search hit, with its location label ("13. Ngày phê duyệt · trang 4"). */
export function referenceOfResult(result: SearchItemsResult): { reference: Reference; where: string } | null {
  const reference = referenceOf(result.references?.[0]);
  return reference ? { reference, where: locationLabel(reference) } : null;
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
  if (!(CONTRIBUTE_TYPES as readonly string[]).includes(ext)) return "Loại tệp này không được hỗ trợ";
  if (file.size > MAX_UPLOAD_BYTES) return "Lớn hơn 100 MB";
  if (!file.size) return "Tệp này trống";
  return "";
}

/** Clip at a word boundary with an ellipsis. */
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);
