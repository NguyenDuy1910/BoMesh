"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";
import type { Concept, ConceptScheme } from "@/modules/knowledge/api";

import type { DecisionInit } from "./api";

/**
 * Studio › Phân loại (openapi.yaml "Knowledge": ConceptScheme, Concept, versions, proposals, shared labels; api_design.md
 * “Taxonomy”). The working copy is edited here; machines read only published versions (`:publish`). Scheme and concept
 * arguments are full names (`workspaces/{w}/conceptSchemes/{s}[/concepts/{c}]`); reads of the scheme list and concepts are
 * `@/modules/knowledge/api` (`loadTaxonomyData`).
 */

export type { Concept, ConceptScheme };
export type ConceptSchemeVersion = Schema<"ConceptSchemeVersion">;
export type ConceptSchemeViolation = Schema<"ConceptSchemeViolation">;
export type ConceptSchemeWarning = Schema<"ConceptSchemeWarning">;
export type ConceptChange = Schema<"ConceptChange">;
export type ConceptReclassification = Schema<"ConceptReclassification">;
export type ConceptLabel = Schema<"ConceptLabel">;
export type ConceptMapping = Schema<"ConceptMapping">;
export type ConceptImportRow = Schema<"ConceptImportRow">;
export type ImportConceptsResult = Schema<"ImportConceptsResponse">;
export type ConceptProposal = Schema<"ConceptProposal">;
export type AcceptConceptProposalBody = Schema<"AcceptConceptProposalRequest">;
export type SharedLabel = Schema<"SharedLabel">;
export type TestClassificationRequest = Schema<"TestClassificationRequest">;
export type TestClassificationResult = Schema<"TestClassificationResponse">;
export type ClassificationPrompt = Schema<"CompileClassificationPromptResponse">;
export type ConceptRule = Schema<"ConceptRule">;
export type ExportFormat = "TURTLE" | "JSON_LD";

/** `workspaces/{w}/conceptSchemes/{s}[/concepts/{c}]` → path params. */
function pathOf(name: string) {
  const [, workspace = "", , conceptScheme = "", , concept = ""] = name.split("/");
  return { workspace, conceptScheme, concept };
}
const schemePath = (scheme: string) => {
  const { workspace, conceptScheme } = pathOf(scheme);
  return { workspace, conceptScheme };
};

/* ═══════════════ Schemes ═══════════════ */

export type SchemePatch = Partial<
  Pick<ConceptScheme, "displayName" | "description" | "position" | "cardinality" | "maxDepth" | "assignTopConcepts" | "sectionAssignments" | "llmPolicy" | "autoThreshold" | "reviewThreshold">
>;

/** Changes only the fields in `patch` (`updateMask`); stale etag → ABORTED. */
export function updateConceptScheme(scheme: ConceptScheme, patch: SchemePatch): Promise<ConceptScheme> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}", {
      params: { path: schemePath(scheme.name ?? ""), query: { updateMask: Object.keys(patch).join(",") } },
      body: { ...patch, etag: scheme.etag },
    }),
  );
}

/**
 * Publishes the working copy as the next version (done within the request). `validateOnly` stores nothing and returns
 * the version preview: `violations[]` (block), `warnings[]`, `changes[]` and `reclassification` (impact).
 */
export async function publishConceptScheme(scheme: ConceptScheme, { validateOnly = false }: { validateOnly?: boolean } = {}): Promise<ConceptSchemeVersion> {
  const op = await call(
    api.POST("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}:publish", {
      params: { path: schemePath(scheme.name ?? "") },
      body: { etag: scheme.etag, validateOnly },
    }),
  );
  return (op.response ?? {}) as ConceptSchemeVersion;
}

/** Merges spreadsheet rows by notation into the working copy (one transaction); `validateOnly` changes nothing. */
export function importConcepts(scheme: string, body: { rows: readonly ConceptImportRow[]; validateOnly?: boolean }): Promise<ImportConceptsResult> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}:importConcepts", {
      params: { path: schemePath(scheme) },
      body: { rows: [...body.rows], validateOnly: body.validateOnly },
    }),
  );
}

/** Published versions, newest first. */
export function listSchemeVersions(scheme: string): Promise<ConceptSchemeVersion[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/versions", {
          params: { path: schemePath(scheme), query: { pageSize: 100, pageToken } },
        }),
      ),
    (page) => page.conceptSchemeVersions,
  );
}

/** A published version as a SKOS document (Turtle or JSON-LD). */
export function exportSchemeVersion(scheme: string, version: number, format: ExportFormat = "TURTLE"): Promise<Schema<"ExportConceptSchemeVersionResponse">> {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/versions/{version}:export", {
      params: { path: { ...schemePath(scheme), version: String(version) }, query: { format } },
    }),
  );
}

/* ═══════════════ Concepts ═══════════════ */

export type ConceptFields = Pick<
  Concept,
  "prefLabels" | "altLabels" | "hiddenLabels" | "definition" | "scopeNote" | "examples" | "broader" | "related" | "mappings" | "matchPatterns" | "timeSensitive" | "color" | "icon"
>;

/** A DRAFT concept; `notation` is its immutable ID. */
export function createConcept(scheme: string, notation: string, concept: Partial<ConceptFields>): Promise<Concept> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/concepts", {
      params: { path: schemePath(scheme), query: { conceptId: notation, requestId: requestId() } },
      body: concept,
    }),
  );
}

/** Changes only the fields in `patch` (`updateMask`); stale etag → ABORTED. */
export function updateConcept(concept: Concept, patch: Partial<ConceptFields>): Promise<Concept> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/concepts/{concept}", {
      params: { path: pathOf(concept.name ?? ""), query: { updateMask: Object.keys(patch).join(",") } },
      body: { ...patch, etag: concept.etag },
    }),
  );
}

/** Deletes a never-published DRAFT (its notation stays reserved). */
export function deleteConcept(concept: string, { keepalive }: DecisionInit = {}): Promise<unknown> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/concepts/{concept}", { params: { path: pathOf(concept) }, keepalive }));
}

/** Deprecates at the next publish: one replacement = merge (“Gộp vào”), several = split (“Tách”), none = retire. */
export function deprecateConcept(concept: Concept, replacedBy: readonly string[], { keepalive }: DecisionInit = {}): Promise<Concept> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/concepts/{concept}:deprecate", {
      params: { path: pathOf(concept.name ?? "") },
      body: { replacedBy: [...replacedBy], etag: concept.etag },
      keepalive,
    }),
  );
}

/** Classification rules: those that file documents under `concept` (`then`), or every rule of the workspace without one. */
export function listConceptRules(workspace: string, concept?: string): Promise<ConceptRule[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conceptRules", {
          params: { path: { workspace }, query: { pageSize: 1000, ...(concept ? { filter: `then = ${JSON.stringify(concept)}` } : {}), pageToken } },
        }),
      ),
    (page) => page.conceptRules,
  );
}

/** SUGGESTED → ACCEPTED for the documents `filter` (ListItems) matches that the caller may edit. */
export async function confirmAssignments(concept: string, filter = "", { keepalive }: DecisionInit = {}): Promise<number> {
  const r = await call(
    api.POST("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/concepts/{concept}:confirmAssignments", { params: { path: pathOf(concept) }, body: { filter }, keepalive }),
  );
  return r.confirmedCount ?? 0;
}

/** Machine assignments → REJECTED for the documents `filter` matches that the caller may edit. */
export async function rejectAssignments(concept: string, filter = "", { keepalive }: DecisionInit = {}): Promise<number> {
  const r = await call(
    api.POST("/api/v1/workspaces/{workspace}/conceptSchemes/{conceptScheme}/concepts/{concept}:rejectAssignments", { params: { path: pathOf(concept) }, body: { filter }, keepalive }),
  );
  return r.rejectedCount ?? 0;
}

/* ═══════════════ Classification preview ═══════════════ */

/** Classifies a sample like processing does (rules first, else the model, on the published versions); nothing stored. */
export function testClassification(workspace: string, body: TestClassificationRequest): Promise<TestClassificationResult> {
  return call(api.POST("/api/v1/workspaces/{workspace}/conceptSchemes:testClassification", { params: { path: { workspace } }, body }));
}

/** The classification prompt processing sends and the rules checked before it (no model call). */
export function compileClassificationPrompt(workspace: string): Promise<ClassificationPrompt> {
  return call(api.GET("/api/v1/workspaces/{workspace}/conceptSchemes:compileClassificationPrompt", { params: { path: { workspace } } }));
}

/* ═══════════════ Proposals and shared labels ═══════════════ */

/** Open proposals (new concepts and labels), newest first. */
export function listOpenProposals(workspace: string): Promise<ConceptProposal[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conceptProposals", {
          params: { path: { workspace }, query: { pageSize: 200, filter: "state = OPEN", orderBy: "createTime desc", pageToken } },
        }),
      ),
    (page) => page.conceptProposals,
  );
}

/** NEW_CONCEPT: creates a DRAFT concept (`conceptId` + overrides); LABEL: adds the label to its target concept. */
export function acceptProposal(proposal: string, body: AcceptConceptProposalBody, { keepalive }: DecisionInit = {}): Promise<ConceptProposal> {
  const [, workspace = ""] = proposal.split("/");
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conceptProposals/{conceptProposal}:accept", {
      params: { path: { workspace, conceptProposal: resourceId(proposal) } },
      body,
      keepalive,
    }),
  );
}

export function rejectProposal(proposal: string, { keepalive }: DecisionInit = {}): Promise<ConceptProposal> {
  const [, workspace = ""] = proposal.split("/");
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conceptProposals/{conceptProposal}:reject", {
      params: { path: { workspace, conceptProposal: resourceId(proposal) } },
      body: {},
      keepalive,
    }),
  );
}

/** Labels several concepts share: within one scheme's working copy (W1, a warning) and across published schemes (W2). */
export function listSharedLabels(workspace: string): Promise<SharedLabel[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/sharedLabels", { params: { path: { workspace }, query: { pageSize: 500, pageToken } } })),
    (page) => page.sharedLabels,
  );
}
