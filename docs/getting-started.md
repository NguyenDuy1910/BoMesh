# Getting started

This guide prepares a local BoMesh environment for backend, WebUI, and
connector development.

## Prerequisites

- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Docker with Docker Compose
- [Bun](https://bun.sh/) to install and run the WebUI
- Node.js 22.6 or newer for the WebUI unit tests (`bun run test` runs `node --test`)
- An OpenAI API key for chat and an OpenRouter API key for document vision and embeddings

## Initialize the local stack

From the repository root:

```bash
uv sync --project backend
(cd apps/web && bun install)
make init
```

`make init` performs the complete local bootstrap:

1. `make config` creates the root `.env` from `backend/.env.example` when it is
   missing, points it at the local PostgreSQL, Qdrant, Gotenberg, and RustFS
   endpoints, and generates the missing local secrets
   (`BOMESH_AUTH_JWT_SECRET`, `BOMESH_INTEGRATION_ENCRYPTION_KEY`,
   `RUSTFS_SECRET_KEY`).
2. `make services` starts PostgreSQL, Qdrant, Gotenberg, and RustFS, waits for
   them, and runs `rustfs-init`, which creates the private bucket and its
   browser CORS rule.
3. `make db-reset` rebuilds PostgreSQL from the current SQLAlchemy models,
   syncs the IAM permissions and predefined roles, and seeds the HCMUTE
   workspace with its system administrator.
4. `make db-seed-accounts` seeds the HCMUTE role-matrix accounts, one per IAM
   role, all with the password `19102003`.
5. `make qdrant-init` recreates the derived Qdrant collection with dense and
   BM25 vectors.
6. `make status` prints the Compose status and API health.

The command is deliberately destructive to local derived and database state.
It drops the PostgreSQL `public` schema and
replaces the Qdrant collection. Never run it against retained data.

File work in chat (the agent's `run_shell` tool) runs in BoMesh's own Docker
sandbox. Build its image once:

```bash
docker build -t bomesh-sandbox:latest deployment/sandbox
```

Without the image, chat works without sandbox tools; see
[Operations](operations.md#agent-sandbox-docker).

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

Start the local stack, API, and ingestion worker with one command:

```bash
cd backend
uv run main.py
```

This runs `make services` first (which updates the root `.env` with local
endpoints), then supervises the API and worker. Stopping the command stops the
worker, but leaves the shared Compose containers running. Run `make init` once
to initialize the database, seed accounts, and create the Qdrant collection;
starting the API does not reset or create those schemas. For deployments with
externally managed dependencies, run the API and the ingestion worker
(`cd backend && uv run python -m bomesh.services.ingestion.worker`) separately
instead of using this local entrypoint.

Start the WebUI in a separate terminal, in development mode for editing:

```bash
bun run web        # make web-dev: HMR, unminified, source maps
```

or as the optimized production build for anything shared, demoed or measured:

```bash
bun run web:prod   # make web-prod: next build && next start
```

Never take performance numbers from the development server; `.next/dev` and the
Turbopack HMR client in the network panel mean you are measuring dev mode.

The WebUI loads its public configuration from the same root `.env`. Every API
request authenticates with a bearer access token (`auth_contract.md`); there is
no development identity header.

## Local service endpoints

| Service | URL |
| --- | --- |
| WebUI | `http://127.0.0.1:3000` |
| FastAPI | `http://127.0.0.1:8000` |
| OpenAPI | `http://127.0.0.1:8000/docs` |
| Health | `http://127.0.0.1:8000/health` |
| Qdrant | `http://127.0.0.1:6333` |
| RustFS S3 API | `http://127.0.0.1:9000` (console off; see [Operations](operations.md#object-storage)) |

## Useful reset boundaries

```bash
make services     # dependencies only
make reset-all    # PostgreSQL + Qdrant + current schema + HCMUTE admin and role-matrix accounts
make db-init      # PostgreSQL schema and IAM catalog only; destructive
make db-seed      # HCMUTE workspace and its system administrator only
make db-reset     # PostgreSQL schema plus HCMUTE workspace and administrator
make db-seed-accounts  # db-reset plus the role-matrix accounts (password 19102003)
make qdrant-init  # Qdrant collection only; destructive
make status       # Compose status and API health
```

Use `make db-reset` after changing SQLAlchemy models. It starts missing local
services, rebuilds PostgreSQL from the current ORM metadata, and restores the
HCMUTE workspace and its administrator without recreating Qdrant.

Use `make reset-all` after changing the data design or Qdrant schema. It resets
the application database plus the derived vector collection,
applies the current SQLAlchemy schema, and restores the HCMUTE administrator
and role-matrix accounts. It does not delete raw RustFS objects.

For the ownership implications of these resets, see
[Architecture](architecture.md) and [Data schema](data.schema.md).
