<h1 align="center">BoMesh</h1>

<p align="center">
  <strong>Business-only Knowledge Mesh — grounded, permission-aware answers from an organization's own knowledge.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#development">Development</a>
</p>

BoMesh connects to trusted enterprise sources, ingests and indexes their
knowledge, retrieves only the evidence a person is allowed to read, and
answers with citations back to the source. The model reasons over evidence;
it never becomes the source of truth.

## What it provides

| Capability | How BoMesh approaches it |
| --- | --- |
| One knowledge model | Collections and Documents are one `Item` resource with one canonical parent. Content versions are immutable revisions; shortcuts, saved items, recent items and space materials are references that never grant access. |
| Grounded answers | The agent retrieves tenant-scoped, permission-filtered evidence and cites the passages of the revision that was indexed. |
| Contextual hybrid retrieval | Contextualized chunk text with dense embeddings and Qdrant BM25, fused, optionally reranked, and re-checked against PostgreSQL visibility before evidence reaches the agent. |
| Explicit processing | Uploads and source syncs only add content. Parsing (Docling), classification, contextualization, embedding and indexing happen in an explicit Ingestion Run. |
| Governed contributions | Members contribute documents for review; reviewers approve, request changes or publish new revisions. Publication, content, indexing and deletion are independent states. |
| Document viewer | A preview engine renders every supported format from the stored original (Gotenberg for Office and HTML), independent of indexing. |
| File work | The agent works on files in BoMesh's own Docker sandbox, one container per conversation; outputs are kept as downloadable artifacts. |
| IAM | Roles are granted on workspaces, collections and spaces; every method declares its permission. |

## Architecture

```text
apps/web (Next.js + HeroUI)
        │  /api/v1 · Bearer JWT · SSE
        ▼
FastAPI · backend/api (routers api/v1, DTOs api/dto)
        │
        ▼
Services · backend/bomesh/services/<domain>
        │
 ┌──────┼──────────────┬─────────────────┬────────────────┐
 ▼      ▼              ▼                 ▼                ▼
PostgreSQL     RustFS / S3 / R2     Qdrant             Docker sandbox
business       original bytes and   rebuildable        per-conversation
state, queue   derived previews     retrieval index    file work

Ingestion worker (bomesh.services.ingestion.worker): runs, syncs and schedules,
with PostgreSQL as the queue · connectors → Docling → document_index → Qdrant
```

| System | Owns |
| --- | --- |
| PostgreSQL | Identities, tenants, IAM, Items and revisions, contributions, conversations, ingestion history, audit records and the ingestion queue. Schema: [`design.dbml`](backend/docs_design/design.dbml). |
| RustFS / AWS S3 / Cloudflare R2 | Original document bytes and derived preview objects. |
| Qdrant | Contextual chunks, vectors and the retrieval filter payload; rebuildable from PostgreSQL and object storage. |
| Gotenberg | Office and HTML conversion for the document viewer. |
| Docling | Parsing, normalization, provenance and chunking during an Ingestion Run. |

| Path | Contents |
| --- | --- |
| `backend/api` | HTTP boundary: `/api/v1` routers and DTOs, mounted by `backend/main.py`. |
| `backend/bomesh/services` | One package per domain (`knowledge_items`, `ingestion`, `conversations`, `artifacts`, `knowledge_curation`, `library`, `collaboration`, `workspaces`, `identity`, `previews`, …). |
| `backend/bomesh/connector` | Source connectors (Confluence, Google Drive) and content processing ([README](backend/bomesh/connector/README.md)). |
| `backend/bomesh/document_index`, `knowledge`, `agent`, `iam`, `db`, `storage` | Indexing, authorization-aware retrieval, the agent loop, authorization, ORM models and triggers, object storage. |
| `backend/docs_design` | The architectural source of truth: API contract, schema, domain and flow designs. |
| `backend/eval` | RAG benchmark ([README](backend/eval/README.md)). |
| `apps/web` | The web client. |
| `apps/ux_preview` | Canonical, framework-neutral UX preview the web client implements ([README](apps/ux_preview/readme.md)). |
| `deployment` | Local Compose services and the sandbox image. |
| `tests` | Backend, API, contract and web navigation tests. |

## Quick start

### Prerequisites

- Python 3.12+ and [uv](https://docs.astral.sh/uv/)
- Docker with Docker Compose
- [Bun](https://bun.sh/) for the web app, and Node.js 22.6+ for its unit tests
- An OpenRouter API key (embeddings, contextualization, document vision and,
  by default, the agent); an OpenAI API key only if the agent runs on OpenAI

### 1. Install and initialize

```bash
uv sync --project backend
(cd apps/web && bun install)
make init
```

`make init` creates the root `.env` from
[`backend/.env.example`](backend/.env.example) (pointing it at the local
services and generating the local secrets), starts PostgreSQL, Qdrant,
Gotenberg and RustFS, rebuilds the database from the ORM models, seeds the
HCMUTE demo workspace with one account per IAM role, and recreates the Qdrant
collection.

> `make init` drops the local database schema and the Qdrant collection. Never
> run it against an environment whose data you need.

### 2. Configure models

Set the provider key and the models in the root `.env`:

```dotenv
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...
EMBEDDING_MODEL=...
BOMESH_CONTEXTUALIZATION_MODEL=...
BOMESH_DOCLING_MODEL=...   # optional: transcribes scanned PDF pages
```

Every model call uses only these configured models. The Qdrant collection is
created with 1536-dimension vectors (`QDRANT_VECTOR_SIZE` in the `Makefile`);
it must match `EMBEDDING_MODEL`. Every other setting is documented in
`backend/.env.example` and [Operations and configuration](docs/operations.md).

### 3. Build the sandbox image

Needed once for the agent's file work:

```bash
docker build -t bomesh-sandbox:latest deployment/sandbox
```

### 4. Run

```bash
cd backend && uv run python main.py   # API + ingestion worker
bun run web                           # WebUI, development mode (from the repository root)
```

`bun run web:prod` (or `make web-prod`) builds and serves the optimized
WebUI; use it for anything shared, demoed or measured.

Sign in as `nguyendqduy` (platform owner, administers both workspaces) or a
seeded system account such as `hcmute.curator` or `ftu-hcmc.member` with
password `19102003`; `make seed` prints the full role matrix
(`backend/docs_design/auth_contract.md` "Seeded workspaces and accounts").

| Service | Address |
| --- | --- |
| WebUI | <http://127.0.0.1:3000> |
| API | <http://127.0.0.1:8000> |
| OpenAPI (interactive) | <http://127.0.0.1:8000/docs> |
| Health | <http://127.0.0.1:8000/health> |
| Qdrant dashboard | <http://127.0.0.1:6333/dashboard> |
| RustFS S3 API | <http://127.0.0.1:9000> |

## Documentation

| Guide | Use it for |
| --- | --- |
| [`backend/docs_design`](backend/docs_design) | The source of truth: [API design](backend/docs_design/api_design.md) and [`openapi.yaml`](backend/docs_design/openapi.yaml), [schema](backend/docs_design/design.dbml), [Item model](backend/docs_design/item_model.md), [database architecture](backend/docs_design/database_architecture.md), [auth](backend/docs_design/auth_contract.md), [conversation loop](backend/docs_design/conversation_loop.md), [documents](backend/docs_design/document_contract.md), [viewer](backend/docs_design/document_viewer.md), [evaluation](backend/docs_design/evaluation.md). |
| [UX preview](apps/ux_preview/readme.md) | Presentation, interaction states and end-to-end flows the web client implements. |
| [Documentation index](docs/README.md) | Setup, architecture, connectors and operations guides. |
| [`AGENTS.md`](AGENTS.md) | Engineering rules: contract-first API work, schema policy, UX-first client changes, model usage. |

## Development

```bash
make help              # every target
make services          # start PostgreSQL, Qdrant, Gotenberg and RustFS
make reset-all         # wipe PostgreSQL, Qdrant and RustFS volumes, rebuild, reseed (also run by make init)
make db-reset          # rebuild PostgreSQL only and reseed
make seed              # (re)seed both workspaces, the role-matrix accounts and HCM-UTE's topics and folders
make qdrant-init       # recreate the Qdrant collection and its payload indexes
make status            # dependency state and API health
```

There are no migrations: the database is created from
`backend/bomesh/db/models`, which implement `design.dbml`.

Verification:

```bash
# Backend, API and contract tests (TEST_DATABASE_URL comes from .env)
cd backend && set -a && . ../.env && set +a && uv run python -m pytest ../tests -q

# API contract and schema only
cd backend && uv run python -m pytest ../tests/docs_design -q
npx -y -p @dbml/cli dbml2sql --postgres backend/docs_design/design.dbml

# Web
cd apps/web && bun run typecheck && bun run test && bun run build
```

## Security

- Never commit `.env`, provider credentials, encryption keys or signed object
  URLs.
- Every API request authenticates with a bearer access token.
- Connector credentials are encrypted at rest; retrieval authorization comes
  from Item access in PostgreSQL, never from a connector's provider credential.
- Object storage is mandatory for content bytes: PostgreSQL stores no blobs,
  and Qdrant holds no canonical business state.

BoMesh is in active development. The schema is created directly from the
current models and favours the present design over backwards compatibility.
Preserve tenant isolation, authorization before retrieval, source lineage and
grounded citations when extending it.
