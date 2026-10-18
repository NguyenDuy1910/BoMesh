"""Persist recovery metadata for conversation sandboxes."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from bomesh.db.engine import transaction_scope
from bomesh.db.models import Conversation, SandboxSession
from bomesh.services import (
    AuthContext,
    DocumentNotFoundError,
    SandboxManifestResource,
    SandboxMaterializedFile,
    SandboxSessionState,
    conversation_access_filter,
    require_user_identity,
)


class SandboxSessionService:
    """Own durable sandbox identity, recovery manifest, and container binding.

    This service deliberately does not create a container or transfer file
    bytes. Those are sandbox-provider operations. It records only enough
    metadata to reuse the conversation's container or rebuild a new one from
    durable Item resources after the old container has gone.
    """

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory

    async def active(
        self,
        access: AuthContext,
        *,
        conversation_id: UUID,
        provider: str,
    ) -> SandboxSessionState | None:
        """Return the caller's current sandbox binding, without creating one."""

        user_id = require_user_identity(access)
        tenant_id = _tenant_id(access)
        normalized_provider = _provider(provider)
        async with transaction_scope(self._sessions) as session:
            await _conversation(session, access, conversation_id)
            row = await session.scalar(
                select(SandboxSession).where(
                    SandboxSession.conversation_id == conversation_id,
                    SandboxSession.tenant_id == tenant_id,
                    SandboxSession.user_id == user_id,
                    SandboxSession.provider == normalized_provider,
                    SandboxSession.status == "active",
                    SandboxSession.deleted_at.is_(None),
                )
                .order_by(SandboxSession.updated_at.desc())
                .limit(1)
            )
        return _state(row) if row is not None else None

    async def recoverable(
        self,
        access: AuthContext,
        *,
        conversation_id: UUID,
        provider: str,
    ) -> SandboxSessionState | None:
        """Return the newest expired manifest after rechecking conversation access."""

        user_id = require_user_identity(access)
        tenant_id = _tenant_id(access)
        normalized_provider = _provider(provider)
        async with transaction_scope(self._sessions) as session:
            await _conversation(session, access, conversation_id)
            row = await session.scalar(
                select(SandboxSession)
                .where(
                    SandboxSession.conversation_id == conversation_id,
                    SandboxSession.tenant_id == tenant_id,
                    SandboxSession.user_id == user_id,
                    SandboxSession.provider == normalized_provider,
                    SandboxSession.status == "expired",
                    SandboxSession.deleted_at.is_(None),
                )
                .order_by(SandboxSession.updated_at.desc())
                .limit(1)
            )
        return _state(row) if row is not None else None

    async def ensure(
        self,
        access: AuthContext,
        *,
        conversation_id: UUID,
        provider: str,
    ) -> SandboxSessionState:
        """Return or lazily create the sole active sandbox for this provider."""

        user_id = require_user_identity(access)
        tenant_id = _tenant_id(access)
        normalized_provider = _provider(provider)
        async with transaction_scope(self._sessions) as session:
            await _conversation(session, access, conversation_id, lock=True)
            row = await session.scalar(
                select(SandboxSession)
                .where(
                    SandboxSession.conversation_id == conversation_id,
                    SandboxSession.tenant_id == tenant_id,
                    SandboxSession.user_id == user_id,
                    SandboxSession.provider == normalized_provider,
                    SandboxSession.status == "active",
                    SandboxSession.deleted_at.is_(None),
                )
                .with_for_update()
            )
            if row is None:
                row = SandboxSession(
                    tenant_id=tenant_id,
                    conversation_id=conversation_id,
                    user_id=user_id,
                    provider=normalized_provider,
                    manifest={"resources": []},
                    provider_state={"materialized_files": []},
                    last_used_at=datetime.now(UTC),
                )
                session.add(row)
                await session.flush()
            else:
                row.last_used_at = datetime.now(UTC)
                await session.flush()
            return _state(row)

    async def bind_container(
        self,
        access: AuthContext,
        *,
        session_id: UUID,
        container_id: str,
        replaces: str | None,
    ) -> SandboxSessionState:
        """Bind a freshly claimed, empty container to the session.

        The bind only succeeds while the session is still bound to
        ``replaces``; a concurrent request that bound another container first
        wins, and the caller sees that binding in the returned state. A new
        container starts empty, so the materialized-file list is reset.
        """

        normalized_container = _identifier(container_id, "sandbox container")
        async with transaction_scope(self._sessions) as session:
            row = await _active_session(session, access, session_id)
            current = _state(row)
            if current.container_id == replaces:
                row.provider_state = _provider_state(
                    container_id=normalized_container, materialized_files=()
                )
                row.last_used_at = datetime.now(UTC)
                await session.flush()
            return _state(row)

    async def record_materialization(
        self,
        access: AuthContext,
        *,
        session_id: UUID,
        container_id: str,
        resource: SandboxManifestResource,
        files: Sequence[SandboxMaterializedFile],
    ) -> SandboxSessionState:
        """Record a resource copied into the bound container for workspace rebuild.

        One resource may arrive as several files: the original and any
        shell-friendly renditions of it (a spreadsheet's sheets as CSV). The
        file list is only recorded while ``container_id`` is still bound.
        """

        if not files:
            raise ValueError("a materialized resource needs at least one file")
        async with transaction_scope(self._sessions) as session:
            row = await _active_session(session, access, session_id)
            resources = list(_manifest_resources(row.manifest))
            if not any(item.resource_id == resource.resource_id for item in resources):
                resources.append(resource)
                row.manifest = {
                    "resources": [_resource_payload(item) for item in resources]
                }
            current = _state(row)
            if current.container_id == container_id:
                kept = [
                    item
                    for item in current.materialized_files
                    if item.resource_id != resource.resource_id
                ]
                row.provider_state = _provider_state(
                    container_id=container_id,
                    materialized_files=(*kept, *files),
                )
            row.last_used_at = datetime.now(UTC)
            await session.flush()
            return _state(row)

    async def record_resource(
        self,
        access: AuthContext,
        *,
        session_id: UUID,
        resource: SandboxManifestResource,
    ) -> SandboxSessionState:
        """Add a durable resource to the rebuild manifest without a container call."""

        async with transaction_scope(self._sessions) as session:
            row = await _active_session(session, access, session_id)
            resources = list(_manifest_resources(row.manifest))
            if not any(item.resource_id == resource.resource_id for item in resources):
                resources.append(resource)
                row.manifest = {
                    "resources": [_resource_payload(item) for item in resources]
                }
            row.last_used_at = datetime.now(UTC)
            await session.flush()
            return _state(row)

    async def expire(
        self,
        access: AuthContext,
        *,
        session_id: UUID,
    ) -> None:
        """Tombstone a sandbox binding that can no longer be resumed."""

        async with transaction_scope(self._sessions) as session:
            row = await _active_session(session, access, session_id)
            row.status = "expired"
            row.last_used_at = datetime.now(UTC)

    # -- Sandbox maintenance (no caller identity; never exposed by the API) --

    async def expire_idle(
        self, *, provider: str, idle_before: datetime
    ) -> tuple[str, ...]:
        """Expire active sessions unused since ``idle_before``; return their containers.

        Their manifests stay recoverable: the conversation's next sandbox use
        rebuilds a new container from them.
        """

        normalized_provider = _provider(provider)
        async with transaction_scope(self._sessions) as session:
            rows = (
                await session.scalars(
                    update(SandboxSession)
                    .where(
                        SandboxSession.provider == normalized_provider,
                        SandboxSession.status == "active",
                        SandboxSession.deleted_at.is_(None),
                        SandboxSession.last_used_at < idle_before,
                    )
                    .values(status="expired")
                    .returning(SandboxSession.provider_state)
                )
            ).all()
        return tuple(
            container
            for container in (_container_id(state) for state in rows)
            if container is not None
        )

    async def active_container_ids(self, *, provider: str) -> frozenset[str]:
        """Every container currently bound to an active session."""

        normalized_provider = _provider(provider)
        async with transaction_scope(self._sessions) as session:
            rows = (
                await session.scalars(
                    select(SandboxSession.provider_state).where(
                        SandboxSession.provider == normalized_provider,
                        SandboxSession.status == "active",
                        SandboxSession.deleted_at.is_(None),
                    )
                )
            ).all()
        return frozenset(
            container
            for container in (_container_id(state) for state in rows)
            if container is not None
        )


def _tenant_id(access: AuthContext) -> UUID:
    if access.tenant_id is None:
        raise DocumentNotFoundError("sandbox session not found")
    return access.tenant_id


def _provider(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("sandbox provider must not be blank")
    return normalized


async def _conversation(
    session: AsyncSession,
    access: AuthContext,
    conversation_id: UUID,
    *,
    lock: bool = False,
) -> Conversation:
    statement = select(Conversation).where(
        Conversation.id == conversation_id,
        Conversation.tenant_id == _tenant_id(access),
        conversation_access_filter(access),
        Conversation.status == "active",
    )
    if lock:
        statement = statement.with_for_update()
    row = await session.scalar(statement)
    if row is None:
        raise DocumentNotFoundError(f"conversation not found: {conversation_id}")
    return row


async def _active_session(
    session: AsyncSession, access: AuthContext, session_id: UUID
) -> SandboxSession:
    user_id = require_user_identity(access)
    row = await session.scalar(
        select(SandboxSession)
        .where(
            SandboxSession.id == session_id,
            SandboxSession.tenant_id == _tenant_id(access),
            SandboxSession.user_id == user_id,
            SandboxSession.status == "active",
            SandboxSession.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if row is None:
        raise DocumentNotFoundError("sandbox session not found")
    await _conversation(session, access, row.conversation_id)
    return row


def _state(row: SandboxSession) -> SandboxSessionState:
    return SandboxSessionState(
        id=row.id,
        provider=row.provider,
        status=row.status,  # type: ignore[arg-type]
        manifest=_manifest_resources(row.manifest),
        container_id=_container_id(row.provider_state),
        materialized_files=_materialized_files(row.provider_state),
    )


def _container_id(provider_state: object) -> str | None:
    payload = provider_state if isinstance(provider_state, dict) else {}
    return _optional_identifier(payload.get("container_id"))


def _manifest_resources(value: object) -> tuple[SandboxManifestResource, ...]:
    payload = value if isinstance(value, dict) else {}
    raw_resources = payload.get("resources")
    if not isinstance(raw_resources, list):
        return ()
    resources: list[SandboxManifestResource] = []
    for item in raw_resources:
        if not isinstance(item, dict):
            continue
        try:
            resource = SandboxManifestResource(
                resource_id=_identifier(item.get("resource_id"), "resource"),
                name=_identifier(item.get("name"), "resource name"),
                mime_type=_identifier(item.get("mime_type"), "resource mime type"),
                size_bytes=_size(item.get("size_bytes")),
            )
        except ValueError:
            continue
        if not any(existing.resource_id == resource.resource_id for existing in resources):
            resources.append(resource)
    return tuple(resources)


def _materialized_files(provider_state: object) -> tuple[SandboxMaterializedFile, ...]:
    payload = provider_state if isinstance(provider_state, dict) else {}
    raw_files = payload.get("materialized_files")
    if not isinstance(raw_files, list):
        return ()
    files: list[SandboxMaterializedFile] = []
    for item in raw_files:
        if not isinstance(item, dict):
            continue
        try:
            file = SandboxMaterializedFile(
                path=_identifier(item.get("path"), "sandbox file path"),
                resource_id=_identifier(item.get("resource_id"), "resource"),
            )
        except ValueError:
            continue
        if not any(existing.path == file.path for existing in files):
            files.append(file)
    return tuple(files)


def _provider_state(
    *, container_id: str, materialized_files: Iterable[SandboxMaterializedFile]
) -> dict[str, object]:
    return {
        "container_id": container_id,
        "materialized_files": [
            {"path": item.path, "resource_id": item.resource_id}
            for item in materialized_files
        ],
    }


def _resource_payload(resource: SandboxManifestResource) -> dict[str, object]:
    return {
        "resource_id": resource.resource_id,
        "name": resource.name,
        "mime_type": resource.mime_type,
        "size_bytes": resource.size_bytes,
    }


def _identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must not be blank")
    return value.strip()


def _optional_identifier(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _size(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("resource size is invalid")
    return value


__all__ = ["SandboxSessionService"]
