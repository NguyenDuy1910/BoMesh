# BoMesh documentation

Setup, architecture and operations guides. The architectural source of truth
— API contract, schema, domain model and flows — is
[`backend/docs_design`](../backend/docs_design); never write a second contract
here. Presentation and UX flows belong to
[`apps/ux_preview`](../apps/ux_preview/readme.md).

## Guides

| Document | Scope |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, `make init`, the seeded accounts and the reset behavior. |
| [Architecture](architecture.md) | HTTP boundary, package ownership, request flow and infrastructure responsibilities. |
| [Architecture overview](architecture-overview.md) | System-level summary of the components and how they interact. |
| [Connectors and indexing](connectors-and-indexing.md) | Sources, syncs, Docling processing, contextual hybrid indexing, ACLs and checkpoints. |
| [Operations and configuration](operations.md) | Environment variables, object storage, health checks, observability, testing and common local failures. |
| [Data schema](data.schema.md) | Pointer to the canonical schema and storage-ownership design. |
| [Agent architecture](references/agent-loop.md) | OpenResponses protocol, streaming lifecycle, tools and citation projection. |
| [Temporal runtime](temporal.md) | The disabled Temporal setup kept in `bomesh.services.workflow`; ingestion runs in the ingestion worker with PostgreSQL as the queue. |

## Design background and audits

Dated records, kept for their reasoning and measurements. The current contract
always wins over them.

| Document | Scope |
| --- | --- |
| [Universal file preview](universal-file-preview.md) | Background for the document viewer; the built contract is [`document_viewer.md`](../backend/docs_design/document_viewer.md). |
| [Performance remediation plan](performance-remediation-plan.md) | Measured performance audit and the fixes it proposes. |
| [Web implementation gaps](web-implementation-gap.md) | Functional audit of `apps/web` against the contract and the UX preview. |

## Principles

- Behavior is defined in `backend/docs_design`; update the matching guide here
  in the same change when setup, operations or a boundary changes.
- Describe the current system only; no migration notes.
- Never put credentials, signed URLs, tenant data or production-only values in
  documentation.
