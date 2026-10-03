"""BoMesh HTTP application: assemble routers, errors, and the runtime."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.deps import get_runtime
from api.errors import register_error_handlers
from api.authentication import JwtAuthenticationMiddleware
from api.routers import (
    agent,
    auth,
    artifacts,
    collections,
    connections,
    documents,
    governance,
    health,
    iam,
    ingestions,
    knowledge,
    platform,
    sources,
    workspaces,
)

API_PREFIX = "/api/v1"

_CONTRACT_METADATA: dict[tuple[str, str], dict[str, Any]] = {
    ("post", "/api/v1/agent/chat"): {"x-required-permissions": ["knowledge.read"]},
    ("get", "/api/v1/knowledge/home"): {"x-required-permissions": ["knowledge.read"]},
    ("get", "/api/v1/collections"): {"x-required-collection-permission": "collection.read"},
    ("post", "/api/v1/collections"): {
        "x-required-permissions": ["item.manage"],
        "x-authorization-rule": "A child also requires collection.update on its parent Collection.",
    },
    ("get", "/api/v1/collections/{collection_id}"): {"x-required-collection-permission": "collection.read"},
    ("patch", "/api/v1/collections/{collection_id}"): {"x-required-collection-permission": "collection.update"},
    ("delete", "/api/v1/collections/{collection_id}"): {"x-required-collection-permission": "collection.delete"},
    ("put", "/api/v1/collections/personal"): {
        "x-required-permissions": ["knowledge.read"],
        "x-authorization-rule": "Signed-in user; the Collection is owned by the caller.",
    },
    ("get", "/api/v1/collections/{collection_id}/access"): {"x-required-collection-permission": "collection.share"},
    ("put", "/api/v1/collections/{collection_id}/access/{principal_type}/{principal_id}"): {"x-required-collection-permission": "collection.share"},
    ("delete", "/api/v1/collections/{collection_id}/access/{principal_type}/{principal_id}"): {"x-required-collection-permission": "collection.share"},
    ("post", "/api/v1/collections/{collection_id}/documents"): {
        "tags": ["documents"],
        "x-required-collection-permission": "collection.update",
        "x-required-collection-role": "editor",
    },
    ("get", "/api/v1/documents"): {
        "x-required-collection-permission": "collection.read",
        "x-required-collection-role": "viewer",
    },
    ("post", "/api/v1/documents/search"): {
        "x-required-permissions": ["knowledge.read"],
        "x-required-collection-permission": "collection.read",
        "x-required-collection-role": "viewer",
    },
    ("get", "/api/v1/documents/{document_id}"): {
        "x-required-collection-permission": "collection.read",
        "x-required-collection-role": "viewer",
    },
    ("delete", "/api/v1/documents/{document_id}"): {
        "x-required-collection-permission": "collection.update",
        "x-authorization-rule": "Signed-in user; conversation_attachment deletion also requires upload ownership.",
        "x-required-collection-role": "editor",
    },
    ("put", "/api/v1/documents/{document_id}/content"): {
        "x-required-collection-permission": "collection.update",
        "x-required-collection-role": "editor",
    },
    ("post", "/api/v1/connections"): {
        "x-authorization-rule": "Personal connections belong to the caller; workspace-owned connections require source.manage.",
    },
    ("post", "/api/v1/connections/{connection_id}/sources"): {"tags": ["sources"]},
    ("post", "/api/v1/sources/{source_id}/ingestions"): {"tags": ["ingestions"]},
    ("get", "/api/v1/sources/{source_id}/ingestions"): {"tags": ["ingestions"]},
    ("get", "/api/v1/sources/{source_id}/ingestions/{ingestion_id}"): {"tags": ["ingestions"]},
    ("patch", "/api/v1/workspaces/{workspace_id}"): {"x-required-permissions": ["tenant.manage"]},
    ("get", "/api/v1/workspaces/{workspace_id}/overview"): {
        "x-required-permissions": ["tenant.read"],
        "x-authorization-rule": "recent_activity is empty without audit.read.",
    },
    ("get", "/api/v1/users"): {"x-required-permissions": ["user.manage"]},
    ("post", "/api/v1/users"): {"x-required-permissions": ["user.manage"]},
    ("get", "/api/v1/accounts"): {"x-required-permissions": ["user.manage"]},
    ("get", "/api/v1/users/{user_id}"): {"x-required-permissions": ["user.manage"]},
    ("patch", "/api/v1/users/{user_id}"): {"x-required-permissions": ["user.manage"]},
    ("get", "/api/v1/roles"): {"x-required-permissions": ["role.manage"]},
    ("post", "/api/v1/roles"): {"x-required-permissions": ["role.manage"]},
    ("get", "/api/v1/roles/{role_id}"): {"x-required-permissions": ["role.manage"]},
    ("patch", "/api/v1/roles/{role_id}"): {"x-required-permissions": ["role.manage"]},
    ("get", "/api/v1/groups"): {"x-required-permissions": ["group.manage"]},
    ("post", "/api/v1/groups"): {"x-required-permissions": ["group.manage"]},
    ("get", "/api/v1/groups/{group_id}"): {"x-required-permissions": ["group.manage"]},
    ("patch", "/api/v1/groups/{group_id}"): {"x-required-permissions": ["group.manage"]},
    ("delete", "/api/v1/groups/{group_id}"): {"x-required-permissions": ["group.manage"]},
    ("put", "/api/v1/groups/{group_id}/members"): {"x-required-permissions": ["group.manage"]},
    ("get", "/api/v1/permissions"): {"x-required-permissions": ["role.manage"]},
    ("post", "/api/v1/approval-requests"): {
        "x-authorization-rule": "Own resource_access request; plugin_installation creation requires source.manage.",
    },
    ("get", "/api/v1/approval-requests"): {
        "x-authorization-rule": "Own requests, or reviewable types: access.manage for resource_access, source.manage for plugin_installation.",
    },
    ("get", "/api/v1/approval-requests/{approval_request_id}"): {
        "x-authorization-rule": "Own request, or reviewer permission: access.manage for resource_access, source.manage for plugin_installation.",
    },
    ("patch", "/api/v1/approval-requests/{approval_request_id}"): {
        "x-authorization-rule": "Pending only. Requester may cancel; approve/deny requires access.manage for resource_access or source.manage for plugin_installation. Reviewers may also cancel.",
    },
    ("get", "/api/v1/audit-logs"): {"x-required-permissions": ["audit.read"]},
    ("get", "/api/v1/platform/overview"): {"x-required-permissions": ["platform.tenant.read"]},
    ("get", "/api/v1/platform/workspaces"): {"x-required-permissions": ["platform.tenant.read"]},
    ("get", "/api/v1/platform/users"): {"x-required-permissions": ["platform.user.read"]},
    ("get", "/api/v1/platform/audit-logs"): {"x-required-permissions": ["platform.audit.read"]},
    ("get", "/api/v1/platform/health"): {"x-required-permissions": ["platform.health.read"]},
}


def _operation_id(route) -> str:
    """Use contract operation names instead of FastAPI's path-derived IDs."""
    name = route.name.removesuffix("_contract")
    if name == "health":
        return "getHealth"
    parts = name.split("_")
    return parts[0] + "".join(part.title() for part in parts[1:])

_ROUTERS = (
    agent.router,
    knowledge.router,
    collections.router,
    documents.collections_router,
    documents.router,
    artifacts.router,
    connections.router,
    sources.router,
    ingestions.router,
    workspaces.router,
    iam.router,
    governance.router,
    platform.router,
)


log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Resume interrupted direct ingestions; close every client at shutdown."""

    resuming = asyncio.create_task(_resume_direct_ingestions())
    try:
        yield
    finally:
        resuming.cancel()
        with suppress(asyncio.CancelledError):
            await resuming
        await get_runtime().aclose()


async def _resume_direct_ingestions() -> None:
    # Startup must not wait for, or fail on, the database.
    try:
        resumed = await get_runtime().document_service().resume_direct_ingestions()
    except Exception:  # noqa: BLE001 - best effort; a later retry recovers the rest
        log.warning("direct ingestions could not be resumed", exc_info=True)
        return
    if resumed:
        log.info("resumed %d interrupted direct ingestions", resumed)


def create_app() -> FastAPI:
    """Build the application; one call per process, or one per test."""

    app = FastAPI(
        title="BoMesh API",
        version="0.1.0",
        description="Enterprise knowledge and BI assistant.",
        lifespan=lifespan,
        generate_unique_id_function=_operation_id,
    )
    app.state.allow_insecure_development_identity = (
        get_runtime().config.identity.allow_insecure_development_identity
    )
    register_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # tighten per environment
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(
        JwtAuthenticationMiddleware,
        tokens=get_runtime().jwt_token_service(),
    )
    for router in _ROUTERS:
        app.include_router(router, prefix=API_PREFIX)
    app.include_router(auth.router, prefix=API_PREFIX)
    app.include_router(health.router)
    _apply_contract_security(app)
    return app


def _apply_contract_security(app: FastAPI) -> None:
    """Add contract-level bearer metadata without changing middleware behavior."""

    original_openapi = app.openapi

    def openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = original_openapi()
        schema.setdefault("components", {}).setdefault("securitySchemes", {})[
            "bearerAuth"
        ] = {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
        }
        schema["security"] = [{"bearerAuth": []}]
        paths = schema["paths"]
        for path in ("/api/v1/auth/accounts", "/api/v1/auth/sessions", "/health"):
            for operation in paths.get(path, {}).values():
                if isinstance(operation, dict) and "operationId" in operation:
                    operation["security"] = []
        for (method, path), metadata in _CONTRACT_METADATA.items():
            operation = paths.get(path, {}).get(method)
            if operation is not None:
                operation.update(metadata)
        app.openapi_schema = schema
        return schema

    app.openapi = openapi


app = create_app()

__all__ = ["API_PREFIX", "app", "create_app", "lifespan"]
