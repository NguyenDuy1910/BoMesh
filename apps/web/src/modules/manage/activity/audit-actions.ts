/**
 * The one translation from audit `action` codes (`collection.access.granted`)
 * to the sentences people read ("Shared a knowledge base").
 *
 * Every screen and file that shows an audit event goes through here, so the
 * activity table, its drawer, the overview feed, the platform audit log and
 * the CSV export say the same thing. Codes the table below does not know yet
 * fall back to a humanised sentence built from the code's words, with the
 * internal vocabulary (tenant, collection, ingestion…) mapped to product words.
 * A dotted code is never shown as the sentence.
 *
 * Pure module: no React, no API, safe to import from tests and adapters.
 */

export type AuditArea = "knowledge" | "files" | "sources" | "people" | "settings" | "other";

/** Areas people filter activity by, in the order the filter lists them. */
export const AUDIT_AREAS: readonly { value: Exclude<AuditArea, "other">; label: string }[] = [
  { value: "knowledge", label: "Knowledge" },
  { value: "files", label: "Files" },
  { value: "sources", label: "Sources" },
  { value: "people", label: "People & access" },
  { value: "settings", label: "Settings" },
];

/** The fields of an audit event this module reads (OpenAPI `AuditLog`). */
export interface AuditEventLike {
  action: string;
  resource_type?: string | null;
  details?: Record<string, unknown> | null;
  outcome?: string | null;
  actor?: AuditActor | null;
}

export interface AuditActor {
  id: string | null;
  email: string | null;
  display_name: string | null;
}

/** Filters the Activity list and its CSV export apply alike. */
export interface AuditFilters {
  /** A user id, or `system` for events BoMesh did itself. */
  actor?: string;
  area?: AuditArea | "";
  /** `failure` is anything that did not succeed. */
  outcome?: "success" | "failure" | "";
  /** Free text over what people read: the person, the sentence and the target. */
  search?: string;
}

/** Known codes, worded as the person who did it would say it. */
const SENTENCES: Readonly<Record<string, string>> = {
  "artifact.created": "Created a file",
  "artifact.revised": "Made a new version of a file",
  "artifact.published": "Saved a file to knowledge",

  "collection.created": "Created a knowledge base",
  "collection.updated": "Edited a knowledge base",
  "collection.deleted": "Deleted a knowledge base",
  "collection.access.granted": "Shared a knowledge base",
  "collection.access.revoked": "Removed access to a knowledge base",
  "document.updated": "Updated a document",
  "document.deleted": "Deleted a document",

  "ingestion.source.created": "Added a source",
  "ingestion.source.updated": "Changed a source",
  "ingestion.source.deleted": "Removed a source",
  "ingestion.source.sync_requested": "Started a sync",
  "integration.connection.created": "Connected an account",
  "integration.connection.authorized": "Signed in to a connected account",
  "integration.connection.updated": "Changed a connected account",
  "integration.connection.disconnected": "Disconnected an account",
  "integration.connection.deleted": "Removed a connected account",
  "integration.connection.validated": "Checked a connected account",
  "approval_request.plugin_installation.created": "Asked to add a connector",
  "approval_request.plugin_installation.approved": "Approved a connector request",
  "approval_request.plugin_installation.denied": "Denied a connector request",
  "approval_request.plugin_installation.cancelled": "Withdrew a connector request",

  "member.added": "Added a member",
  "user.updated": "Changed a member",
  "group.created": "Created a group",
  "group.updated": "Edited a group",
  "group.members_replaced": "Changed who is in a group",
  "group.deleted": "Deleted a group",
  "role.created": "Created a role",
  "role.updated": "Edited a role",
  "role_assignment.platform_admin.granted": "Made someone a platform admin",
  "approval_request.resource_access.created": "Asked for access to a knowledge base",
  "approval_request.resource_access.approved": "Approved an access request",
  "approval_request.resource_access.denied": "Denied an access request",
  "approval_request.resource_access.cancelled": "Withdrew an access request",

  "tenant.updated": "Changed workspace settings",
};

/** Internal words → the words the product uses. An empty string drops the word. */
const VOCABULARY: Readonly<Record<string, string>> = {
  tenant: "workspace",
  collection: "knowledge base",
  ingestion: "",
  integration: "",
  connection: "connected account",
  run: "sync",
  user: "member",
  approval: "",
  request: "request",
  resource: "",
  plugin: "connector",
  installation: "",
  artifact: "file",
  item: "item",
  chunk: "passage",
  embedding: "index",
  assignment: "",
  auth: "sign-in",
};

const AREA_BY_PREFIX: readonly [prefix: string, area: AuditArea][] = [
  ["approval_request.plugin_installation", "sources"],
  ["approval_request.resource_access", "people"],
  ["collection", "knowledge"],
  ["document", "knowledge"],
  ["artifact", "files"],
  ["ingestion", "sources"],
  ["integration", "sources"],
  ["member", "people"],
  ["user", "people"],
  ["group", "people"],
  ["role", "people"],
  ["role_assignment", "people"],
  ["tenant", "settings"],
  ["workspace", "settings"],
];

const normalise = (action: unknown) => String(action ?? "").trim().toLowerCase();

const sentenceCase = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

const article = (noun: string) => (/^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`);

/** Lowercase words of one code segment: `members_replaced` → ["members", "replaced"]. */
const wordsOf = (segment: string) => segment.split(/[^a-z0-9]+/).filter(Boolean);

/** Codes are untrusted text: only the tables' own keys count, never `constructor` and friends. */
const productWord = (word: string) => (Object.hasOwn(VOCABULARY, word) ? VOCABULARY[word] : word);

/** Sentences that read better once the details say what changed. */
function refine(action: string, details: Record<string, unknown> | null | undefined): string | null {
  const changed = details?.changed_fields;
  const fields = Array.isArray(changed) ? changed.filter((field): field is string => typeof field === "string") : [];
  const only = (field: string) => fields.length === 1 && fields[0] === field;
  switch (action) {
    case "member.added":
      return details?.readmitted === true ? "Added a member back" : null;
    case "user.updated":
      if (only("roles")) return "Changed a member’s role";
      if (only("groups")) return "Changed a member’s groups";
      if (only("status")) return "Changed whether a member can use the workspace";
      if (only("display_name")) return "Renamed a member";
      return null;
    case "role.updated":
      if (only("status")) return "Turned a role on or off";
      if (only("permission_codes")) return "Changed what a role can do";
      if (only("display_name")) return "Renamed a role";
      return null;
    case "tenant.updated":
      return only("name") ? "Renamed the workspace" : null;
    case "collection.updated":
    case "document.updated": {
      const noun = action === "collection.updated" ? "knowledge base" : "document";
      if (details?.status === "archived") return `Archived ${article(noun)}`;
      if (details?.previous_status === "archived") return `Restored ${article(noun)}`;
      if (only("title")) return `Renamed ${article(noun)}`;
      return null;
    }
    default:
      return null;
  }
}

/**
 * A safe sentence for a code the table does not know. The last segment is
 * what happened; the segments before it name what it happened to.
 * `document.uploaded` → "Uploaded a document";
 * `ingestion.run.retry_requested` → "Sync retry requested".
 */
function humanise(action: string): string {
  const segments = action.split(".").map(wordsOf).filter((words) => words.length);
  if (!segments.length) return "Made a change";
  const verbWords = segments.pop()!;
  const resource = segments
    .flat()
    .map(productWord)
    .filter(Boolean)
    .filter((word, index, all) => all.indexOf(word) === index)
    .join(" ");
  const verb = verbWords.map(productWord).filter(Boolean).join(" ");
  if (!resource) return sentenceCase(verb || "Made a change");
  if (!verb) return sentenceCase(`changed ${article(resource)}`);
  // A single past-tense verb reads as an action ("Archived a document");
  // anything longer reads as a headline ("Group members replaced").
  if (verbWords.length === 1 && /ed$/.test(verb)) return sentenceCase(`${verb} ${article(resource)}`);
  return sentenceCase(`${resource} ${verb}`);
}

/** What happened, as a sentence a workspace admin reads. Never the raw code. */
export function describeAuditAction(action: string | null | undefined, details?: Record<string, unknown> | null): string {
  const code = normalise(action);
  if (Object.hasOwn(SENTENCES, code)) return refine(code, details) ?? SENTENCES[code];
  return humanise(code);
}

/** Which part of the product an action belongs to; unknown codes are `other`. */
export function auditActionArea(action: string | null | undefined): AuditArea {
  const code = normalise(action);
  const match = AREA_BY_PREFIX.find(([prefix]) => code === prefix || code.startsWith(`${prefix}.`));
  return match?.[1] ?? "other";
}

/** The product word for a resource type: `ingestion_source` → "Source". */
export function describeResourceType(resourceType: string | null | undefined): string {
  const words = wordsOf(normalise(resourceType))
    .map(productWord)
    .filter(Boolean);
  const phrase = words.filter((word, index) => words.indexOf(word) === index).join(" ");
  return sentenceCase(phrase || "item");
}

/** The name or email an event's details record for its target, when they record one. */
export function auditTargetName(event: AuditEventLike): string | null {
  for (const key of ["title", "name", "display_name", "email"]) {
    const value = event.details?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * What an event happened to, as far as the event itself records it: the
 * resource kind, plus its name or email when the details carry one. Audit
 * rows never carry raw ids into this text.
 */
export function describeAuditTarget(event: AuditEventLike): string {
  const kind = describeResourceType(event.resource_type);
  const named = auditTargetName(event);
  return named ? `${kind} · ${named}` : kind;
}

/** Who did it. Events with no person behind them were done by BoMesh itself (a schedule, a sync). */
export function auditActorName(actor: AuditActor | null | undefined): string {
  return actor?.display_name?.trim() || actor?.email || "BoMesh";
}

/** Whether an event passes the Activity filters; the CSV export filters with the same rule. */
export function auditEventMatches(event: AuditEventLike, filters: AuditFilters): boolean {
  if (filters.actor) {
    const actorId = event.actor?.id ?? null;
    if (filters.actor === "system" ? actorId !== null : actorId !== filters.actor) return false;
  }
  if (filters.area && auditActionArea(event.action) !== filters.area) return false;
  if (filters.outcome === "success" && event.outcome !== "success") return false;
  if (filters.outcome === "failure" && event.outcome === "success") return false;
  const search = filters.search?.trim().toLowerCase();
  if (!search) return true;
  return [
    auditActorName(event.actor),
    event.actor?.email ?? "",
    describeAuditAction(event.action, event.details),
    describeAuditTarget(event),
  ].some((text) => text.toLowerCase().includes(search));
}

const SIGN_IN_METHODS: Readonly<Record<string, string>> = {
  password: "Password",
  google: "Google",
  // The only OpenID Connect provider BoMesh signs people in with is Google.
  oidc: "Google",
  saml: "Single sign-on",
  internal: "Development sign-in",
};

/** How someone signed in, as the person who chose it would name it. */
export function describeSignInMethod(method: string | null | undefined): string {
  const code = normalise(method);
  return Object.hasOwn(SIGN_IN_METHODS, code) ? SIGN_IN_METHODS[code] : sentenceCase(wordsOf(code).join(" ") || "Unknown method");
}
