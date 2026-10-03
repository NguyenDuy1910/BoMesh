# Getting started

This guide prepares a local BoMesh environment for backend, WebUI, and
connector development.

## Prerequisites

- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Docker and Docker Compose
- Node.js 20 or newer with npm
- [Bun](https://bun.sh/) to run the WebUI
- An OpenAI API key for chat and an OpenRouter API key for document vision and embeddings

The Flutter app under `app/bomesh/` is optional. It needs a current Flutter
SDK only when you are working on the mobile client.

## Initialize the local stack

From the repository root:

```bash
uv sync --project backend
npm --prefix web ci
make init
```

`make init` performs the complete local bootstrap:

1. Creates the root `.env` when missing.
2. Writes local dependency endpoints and enables the backend's local development identity.
3. Starts PostgreSQL, Qdrant, MinIO, Temporal, and the Temporal UI.
4. Creates the configured MinIO bucket.
5. Rebuilds PostgreSQL from the current SQLAlchemy models.
6. Seeds a deterministic local administrator and membership.
7. Recreates the derived Qdrant collection with dense and BM25 vectors.
8. Registers the Temporal Search Attributes used by ingestion visibility.

The command is deliberately destructive to local derived and database state.
It drops the PostgreSQL `public` schema, clears Temporal persistence, and
replaces the Qdrant collection. Never run it against retained data.

## Configure providers

Add provider credentials to the root `.env` before running a chat or embedding
workflow:

```dotenv
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
```

The remaining local settings are maintained by `make config`. For production
or a non-local object store, use [Operations and configuration](operations.md).

## Run the applications

Start the local stack, API, and Temporal ingestion worker with one command:

```bash
cd backend
uv run main.py
```

This runs `make services` first (which updates the root `.env` with local
endpoints), then supervises the API and worker. Stopping the command stops the
worker, but leaves the shared Compose containers running. Run `make init` once
to initialize the database, seed accounts, and create the Qdrant collection;
starting the API does not reset or create those schemas. For deployments with
externally managed dependencies, run the API and worker separately instead of
using this local entrypoint.

Start the WebUI in a separate terminal:

```bash
bun run web
```

The WebUI loads its public configuration from the same root `.env`. The API
accepts the development identity only while
`BOMESH_ALLOW_INSECURE_DEV_IDENTITY=true`; it is not an authentication
mechanism for deployment.

## Local service endpoints

| Service | URL |
| --- | --- |
| WebUI | `http://127.0.0.1:3000` |
| FastAPI | `http://127.0.0.1:8000` |
| OpenAPI | `http://127.0.0.1:8000/docs` |
| Health | `http://127.0.0.1:8000/health` |
| Qdrant | `http://127.0.0.1:6333` |
| MinIO console | `http://127.0.0.1:9001` |
| Temporal UI | `http://127.0.0.1:8080` |

## Useful reset boundaries

```bash
make services     # dependencies only
make reset-all    # all databases + Qdrant + current schema + admin seed
make db-init      # PostgreSQL schema only; destructive
make db-seed      # deterministic admin identity only
make db-reset     # PostgreSQL schema plus deterministic admin identity
make qdrant-init  # Qdrant collection only; destructive
make status       # Compose status and API health
```

Use `make db-reset` after changing SQLAlchemy models. It starts missing local
services, rebuilds PostgreSQL from the current ORM metadata, and restores the
development administrator without recreating Qdrant.

Use `make reset-all` after changing the data design or Qdrant schema. It resets
the application and Temporal databases plus the derived vector collection,
applies the current SQLAlchemy schema, and restores the administrator. It does
not delete raw MinIO objects.

For the ownership implications of these resets, see
[Architecture](architecture.md) and [Data schema](data.schema.md).
