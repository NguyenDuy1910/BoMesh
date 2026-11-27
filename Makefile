SHELL := /bin/bash
.DEFAULT_GOAL := help
.NOTPARALLEL:

COMPOSE_FILE := deployment/compose.yml
# Compose interpolates deployment/compose.yml from the root .env, so the API and
# the services share one configuration: RustFS credentials, RUSTFS_CONSOLE_ENABLE,
# RUSTFS_DATA_DIR, RUSTFS_CORS_ALLOWED_ORIGINS and the bucket the API uses.
ROOT_ENV = $$(sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -n 1)
COMPOSE = RUSTFS_BUCKET="$(call ROOT_ENV,BOMESH_OBJECT_STORAGE_BUCKET)" docker compose $(if $(wildcard .env),--env-file .env) -f $(COMPOSE_FILE)

LOCAL_DATABASE_URL ?= postgresql+asyncpg://bomesh:bomesh@127.0.0.1:5432/bomesh
LOCAL_QDRANT_URL ?= http://127.0.0.1:6333
LOCAL_GOTENBERG_URL ?= http://127.0.0.1:3010
LOCAL_S3_ENDPOINT ?= http://127.0.0.1:9000
LOCAL_S3_BUCKET ?= bomesh
# [temporal-disabled] LOCAL_TEMPORAL_TARGET ?= 127.0.0.1:7233
# [temporal-disabled] LOCAL_TEMPORAL_UI ?= http://127.0.0.1:8080
QDRANT_COLLECTION ?= bomesh
QDRANT_VECTOR_SIZE ?= 1536

# [temporal-disabled] _temporal-reset was listed here.
.PHONY: help init reset-all config services worker worker-stop volumes-reset db-init db-reset seed qdrant-init status web-dev web-build web-prod

help: ## Show available local-development commands.
	@echo "BoMesh local development"
	@echo
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

init: reset-all ## Initialize the complete local BoMesh environment.
	@echo
	@echo "BoMesh local environment is ready."
	@echo "  API:       http://127.0.0.1:8000"
	@echo "  Qdrant:    $(LOCAL_QDRANT_URL)/dashboard"
	@echo "  RustFS:    $(LOCAL_S3_ENDPOINT) (console: RUSTFS_CONSOLE_ENABLE=true in .env, then http://127.0.0.1:9001/rustfs/console/)"
	@echo
	@echo "Start the API and ingestion worker with: cd backend && uv run python main.py"
	@echo "  or the worker as a container (make worker), then the API alone: cd backend && uv run python main.py --api-only"
	@echo "Start the WebUI with: bun run web"

# [temporal-disabled] reset-all also depended on _temporal-reset.
reset-all: volumes-reset db-init qdrant-init seed status ## Wipe PostgreSQL, Qdrant and local object storage, apply the current design, and seed the workspaces.
	@echo "Full reset is complete."

# [temporal-disabled] config also wrote BOMESH_TEMPORAL_TARGET=$(LOCAL_TEMPORAL_TARGET),
# BOMESH_TEMPORAL_NAMESPACE=default and BOMESH_TEMPORAL_TLS=false into .env.
config: ## Create the root .env from backend/.env.example, default it to the local services (keeping any other endpoints already set), and generate missing local secrets.
	@set -euo pipefail
	@if [[ ! -f .env ]]; then cp backend/.env.example .env; fi
	@update_env() { \
		local file="$$1" key="$$2" value="$$3" temp_file; \
		temp_file="$$(mktemp)"; \
		awk -v key="$$key" -v value="$$value" 'BEGIN { found = 0 } $$0 ~ "^" key "=" { print key "=" value; found = 1; next } { print } END { if (!found) print key "=" value }' "$$file" > "$$temp_file"; \
		mv "$$temp_file" "$$file"; \
	}; \
	set_default() { \
		grep -q "^$$2=" "$$1" || update_env "$$1" "$$2" "$$3"; \
	}; \
	set_default .env DATABASE_URL "$(LOCAL_DATABASE_URL)"; \
	set_default .env QDRANT_URL "$(LOCAL_QDRANT_URL)"; \
	set_default .env QDRANT_COLLECTION "$(QDRANT_COLLECTION)"; \
	set_default .env QDRANT_API_KEY ""; \
	set_default .env BOMESH_OBJECT_STORAGE_PROVIDER rustfs; \
	set_default .env BOMESH_OBJECT_STORAGE_BUCKET "$(LOCAL_S3_BUCKET)"; \
	set_default .env BOMESH_S3_ENDPOINT_URL "$(LOCAL_S3_ENDPOINT)"; \
	set_default .env BOMESH_S3_ADDRESSING_STYLE path; \
	set_default .env BOMESH_S3_REGION us-east-1; \
	set_default .env BOMESH_GOTENBERG_URL "$(LOCAL_GOTENBERG_URL)"; \
	rustfs_access_key="$$(sed -n 's/^RUSTFS_ACCESS_KEY=//p' .env | tail -n 1)"; \
	rustfs_secret_key="$$(sed -n 's/^RUSTFS_SECRET_KEY=//p' .env | tail -n 1)"; \
	if [[ -z "$$rustfs_access_key" ]]; then update_env .env RUSTFS_ACCESS_KEY bomesh; fi; \
	if [[ ! "$$rustfs_secret_key" =~ ^[A-Za-z0-9_-]{32,}$$ ]]; then \
		update_env .env RUSTFS_SECRET_KEY "$$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"; \
	fi; \
	integration_key="$$(sed -n 's/^BOMESH_INTEGRATION_ENCRYPTION_KEY=//p' .env | tail -n 1)"; \
	if [[ ! "$$integration_key" =~ ^[A-Za-z0-9_-]{43}=?$$ ]]; then \
		update_env .env BOMESH_INTEGRATION_ENCRYPTION_KEY "$$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n')"; \
	fi; \
	jwt_secret="$$(sed -n 's/^BOMESH_AUTH_JWT_SECRET=//p' .env | tail -n 1)"; \
	if [[ $${#jwt_secret} -lt 32 ]]; then \
		update_env .env BOMESH_AUTH_JWT_SECRET "$$(openssl rand -base64 48 | tr -d '\n')"; \
	fi
	@echo "Configured the root environment file."

# [temporal-disabled] services also started temporal temporal-admin-tools temporal-ui
# and ran temporal-init.
services: config ## Start PostgreSQL, Qdrant, Gotenberg, and local RustFS unless BOMESH_S3_ENDPOINT_URL names a remote store.
	@set -euo pipefail
	@s3_endpoint="$(call ROOT_ENV,BOMESH_S3_ENDPOINT_URL)"; \
	local_storage=""; \
	if [[ "$$s3_endpoint" == "$(LOCAL_S3_ENDPOINT)" ]]; then local_storage=rustfs; fi; \
	$(COMPOSE) up -d postgres qdrant gotenberg $$local_storage
	@for attempt in {1..30}; do \
		if $(COMPOSE) exec -T postgres sh -c 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' >/dev/null 2>&1; then break; fi; \
		if [[ $$attempt -eq 30 ]]; then echo "PostgreSQL did not become ready." >&2; exit 1; fi; \
		sleep 1; \
	done
	@for attempt in {1..30}; do \
		if curl --fail --silent --max-time 2 "$(LOCAL_QDRANT_URL)/readyz" >/dev/null; then break; fi; \
		if [[ $$attempt -eq 30 ]]; then echo "Qdrant did not become ready." >&2; exit 1; fi; \
		sleep 1; \
	done
	@for attempt in {1..60}; do \
		if curl --fail --silent --max-time 2 "$(LOCAL_GOTENBERG_URL)/health" >/dev/null; then break; fi; \
		if [[ $$attempt -eq 60 ]]; then echo "Gotenberg did not become ready." >&2; exit 1; fi; \
		sleep 1; \
	done
	@s3_endpoint="$(call ROOT_ENV,BOMESH_S3_ENDPOINT_URL)"; \
	for attempt in {1..30}; do \
		if curl --fail --silent --max-time 2 "$$s3_endpoint/health" >/dev/null; then break; fi; \
		if [[ $$attempt -eq 30 ]]; then echo "Object storage at $$s3_endpoint did not become ready." >&2; exit 1; fi; \
		sleep 1; \
	done; \
	if [[ "$$s3_endpoint" == "$(LOCAL_S3_ENDPOINT)" ]]; then $(COMPOSE) run --rm rustfs-init >/dev/null; fi
	@echo "PostgreSQL, Qdrant, Gotenberg, and object storage are accepting connections."

worker: services ## Start (or restart on changed code) the ingestion worker container; then run the API alone: cd backend && uv run python main.py --api-only
	@set -euo pipefail
	@in_network() { \
		printf '%s' "$$1" | sed -E \
			-e 's#(127\.0\.0\.1|localhost):5432#postgres:5432#' \
			-e 's#(127\.0\.0\.1|localhost):6333#qdrant:6333#' \
			-e 's#(127\.0\.0\.1|localhost):3010#gotenberg:3000#' \
			-e 's#(127\.0\.0\.1|localhost):9000#rustfs:9000#' \
			-e 's#//(127\.0\.0\.1|localhost)([:/]|$$)#//host.docker.internal\2#'; \
	}; \
	export WORKER_DATABASE_URL="$$(in_network "$(call ROOT_ENV,DATABASE_URL)")"; \
	export WORKER_LOCK_DATABASE_URL="$$(in_network "$(call ROOT_ENV,BOMESH_INGESTION_LOCK_DATABASE_URL)")"; \
	export WORKER_QDRANT_URL="$$(in_network "$(call ROOT_ENV,QDRANT_URL)")"; \
	export WORKER_S3_ENDPOINT_URL="$$(in_network "$(call ROOT_ENV,BOMESH_S3_ENDPOINT_URL)")"; \
	export WORKER_GOTENBERG_URL="$$(in_network "$(call ROOT_ENV,BOMESH_GOTENBERG_URL)")"; \
	export WORKER_HTTPS_PROXY="$$(in_network "$(call ROOT_ENV,HTTPS_PROXY)")"; \
	export WORKER_HTTP_PROXY="$$(in_network "$(call ROOT_ENV,HTTP_PROXY)")"; \
	$(COMPOSE) --profile worker up -d --build --force-recreate --wait ingestion-worker
	@echo "Ingestion worker is running (logs: docker logs -f bomesh-ingestion-worker-1). Run the API with: cd backend && uv run python main.py --api-only"

worker-stop: ## Stop the ingestion worker container (it gives back what it runs).
	@$(COMPOSE) --profile worker stop ingestion-worker

# [temporal-disabled] Temporal persistence reset (Temporal is not used in this phase).
# _temporal-reset: services
# 	@set -euo pipefail
# 	@$(COMPOSE) stop temporal-ui temporal-admin-tools temporal >/dev/null
# 	@$(COMPOSE) exec -T postgres sh -c 'for database in temporal temporal_visibility; do psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$$database\" WITH (FORCE);"; done' >/dev/null
# 	@$(COMPOSE) up -d temporal temporal-admin-tools temporal-ui >/dev/null
# 	@$(COMPOSE) run --rm temporal-init >/dev/null
# 	@echo "Temporal persistence is reset."

volumes-reset: config ## Delete the local PostgreSQL, Qdrant and RustFS volumes (all data), then start the services again.
	@set -euo pipefail
	@s3_endpoint="$(call ROOT_ENV,BOMESH_S3_ENDPOINT_URL)"; \
	if [[ -n "$$s3_endpoint" && "$$s3_endpoint" != "$(LOCAL_S3_ENDPOINT)" ]]; then \
		echo "Refusing: object storage is remote ($$s3_endpoint); a local reset would leave its objects orphaned." >&2; exit 1; \
	fi; \
	if [[ -n "$(call ROOT_ENV,RUSTFS_DATA_DIR)" ]]; then \
		echo "Refusing: RUSTFS_DATA_DIR is a host directory; empty it by hand, then unset it or rerun." >&2; exit 1; \
	fi
	@$(COMPOSE) --profile worker down --volumes --remove-orphans
	@$(MAKE) --no-print-directory services
	@echo "PostgreSQL, Qdrant and RustFS volumes were recreated empty."

db-init: services ## Apply the current database design and the IAM catalog (permissions, predefined roles).
	@set -euo pipefail
	@$(COMPOSE) exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"' >/dev/null
	@cd backend && DATABASE_URL="$(LOCAL_DATABASE_URL)" uv run python -c 'import asyncio; from bomesh.db.engine import get_engine, get_session_factory; from bomesh.db.models import Base; from bomesh.iam.sync import sync_catalog; exec("async def initialize():\n    engine = get_engine()\n    async with engine.begin() as connection:\n        await connection.run_sync(Base.metadata.create_all)\n    async with get_session_factory()() as session:\n        async with session.begin():\n            await sync_catalog(session)\n    await engine.dispose()") ; asyncio.run(initialize())'
	@echo "PostgreSQL schema, permissions, and predefined roles are initialized."

db-reset: db-init seed ## Rebuild PostgreSQL from the current ORM and reseed the workspaces (Qdrant and storage untouched).
	@echo "PostgreSQL reset is complete."

seed: services ## Seed both workspaces, the role-matrix accounts (password 19102003), the university taxonomy and HCM-UTE's folders.
	@set -euo pipefail
	@cd backend && DATABASE_URL="$(LOCAL_DATABASE_URL)" uv run python script/seed.py

qdrant-init: services ## Rebuild the derived contextual-hybrid Qdrant collection and its payload indexes.
	@set -euo pipefail
	@status_code="$$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$(LOCAL_QDRANT_URL)/collections/$(QDRANT_COLLECTION)")"; \
	if [[ "$$status_code" == "200" ]]; then \
		curl --fail --silent --show-error --max-time 10 \
			-X DELETE "$(LOCAL_QDRANT_URL)/collections/$(QDRANT_COLLECTION)" >/dev/null; \
	elif [[ "$$status_code" != "404" ]]; then \
		echo "Unexpected Qdrant response: HTTP $$status_code" >&2; \
		exit 1; \
	fi; \
	curl --fail --silent --show-error --max-time 10 \
		-X PUT "$(LOCAL_QDRANT_URL)/collections/$(QDRANT_COLLECTION)" \
		-H 'Content-Type: application/json' \
		-d '{"vectors":{"content":{"size":$(QDRANT_VECTOR_SIZE),"distance":"Cosine"}},"sparse_vectors":{"content_bm25":{"modifier":"idf"}}}' >/dev/null; \
	for index in \
		'{"field_name":"tenant_id","field_schema":{"type":"keyword","is_tenant":true}}' \
		'{"field_name":"collection_item_id","field_schema":"keyword"}' \
		'{"field_name":"item_id","field_schema":"keyword"}' \
		'{"field_name":"chunk_id","field_schema":"keyword"}' \
		'{"field_name":"chunk_index","field_schema":"integer"}' \
		'{"field_name":"published","field_schema":"bool"}' \
		'{"field_name":"is_deleted","field_schema":"bool"}' \
		'{"field_name":"schema_version","field_schema":"integer"}'; do \
		curl --fail --silent --show-error --max-time 10 \
			-X PUT "$(LOCAL_QDRANT_URL)/collections/$(QDRANT_COLLECTION)/index?wait=true" \
			-H 'Content-Type: application/json' -d "$$index" >/dev/null; \
	done; \
	echo "Rebuilt Qdrant collection $(QDRANT_COLLECTION): content + content_bm25, payload indexes on every filtered field."

status: ## Show the current local dependency and application health.
	@$(COMPOSE) ps
	@echo
	@curl --silent --show-error --max-time 10 http://127.0.0.1:8000/health || echo "API is not running yet."
	@echo

web-dev: ## Run the WebUI in development mode (HMR, unminified; editing only, never for benchmarks or shared use).
	@cd apps/web && bun run dev

web-build: ## Build the optimized production WebUI into apps/web/.next.
	@cd apps/web && bun run build

web-prod: web-build ## Build and serve the production WebUI on :3000 (what users and performance measurements use).
	@cd apps/web && bun run start
