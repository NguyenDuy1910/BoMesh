"""FastAPI dependency providers: one runtime, one identity, ready services."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request

from bomesh.db.engine import transaction_scope
from bomesh.health import HealthService
from bomesh.runtime import AppRuntime
from bomesh.services import AuthenticationError, AuthContext, AuthorizationError, JwtClaims
from bomesh.services.workspace_control_plane import WorkspaceControlPlaneService
from bomesh.services.integration_lifecycle import IntegrationLifecycleService
from bomesh.services.ingestion import IngestionRunService
from bomesh.services.artifact import ArtifactService
from bomesh.services.chat import ChatService
from bomesh.services.knowledge_query import KnowledgeQueryService
from bomesh.services.knowledge_view import KnowledgeViewService
from bomesh.services.documents import DocumentService

from api.identity import RequestIdentity, resolve_auth_context
from api.routers import ChatRequest


@lru_cache(maxsize=1)
def get_runtime() -> AppRuntime:
    """Return the process-wide composition root."""

    return AppRuntime()


def get_request_identity(request: Request) -> RequestIdentity:
    """Read the identity the authentication middleware placed on the request."""

    return RequestIdentity(
        auth_context=getattr(request.state, "auth_context", None),
        token_claims=getattr(request.state, "jwt_claims", None),
        user_id=request.headers.get("X-Bomesh-User-Id"),
        tenant_id=request.headers.get("X-Bomesh-Tenant-Id"),
    )


async def get_auth_context(
    identity: Annotated[RequestIdentity, Depends(get_request_identity)],
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> AuthContext:
    """Resolve the trusted caller before any service sees the request."""

    async with transaction_scope(runtime.sessions()) as session:
        return await resolve_auth_context(
            identity,
            session,
            allow_insecure_development_identity=(
                runtime.config.identity.allow_insecure_development_identity
            ),
        )


async def get_chat_auth_context(
    body: ChatRequest,
    identity: Annotated[RequestIdentity, Depends(get_request_identity)],
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> AuthContext:
    """Resolve the caller and reject a chat body that claims another tenant."""

    async with transaction_scope(runtime.sessions()) as session:
        return await resolve_auth_context(
            identity,
            session,
            allow_insecure_development_identity=(
                runtime.config.identity.allow_insecure_development_identity
            ),
        )


def get_token_claims(request: Request) -> JwtClaims:
    """Return the verified bearer claims required by token-only auth routes."""

    claims = getattr(request.state, "jwt_claims", None)
    if not isinstance(claims, JwtClaims):
        raise AuthenticationError("a valid bearer access token is required")
    return claims


def require_permission(permission_code: str):
    """Create a dependency that checks a signed active-tenant permission claim."""

    async def check(
        claims: Annotated[JwtClaims, Depends(get_token_claims)],
        context: Annotated[AuthContext, Depends(get_auth_context)],
    ) -> AuthContext:
        if not claims.has_permission(permission_code) or not context.has_permissions(
            permission_code
        ):
            raise AuthorizationError(f"missing required permissions: {permission_code}")
        return context

    return check


def get_chat_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> ChatService:
    return runtime.chat_service()


def get_knowledge_query_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> KnowledgeQueryService:
    return runtime.knowledge_query_service()


def get_knowledge_view_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> KnowledgeViewService:
    return runtime.knowledge_view_service()


def get_document_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> DocumentService:
    return runtime.document_service()


def get_workspace_control_plane_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> WorkspaceControlPlaneService:
    return runtime.workspace_control_plane_service()


def get_integration_lifecycle_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> IntegrationLifecycleService:
    return runtime.integration_lifecycle_service()


def get_ingestion_run_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> IngestionRunService:
    return runtime.ingestion_run_service()


def get_artifact_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> ArtifactService:
    return runtime.artifact_service()


def get_health_service(
    runtime: Annotated[AppRuntime, Depends(get_runtime)],
) -> HealthService:
    return runtime.health_service()


Runtime = Annotated[AppRuntime, Depends(get_runtime)]
TokenClaims = Annotated[JwtClaims, Depends(get_token_claims)]
Caller = Annotated[AuthContext, Depends(get_auth_context)]
ChatCaller = Annotated[AuthContext, Depends(get_chat_auth_context)]
Chat = Annotated[ChatService, Depends(get_chat_service)]
KnowledgeQuery = Annotated[KnowledgeQueryService, Depends(get_knowledge_query_service)]
KnowledgeView = Annotated[KnowledgeViewService, Depends(get_knowledge_view_service)]
Documents = Annotated[DocumentService, Depends(get_document_service)]
WorkspaceControlPlane = Annotated[WorkspaceControlPlaneService, Depends(get_workspace_control_plane_service)]
ConnectionLifecycle = Annotated[
    IntegrationLifecycleService, Depends(get_integration_lifecycle_service)
]
IngestionRuns = Annotated[IngestionRunService, Depends(get_ingestion_run_service)]
Artifacts = Annotated[ArtifactService, Depends(get_artifact_service)]
Health = Annotated[HealthService, Depends(get_health_service)]

__all__ = [
    "WorkspaceControlPlane",
    "Artifacts",
    "Caller",
    "Chat",
    "ChatCaller",
    "Documents",
    "Health",
    "ConnectionLifecycle",
    "IngestionRuns",
    "KnowledgeQuery",
    "KnowledgeView",
    "Runtime",
    "TokenClaims",
    "get_artifact_service",
    "get_auth_context",
    "get_chat_auth_context",
    "get_integration_lifecycle_service",
    "get_request_identity",
    "get_runtime",
    "get_token_claims",
    "require_permission",
]
