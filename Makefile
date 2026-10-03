SHELL := /bin/bash
.DEFAULT_GOAL := help
.NOTPARALLEL:

COMPOSE_FILE := deployment/compose.yml
COMPOSE := docker compose -f $(COMPOSE_FILE)

LOCAL_DATABASE_URL ?= postgresql+asyncpg://bomesh:bomesh@127.0.0.1:5432/bomesh
LOCAL_QDRANT_URL ?= http://127.0.0.1:6333
LOCAL_S3_ENDPOINT ?= http://127.0.0.1:9000
LOCAL_S3_BUCKET ?= bomesh
LOCAL_TEMPORAL_TARGET ?= 127.0.0.1:7233
LOCAL_TEMPORAL_UI ?= http://127.0.0.1:8080
QDRANT_COLLECTION ?= bomesh
QDRANT_VECTOR_SIZE ?= 1536

DEV_TENANT_ID ?= 00000000-0000-0000-0000-000000000001
DEV_USER_ID ?= 00000000-0000-0000-0000-000000000002
DEV_TENANT_ADMIN_ASSIGNMENT_ID ?= 00000000-0000-0000-0000-000000000003
DEV_PLATFORM_ADMIN_ASSIGNMENT_ID ?= 00000000-0000-0000-0000-000000000004
DEV_TENANT_CODE ?= local
DEV_USER_EMAIL ?= local-admin@bomesh.dev
DEV_USER_IS_PLATFORM_ADMIN ?= true

FLUTTER ?= flutter
APP_DIR := app
APP_ENV ?= local
APP_ENV_FILE := $(APP_DIR)/env/$(APP_ENV).json
APP_PACKAGE_CONFIG := $(APP_DIR)/.dart_tool/package_config.json
DEVICE ?= chrome
WEB_PORT ?= 5174
MODE ?= debug
FLUTTER_RUN_FLAGS ?=
FLUTTER_RUN := $(FLUTTER) run --$(MODE) --no-pub --dart-define-from-file=env/$(APP_ENV).json $(FLUTTER_RUN_FLAGS)

.PHONY: help init reset-all config services _temporal-reset db-init db-seed db-seed-accounts qdrant-init status app-deps app-run app-web app-devices _app-env

help: ## Show available local-development commands.
	@echo "BoMesh local development"
	@echo
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

init: reset-all ## Initialize the complete local BoMesh environment.
	@echo
	@echo "BoMesh local environment is ready."
	@echo "  API:       http://127.0.0.1:8000"
	@echo "  Qdrant:    $(LOCAL_QDRANT_URL)/dashboard"
	@echo "  MinIO:     http://127.0.0.1:9001"
	@echo "  Temporal:  $(LOCAL_TEMPORAL_UI)"
	@echo "  Tenant ID: $(DEV_TENANT_ID)"
	@echo "  User ID:   $(DEV_USER_ID)"
	@echo
	@echo "Start the local services, API, and ingestion worker with: cd backend && uv run main.py"

reset-all: _temporal-reset db-reset db-seed-accounts qdrant-init status ## Reset all databases and Qdrant, apply the current design, and seed full-access test accounts.
	@echo "PostgreSQL, Temporal, and Qdrant reset is complete."

config: ## Create the root environment file and enforce local dependency endpoints.
	@set -euo pipefail
	@if [[ ! -f .env ]]; then cp backend/.env.example .env; fi
	@update_env() { \
		local file="$$1" key="$$2" value="$$3" temp_file; \
		temp_file="$$(mktemp)"; \
		awk -v key="$$key" -v value="$$value" 'BEGIN { found = 0 } $$0 ~ "^" key "=" { print key "=" value; found = 1; next } { print } END { if (!found) print key "=" value }' "$$file" > "$$temp_file"; \
		mv "$$temp_file" "$$file"; \
	}; \
	remove_env() { \
		local file="$$1" key="$$2" temp_file; \
		temp_file="$$(mktemp)"; \
		awk -v key="$$key" '$$0 !~ "^" key "=" { print }' "$$file" > "$$temp_file"; \
		mv "$$temp_file" "$$file"; \
	}; \
	rename_prefix() { \
		local file="$$1" old="$$2" new="$$3" temp_file; \
		temp_file="$$(mktemp)"; \
		awk -v old="$$old" -v new="$$new" 'index($$0, old) == 1 { $$0 = new substr($$0, length(old) + 1) } { print }' "$$file" > "$$temp_file"; \
		mv "$$temp_file" "$$file"; \
	}; \
	rename_prefix .env BOTHESIS_ BOMESH_; \
	rename_prefix .env NEXT_PUBLIC_BOTHESIS_ NEXT_PUBLIC_BOMESH_; \
	update_env .env DATABASE_URL "$(LOCAL_DATABASE_URL)"; \
	update_env .env QDRANT_URL "$(LOCAL_QDRANT_URL)"; \
	update_env .env QDRANT_COLLECTION "$(QDRANT_COLLECTION)"; \
	update_env .env QDRANT_API_KEY ""; \
	update_env .env BOMESH_TEMPORAL_TARGET "$(LOCAL_TEMPORAL_TARGET)"; \
	update_env .env BOMESH_TEMPORAL_NAMESPACE default; \
	update_env .env BOMESH_TEMPORAL_TLS false; \
	update_env .env BOMESH_OBJECT_STORAGE_PROVIDER aws_s3; \
	update_env .env BOMESH_OBJECT_STORAGE_BUCKET "$(LOCAL_S3_BUCKET)"; \
	update_env .env BOMESH_S3_ENDPOINT_URL "$(LOCAL_S3_ENDPOINT)"; \
	update_env .env BOMESH_S3_ADDRESSING_STYLE path; \
	update_env .env BOMESH_S3_REGION us-east-1; \
	update_env .env AWS_ACCESS_KEY_ID bomesh; \
	update_env .env AWS_SECRET_ACCESS_KEY bomesh-local; \
	integration_key="$$(sed -n 's/^BOMESH_INTEGRATION_ENCRYPTION_KEY=//p' .env | tail -n 1)"; \
	legacy_plugin_key="$$(sed -n 's/^BOMESH_PLUGIN_ENCRYPTION_KEY=//p' .env | tail -n 1)"; \
	legacy_connector_key="$$(sed -n 's/^BOMESH_CONNECTOR_ENCRYPTION_KEY=//p' .env | tail -n 1)"; \
	if [[ ! "$$integration_key" =~ ^[A-Za-z0-9_-]{43}=?$$ ]]; then \
		if [[ "$$legacy_plugin_key" =~ ^[A-Za-z0-9_-]{43}=?$$ ]]; then \
			integration_key="$$legacy_plugin_key"; \
		elif [[ "$$legacy_connector_key" =~ ^[A-Za-z0-9_-]{43}=?$$ ]]; then \
			integration_key="$$legacy_connector_key"; \
		else \
			integration_key="$$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n')"; \
		fi; \
		update_env .env BOMESH_INTEGRATION_ENCRYPTION_KEY "$$integration_key"; \
	fi; \
	remove_env .env BOMESH_PLUGIN_ENCRYPTION_KEY; \
	remove_env .env BOMESH_CONNECTOR_ENCRYPTION_KEY; \
	update_env .env BOMESH_ALLOW_INSECURE_DEV_IDENTITY true; \
	remove_env .env BOMESH_PUBLIC_TENANT_CODE; \
	remove_env .env BOMESH_GUEST_SESSION_EXPIRES_IN_SECONDS
	@echo "Configured the root environment file."

services: config ## Start PostgreSQL, Qdrant, object storage, and Temporal.
	@set -euo pipefail
	@$(COMPOSE) up -d postgres qdrant minio temporal temporal-admin-tools temporal-ui
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
	@for attempt in {1..30}; do \
		if curl --fail --silent --max-time 2 "$(LOCAL_S3_ENDPOINT)/minio/health/ready" >/dev/null; then break; fi; \
		if [[ $$attempt -eq 30 ]]; then echo "Object storage did not become ready." >&2; exit 1; fi; \
		sleep 1; \
	done
	@$(COMPOSE) run --rm minio-init >/dev/null
	@$(COMPOSE) run --rm temporal-init >/dev/null
	@echo "PostgreSQL, Qdrant, object storage, and Temporal are accepting connections."

_temporal-reset: services
	@set -euo pipefail
	@$(COMPOSE) stop temporal-ui temporal-admin-tools temporal >/dev/null
	@$(COMPOSE) exec -T postgres sh -c 'for database in temporal temporal_visibility; do psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$$database\" WITH (FORCE);"; done' >/dev/null
	@$(COMPOSE) up -d temporal temporal-admin-tools temporal-ui >/dev/null
	@$(COMPOSE) run --rm temporal-init >/dev/null
	@echo "Temporal persistence is reset."

db-init: services ## Apply the current database design and the permission/system-role catalogs.
	@set -euo pipefail
	@$(COMPOSE) exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"' >/dev/null
	@cd backend && DATABASE_URL="$(LOCAL_DATABASE_URL)" uv run python -c 'import asyncio; from bomesh.db.engine import get_engine, get_session_factory; from bomesh.db.models import Base; from bomesh.services.identity_access.identity_store import IdentityStoreService; exec("async def initialize():\n    engine = get_engine()\n    async with engine.begin() as connection:\n        await connection.run_sync(Base.metadata.create_all)\n    async with get_session_factory()() as session:\n        async with session.begin():\n            await IdentityStoreService(session).sync_system_roles()\n    await engine.dispose()") ; asyncio.run(initialize())'
	@echo "PostgreSQL schema, permissions, and system roles are initialized."

db-seed: services ## Create or refresh the deterministic local admin identity.
	@set -euo pipefail
	@tenant_id="$$( $(COMPOSE) exec -T postgres sh -c 'psql -Atq -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "$$1"' _ "INSERT INTO tenants (id, code, name, status, settings) VALUES ('$(DEV_TENANT_ID)', '$(DEV_TENANT_CODE)', 'BoMesh Local', 'active', '{}'::jsonb) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = now() RETURNING id" )"; \
	user_id="$$( $(COMPOSE) exec -T postgres sh -c 'psql -Atq -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "$$1"' _ "INSERT INTO users (id, email, display_name, status, preferences) VALUES ('$(DEV_USER_ID)', '$(DEV_USER_EMAIL)', 'Local Administrator', true, '{}'::jsonb) ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name, status = true, updated_at = now() RETURNING id" )"; \
	$(COMPOSE) exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "$$1"' _ "INSERT INTO tenant_memberships (user_id, tenant_id, status, joined_at, deleted_at) VALUES ('$$user_id', '$$tenant_id', 'active', now(), NULL) ON CONFLICT (user_id, tenant_id) DO UPDATE SET status = 'active', deleted_at = NULL" >/dev/null; \
	$(COMPOSE) exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "$$1"' _ "INSERT INTO role_assignments (id, user_id, role_id, tenant_id) SELECT '$(DEV_TENANT_ADMIN_ASSIGNMENT_ID)', '$$user_id', role.id, '$$tenant_id' FROM roles role WHERE role.is_system AND role.code = 'tenant_admin' ON CONFLICT DO NOTHING" >/dev/null; \
	if [[ "$(DEV_USER_IS_PLATFORM_ADMIN)" == "true" ]]; then \
		$(COMPOSE) exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "$$1"' _ "INSERT INTO role_assignments (id, user_id, role_id) SELECT '$(DEV_PLATFORM_ADMIN_ASSIGNMENT_ID)', '$$user_id', role.id FROM roles role WHERE role.is_system AND role.code = 'platform_admin' ON CONFLICT DO NOTHING" >/dev/null; \
	fi; \
	echo "Local admin identity is ready: $$user_id"

db-reset: db-init db-seed ## Rebuild PostgreSQL from the current ORM and reseed the local admin identity.
	@echo "PostgreSQL reset is complete."

db-seed-accounts: db-reset ## Seed three full-access local test accounts.
	@set -euo pipefail
	@cd backend && DATABASE_URL="$(LOCAL_DATABASE_URL)" uv run python script/seed_account.py

qdrant-init: services ## Rebuild the derived contextual-hybrid Qdrant collection.
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
	echo "Rebuilt Qdrant collection $(QDRANT_COLLECTION) with content + content_bm25."

status: ## Show the current local dependency and application health.
	@$(COMPOSE) ps
	@echo
	@curl --silent --show-error --max-time 10 http://127.0.0.1:8000/health || echo "API is not running yet."
	@echo

app-deps: $(APP_PACKAGE_CONFIG) ## Run flutter pub get only when pubspec.yaml/pubspec.lock changed.

$(APP_PACKAGE_CONFIG): $(APP_DIR)/pubspec.yaml $(APP_DIR)/pubspec.lock
	@cd $(APP_DIR) && $(FLUTTER) pub get
	@touch $@

_app-env:
	@if [[ ! -f "$(APP_ENV_FILE)" ]]; then echo "Missing $(APP_ENV_FILE); create it or pass APP_ENV=<name>." >&2; exit 1; fi
	@if [[ ! "$(MODE)" =~ ^(debug|profile|release)$$ ]]; then echo "MODE must be debug, profile, or release (got: $(MODE))." >&2; exit 1; fi

app-run: app-deps _app-env ## Run Flutter on DEVICE=<id> (default chrome) in MODE=debug|profile|release with app/env/<APP_ENV>.json.
	@cd $(APP_DIR) && $(FLUTTER_RUN) -d "$(DEVICE)"

app-web: app-deps _app-env ## Serve Flutter web on 127.0.0.1:<WEB_PORT> (default 5174) with app/env/<APP_ENV>.json.
	@cd $(APP_DIR) && $(FLUTTER_RUN) -d web-server --web-hostname=127.0.0.1 --web-port=$(WEB_PORT)

app-devices: ## List Flutter devices and their ids for DEVICE=<id>.
	@$(FLUTTER) devices
