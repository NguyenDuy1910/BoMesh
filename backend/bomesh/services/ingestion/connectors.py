"""The platform connector catalog (``connectors/{connector}``).

A connector is a registry entry (``ConnectorRegistry``) overlaid with its
``platform_connector_settings`` row: display overrides, availability and the
OAuth client. No row means registry defaults and the deployment's environment
OAuth client. State: UNSUPPORTED (catalog-only registry entry), DISABLED
(``available = false``) or ACTIVE.

Platform staff (``connectors.*`` on the platform) see every connector with its
usage counts; workspace members (``connectors.list``/``.get`` in a workspace
where they are ACTIVE) see ACTIVE connectors only.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import (
    Boolean,
    String,
    case,
    column,
    false,
    func,
    literal,
    select,
    values,
)
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Subquery

from bomesh import etag as etags
from bomesh.connector import ConnectorDefinition
from bomesh.connector.registry import ConnectorRegistry
from bomesh.db.engine import SessionFactory, transaction_scope
from bomesh.db.models import IntegrationConnection, PlatformConnectorSettings, Request
from bomesh.errors import FailedPrecondition, InvalidArgument, NotFound, Unavailable
from bomesh.iam.authorizer import PlatformRef, permission_denied
from bomesh.integrations.registry import ConnectionProviderRegistry
from bomesh.services.ingestion.common import connector_name
from bomesh.services.ingestion.credentials import seal_client_secret
from bomesh.services.kernel.audit import Audit
from bomesh.services.kernel.context import RequestContext
from bomesh.services.kernel.listing import ListQuery

if TYPE_CHECKING:
    from bomesh.runtime import AppRuntime

ConnectorState = Literal["ACTIVE", "DISABLED", "UNSUPPORTED"]

#: ``updated_at`` of a connector without a settings row: its etag is stable.
_NEVER_UPDATED = datetime(1970, 1, 1, tzinfo=UTC)
_OPEN_REQUEST_STATES = ("open", "needs_info")
_CATALOG = PlatformRef("connectors")

#: Mutable paths of ``UpdateConnector`` (``api.aip.fieldmask``).
UPDATABLE_FIELDS = (
    "displayName",
    "description",
    "oauthClient.clientId",
    "oauthClient.clientSecret",
)


@dataclass(frozen=True, slots=True)
class OAuthClientRecord:
    client_id: str | None
    secret_configured: bool


@dataclass(frozen=True, slots=True)
class ConnectorRecord:
    """A connector as one caller sees it; counts only for platform callers."""

    key: str
    display_name: str
    description: str
    authentication_type: str
    state: ConnectorState
    oauth_client: OAuthClientRecord | None
    etag: str
    workspace_count: int | None = None
    request_count: int | None = None

    @property
    def name(self) -> str:
        return connector_name(self.key)


class ConnectorService:
    """List, Get, Update, Enable and Disable catalog connectors."""

    def __init__(
        self,
        sessions: SessionFactory,
        *,
        providers: ConnectionProviderRegistry,
        credential_encryption_key: str | None,
        connectors: ConnectorRegistry | None = None,
    ) -> None:
        self._sessions = sessions
        self._providers = providers
        self._encryption_key = credential_encryption_key
        self._connectors = connectors or ConnectorRegistry.default()

    @classmethod
    def from_runtime(cls, runtime: AppRuntime) -> ConnectorService:
        return cls(
            runtime.sessions(),
            providers=runtime.connection_providers(),
            credential_encryption_key=runtime.config.integration.credential_encryption_key,
        )

    def catalog_table(self) -> Subquery:
        """Columns ``key, display_name, description, authentication_type, state, ...``.

        ``authentication_type`` and ``state`` hold the API enum values, so
        filters compare them directly.
        """
        return catalog_query(self._connectors).subquery("connectors")

    async def list(
        self, ctx: RequestContext, query: ListQuery, table: Subquery
    ) -> tuple[list[ConnectorRecord], int]:
        """The page of connectors the caller may see, and how many there are in total."""
        platform = await _reader_scope(ctx, "connectors.list")
        statement = select(table)
        if not platform:
            statement = statement.where(table.c.state == "ACTIVE")
        async with transaction_scope(self._sessions) as session:
            total = int(await session.scalar(query.count(statement)) or 0)
            rows = [row._mapping for row in (await session.execute(query.apply(statement))).all()]
            counts = await _usage(session, [row["key"] for row in rows]) if platform else None
        return [self._record(row, counts) for row in rows], total

    async def get(self, ctx: RequestContext, key: str) -> ConnectorRecord:
        platform = await _reader_scope(ctx, "connectors.get")
        async with transaction_scope(self._sessions) as session:
            row = await self._row(session, key)
            if row is None or not platform and row["state"] != "ACTIVE":
                if platform:
                    raise _not_found(key)
                raise permission_denied("connectors.get", PlatformRef(connector_name(key)))
            counts = await _usage(session, [key]) if platform else None
        return self._record(row, counts)

    async def update(
        self,
        ctx: RequestContext,
        key: str,
        changes: Mapping[str, str | None],
        *,
        etag: str | None,
    ) -> ConnectorRecord:
        """Apply ``changes`` (UPDATABLE_FIELDS path → value; empty clears to the default)."""
        definition = await self._require(ctx, "connectors.update", key)
        if definition.authentication_type != "oauth" and any(
            path.startswith("oauthClient.") for path in changes
        ):
            raise InvalidArgument.for_field(
                "oauthClient", f"Connector '{key}' is not authorized with OAuth."
            )
        async with transaction_scope(self._sessions) as session:
            settings, current = await _locked_settings(session, key)
            etags.check(etag, current)
            for path, value in changes.items():
                self._apply(settings, path, (value or "").strip() or None)
            settings.updated_by_user_id = ctx.user_id
            await _touch(session, settings)
            await Audit(session).record(
                ctx,
                workspace_id=None,
                category="sources",
                action="UpdateConnector",
                target=connector_name(key),
                details={"fields": sorted(changes)},
            )
        return await self._platform_record(key)

    async def enable(self, ctx: RequestContext, key: str, *, etag: str | None) -> ConnectorRecord:
        """DISABLED → ACTIVE; an OAuth connector needs its client secret first."""
        definition = await self._require(ctx, "connectors.enable", key)
        async with transaction_scope(self._sessions) as session:
            settings, current = await _locked_settings(session, key)
            etags.check(etag, current)
            row = await self._row(session, key)
            assert row is not None
            if row["state"] != "DISABLED":
                raise FailedPrecondition(f"Connector '{key}' is {row['state']}, not DISABLED.")
            if (
                definition.authentication_type == "oauth"
                and not self._oauth_client(row).secret_configured
            ):
                raise FailedPrecondition(
                    f"Connector '{key}' has no OAuth client secret configured."
                )
            await _set_available(session, ctx, settings, available=True, action="EnableConnector")
        return await self._platform_record(key)

    async def disable(self, ctx: RequestContext, key: str, *, etag: str | None) -> ConnectorRecord:
        """ACTIVE → DISABLED: no new connections, existing connections stop syncing."""
        await self._require(ctx, "connectors.disable", key)
        async with transaction_scope(self._sessions) as session:
            settings, current = await _locked_settings(session, key)
            etags.check(etag, current)
            row = await self._row(session, key)
            assert row is not None
            if row["state"] != "ACTIVE":
                raise FailedPrecondition(f"Connector '{key}' is {row['state']}, not ACTIVE.")
            await _set_available(session, ctx, settings, available=False, action="DisableConnector")
        return await self._platform_record(key)

    # -- Internals -----------------------------------------------------------

    async def _require(self, ctx: RequestContext, permission: str, key: str) -> ConnectorDefinition:
        await ctx.authorizer.require(ctx.principal, permission, PlatformRef(connector_name(key)))
        try:
            return self._connectors.get(key)
        except LookupError:
            raise _not_found(key) from None

    async def _platform_record(self, key: str) -> ConnectorRecord:
        async with transaction_scope(self._sessions) as session:
            row = await self._row(session, key)
            assert row is not None
            return self._record(row, await _usage(session, [key]))

    async def _row(self, session: AsyncSession, key: str) -> Mapping[str, Any] | None:
        table = self.catalog_table()
        row = (await session.execute(select(table).where(table.c.key == key))).first()
        return row._mapping if row is not None else None

    def _apply(self, settings: PlatformConnectorSettings, path: str, value: str | None) -> None:
        match path:
            case "displayName":
                settings.display_name = _bounded(value, 255, path)
            case "description":
                settings.description = value
            case "oauthClient.clientId":
                settings.oauth_client_id = _bounded(value, 512, path)
            case "oauthClient.clientSecret":
                settings.oauth_client_secret_encrypted = (
                    seal_client_secret(self._key(), settings.connector_key, value)
                    if value is not None
                    else None
                )

    def _record(
        self, row: Mapping[str, Any], counts: Mapping[str, tuple[int, int]] | None
    ) -> ConnectorRecord:
        usage = counts.get(row["key"], (0, 0)) if counts is not None else None
        return ConnectorRecord(
            key=row["key"],
            display_name=row["display_name"],
            description=row["description"],
            authentication_type=row["authentication_type"],
            state=row["state"],
            oauth_client=(
                self._oauth_client(row) if row["authentication_type"] == "OAUTH" else None
            ),
            etag=_row_etag(row),
            workspace_count=usage[0] if usage is not None else None,
            request_count=usage[1] if usage is not None else None,
        )

    def _oauth_client(self, row: Mapping[str, Any]) -> OAuthClientRecord:
        """The effective client: the stored one, else the deployment's environment."""
        provider = self._providers.for_connector(row["key"])
        return OAuthClientRecord(
            client_id=row["oauth_client_id"] or (provider.client_id if provider else None),
            secret_configured=row["secret_stored"]
            or (provider is not None and provider.has_client_secret),
        )

    def _key(self) -> str:
        if not self._encryption_key:
            raise Unavailable("BOMESH_INTEGRATION_ENCRYPTION_KEY is not configured.")
        return self._encryption_key


def catalog_query(connectors: ConnectorRegistry) -> Any:
    """The catalog joined with its settings; one row per registry entry."""
    catalog = values(
        column("key", String),
        column("default_display_name", String),
        column("default_description", String),
        column("authentication_type", String),
        column("supported", Boolean),
        name="catalog",
    ).data(
        [
            (
                definition.key,
                definition.display_name,
                definition.description,
                definition.authentication_type.upper(),
                definition.supported,
            )
            for definition in connectors.list()
        ]
    )
    settings = PlatformConnectorSettings
    updated_at = func.coalesce(settings.updated_at, literal(_NEVER_UPDATED))
    return select(
        catalog.c.key,
        func.coalesce(settings.display_name, catalog.c.default_display_name).label(
            "display_name"
        ),
        func.coalesce(settings.description, catalog.c.default_description).label("description"),
        catalog.c.authentication_type,
        case(
            (catalog.c.supported.is_(false()), "UNSUPPORTED"),
            (settings.available.is_(false()), "DISABLED"),
            else_="ACTIVE",
        ).label("state"),
        settings.oauth_client_id,
        settings.oauth_client_secret_encrypted.is_not(None).label("secret_stored"),
        updated_at.label("updated_at"),
    ).select_from(catalog.outerjoin(settings, settings.connector_key == catalog.c.key))


async def _reader_scope(ctx: RequestContext, permission: str) -> bool:
    """True for platform staff; False for members holding ``permission`` in some workspace."""
    authorizer, principal = ctx.authorizer, ctx.principal
    if permission in await authorizer.platform_permissions(principal):
        return True
    for workspace_id in await authorizer.member_workspaces(principal):
        if permission in await authorizer.workspace_permissions(principal, workspace_id):
            return False
    raise permission_denied(permission, _CATALOG)


async def _usage(session: AsyncSession, keys: Sequence[str]) -> dict[str, tuple[int, int]]:
    """``workspaceCount`` and ``requestCount`` per connector key."""
    workspaces = dict(
        (
            await session.execute(
                select(
                    IntegrationConnection.connector_key,
                    func.count(IntegrationConnection.tenant_id.distinct()),
                )
                .where(
                    IntegrationConnection.connector_key.in_(keys),
                    IntegrationConnection.deleted_at.is_(None),
                )
                .group_by(IntegrationConnection.connector_key)
            )
        ).tuples().all()
    )
    requests = dict(
        (
            await session.execute(
                select(Request.connector_key, func.count())
                .where(
                    Request.kind == "connector",
                    Request.connector_key.in_(keys),
                    Request.state.in_(_OPEN_REQUEST_STATES),
                )
                .group_by(Request.connector_key)
            )
        ).tuples().all()
    )
    return {key: (workspaces.get(key, 0), requests.get(key, 0)) for key in keys}


async def _locked_settings(
    session: AsyncSession, key: str
) -> tuple[PlatformConnectorSettings, str]:
    """The connector's settings row, created if missing and locked, with the current etag.

    A row created here did not exist for the caller: its etag is the defaults' etag.
    """
    created = await session.scalar(
        insert(PlatformConnectorSettings)
        .values(connector_key=key)
        .on_conflict_do_nothing(index_elements=[PlatformConnectorSettings.connector_key])
        .returning(PlatformConnectorSettings.connector_key)
    )
    settings = await session.scalar(
        select(PlatformConnectorSettings)
        .where(PlatformConnectorSettings.connector_key == key)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    assert settings is not None
    updated_at = _NEVER_UPDATED if created is not None else settings.updated_at
    return settings, etags.compute(connector_name(key), updated_at)


async def _touch(session: AsyncSession, settings: PlatformConnectorSettings) -> None:
    settings.updated_at = func.clock_timestamp()
    await session.flush()
    await session.refresh(settings)


async def _set_available(
    session: AsyncSession,
    ctx: RequestContext,
    settings: PlatformConnectorSettings,
    *,
    available: bool,
    action: str,
) -> None:
    settings.available = available
    settings.updated_by_user_id = ctx.user_id
    await _touch(session, settings)
    await Audit(session).record(
        ctx,
        workspace_id=None,
        category="sources",
        action=action,
        target=connector_name(settings.connector_key),
    )


def _row_etag(row: Mapping[str, Any]) -> str:
    return etags.compute(connector_name(row["key"]), row["updated_at"])


def _bounded(value: str | None, limit: int, path: str) -> str | None:
    if value is not None and len(value) > limit:
        raise InvalidArgument.for_field(path, f"{path} must be at most {limit} characters.")
    return value


def _not_found(key: str) -> NotFound:
    return NotFound(f"Connector '{connector_name(key)}' does not exist.")


__all__ = [
    "UPDATABLE_FIELDS",
    "ConnectorRecord",
    "ConnectorService",
    "ConnectorState",
    "OAuthClientRecord",
    "catalog_query",
]
