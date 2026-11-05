# Operations and configuration

This guide describes operational settings for a local environment and the
boundaries that must be configured explicitly in deployment. Start with
[Getting started](getting-started.md) for local bootstrap.

## Environment files

| File | Purpose |
| --- | --- |
| `backend/.env.example` | Complete backend configuration template used to create the ignored root `.env`. |
| `apps/web/.env.example` | Browser-only public-variable reference for deployments that inject WebUI configuration through the build. |
| `deployment/compose.yml` | Local PostgreSQL, Qdrant, RustFS, and Temporal topology (legacy MinIO behind the `minio` profile). Optional Compose overrides go in ignored `deployment/.env`; `make` targets pass the RustFS keys from the root `.env`. |

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

## Document index configuration

```dotenv
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=bomesh
QDRANT_API_KEY=
QDRANT_PREFER_GRPC=false

BOMESH_CONTEXTUALIZATION_ENABLED=false
BOMESH_CONTEXTUALIZATION_MODEL=
BOMESH_HYBRID_CANDIDATE_LIMIT=20
```

The local Qdrant collection has one dense vector named `content` and one sparse
BM25 vector named `content_bm25`. It is derived state and can be recreated with
`make qdrant-init`.

## Object storage

Raw document storage is mandatory. Configure one S3-compatible provider with
`BOMESH_OBJECT_STORAGE_PROVIDER`: `rustfs`, `aws_s3` (also MinIO and other
generic S3 endpoints), or `cloudflare_r2`. All three use the same adapter
(`bomesh.storage.S3DocumentStorage`), so switching providers changes no
business flow, object key, or database row.

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
only after workspace authorization. Unlike MinIO, RustFS returns no CORS
headers until a bucket rule exists, so the WebUI document viewer and browser
uploads depend on `rustfs-init` having run.

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
window — it holds every `storage_key`; Qdrant is rebuildable.

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
restart the API and worker. Objects are never moved automatically: Documents
keep their `storage_key`, so the new store must already hold the same keys in
the configured bucket.

Moving from the former local MinIO to RustFS:

```bash
make storage-migrate-minio
```

It starts legacy MinIO (`--profile minio`, host ports `127.0.0.1:9100/9101`),
runs `mc mirror --preserve` into RustFS — content type and ETag are kept, so
preview versions stay valid — and stops MinIO. Nothing is deleted from the
`minio_data` volume. To run MinIO as the active store instead, start it with
`--profile minio`, set `BOMESH_OBJECT_STORAGE_PROVIDER=aws_s3`,
`BOMESH_S3_ENDPOINT_URL=http://127.0.0.1:9100`, and its root credentials in
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.

### Signed URLs and the public endpoint

Signed URLs (previews, "open original", presigned uploads) are used by the
browser or phone, not the backend, and SigV4 signs the host, so they must name
storage as the client reaches it. When that differs from
`BOMESH_S3_ENDPOINT_URL` — a phone on the network cannot reach the Mac's
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

Never persist a presigned URL. Store the Item's `storage_key` and generate a
short-lived upload or download URL only at runtime. A `SignatureDoesNotMatch`
response means the API's key pair does not match the storage server's.

Backend reads of an original (ingestion, preview rendering, agent attachments)
issue one bounded `GET`: the size limit is checked from the response headers
before any body byte is read, and files stream to a temporary path in 1 MiB
blocks rather than into memory.

Image and PDF ingestion may also write versioned WebP objects below the owning
Item's `previews/` prefix. These are derived presentation assets; the raw object
remains authoritative. Bound rendering with `BOMESH_PREVIEW_MAX_SOURCE_BYTES`,
`BOMESH_PREVIEW_MAX_PAGES`, `BOMESH_PREVIEW_MAX_DIMENSION`, and
`BOMESH_PREVIEW_WEBP_QUALITY`. Preview URLs are signed at read time and use
`BOMESH_PREVIEW_URL_SECONDS`.

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
uv run --project backend pytest -q tests
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

`make reset-all` is the complete local data reset. It clears application and
Temporal persistence, reapplies the current SQLAlchemy database design, seeds
the local administrator, and recreates the Qdrant collection while retaining
raw RustFS objects.

For the running API, use `http://127.0.0.1:8000/docs` as the authoritative
request and response reference.

## Common local failures

| Symptom | Check |
| --- | --- |
| `relation "users" does not exist` | Run `make db-init` and `make db-seed`; confirm `DATABASE_URL` points to local PostgreSQL. |
| `SignatureDoesNotMatch` during upload | With RustFS, `RUSTFS_ACCESS_KEY`/`RUSTFS_SECRET_KEY` in the root `.env` must be the pair the running container started with; after changing them run `make services` and restart the API. With AWS S3/MinIO, align `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. |
| Browser preview or upload fails with a CORS error | Run `make services` (re-applies the bucket CORS rule) and include the WebUI origin in `RUSTFS_CORS_ALLOWED_ORIGINS`. |
| `MissingGreenlet` while listing datasources | Ensure the API was restarted after the datasource service update; the list query eager-loads connector credentials. |
| Qdrant schema is incompatible | Run `make qdrant-init`; it recreates the local derived collection. |
| `/health` is degraded | Inspect the individual service entries for missing provider credentials or unreachable dependencies. |
| Turbopack panics with `Next.js package not found` after moving the WebUI | Stop the dev server, remove the generated `apps/web/.next/` cache, and restart `bun run web`. `turbopack.root` is pinned to `apps/web/`; do not reuse a cache generated at the old path. |
