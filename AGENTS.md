# BoMesh Agent Rules

## Project intent

BoMesh (Business-only Knowledge Mesh) is an enterprise knowledge platform.

It connects to trusted enterprise sources, ingests and indexes knowledge, retrieves permission-filtered evidence, answers with grounded citations, and supports governed business analytics.

Keep implementations simple, explicit, typed, and aligned with the existing architecture.

---

## Source of truth

Before making any meaningful code change, inspect:

```text
backend/docs_design
```

This directory is the architectural source of truth. It describes the target
architecture only:

```text
api_design.md             resource model, AIP rules, methods, permissions (canonical API)
openapi.yaml              machine-readable API contract; wins on field-level details
item_model.md             Item domain: collections, documents, links, contributions,
                          revisions, authorization invariants, workflows, refactor plan
design.dbml               canonical PostgreSQL schema
database_architecture.md  persistence principles and the schema-change policy
auth_contract.md          authentication and sessions
conversation_loop.md      conversation and LLM agent loop
document_contract.md      document upload, formats, archives, content lifecycle
document_viewer.md        reader rendition and citation geometry
evaluation.md             retrieval and answer evaluation
```

The backend implements this design: it serves the contract under `/api/v1`
(routers in `backend/api/v1`, DTOs in `backend/api/dto`). The web client
`apps/web` uses it; `apps/mobile` still calls the removed legacy routes and is
migrated next. Where code and design differ, the design wins;
the remaining gaps are recorded as "Implementation status" notes in the design
files. There is no legacy design document: do not recreate legacy contracts,
endpoint inventories or migration plans.

Always use the current documents in `docs_design` to understand the intended behavior before changing the implementation.

Do not design a competing architecture when the source of truth already defines one.

---

## API design rules

These rules are binding for every API change. Details and AIP references are
in `api_design.md` §1.

1. **Google AIP is the standard.** Resource names (`workspaces/{workspace}/items/{item}`),
   plural lowerCamelCase collection IDs, references as resource-name strings.
   Standard methods only: Get, List, Create, Update (`PATCH` + `updateMask`),
   Delete. Everything else is a custom method `POST {name}:verb` (or `GET` when
   read-only). No `PUT`. Base path `/api/v1`.
2. **Name APIs after domain resources**, never after screens, features, callers
   or roles. One concept has exactly one resource; reuse it with fields or
   `kind` instead of adding a parallel resource. Tags are interfaces:
   Identity, Workspaces, Library, Knowledge, Ingestion, Assistant,
   Collaboration, Operations.
3. **JSON follows the proto3 mapping**: lowerCamelCase fields, UPPER_SNAKE
   enums, int64 as strings, RFC 3339 times, output-only fields `readOnly`,
   input-only fields `writeOnly`. `state` is output-only and changes through
   state-transition methods.
4. **Lists** use `pageSize`/`pageToken`, AIP-160 `filter`, `orderBy`,
   `showDeleted`. **Writes** use `requestId` for idempotency, `validateOnly`
   where useful, and `etag` for concurrency. Soft-deleted resources have
   `:undelete`. Long work returns an `Operation` with `x-operation-info`.
5. **Errors** are `google.rpc.Status` with an `ErrorInfo` reason. A resource
   the caller cannot read answers exactly like an absent one; illegal
   transitions are `FAILED_PRECONDITION`.
6. **Authorization is declared per method**: `x-permission: <collection>.<method>`
   (IAM style), plus `x-authorization` for ownership rules. `none` is allowed
   only for self, public and operation-polling methods. Roles are granted by
   IAM policies on workspaces, collections and spaces.
7. **New endpoints are designed only in `openapi.yaml` + `api_design.md`.**
8. **Validate every contract change**:
   `cd backend && uv run python -m pytest ../tests/docs_design`.

## Domain model rules (Item)

Details are in `item_model.md`.

1. Collections and documents share one identity: the `items` table and the
   `workspaces/{workspace}/items/{item}` resource. Never add separate
   document, collection or knowledge-base tables or resources.
2. Every Item has exactly one canonical parent. Showing an Item elsewhere is
   a reference: item links (documents only), reading lists, saved/recent
   items, space materials. References never grant access and never copy
   objects or embeddings.
3. Deletion, content, publication and indexing are four independent document
   states. Review state lives on `contributions`. Approval never starts
   ingestion; processing is always an explicit ingestion run.
4. "Readable" always means the visibility rule in `item_model.md` §6. Every
   derived surface (lists, search, facets, counts, home, shares, artifacts,
   tasks) re-checks it in PostgreSQL; the search index is only a pre-filter.
5. Content versions live in `item_revisions`; stored objects are never copied
   and are purged only when no live revision references them.

## Database schema rules

1. `design.dbml` is the schema design; the `backend/bomesh/db/models/`
   package implements all of it, including its CHECKs and triggers.
2. There are no SQL migration files. Databases are created from the models
   (`make db-reset`). A data-preserving upgrade script is written only when a
   persistent environment must keep its data; it is reviewed with the change
   and deleted after it runs. Do not add a migrations directory or framework
   without an explicit decision.
3. Every new table or column needs a justification (limitation, alternatives,
   impact) in `item_model.md` §5 or `database_architecture.md`. Prefer
   targeted columns over new tables; no table without its own identity and
   lifecycle.
4. Validate `design.dbml` after every change:
   `npx -p @dbml/cli dbml2sql --postgres backend/docs_design/design.dbml`.

---

## UI and UX source of truth

Before changing production code under `apps/web/` or `apps/mobile/`, inspect:

```text
apps/ux_preview
```

This directory is the canonical, framework-neutral source for shared web/mobile
visual concepts, component patterns, responsive behavior, interaction states,
and end-to-end UX flows.

Use:

```text
apps/ux_preview/ux-preview.html
apps/ux_preview/styles/
apps/ux_preview/scripts/        (core, data, features, i18n)
→ the single reviewable UX preview for web and mobile

apps/ux_preview/docs/
→ product flows, screen inventory and domain-flow notes
```

Every direct product-code change under `apps/web/` or `apps/mobile/` MUST first
be represented in the canonical UX preview and its sibling CSS/JavaScript so
the user can review the framework-neutral behavior before it is implemented in
a production client. Do not implement the client change first and backfill the
preview afterward.

Keep product behavior and backend contracts aligned with
`backend/docs_design`; `apps/ux_preview` owns presentation and UX, not API,
authorization, persistence, or agent contracts.

Do not create parallel design concepts or UX-flow documents under `docs/`,
`apps/web/`, or `apps/mobile/`. Update the canonical files in
`apps/ux_preview/` instead.

### Product design rules (binding)

Before any UX/UI design or implementation — in `apps/ux_preview`,
`apps/web` or `apps/mobile` — read and follow
`apps/ux_preview/PRODUCT_DESIGN_RULES.md` and apply it to every page and
component you touch:

* run its UX review first (primary intent, shortest journey, audit, remove
  redundant or competing elements, simplest pattern, verify hierarchy);
* one clear purpose per page, one responsibility per component, one primary
  action per context; secondary and advanced actions stay subtle or in menus;
* HeroUI (https://heroui.com/docs/react) is the component source of truth;
* prioritize real user behavior and minimal cognitive load; never introduce
  UI complexity without a user benefit — preserve functionality by
  simplifying its presentation, not by adding elements.

---

## Required workflow

For every implementation task:

```text
docs_design
    ↓
understand affected flow
    ↓
trace current implementation
    ↓
implement/change code
    ↓
verify affected flow
    ↓
update docs_design
```

Before editing code:

1. Read the relevant files in `backend/docs_design`.
2. Trace the existing implementation and affected callers.
3. Identify which documented contract or design owns the behavior.
4. Implement using that design.

After editing code:

1. Verify the changed behavior.
2. Determine whether the implementation changed any API, schema, lifecycle, architecture, auth, RBAC, agent flow, or important design decision.
3. Update the corresponding file(s) in `backend/docs_design`.
4. Ensure documentation and implementation describe the same final system.

Never leave `docs_design` describing anything other than the intended system.
When code implements part of the design, delete the matching
"Implementation status" note in the same change.

---

## Contract-first rule

For HTTP/API work:

```text
openapi.yaml + api_design.md
    ↓
API (/api/v1: routers + api/dto)
    ↓
Service (bomesh/services/<domain>)
    ↓
persistence / infrastructure
```

The API contract is the source of truth for public behavior.

When implementing a new or changed endpoint:

* follow `openapi.yaml` and the API design rules above;
* keep request/response DTOs typed and routers thin;
* do not expose infrastructure implementation details;
* change the contract first when it intentionally changes.

Do not preserve a legacy API merely because old services were built around it.

Refactor the implementation toward the canonical contract.

---

## Database rule

Use `design.dbml` as the source of truth for persisted domain concepts and relationships.

Before changing:

```text
table
column
relationship
identifier
lifecycle state
tenant/workspace ownership
RBAC persistence
```

check the DB design first.

If the implementation requires a legitimate database design change:

```text
design.dbml
+
bomesh/db/models/
+
affected service code
```

as one coherent change.

Do not silently introduce a database structure that is absent from the documented design.

---

## Authentication and RBAC

Follow the authentication and RBAC contracts in `docs_design`.

Keep these concepts separate:

```text
Authentication
→ who the caller is

Workspace permission / RBAC
→ what capability the caller has

Resource ACL
→ which resource the caller may access

Platform permission
→ cross-workspace platform capability
```

Do not hard-code role names into business authorization.

Prefer stable permissions and documented authorization policies.

Authorization must be enforced before enterprise data reaches retrieval, the agent, or BI execution.

If auth or authorization behavior changes, update the corresponding `docs_design` contract.

---

## Agent / conversation flow

The documented conversation/LLM loop is the source of truth for agent orchestration.

Preserve the existing intelligent agent loop.

Do not turn the agent into a rigid workflow unless explicitly requested.

Keep:

```text
tool selection
retrieval
context building
citation grounding
agent reasoning loop
response streaming
```

aligned with the documented conversation architecture.

Temporal or other workflow infrastructure must not leak into the public agent contract unless explicitly designed there.

---

## Enterprise knowledge boundaries

Preserve:

```text
workspace / tenant boundary
permissions
source lineage
citations
audit information
resource lifecycle
```

Never return enterprise knowledge through retrieval or the agent without applying the required authorization filtering.

Factual enterprise answers that require grounding must preserve citation/source evidence.

Connector-specific behavior must remain isolated from core retrieval and agent orchestration.

---

## Service ownership

Before creating a new service/module, determine whether an existing component already owns the behavior.

Prefer:

```text
one canonical resource/lifecycle service
```

over services based on caller or screen.

Each domain is one package in `bomesh/services/` (for example
`services/knowledge_items`, `services/ingestion`, `services/conversations`)
that owns the domain's use cases and its engine code. There is no separate
application/use-case layer.

Good:

```text
ItemService
ContributionService
ItemIngestionService
ConnectionService
SourceService
```

Avoid:

```text
AdminCollectionService
AgentCollectionService
PageService
ApiService
```

Do not introduce parallel implementations of the same domain operation.

Reuse and consolidate existing flows where possible.

---

## Infrastructure boundaries

Keep infrastructure details behind their owning boundary.

Examples:

```text
connector provider code
→ connector adapters

durable binary content
→ storage

index/search implementation
→ document_index

authorization-aware retrieval
→ knowledge

cross-capability orchestration
→ services

Temporal
→ services.workflow

HTTP/FastAPI
→ backend/api
```

Do not expose infrastructure/vendor names through domain-facing APIs unless they are genuinely part of the domain.

---

## Lifecycle and deletion

Persisted business resources must not be physically deleted unless the documented design explicitly says otherwise.

Use the project's lifecycle/tombstone model, such as:

```text
status
deleted_at
```

Normal reads must exclude tombstoned resources where appropriate.

Deletion API semantics may still use HTTP `DELETE`; persistence implementation remains internal.

---

## LLM model usage

Every LLM, embedding or vision call — whether made by application code, a
script, a test, a probe or a command an agent runs — must use only the models
configured in `.env`:

```text
OPENROUTER_MODEL                 chat / agent loop (OpenRouter)
OPENAI_MODEL                     chat via OpenAI
EMBEDDING_MODEL                  embeddings
BOMESH_CONTEXTUALIZATION_MODEL   chunk contextualization
BOMESH_DOCLING_MODEL             document vision parsing
```

Rules:

* Read the model from the configured environment value; never hard-code,
  substitute or "try" another model name in code, commands, scripts or tests.
* Do not run ad-hoc calls (curl, Python, probes, benchmarks) against a model
  that is not one of the configured values, even to diagnose a failure.
* When the configured model fails (denied, unavailable, too slow), stop and
  report the error; do not switch models. Changing a model is the user's
  decision and is made only by editing `.env` at the user's request.
* Tests that need a model use fakes or the configured value; they never pin a
  different model.

---

## Configuration and secrets

Parse environment configuration at the application/composition boundary.

Inject typed configuration into services.

Do not:

```text
read environment variables throughout domain services
create infrastructure clients ad hoc inside business logic
store secrets in source code
```

Use environment variables or the configured secret-management mechanism.

---

## Testing and verification

Tests belong under:

```text
tests
```

Reuse existing tests where possible.

Do not leave temporary test/debug files in application directories.

For each change, run the smallest verification that proves the affected flow works.

Examples:

```text
API change
→ API-level test + `tests/docs_design` contract checks

retrieval change
→ permission filtering + citation verification

connector change
→ extraction + normalization + lineage verification

agent change
→ relevant conversation/tool flow

database change
→ affected persistence/service tests
```

---

## Documentation synchronization

Documentation maintenance is part of implementation, not a separate optional task.

After every meaningful change, check whether any file under:

```text
backend/docs_design
```

is affected.

Update it when changes affect:

```text
API contract
database model
authentication
RBAC
agent/conversation flow
resource lifecycle
service ownership
important architecture decisions
```

Keep documentation concise and architectural.

Do not document temporary implementation details unless they affect future design decisions.

At the end of each task, report:

```text
Code changed
Docs changed
Contract/design decisions changed
Tests/verification performed
Remaining decisions, if any
```

The final state must satisfy:

```text
docs_design            == intended architecture
implemented behavior   == docs_design, except gaps recorded as
                          "Implementation status" notes
```

---

## General principle

When uncertain:

```text
read docs_design first
→ follow the existing source of truth
→ make the smallest coherent change
→ remove obsolete code when replaced
→ verify the affected path
→ update docs_design to match the final design (and drop resolved
  "Implementation status" notes)
```

Do not create a new architectural direction silently.
