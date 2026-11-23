# Operations and configuration

This guide describes operational settings for a local environment and the
boundaries that must be configured explicitly in deployment. Start with
[Getting started](getting-started.md) for local bootstrap.

## Environment files

| File | Purpose |
| --- | --- |
| `backend/.env.example` | Complete configuration template; `make config` copies it to the ignored root `.env`. The WebUI reads its `NEXT_PUBLIC_*` variables from the same root `.env`. |
| `deployment/compose.yml` | Local PostgreSQL, Qdrant, Gotenberg, and RustFS topology (the Temporal services are commented out while Temporal is disabled). Optional Compose overrides go in ignored `deployment/.env`; `make` targets pass the RustFS keys from the root `.env`. |

Do not commit credentials, encryption keys, signed object URLs, or deployment
environment files.

## Required model configuration

```dotenv
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini

OPENROUTER_API_KEY=...
OPEN_ROUTER_BASE_URL=https://openrouter.ai/api/v1
BOMESH_DOCLING_MODEL=qwen/qwen3-vl-30b-a3b-instruct
EMBEDDING_MODEL=openai/text-embedding-3-small
```

OpenAI serves the chat path. OpenRouter serves embedding requests and Docling's
remote vision pipeline for PDF and image ingestion. PDF/image pages are sent to
`BOMESH_DOCLING_MODEL`, which returns grounded text and table blocks with page
coordinates for citation provenance. No Docling layout, OCR, table, or tokenizer
model is loaded locally. Health reports each dependency separately so a missing
key is visible as an unhealthy required service instead of a silent fallback.

## Database connections

```dotenv
DATABASE_URL=postgresql+asyncpg://bomesh:bomesh@127.0.0.1:5432/bomesh
BOMESH_DB_POOL_SIZE=20      # connections each process (API, worker) keeps open
BOMESH_DB_MAX_OVERFLOW=20   # extra connections opened under load, closed when idle
```

A request holds at most two pooled connections at once (its Authorizer's read
connection and one transaction), so size `pool_size + max_overflow` to at
least twice the requests one API process serves concurrently, and keep the sum
over all API and worker processes under PostgreSQL's `max_connections`.
Connections run with `jit = off` and are pinged on checkout, so a connection
cut while idle is replaced instead of failing a request.

## Document index configuration

```dotenv
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=bomesh
QDRANT_API_KEY=
QDRANT_PREFER_GRPC=false

BOMESH_CONTEXTUALIZATION_ENABLED=false
BOMESH_CONTEXTUALIZATION_MODEL=
# reasoning.effort of contextualization and classification calls (unset = none;
# empty = omit). A reasoning model otherwise spends their small output budget.
BOMESH_CONTEXTUALIZATION_REASONING_EFFORT=none
BOMESH_HYBRID_CANDIDATE_LIMIT=20
```

The local Qdrant collection has one dense vector named `content` and one sparse
BM25 vector named `content_bm25`, and a payload index on every field retrieval
filters on: `tenant_id` (keyword, `is_tenant`), `collection_item_id`, `item_id`,
`chunk_id` (keyword), `published`, `is_deleted` (bool) and `schema_version`
(integer). It is derived state and can be recreated with `make qdrant-init`.

## Ingestion worker

Runs, source syncs, due schedules and index upkeep execute in the ingestion
worker, `cd backend && uv run python -m bomesh.services.ingestion.worker`: the
API's code and image, deployed as its own container and scaled on its own.
PostgreSQL is the queue; there is no other orchestration service. SIGTERM
stops it gracefully: it gives back the documents in flight for another
replica.

```dotenv
BOMESH_INGESTION_MAX_CONCURRENT_RUNS=2        # runs (and syncs) per worker
BOMESH_INGESTION_MAX_CONCURRENT_DOCUMENTS=4   # documents processed at once per worker
BOMESH_INGESTION_POLL_SECONDS=2
BOMESH_INGESTION_GRACEFUL_SHUTDOWN_SECONDS=30
# Direct PostgreSQL connection holding the worker's advisory locks; required
# when DATABASE_URL goes through a transaction-pooling pgbouncer.
BOMESH_INGESTION_LOCK_DATABASE_URL=
```

Batching per run stays `BOMESH_INGESTION_BATCH_MAX_ITEMS`,
`BOMESH_INGESTION_BATCH_MAX_BYTES` and `BOMESH_INGESTION_RUN_PARALLELISM`.

## Object storage

Raw document storage is mandatory. Configure one S3-compatible provider with
`BOMESH_OBJECT_STORAGE_PROVIDER`: `rustfs`, `aws_s3` (also any other
S3-compatible endpoint set in `BOMESH_S3_ENDPOINT_URL`), or `cloudflare_r2`. All three use the same adapter
(`bomesh.storage.S3DocumentStorage`), so switching providers changes no
business flow, object key, or database row.

### Object keys

PostgreSQL stores no object key, bucket or provider path: every key is derived
from row identities by `bomesh/storage/keys.py` (see
[Object storage](../backend/docs_design/database_architecture.md#object-storage)). The first segment is the lifecycle class, the second
the owning tenant UUID (`platform` for platform-level objects):

| Prefix | Holds |
| --- | --- |
| `content/{tenant}/{content_id}` | bytes of a revision (uploads, attachments, source originals, archive members, artifacts) |
| `derived/{tenant}/{content_id}/{product}-v{n}[/{part}]` | representations, covers, artifact previews (rebuildable) |
| `assets/{tenant}/map-background/{image_id}` | workspace assets |
| `exports/{tenant or platform}/{operation_id}` | export Operation results (CSV) |

Keys never contain file names; the name is sent per download as
`Content-Disposition` on the signed URL. A workspace's objects are one prefix
per class (`{class}/{tenant}/`).

**Optional exports lifecycle rule.** Export CSVs stop being downloadable at the
Operation's `result_expires_at` (7 days). To reclaim their space, add a bucket
lifecycle rule expiring objects under `exports/` after 7 days, for example
`mc ilm rule add --prefix exports/ --expire-days 7 rustfs/bomesh` (or the S3/R2
console equivalent). No other class may get an expiry rule.

### RustFS (default for local and single-server deployment)

```dotenv
BOMESH_OBJECT_STORAGE_PROVIDER=rustfs
BOMESH_OBJECT_STORAGE_BUCKET=bomesh
BOMESH_S3_ENDPOINT_URL=http://127.0.0.1:9000
BOMESH_S3_REGION=us-east-1          # optional; RustFS signs with us-east-1
BOMESH_S3_ADDRESSING_STYLE=path     # optional; RustFS requires path-style
RUSTFS_ACCESS_KEY=bomesh
RUSTFS_SECRET_KEY=<generated>
```

`make config` writes these values only when they are missing and generates
`RUSTFS_SECRET_KEY` once. `RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY` are the
same pair the RustFS server reads, so the API and the container cannot drift
apart. When `BOMESH_S3_ENDPOINT_URL` is the local `http://127.0.0.1:9000`,
`make services` starts the pinned `rustfs/rustfs` image and runs
`rustfs-init`, which idempotently creates the private bucket and applies its
CORS rule.

Compose settings. `make` passes `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, and
`RUSTFS_API_BIND` from the root `.env`; set the others in `deployment/.env`.
On a server, put all of them in `deployment/.env` and run
`docker compose -f deployment/compose.yml up -d rustfs` then
`docker compose -f deployment/compose.yml run --rm rustfs-init`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY` | none — required | Server credentials; Compose refuses to start without them. |
| `RUSTFS_VERSION` | `1.0.4` | Pinned image tag. |
| `RUSTFS_API_BIND` | `127.0.0.1` | Host address for the S3 API. Set `0.0.0.0` only when devices on the network need signed URLs. |
| `RUSTFS_API_PORT` | `9000` | Host port for the S3 API. |
| `RUSTFS_DATA_DIR` | `rustfs_data` volume | Host SSD path instead of the named volume; `chown -R 10001:10001` it first. |
| `RUSTFS_CONSOLE_ENABLE` | `false` | Admin console, published only on `127.0.0.1:${RUSTFS_CONSOLE_PORT:-9001}`; reach it through an SSH tunnel. |
| `RUSTFS_BUCKET` | `bomesh` | Bucket `rustfs-init` creates. |
| `RUSTFS_CORS_ALLOWED_ORIGINS` | `*` | Comma-separated web origins for signed-URL `GET`/`HEAD`/`PUT`. Restrict to the WebUI origin in deployment. |

The bucket has no public policy: every read needs a signature the API issues
only after workspace authorization. RustFS returns no CORS headers until a
bucket rule exists, so the WebUI document viewer and browser uploads depend on
`rustfs-init` having run.

Verify:

```bash
curl -fsS http://127.0.0.1:9000/health                       # server
docker compose -f deployment/compose.yml ps rustfs           # (healthy)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9000/bomesh/   # 403: private
```

Objects live in the `bomesh_rustfs_data` volume (or `RUSTFS_DATA_DIR`) and
survive `restart`, `stop`, and container recreation; only
`docker compose down -v` or `docker volume rm` deletes them.

**Backup (single node).** RustFS here has one node and one drive: no
redundancy. Back up the bucket off the machine, for example nightly
`mc mirror --preserve rustfs/bomesh <offsite>` or a filesystem snapshot of
`RUSTFS_DATA_DIR` taken while RustFS is stopped. Back up PostgreSQL in the same
window — its rows hold the identities every object key is derived from; Qdrant
is rebuildable.

### Shared RustFS (homelab)

To use the RustFS server of the homelab stack (`homelab/stacks/rustfs`)
instead of a local container, point the root `.env` at its tailnet address
and use that stack's `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY`:

```dotenv
BOMESH_S3_ENDPOINT_URL=http://<homelab-tailscale-ip>:9000
BOMESH_S3_PUBLIC_ENDPOINT_URL=http://<homelab-tailscale-ip>:9000
```

`make services` then starts no local RustFS and only waits for the remote
`/health`. The homelab's `rustfs-init` owns the bucket and its CORS rule, which
allows only the deployed WebUI origin, so browser uploads from a local web
origin need that origin added there. Signed URLs name the tailnet address, so
every client must be on the tailnet.

### Switching providers

Change `BOMESH_OBJECT_STORAGE_PROVIDER` and that provider's settings, then
restart the API and worker. Objects are never moved automatically: keys are
derived from row identities, so the new store must already hold the same keys
in the configured bucket (copy the bucket as is).

To use another S3-compatible server, set `BOMESH_OBJECT_STORAGE_PROVIDER=aws_s3`,
its address in `BOMESH_S3_ENDPOINT_URL`, and its credentials in
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.

### Signed URLs and the public endpoint

Signed URLs (previews, "open original", presigned uploads) are used by the
browser, not the backend, and SigV4 signs the host, so they must name
storage as the browser reaches it. When that differs from
`BOMESH_S3_ENDPOINT_URL` — a browser on another device cannot reach the Mac's
`127.0.0.1` — set:

```dotenv
BOMESH_S3_PUBLIC_ENDPOINT_URL=http://<machine-network-address>:9000
```

The backend still reads and writes through `BOMESH_S3_ENDPOINT_URL` (loopback,
or `http://rustfs:9000` when the API runs inside the Compose network). Without
it, device previews fail although the API itself is reachable. Behind an HTTPS
reverse proxy, set it to the proxy's origin (for example
`https://files.example.com`) and proxy that host unchanged to RustFS: the
`Host` header must stay the signed host. Browsers then fetch originals and
preview pages directly from storage, including HTTP `Range` requests, without
passing bytes through the API.

### AWS S3 and Cloudflare R2

AWS S3 uses boto3's standard credential chain (`AWS_ACCESS_KEY_ID`, profiles,
instance roles). Cloudflare R2 uses its S3-compatible endpoint and API-token
access key pair:

```dotenv
BOMESH_OBJECT_STORAGE_PROVIDER=cloudflare_r2
BOMESH_R2_BUCKET=...
BOMESH_R2_ACCOUNT_ID=...
BOMESH_R2_ACCESS_KEY_ID=...
BOMESH_R2_SECRET_ACCESS_KEY=...
```

Never persist a presigned URL (nor any object key: keys are derived, see
[Object keys](#object-keys)). Generate a short-lived upload or download URL only at runtime. A `SignatureDoesNotMatch`
response means the API's key pair does not match the storage server's.

Backend reads of an original (ingestion, preview production, agent attachments)
issue one bounded `GET`: the size limit is checked from the response headers
before any body byte is read, and files stream to a temporary path in 1 MiB
blocks rather than into memory. A TEXT representation reads only the
original's first MiB, with one `Range` GET.

Knowledge documents are shown through the preview engine
(`backend/bomesh/services/previews/`, `document_viewer.md`): the ingestion
worker turns each revision's original into one representation (PDF, IMAGE,
TABLE, TEXT, MEDIA or ARCHIVE) when its content arrives, stored once and
immutable under its content's `derived/{tenant}/{content_id}/representation-v1`
key; requests never convert.
Office, OpenDocument, RTF, HTML and e-mail files become PDF through Gotenberg,
which `make services` starts (`deployment/compose.yml`, image
`gotenberg/gotenberg:8`, loopback port `GOTENBERG_PORT`, default 3010) and
waits for on `/health`:

```dotenv
BOMESH_GOTENBERG_URL=http://127.0.0.1:3010   # http://gotenberg:3000 inside the Compose network
BOMESH_PREVIEW_CONVERSIONS=2                 # Gotenberg conversions per worker at once
```

Gotenberg is internal only and receives file bytes, never URLs; Chromium runs
without JavaScript and with every request but the uploaded page denied. A
worker that cannot reach it records nothing: the next read or the ten-minute
sweep converts again. Sources over 100 MiB are not converted, and a
conversion stops after 120 s. Representation URLs are signed at the start of
a `BOMESH_PREVIEW_URL_SECONDS` window (default 300), so a reopened document is
served from the browser cache.

Conversation artifacts may also write versioned WebP page images and a
document rendition under their content's `derived/{tenant}/{content_id}/preview-v{n}/`
prefix. Bound rendering
with `BOMESH_PREVIEW_MAX_SOURCE_BYTES`, `BOMESH_PREVIEW_MAX_PAGES`,
`BOMESH_PREVIEW_MAX_DIMENSION`, and `BOMESH_PREVIEW_WEBP_QUALITY`.

The ingestion worker also writes one immutable cover WebP per document
content (`derived/{tenant}/{content_id}/cover-v2`, at most 480 px wide) after its representation:
page one of a PDF representation, so office documents get their real first
page; sources over 50 MB get none. Cover URLs are signed with a timestamp
aligned to a `BOMESH_PREVIEW_COVER_URL_SECONDS` window (default 3600), so a
list returns the same URL for the whole window and browsers reuse the cached
image.

## Identity and credentials

```dotenv
# Exactly 32 URL-safe base64-decoded bytes; generate once and retain securely.
BOMESH_INTEGRATION_ENCRYPTION_KEY=...
```

Integration credentials are encrypted before they are written to
`integration_credentials`. They are not Item metadata, Qdrant payload, frontend
configuration, or audit-log content.

## Agent sandbox (Docker)

The agent's `run_shell` tool runs in BoMesh-owned Docker containers (one per
conversation, no network, non-root, resource-limited). The API process needs
access to the Docker daemon (`DOCKER_HOST` or the default socket) and the
image:

```bash
docker build -t bomesh-sandbox:latest deployment/sandbox
```

```dotenv
BOMESH_SANDBOX_ENABLED=true            # false: sandbox tools are never offered
BOMESH_SANDBOX_IMAGE=bomesh-sandbox:latest
BOMESH_SANDBOX_WARM_POOL_SIZE=2        # pristine containers kept ready
BOMESH_SANDBOX_IDLE_TTL_SECONDS=1800   # idle conversation containers are removed
BOMESH_SANDBOX_MEMORY=1g
BOMESH_SANDBOX_CPUS=1.0
BOMESH_SANDBOX_PIDS_LIMIT=256
BOMESH_SANDBOX_COMMAND_TIMEOUT_SECONDS=60
BOMESH_SANDBOX_MAX_OUTPUT_CHARACTERS=8000
```

Without Docker or the image the API logs a warning and chat works without
sandbox tools. Containers carry the label `bomesh.sandbox=1`
(`docker ps --filter label=bomesh.sandbox=1`). See
`backend/docs_design/conversation_loop.md` ("Sandbox shell work").

## Health and observability

`GET /health` reports API, Qdrant, OpenAI chat, OpenRouter embeddings, and
optional Langfuse availability. It reports `healthy`, `degraded`, or
`unhealthy` without exposing credentials.

Langfuse tracing is optional:

```dotenv
LANGFUSE_SECRET_KEY=...
LANGFUSE_PUBLIC_KEY=...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development
OTEL_SERVICE_NAME=bomesh-api
```

Both Langfuse keys are required. Keep trace retention and access policies
appropriate for potentially sensitive prompts, outputs, and retrieved content.

## Verification

```bash
make status
(cd backend && set -a && . ../.env && set +a && uv run python -m pytest ../tests -q)
(cd apps/web && bun run test)
(cd apps/web && bun run typecheck)
(cd apps/web && bun run build)
```

The PostgreSQL tests read `TEST_DATABASE_URL`, which `backend/.env.example`
defines for the local database; sourcing the root `.env` exports it. They are
skipped when it is unset.

`make reset-all` is the complete local data reset. It deletes the PostgreSQL,
Qdrant and RustFS volumes (`make volumes-reset`; it refuses a remote object
store or a `RUSTFS_DATA_DIR` host directory), reapplies the current SQLAlchemy
database design, recreates the Qdrant collection with its payload indexes and
runs `make seed` (both workspaces and the role-matrix accounts,
`auth_contract.md` "Seeded workspaces and accounts"). Stop the API and the
ingestion worker first.

For the running API, use `http://127.0.0.1:8000/docs` as the authoritative
request and response reference.

## Common local failures

| Symptom | Check |
| --- | --- |
| `relation "users" does not exist` | Run `make db-reset`; confirm `DATABASE_URL` points to local PostgreSQL. |
| `SignatureDoesNotMatch` during upload | With RustFS, `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` in the root `.env` must be the pair the running container started with; after changing them run `make services` and restart the API. With AWS S3 or another S3-compatible server, align `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. |
| Browser preview or upload fails with a CORS error | Run `make services` (re-applies the bucket CORS rule) and include the WebUI origin in `RUSTFS_CORS_ALLOWED_ORIGINS`. |
| Qdrant schema is incompatible | Run `make qdrant-init`; it recreates the local derived collection. |
| `/health` is degraded | Inspect the individual service entries for missing provider credentials or unreachable dependencies. |
| Turbopack panics with `Next.js package not found` | Stop the dev server, remove the generated `apps/web/.next/` cache, and restart `bun run web`. `turbopack.root` is pinned to `apps/web/`; a cache generated at another path does not resolve. |
