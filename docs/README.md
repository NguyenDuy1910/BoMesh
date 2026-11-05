# BoMesh documentation

This directory contains operational and architecture documentation. API design
ownership lives in [`backend/docs_design`](../backend/docs_design), so do not
create a second API contract here.

## Start here

| Document | Scope |
| --- | --- |
| [Getting started](getting-started.md) | Local dependencies, initialization, development identity, and reset behavior. |
| [Architecture](architecture.md) | HTTP boundary, package ownership, request flow, and infrastructure responsibilities. |
| [UI and UX source of truth](../apps/ux_preview/README.md) | Canonical review surface for web/mobile visual language, interaction states, and end-to-end flows. |
| [API design](../backend/docs_design/api_design.md) | Resource model (Google AIP), methods, permissions and errors of the canonical `/api/v1` API. |
| [OpenAPI contract](../backend/docs_design/openapi.yaml) | Machine-readable OpenAPI 3.1 contract of the `/api/v1` API served by the backend (web/mobile clients still call the removed legacy routes until migrated). |
| [Item model](../backend/docs_design/item_model.md) | Collections, documents, links, contributions, revisions: decisions, invariants and workflows. |
| [Schema design](../backend/docs_design/design.dbml) | Canonical PostgreSQL schema (DBML). |
| [Database architecture](../backend/docs_design/database_architecture.md) | Tenant boundaries, identity/session separation, Item lineage, storage ownership, and ID/index policy. |
| [Connectors and indexing](connectors-and-indexing.md) | Source hierarchy, Docling processing, contextual hybrid indexing, deletion, ACLs, and checkpoint semantics. |
| [Operations and configuration](operations.md) | Environment configuration, object storage, health checks, observability, testing, and common local failures. |

## Reference material

| Document | Scope |
| --- | --- |
| [Data schema](data.schema.md) | Pointer to the canonical schema and storage-ownership design. |
| [Agent architecture](references/agent-loop.md) | OpenResponses protocol, streaming lifecycle, tools, and citation projection. |

## Documentation principles

- Code is authoritative for behavior; update the nearest relevant document in
  the same change when an interface or architectural boundary changes.
- Document ownership and operational decisions here, not in `main.py` or
  package implementation modules.
- Do not place credentials, signed URLs, tenant data, or production-only
  configuration values in documentation.
