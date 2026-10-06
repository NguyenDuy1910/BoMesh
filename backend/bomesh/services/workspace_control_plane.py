"""Transactional application service for workspace and platform resources."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.document_index import ItemIndex
from bomesh.services import (
    COLLECTION_SHARE_PERMISSION,
    ControlPlaneConflictError,
    AuthContext,
)
from bomesh.services.approval_request import ApprovalRequestService
from bomesh.services.audit import AuditService
from bomesh.services.dashboard.activity import ActivityService
from bomesh.services.dashboard.dashboard import DashboardService
from bomesh.services.identity_access.access_session import AccessSessionService
from bomesh.services.identity_access.authorization import AuthorizationService
from bomesh.services.identity_access.role_assignments import RoleAssignmentService
from bomesh.services.identity_access.groups import GroupService
from bomesh.services.identity_access.roles import RoleService
from bomesh.services.identity_access.tenants import TenantService
from bomesh.services.identity_access.users import UserService
from bomesh.services.item_catalog import ItemCatalogService
from bomesh.services.item_ingestion import ItemIngestionService
from config import VectorIndexConfig


class WorkspaceControlPlaneService:
    """Own workspace-control transactions and delegate to focused services."""

    def __init__(
        self,
        session_factory: SessionFactory,
        *,
        vector_index: VectorIndexConfig,
        processing_version: str | None,
    ) -> None:
        self._sessions = session_factory
        self._vector_index = vector_index
        self._processing_version = processing_version

    # -- Tenants ------------------------------------------------------------

    async def workspace_overview(
        self, actor: AuthContext, *, tz: str = "UTC"
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await DashboardService(
                session, processing_version=self._processing_version
            ).overview(actor, tz=tz)

    async def workspace_activity(
        self, actor: AuthContext, workspace_id: UUID, **filters: Any
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await ActivityService(session).workspace_activity(
                actor, workspace_id, **filters
            )

    async def platform_overview(self, actor: AuthContext) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await DashboardService(session).platform_overview(actor)

    async def list_platform_workspaces(
        self, actor: AuthContext, **filters: Any
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await DashboardService(session).list_platform_workspaces(
                actor, **filters
            )

    async def list_workspaces(self, actor: AuthContext) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await TenantService(session).list_tenants(actor)

    async def get_workspace(self, actor: AuthContext, workspace_id: UUID) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await TenantService(session).get_tenant(actor, workspace_id)

    async def update_workspace(
        self, actor: AuthContext, workspace_id: UUID, changes: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await TenantService(session).update_tenant(
                actor, workspace_id, **changes
            )

    # -- Users, roles, groups ----------------------------------------------

    async def list_users(self, actor: AuthContext, **filters: Any) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await UserService(session).list_users(actor, **filters)

    async def list_platform_users(
        self, actor: AuthContext, **filters: Any
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await UserService(session).list_platform_users(actor, **filters)

    async def lookup_account(self, actor: AuthContext, email: str) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await UserService(session).lookup_account(actor, email=email)

    async def add_member(
        self, actor: AuthContext, values: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await UserService(session).add_member(actor, **values)

    async def get_user(self, actor: AuthContext, user_id: UUID) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await UserService(session).get_user(actor, user_id)

    async def update_user(
        self, actor: AuthContext, user_id: UUID, changes: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await UserService(session).update_user(actor, user_id, **changes)

    async def list_permissions(self, actor: AuthContext) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await RoleService(session).list_permissions(actor)

    async def list_roles(self, actor: AuthContext, **filters: Any) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await RoleService(session).list_roles(actor, **filters)

    async def create_role(
        self, actor: AuthContext, values: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await RoleService(session).create_role(actor, **values)

    async def get_role(self, actor: AuthContext, role_id: UUID) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await RoleService(session).get_role(actor, role_id)

    async def update_role(
        self, actor: AuthContext, role_id: UUID, changes: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await RoleService(session).update_role(actor, role_id, **changes)

    async def disable_role(self, actor: AuthContext, role_id: UUID) -> None:
        async with self._unit_of_work() as session:
            await RoleService(session).disable_role(actor, role_id)

    async def list_groups(self, actor: AuthContext, **filters: Any) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await GroupService(session).list_groups(actor, **filters)

    async def create_group(
        self, actor: AuthContext, values: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await GroupService(session).create_group(actor, **values)

    async def get_group(self, actor: AuthContext, group_id: UUID) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await GroupService(session).get_group(actor, group_id)

    async def update_group(
        self, actor: AuthContext, group_id: UUID, changes: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await GroupService(session).update_group(
                actor,
                group_id,
                description_provided="description" in changes,
                **changes,
            )

    async def replace_group_members(
        self, actor: AuthContext, group_id: UUID, user_ids: list[UUID]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await GroupService(session).replace_members(
                actor, group_id, user_ids
            )

    async def delete_group(self, actor: AuthContext, group_id: UUID) -> None:
        async with self._unit_of_work() as session:
            await GroupService(session).delete_group(actor, group_id)

    # -- Items and Collections ---------------------------------------------

    async def list_items(self, actor: AuthContext, **filters: Any) -> dict[str, Any]:
        async with self._catalog() as (session, service):
            del session
            return await service.list_items(actor, **filters)

    async def list_collections(self, actor: AuthContext, **filters: Any) -> dict[str, Any]:
        async with self._catalog() as (session, service):
            del session
            result = await service.list_collections(actor, **filters)
        return {
            **result,
            "items": [self._collection_payload(item) for item in result.get("items", [])],
        }

    async def create_collection(
        self, actor: AuthContext, values: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._catalog() as (session, service):
            del session
            return await service.create_collection(actor, **values)

    async def create_collection_contract(self, actor: AuthContext, values: dict[str, Any]) -> dict[str, Any]:
        return self._collection_payload(await self.create_collection(actor, values))

    async def get_item(self, actor: AuthContext, item_id: UUID) -> dict[str, Any]:
        async with self._catalog() as (session, service):
            del session
            return await service.get_item(actor, item_id)

    async def get_collection(self, actor: AuthContext, collection_id: UUID) -> dict[str, Any]:
        async with self._catalog() as (session, service):
            del session
            return self._collection_payload(await service.get_collection(actor, collection_id))

    async def update_collection(
        self, actor: AuthContext, item_id: UUID, changes: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._catalog() as (session, service):
            del session
            return await service.update_collection(
                actor,
                item_id,
                title=changes.get("title"),
                description=changes.get("description"),
                description_provided="description" in changes,
            )

    async def update_collection_contract(self, actor: AuthContext, collection_id: UUID, changes: dict[str, Any]) -> dict[str, Any]:
        return self._collection_payload(await self.update_collection(actor, collection_id, changes))

    async def delete_collection(self, actor: AuthContext, collection_id: UUID) -> None:
        async with self._catalog() as (session, service):
            del session
            await service.delete_collection(actor, collection_id)

    async def update_item(
        self, actor: AuthContext, item_id: UUID, status: str
    ) -> dict[str, Any]:
        async with self._catalog() as (session, service):
            del session
            return await service.update_status(actor, item_id, status=status)

    async def delete_item(self, actor: AuthContext, item_id: UUID) -> None:
        async with self._catalog() as (session, service):
            del session
            await service.delete_item(actor, item_id)

    # -- Collection access --------------------------------------------------

    @staticmethod
    async def _require_share(
        session: AsyncSession, actor: AuthContext, item_id: UUID
    ) -> None:
        """Only someone who may share this Collection may read or change who can."""

        await AuthorizationService(session).require_item(
            item_id, access=actor, permission=COLLECTION_SHARE_PERMISSION
        )

    async def list_collection_access(
        self, actor: AuthContext, item_id: UUID, **filters: Any
    ) -> dict[str, object]:
        async with self._unit_of_work() as session:
            await self._require_share(session, actor, item_id)
            return await RoleAssignmentService(session).list_collection_grants(
                item_id, **filters
            )

    async def grant_collection_access(
        self, actor: AuthContext, item_id: UUID, values: dict[str, Any]
    ) -> dict[str, object]:
        async with self._unit_of_work() as session:
            await self._require_share(session, actor, item_id)
            assignments = RoleAssignmentService(session)
            grant, role = await assignments.grant_collection_role(
                item_id, created_by_user_id=actor.user_id, **values
            )
            await AuditService(session).record(
                actor,
                action="collection.access.granted",
                resource_type="collection",
                resource_id=str(item_id),
                details={
                    "principal_type": grant.principal_type,
                    "principal_id": str(grant.principal_id),
                    "role_code": role.code,
                },
            )
            return assignments.grant_payload(grant, role)

    async def revoke_collection_access(
        self,
        actor: AuthContext,
        item_id: UUID,
        *,
        principal_type: str,
        principal_id: UUID,
    ) -> None:
        async with self._unit_of_work() as session:
            await self._require_share(session, actor, item_id)
            await RoleAssignmentService(session).revoke_collection_role(
                item_id,
                principal_type=principal_type,
                principal_id=principal_id,
            )
            await AuditService(session).record(
                actor,
                action="collection.access.revoked",
                resource_type="collection",
                resource_id=str(item_id),
                details={
                    "principal_type": principal_type,
                    "principal_id": str(principal_id),
                },
            )

    # -- Approval requests and audit ---------------------------------------

    async def list_approval_requests(
        self, actor: AuthContext, **filters: Any
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await ApprovalRequestService(session).list_requests(actor, **filters)

    async def create_approval_request(
        self, actor: AuthContext, values: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await ApprovalRequestService(session).create_request(actor, **values)

    async def get_approval_request(
        self, actor: AuthContext, request_id: UUID
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await ApprovalRequestService(session).get_request(actor, request_id)

    async def update_approval_request(
        self, actor: AuthContext, request_id: UUID, values: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await ApprovalRequestService(session).update_request(
                actor, request_id, **values
            )

    async def list_audit_logs(
        self, actor: AuthContext, **filters: Any
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await AuditService(session).list_events(actor, **filters)

    async def list_platform_audit_logs(
        self, actor: AuthContext, **filters: Any
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await AuditService(session).list_platform_events(actor, **filters)

    async def list_access_sessions(
        self, actor: AuthContext, **filters: Any
    ) -> dict[str, Any]:
        async with self._unit_of_work() as session:
            return await AccessSessionService(session).list_sessions(actor, **filters)

    # -- Internals ----------------------------------------------------------

    @asynccontextmanager
    async def _unit_of_work(self) -> AsyncIterator[AsyncSession]:
        """Commit one control-plane change, reporting write conflicts."""

        try:
            async with transaction_scope(self._sessions) as session:
                yield session
        except IntegrityError as exc:
            raise ControlPlaneConflictError(
                "the requested change conflicts with durable state"
            ) from exc

    @asynccontextmanager
    async def _catalog(
        self,
    ) -> AsyncIterator[tuple[AsyncSession, ItemCatalogService]]:
        """Open a unit of work with an Item catalog bound to its own index."""

        index = ItemIndex(
            collection_name=self._vector_index.collection,
            url=self._vector_index.url,
            api_key=self._vector_index.api_key,
            timeout=self._vector_index.timeout_seconds,
        )
        try:
            async with self._unit_of_work() as session:
                yield session, ItemCatalogService(
                    session,
                    ingestion_service=ItemIngestionService(
                        self._sessions, index=index
                    ),
                )
        finally:
            await index.aclose()

    @staticmethod
    def _collection_payload(item: dict[str, Any]) -> dict[str, Any]:
        metadata = item.get("metadata") or {}
        return {
            "id": item["id"],
            "title": item.get("title", ""),
            "description": metadata.get("description"),
            "parent_collection_id": item.get("parent_item_id"),
            "status": "archived" if item.get("status") in {"archived", "deleted"} else "active",
            "document_count": item.get("item_count", 0),
            "source_count": item.get("source_count", 0),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
            "permissions": item.get("permissions", []),
        }


__all__ = ["WorkspaceControlPlaneService"]
